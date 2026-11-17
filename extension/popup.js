'use strict';

/* popup <- background(service worker) <- native host <- ffmpeg */

const $ = (id) => document.getElementById(id);
const SETTING_KEYS = ['ffmpegPath', 'outDir', 'outName', 'useCookies', 'referer', 'userAgent', 'baseUrl', 'lastUrl'];

let port = null;
let currentTabId = null;
let activePane = 'auto';
let job = { active: false, percent: null, outTimeMs: 0, durationMs: 0, speed: null, size: 0, output: null };
let lastOutput = null;
let saveTimer = null;
let needsPermission = [];

init();

async function init() {
  bindEvents();
  await loadSettings();

  try {
    $('extId').value = chrome.runtime.id || '';
  } catch (e) {
    $('extId').value = '';
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tabs && tabs[0] ? tabs[0].id : null;
  } catch (e) {
    currentTabId = null;
  }

  connect();
  send({ type: 'defaults', id: 'defaults' });
  requestCandidates();
}

/* ---------------- port ---------------- */
function connect() {
  port = chrome.runtime.connect({ name: 'ui' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(() => { if (!port) connect(); }, 600);
  });
  port.postMessage({ type: 'get-state' });
  port.postMessage({ type: 'ping' });
}

function send(msg) {
  if (!port) return;
  try { port.postMessage(msg); } catch (e) { /* ignore */ }
}

/* ---------------- 受信 ---------------- */
function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'state':
      if (msg.hostStatus) setHost(msg.hostStatus.status, msg.hostStatus.message);
      if (msg.job) renderJob(msg.job);
      break;

    case 'host-status':
      setHost(msg.status, msg.message);
      if (msg.status === 'disconnected' && msg.message) {
        appendLog('[host] ' + msg.message);
        if (/not found|見つかりません/i.test(msg.message)) {
          appendLog('→ native-host\\install.ps1 を実行してホストを登録してください。');
        }
      }
      break;

    case 'candidates':
      if (msg.tabId === currentTabId) {
        renderCandidates(msg.list || [], false);
        renderPermission(msg.needsPermission || []);
      }
      break;

    case 'scan-result':
      if (msg.tabId === currentTabId) {
        renderCandidates(msg.list || [], true);
        renderPermission(msg.needsPermission || []);
        if (msg.error) appendLog('[scan] ' + msg.error);
        else if (msg.scanned > 0) appendLog('スキャン: ' + msg.scanned + ' 件の URL を確認');
        else if (msg.scanned === 0) appendLog('スキャン: 候補が見つかりませんでした（再生してから再スキャンしてください）');
      }
      break;

    case 'defaults':
      if (!$('outDir').value.trim() && msg.outDir) {
        $('outDir').value = msg.outDir;
        saveSettings();
      }
      break;

    case 'ffmpeg-probe':
      if (msg.ok) setProbe('OK: ' + (msg.version || ''), 'ok');
      else setProbe('NG: ' + (msg.message || '起動できません'), 'ng');
      break;

    case 'started':
      if (msg.job) {
        lastOutput = msg.job.output;
        appendLog('$ ' + (msg.job.args || ''));
        appendLog('出力: ' + msg.job.output);
      }
      setState('変換中...', '');
      break;

    case 'progress':
    case 'job':
      renderJob(msg.job);
      break;

    case 'log':
      appendLog(msg.line);
      break;

    case 'info':
      appendLog(msg.message);
      break;

    case 'error':
      setState('エラー: ' + msg.message, 'err');
      appendLog('[error] ' + msg.message);
      job.active = false;
      updateButtons();
      break;

    case 'done':
      finish(msg.result || {});
      break;

    default:
      break;
  }
}

/* ---------------- 設定 ---------------- */
async function loadSettings() {
  let s = {};
  try { s = await chrome.storage.local.get(SETTING_KEYS); } catch (e) { s = {}; }
  if (s.ffmpegPath) $('ffmpegPath').value = s.ffmpegPath;
  if (s.outDir) $('outDir').value = s.outDir;
  if (s.outName) $('outName').value = s.outName;
  $('useCookies').checked = !!s.useCookies;
  if (s.referer) $('referer').value = s.referer;
  if (s.userAgent) $('userAgent').value = s.userAgent;
  if (s.baseUrl) $('baseUrl').value = s.baseUrl;
  if (s.lastUrl) $('url').value = s.lastUrl;
}

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      chrome.storage.local.set({
        ffmpegPath: $('ffmpegPath').value.trim(),
        outDir: $('outDir').value.trim(),
        outName: $('outName').value.trim(),
        useCookies: $('useCookies').checked,
        referer: $('referer').value.trim(),
        userAgent: $('userAgent').value.trim(),
        baseUrl: $('baseUrl').value.trim(),
        lastUrl: $('url').value.trim()
      });
    } catch (e) { /* ignore */ }
  }, 300);
}

/* ---------------- 画面操作 ---------------- */
function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchPane(btn.dataset.tab));
  });

  $('btnProbe').addEventListener('click', () => {
    setProbe('確認中...', '');
    send({ type: 'probe', ffmpegPath: $('ffmpegPath').value.trim() });
  });

  $('btnScan').addEventListener('click', () => {
    $('btnScan').disabled = true;
    setState('スキャン中...', '');
    send({ type: 'scan-page', tabId: currentTabId });
    setTimeout(() => { $('btnScan').disabled = false; }, 1500);
  });

  $('btnGrant').addEventListener('click', async () => {
    if (!needsPermission.length) return;

    const origins = needsPermission.slice();
    $('btnGrant').disabled = true;
    let granted = false;
    let error = '';

    try {
      granted = await chrome.permissions.request({ origins: origins });
    } catch (e) {
      error = (e && e.message) || String(e);
    }
    $('btnGrant').disabled = false;

    if (granted) {
      $('permText').textContent = '許可しました。再検証しています...';
      appendLog('許可: ' + origins.join(', '));
      send({ type: 'verify-pending', tabId: currentTabId });
    } else if (error) {
      $('permText').textContent = '許可ダイアログを開けませんでした: ' + error;
      appendLog('[grant] ' + error);
    } else {
      $('permText').textContent = '許可されませんでした（URLタブ / 貼り付けタブはそのまま使えます）';
      appendLog('許可されませんでした: ' + origins.join(', '));
    }
  });

  $('btnStart').addEventListener('click', start);
  $('btnCancel').addEventListener('click', () => send({ type: 'cancel' }));

  $('btnCopyId').addEventListener('click', async () => {
    const id = $('extId').value;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      $('copyResult').textContent = 'コピーしました: ' + id;
    } catch (e) {
      try {
        $('extId').select();
        document.execCommand('copy');
        $('copyResult').textContent = 'コピーしました: ' + id;
      } catch (e2) {
        $('copyResult').textContent = '手動で選択してコピーしてください';
      }
    }
  });

  $('btnOpen').addEventListener('click', () => {
    if (lastOutput) send({ type: 'open-folder', path: lastOutput });
  });

  $('candidates').addEventListener('change', () => {
    const url = $('candidates').value;
    if (!url) return;
    $('url').value = url;
    if (!$('outName').value.trim()) $('outName').value = suggestName(url);
    saveSettings();
  });

  ['ffmpegPath', 'outDir', 'outName', 'referer', 'userAgent', 'baseUrl'].forEach((id) => {
    $(id).addEventListener('input', saveSettings);
  });
  $('useCookies').addEventListener('change', async () => {
    if ($('useCookies').checked) {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ permissions: ['cookies'] });
      } catch (e) {
        granted = false;
      }
      if (!granted) {
        $('useCookies').checked = false;
        appendLog('Cookie の権限が許可されませんでした（この機能は任意です）');
      }
    }
    saveSettings();
  });
}

function switchPane(name) {
  activePane = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['auto', 'url', 'text'].forEach((n) => { $('pane-' + n).hidden = (n !== name); });
}

function requestCandidates() {
  send({ type: 'get-candidates', tabId: currentTabId });
  if (typeof currentTabId === 'number') {
    setState('スキャン中...', '');
    send({ type: 'scan-page', tabId: currentTabId });
  } else {
    setState('このページでは使用できません', 'err');
  }
}

function renderCandidates(list, preferNewest) {
  const sel = $('candidates');
  const previous = sel.value;
  sel.textContent = '';

  if (!list.length) {
    const o = document.createElement('option');
    o.textContent = '（まだ検出されていません）';
    o.value = '';
    sel.appendChild(o);
    return;
  }

  for (const item of list) {
    const o = document.createElement('option');
    o.value = item.url;

    let tag = '[未確認] ';
    let note = '内容を確認できていません（そのまま変換を試せます）';
    if (item.verify === 'ok') { tag = '[確認済] '; note = '応答の先頭が #EXTM3U であることを確認済み'; }
    else if (item.verify === 'assumed') { tag = '[URL] '; note = 'URL が .m3u8 形式'; }
    else if (item.verify === 'need-permission') { tag = '[未確認] '; note = '配信元へのアクセス許可が必要です'; }
    else if (item.verify === 'error') { tag = '[失敗] '; note = '取得に失敗しました（期限切れ・アクセス制限の可能性）'; }

    o.textContent = tag + shortUrl(item.url);
    o.title = note + '\n' + item.url;
    sel.appendChild(o);
  }

  // スキャン直後は最新（先頭）を選ぶ。それ以外は選択中のものを維持する
  const exists = list.some((i) => i.url === previous);
  sel.value = (preferNewest || !exists) ? list[0].url : previous;

  if ($('url').value !== sel.value) {
    $('url').value = sel.value;
    if (!$('outName').value.trim()) $('outName').value = suggestName(sel.value);
  }
}

/* 配信元の許可が必要なときにバナーを出す */
function renderPermission(origins) {
  needsPermission = Array.isArray(origins) ? origins : [];
  const banner = $('permBanner');
  if (!needsPermission.length) {
    banner.hidden = true;
    return;
  }
  const hosts = needsPermission.map((p) => String(p).replace(/^\w+:\/\//, '').replace(/\/\*$/, ''));
  $('permText').textContent = '配信元（' + hosts.join(', ') + '）へのアクセスを許可すると、拡張子なしプレイリストかどうかを自動判定できます。';
  banner.hidden = false;
}

/* ---------------- 開始 / 完了 ---------------- */
function start() {
  const ffmpegPath = $('ffmpegPath').value.trim();
  const outDir = $('outDir').value.trim();
  const rawName = $('outName').value.trim();
  let input = null;

  if (activePane === 'text') {
    const text = $('text').value.trim();
    if (text.indexOf('#EXTM3U') !== 0) {
      setState('m3u8 の中身（#EXTM3U ...）を貼り付けてください', 'err');
      return;
    }
    input = { kind: 'text', text: text, baseUrl: $('baseUrl').value.trim() };
  } else {
    const url = (activePane === 'auto' ? ($('candidates').value || $('url').value) : $('url').value).trim();
    if (!/^https?:\/\//i.test(url)) {
      setState('m3u8 の URL を特定できません。URL タブで直接指定してください。', 'err');
      return;
    }
    input = { kind: 'url', url: url };
    if (!rawName) $('outName').value = suggestName(url);
  }

  lastOutput = null;
  $('btnOpen').hidden = true;
  $('barFill').style.width = '0%';
  $('detailText').textContent = '';
  $('log').textContent = '';
  setState('開始しています...', '');
  $('btnStart').disabled = true;

  send({
    type: 'start',
    ffmpegPath: ffmpegPath,
    outDir: outDir,
    outName: rawName ? ensureMp4(rawName) : '',
    input: input,
    useCookies: $('useCookies').checked,
    referer: $('referer').value.trim(),
    userAgent: $('userAgent').value.trim()
  });
  saveSettings();
}

function finish(r) {
  job.active = false;
  updateButtons();

  if (r.cancelled) {
    setState('中止しました', '');
    $('barFill').style.width = '0%';
    return;
  }

  if (r.code === 0) {
    lastOutput = r.output || null;
    setState('完了', 'ok');
    $('barFill').style.width = '100%';
    $('detailText').textContent = [fmtSize(r.size), fmtDur(r.elapsedMs)].filter(Boolean).join(' · ');
    if (lastOutput) $('btnOpen').hidden = false;
    appendLog('完了: ' + (lastOutput || ''));
  } else {
    setState('失敗 (exit ' + r.code + ')', 'err');
    if (r.error) appendLog(r.error);
    if (r.detail) r.detail.forEach((l) => appendLog(l));
  }
}

function renderJob(j) {
  if (!j) return;
  job = j;

  if (typeof j.percent === 'number') {
    const p = Math.max(0, Math.min(100, j.percent));
    $('barFill').style.width = p.toFixed(1) + '%';
  }

  if (j.active) {
    setState('変換中...', '');
    const parts = [];
    if (j.durationMs) parts.push(fmtDur(j.outTimeMs) + ' / ' + fmtDur(j.durationMs));
    if (j.speed) parts.push(j.speed);
    if (j.size) parts.push(fmtSize(j.size));
    $('detailText').textContent = parts.join(' · ');
  }

  updateButtons();
}

function updateButtons() {
  $('btnStart').disabled = !!job.active;
  $('btnCancel').disabled = !job.active;
}

/* ---------------- 表示ヘルパー ---------------- */
function setState(text, cls) {
  const el = $('stateText');
  el.textContent = text;
  el.className = cls || '';
}

function setHost(status, message) {
  const dot = $('hostDot');
  dot.className = 'dot';

  const labels = {
    ready: 'ホスト準備完了',
    connecting: '接続中...',
    disconnected: '未接続',
    unknown: '未接続',
    error: '接続エラー'
  };

  if (status === 'ready') dot.classList.add('ready');
  else if (status === 'connecting') dot.classList.add('connecting');
  else if (status === 'error') dot.classList.add('error');

  $('hostText').textContent = labels[status] || status;
  $('hostText').title = message || '';
}

function setProbe(text, cls) {
  const el = $('probeResult');
  el.textContent = text;
  el.className = 'hint ' + (cls || '');
}

function appendLog(line) {
  const el = $('log');
  const text = String(line == null ? '' : line);
  if (!text) return;

  const lines = el.textContent ? el.textContent.split('\n') : [];
  lines.push(text);
  while (lines.length > 200) lines.shift();
  el.textContent = lines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

function ensureMp4(name) {
  return /\.mp4$/i.test(name) ? name : name + '.mp4';
}

function suggestName(url) {
  let base = 'video';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    base = last.replace(/\.m3u8$/i, '') || 'video';
  } catch (e) { /* ignore */ }

  base = base.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const d = new Date();
  const stamp = '' + d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  return base + '_' + stamp + '.mp4';
}

function shortUrl(url) {
  const s = String(url);
  return s.length > 64 ? s.slice(0, 31) + '…' + s.slice(-31) : s;
}
