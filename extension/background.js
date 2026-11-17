'use strict';

/*
 * m3u8 -> MP4 : background service worker（最小権限版）
 *
 *  - 検出は「ポップアップを開いたとき（= activeTab が付与されたとき）」に
 *    ページをスキャンして行う。常時監視はしない。
 *  - URL に .m3u8 が無いプレイリストの検証（応答の先頭 #EXTM3U 判定）は、
 *    配信元 origin の任意ホスト権限がある場合のみ service worker から fetch する。
 *    権限が無い場合はポップアップ側で chrome.permissions.request() を出し、
 *    許可後に再検証する（ページ文脈のCORSに依存しない）。
 *  - 変換はローカルの ffmpeg が行うため、ブラウザの権限は不要。
 */

importScripts('lib/detect.js');

const D = self.M3U8Detect;

const HOST_NAME = 'com.local.m3u8mp4';
const MAX_PER_TAB = 15;
const PROBE_LIMIT = 8;
const VERIFY_TTL = 15 * 60 * 1000;

/** @type {Map<number, Array<{url: string, ts: number, source: string, verify: string}>>} */
const candidatesByTab = new Map();
/** @type {Map<string, {status: string, ts: number}>} */
const verifyCache = new Map();
const uiPorts = new Set();

let nativePort = null;
let hostStatus = { status: 'unknown', message: '' };
let job = blankJob();

function blankJob() {
  return {
    id: null, active: false, percent: null, outTimeMs: 0, durationMs: 0,
    speed: null, size: 0, output: null, args: null, startedAt: 0, log: []
  };
}

/* ------------------------------------------------------------------ */
/* popup との接続                                                      */
/* ------------------------------------------------------------------ */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui') return;
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  port.onMessage.addListener((msg) => { handleUiMessage(msg, port); });
  safePost(port, buildStateMessage());
});

function safePost(port, msg) {
  try { port.postMessage(msg); } catch (e) { /* popup が閉じた */ }
}

function broadcast(msg) {
  for (const p of uiPorts) safePost(p, msg);
}

function buildStateMessage() {
  return { type: 'state', hostStatus: hostStatus, job: publicJob(), extensionId: chrome.runtime.id };
}

function publicJob() {
  return {
    id: job.id,
    active: job.active,
    percent: job.percent,
    outTimeMs: job.outTimeMs,
    durationMs: job.durationMs,
    speed: job.speed,
    size: job.size,
    output: job.output,
    args: job.args,
    startedAt: job.startedAt,
    log: job.log.slice(-120)
  };
}

function pushLog(line) {
  job.log.push(line);
  if (job.log.length > 120) job.log.shift();
}

function candidatesOf(tabId) {
  return candidatesByTab.get(tabId) || [];
}

async function handleUiMessage(msg, port) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'get-state':
      return safePost(port, buildStateMessage());

    case 'get-candidates':
      return safePost(port, {
        type: 'candidates', tabId: msg.tabId, list: candidatesOf(msg.tabId), needsPermission: collectNeedPermission(msg.tabId)
      });

    case 'scan-page': {
      const result = await runScan(msg.tabId);
      return safePost(port, {
        type: 'scan-result',
        tabId: msg.tabId,
        scanned: result.scanned,
        error: result.error,
        needsPermission: result.needsPermission,
        list: candidatesOf(msg.tabId)
      });
    }

    case 'verify-pending': {
      const result = await reverifyPending(msg.tabId);
      return safePost(port, {
        type: 'scan-result', tabId: msg.tabId, scanned: -1,
        needsPermission: result.needsPermission, list: candidatesOf(msg.tabId)
      });
    }

    case 'ping': {
      const p = ensureNativePort();
      if (p) p.postMessage({ type: 'ping', id: 'ui-ping' });
      return;
    }

    case 'defaults': {
      const p = ensureNativePort();
      if (p) p.postMessage({ type: 'defaults', id: msg.id || 'defaults' });
      return;
    }

    case 'probe': {
      const p = ensureNativePort();
      if (p) p.postMessage({ type: 'probe-ffmpeg', id: 'probe', ffmpegPath: msg.ffmpegPath || '' });
      return;
    }

    case 'start':
      return startJob(msg);

    case 'cancel': {
      if (nativePort) nativePort.postMessage({ type: 'cancel', id: job.id });
      return;
    }

    case 'open-folder': {
      if (nativePort) nativePort.postMessage({ type: 'open-folder', path: msg.path || job.output || '' });
      return;
    }

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* 検出                                                               */
/* ------------------------------------------------------------------ */
function addCandidate(tabId, url, source, verify) {
  if (typeof tabId !== 'number' || tabId < 0 || !url) return;

  const list = candidatesOf(tabId);
  const existing = list.find((c) => c.url === url);

  if (existing) {
    if (verify && existing.verify !== verify) {
      existing.verify = verify;
      broadcast({ type: 'candidates', tabId: tabId, list: list, needsPermission: collectNeedPermission(tabId) });
    }
    return;
  }

  list.unshift({ url: url, ts: Date.now(), source: source || 'hint', verify: verify || 'assumed' });
  if (list.length > MAX_PER_TAB) list.length = MAX_PER_TAB;
  candidatesByTab.set(tabId, list);
  broadcast({ type: 'candidates', tabId: tabId, list: list, needsPermission: collectNeedPermission(tabId) });
}

function removeCandidate(tabId, url) {
  const list = candidatesOf(tabId);
  const i = list.findIndex((c) => c.url === url);
  if (i < 0) return;
  list.splice(i, 1);
  broadcast({ type: 'candidates', tabId: tabId, list: list, needsPermission: collectNeedPermission(tabId) });
}

/* 許可を求めるとよい origin の一覧（未検証の候補から作る） */
function collectNeedPermission(tabId) {
  const out = [];
  for (const c of candidatesOf(tabId)) {
    if (c.verify !== 'need-permission') continue;
    const p = D.originPattern(c.url);
    if (p && out.indexOf(p) < 0) out.push(p);
  }
  return out;
}

/* 応答の先頭64バイトから #EXTM3U を判定する。
   配信元 origin のホスト権限が無いと fetch が CORS で失敗するため、
   その場合は 'need-permission' を返してポップアップに許可ボタンを出させる。 */
async function verifyUrl(url) {
  const cached = verifyCache.get(url);
  if (cached && Date.now() - cached.ts < VERIFY_TTL) return cached.status;

  const pattern = D.originPattern(url);
  if (!pattern) return 'error';

  let status;
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok || !res.body) {
      status = 'no';
    } else {
      const reader = res.body.getReader();
      const first = await reader.read();
      try { reader.cancel(); } catch (e) { /* ignore */ }
      const bytes = first && first.value ? first.value.slice(0, 64) : new Uint8Array(0);
      status = D.looksLikePlaylistText(new TextDecoder('utf-8').decode(bytes)) ? 'ok' : 'no';
    }
  } catch (e) {
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [pattern] });
    } catch (e2) {
      granted = false;
    }
    status = granted ? 'error' : 'need-permission';
  }

  verifyCache.set(url, { status: status, ts: Date.now() });
  if (verifyCache.size > 300) {
    const old = Array.from(verifyCache.entries()).sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
    for (const pair of old) verifyCache.delete(pair[0]);
  }
  return status;
}

async function runScan(tabId) {
  if (typeof tabId !== 'number') return { scanned: 0, error: 'no-tab', needsPermission: [] };

  let urls = [];
  let error = null;
  try {
    urls = await scanPage(tabId);
  } catch (e) {
    error = (e && e.message) || 'scan failed';
    urls = [];
  }

  const picked = D.classify(urls, 40);

  candidatesByTab.delete(tabId);
  broadcast({ type: 'candidates', tabId: tabId, list: [], needsPermission: [] });

  for (const u of picked.playlists) addCandidate(tabId, u, 'url', 'assumed');

  const hints = picked.hints.slice(0, PROBE_LIMIT);
  const statuses = await Promise.all(hints.map((u) => verifyUrl(u)));

  for (let i = 0; i < hints.length; i++) {
    if (statuses[i] === 'no') continue;
    addCandidate(tabId, hints[i], 'hint', statuses[i]);
  }

  return { scanned: urls.length, error: error, needsPermission: collectNeedPermission(tabId) };
}

/* 権限が付与された後、未検証の候補だけを再検証する */
async function reverifyPending(tabId) {
  const pending = candidatesOf(tabId).filter((c) => c.verify === 'need-permission');
  for (const c of pending) verifyCache.delete(c.url);

  const statuses = await Promise.all(pending.map((c) => verifyUrl(c.url)));

  for (let i = 0; i < pending.length; i++) {
    if (statuses[i] === 'no') removeCandidate(tabId, pending[i].url);
    else addCandidate(tabId, pending[i].url, 'hint', statuses[i]);
  }
  return { needsPermission: collectNeedPermission(tabId) };
}

/* ポップアップを開いた時点の activeTab でページを走査する */
async function scanPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const out = [];
      const push = (u) => {
        if (u && out.indexOf(u) < 0 && out.length < 60) out.push(u);
      };
      try {
        for (const e of performance.getEntriesByType('resource')) push(e.name);
      } catch (e) { /* ignore */ }
      try {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const re = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;
        let m;
        while ((m = re.exec(html)) !== null) push(m[0]);
      } catch (e) { /* ignore */ }
      return out;
    }
  });
  return (results && results[0] && results[0].result) || [];
}

/* ページ遷移したら候補をリセット */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info || info.status !== 'loading') return;
  candidatesByTab.delete(tabId);
  broadcast({ type: 'candidates', tabId: tabId, list: [], needsPermission: [] });
});

/* ------------------------------------------------------------------ */
/* ネイティブホストとの通信                                            */
/* ------------------------------------------------------------------ */
function ensureNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    setHostStatus('error', 'ネイティブホストに接続できません: ' + e.message);
    return null;
  }
  nativePort.onMessage.addListener(onHostMessage);
  nativePort.onDisconnect.addListener(onHostDisconnect);
  setHostStatus('connecting', '');
  nativePort.postMessage({ type: 'ping', id: 'hello' });
  return nativePort;
}

function onHostDisconnect() {
  const err = chrome.runtime.lastError;
  const message = (err && err.message) || '';
  nativePort = null;

  if (job.active) {
    job.active = false;
    pushLog('ホストとの接続が切れたため中断しました。');
    broadcast({ type: 'job', job: publicJob() });
    broadcast({ type: 'error', message: 'ネイティブホストとの接続が切れました。' + message });
  }
  setHostStatus('disconnected', message);
}

function setHostStatus(status, message) {
  hostStatus = { status: status, message: message || '' };
  broadcast({ type: 'host-status', status: status, message: message || '' });
}

function onHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'pong':
      setHostStatus('ready', 'node ' + msg.node);
      broadcast({ type: 'host-info', info: msg });
      return;

    case 'defaults':
      broadcast({ type: 'defaults', outDir: msg.outDir, homedir: msg.homedir, platform: msg.platform });
      return;

    case 'ffmpeg-probe':
      broadcast({ type: 'ffmpeg-probe', ok: msg.ok, version: msg.version, exe: msg.exe, message: msg.message });
      return;

    case 'started':
      job.output = msg.output;
      job.args = msg.args;
      broadcast({ type: 'started', job: publicJob() });
      return;

    case 'duration':
      job.durationMs = msg.durationMs || 0;
      broadcast({ type: 'progress', job: publicJob() });
      return;

    case 'progress':
      job.percent = msg.percent;
      job.outTimeMs = msg.outTimeMs || 0;
      job.size = msg.size || 0;
      job.speed = msg.speed || null;
      if (msg.durationMs) job.durationMs = msg.durationMs;
      setBadge(job.percent);
      broadcast({ type: 'progress', job: publicJob() });
      return;

    case 'log':
      pushLog(msg.line);
      broadcast({ type: 'log', line: msg.line });
      return;

    case 'cancelling':
      pushLog('中止しています...');
      broadcast({ type: 'log', line: '中止しています...' });
      return;

    case 'cancelled':
      broadcast({ type: 'info', message: msg.message || '実行中のジョブはありません' });
      return;

    case 'folder-opened':
      return;

    case 'done': {
      job.active = false;
      setBadge(msg.code === 0 && !msg.cancelled ? 'OK' : null);
      if (msg.detail && msg.detail.length) {
        for (const line of msg.detail) pushLog(line);
      }
      if (msg.error) pushLog(msg.error);
      broadcast({ type: 'done', result: msg, job: publicJob() });
      return;
    }

    case 'error':
      pushLog('[error] ' + msg.message);
      if (job.active && msg.kind === 'spawn') job.active = false;
      broadcast({ type: 'error', message: msg.message });
      return;

    default:
      broadcast(msg);
  }
}

function setBadge(text) {
  try {
    if (text === null || text === undefined) {
      chrome.action.setBadgeText({ text: '' });
    } else if (typeof text === 'number') {
      chrome.action.setBadgeText({ text: Math.floor(text) + '%' });
      chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
    } else {
      chrome.action.setBadgeText({ text: String(text) });
      chrome.action.setBadgeBackgroundColor({ color: '#2ea043' });
    }
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 変換開始                                                            */
/* ------------------------------------------------------------------ */
async function startJob(msg) {
  if (job.active) {
    broadcast({ type: 'error', message: '既に変換を実行中です。完了するか中止してください。' });
    return;
  }

  const port = ensureNativePort();
  if (!port) return;

  const id = 'job-' + Date.now();
  job = blankJob();
  job.id = id;
  job.active = true;
  job.startedAt = Date.now();
  setBadge(0);
  broadcast({ type: 'job', job: publicJob() });

  const payload = {
    type: 'start',
    id: id,
    ffmpegPath: msg.ffmpegPath || '',
    outDir: msg.outDir || '',
    outName: msg.outName || '',
    input: msg.input || {},
    referer: msg.referer || '',
    userAgent: msg.userAgent || ''
  };

  if (msg.useCookies) {
    const cookies = await collectCookies(msg.input);
    if (cookies) {
      payload.cookies = cookies;
      pushLog('Cookie を ' + cookies.split(';').length + ' 件引き継ぎます。');
    }
  }

  port.postMessage(payload);
}

/* cookies は任意権限。許可されていて、そのURLにアクセスできる場合のみ取得できる */
async function collectCookies(input) {
  if (!chrome.cookies) return '';

  let url = null;
  if (input && input.kind === 'url') url = input.url;
  else if (input && input.baseUrl) url = input.baseUrl;
  if (!url) return '';

  try {
    const has = await chrome.permissions.contains({ permissions: ['cookies'] });
    if (!has) return '';
  } catch (e) {
    return '';
  }

  try {
    const list = await chrome.cookies.getAll({ url: url });
    return list.map((c) => c.name + '=' + c.value).join('; ');
  } catch (e) {
    return '';
  }
}
