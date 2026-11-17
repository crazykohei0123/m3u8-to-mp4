'use strict';

/*
 * m3u8 -> MP4 : background service worker
 *
 *  1. webRequest でページが読む .m3u8 を検出して候補として保持
 *  2. popup からの依頼でネイティブホスト(com.local.m3u8mp4)へ ffmpeg 実行を委譲
 *  3. ホストからの進捗/ログを popup へ中継
 *
 * ネットワーク取得は ffmpeg が行うので、この拡張自身は .ts を fetch しない
 * (= CORS の影響を受けない)。
 */

const HOST_NAME = 'com.local.m3u8mp4';
const MAX_PER_TAB = 15;
const LOG_KEEP = 120;

/** @type {Map<number, Array<{url: string, ts: number}>>} */
const candidatesByTab = new Map();
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
  return { type: 'state', hostStatus, job: publicJob() };
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
    log: job.log.slice(-LOG_KEEP)
  };
}

function pushLog(line) {
  job.log.push(line);
  if (job.log.length > LOG_KEEP) job.log.shift();
}

async function handleUiMessage(msg, port) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'get-state':
      return safePost(port, buildStateMessage());

    case 'get-candidates': {
      const list = candidatesByTab.get(msg.tabId) || [];
      return safePost(port, { type: 'candidates', tabId: msg.tabId, list });
    }

    case 'scan-page': {
      const urls = await scanPage(msg.tabId);
      ingestUrls(msg.tabId, urls);
      return safePost(port, { type: 'candidates', tabId: msg.tabId, list: candidatesByTab.get(msg.tabId) || [], scanned: urls.length });
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
/* m3u8 候補の検出                                                     */
/* ------------------------------------------------------------------ */
const HINT_RE = /(m3u8|playlist|manifest|streaming|hls|master)/i;
const MEDIA_RE = /\.(ts|m4s|mp4|m4a|mp3|aac|vtt|key|jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|map)(\?|#|$)/i;
const PROBE_LIMIT_PER_TAB = 8;
const VERIFY_TTL = 15 * 60 * 1000;

const probeCount = new Map();   // tabId -> 応答検証の回数
const verifyCache = new Map();  // url -> { ok, ts }

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || !/^https?:/i.test(d.url)) return;

  if (isPlaylistUrl(d.url)) {
    addCandidate(d.tabId, d.url, 'url');
    return;
  }
  // 拡張子なしのプレイリスト（例: /channel_post_movies/982/streaming）
  if ((d.type === 'xmlhttprequest' || d.type === 'other') && isPlaylistHint(d.url)) {
    probeCandidate(d.tabId, d.url);
  }
}, { urls: ['<all_urls>'] });

function isPlaylistUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url) || /[?&](format|type|ext)=m3u8\b/i.test(url);
}

function isPlaylistHint(url) {
  if (!url || MEDIA_RE.test(url)) return false;
  return HINT_RE.test(url);
}

/* ページ内フック(MAIN world)や content.js からの通知 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
  if (!msg || tabId < 0) return;

  if (msg.type === 'page-playlist' && typeof msg.url === 'string') {
    if (/^https?:/i.test(msg.url)) addCandidate(tabId, msg.url, 'hook');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'page-hints' && Array.isArray(msg.urls)) {
    ingestUrls(tabId, msg.urls);
    sendResponse({ ok: true });
  }
});

/* URL一覧を取り込み、必要なら応答本文を検証する */
function ingestUrls(tabId, urls) {
  let probes = 0;
  for (const u of urls.slice(0, 40)) {
    if (typeof u !== 'string' || !/^https?:/i.test(u)) continue;
    if (isPlaylistUrl(u)) addCandidate(tabId, u, 'url');
    else if (isPlaylistHint(u) && probes < PROBE_LIMIT_PER_TAB) {
      probes++;
      probeCandidate(tabId, u);
    }
  }
}

/* 応答の先頭だけを読んで #EXTM3U か判定（ホスト権限があるのでCORSは適用外） */
async function verifyPlaylist(url) {
  const cached = verifyCache.get(url);
  if (cached && Date.now() - cached.ts < VERIFY_TTL) return cached.ok;

  let ok = false;
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const first = await reader.read();
      try { reader.cancel(); } catch (e) { /* ignore */ }
      const bytes = first && first.value ? first.value.slice(0, 64) : new Uint8Array(0);
      const head = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').replace(/^\s+/, '');
      ok = head.indexOf('#EXTM3U') === 0;
    }
  } catch (e) {
    ok = false;
  }

  verifyCache.set(url, { ok: ok, ts: Date.now() });
  if (verifyCache.size > 300) {
    const old = Array.from(verifyCache.entries()).sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
    for (const pair of old) verifyCache.delete(pair[0]);
  }
  return ok;
}

async function probeCandidate(tabId, url) {
  const list = candidatesByTab.get(tabId) || [];
  if (list.some((c) => c.url === url)) return;

  const used = probeCount.get(tabId) || 0;
  if (used >= PROBE_LIMIT_PER_TAB) return;
  probeCount.set(tabId, used + 1);

  if (await verifyPlaylist(url)) addCandidate(tabId, url, 'sniff');
}

/* ページ遷移したら候補をリセット */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  candidatesByTab.delete(tabId);
  probeCount.delete(tabId);
  broadcast({ type: 'candidates', tabId: tabId, list: [] });
});

function addCandidate(tabId, url, source) {
  if (typeof tabId !== 'number' || tabId < 0 || !url) return;

  const list = candidatesByTab.get(tabId) || [];
  const existing = list.find((c) => c.url === url);

  if (existing) {
    // より確度の高い検出（hook/sniff）で上書き
    if (source && existing.source !== source) {
      existing.source = source;
      broadcast({ type: 'candidates', tabId: tabId, list: list });
    }
    return;
  }

  list.unshift({ url: url, ts: Date.now(), source: source || 'url' });
  if (list.length > MAX_PER_TAB) list.length = MAX_PER_TAB;
  candidatesByTab.set(tabId, list);
  broadcast({ type: 'candidates', tabId: tabId, list: list });
}

/* ページ内のHTML/リソースから候補URLを集める（判定は service worker 側） */
async function scanPage(tabId) {
  if (typeof tabId !== 'number') return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const found = [];
        const push = (u) => {
          if (u && found.indexOf(u) < 0 && found.length < 40) found.push(u);
        };
        const re = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        let m;
        while ((m = re.exec(html)) !== null) push(m[0]);
        try {
          for (const e of performance.getEntriesByType('resource')) push(e.name);
        } catch (e) { /* ignore */ }
        return found;
      }
    });
    return (results && results[0] && results[0].result) || [];
  } catch (e) {
    return [];
  }
}


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

    case 'progress': {
      job.percent = msg.percent;
      job.outTimeMs = msg.outTimeMs || 0;
      job.size = msg.size || 0;
      job.speed = msg.speed || null;
      if (msg.durationMs) job.durationMs = msg.durationMs;
      setBadge(job.percent);
      broadcast({ type: 'progress', job: publicJob() });
      return;
    }

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

async function collectCookies(input) {
  let url = null;
  if (input && input.kind === 'url') url = input.url;
  else if (input && input.baseUrl) url = input.baseUrl;

  if (!url) return '';
  try {
    const list = await chrome.cookies.getAll({ url: url });
    return list.map((c) => c.name + '=' + c.value).join('; ');
  } catch (e) {
    return '';
  }
}
