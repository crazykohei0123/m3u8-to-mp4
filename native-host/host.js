#!/usr/bin/env node
/*
 * m3u8 -> MP4 ネイティブメッセージングホスト
 *
 * Chrome 拡張 <-> このプロセス は stdio で通信する:
 *   メッセージ = [4バイト リトルエンディアン長][UTF-8 の JSON]
 *
 * ネットワーク取得・復号・コンテナ変換はすべて ffmpeg プロセスが行うため、
 * ブラウザの CORS 制約は一切関係しない。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'm3u8-to-mp4');
const ERR_LOG_KEEP = 40; // 失敗時にUIへ返す stderr 行数
const MAX_LOG_LINE = 400;

let rxBuf = Buffer.alloc(0);
let bomChecked = false;
const jobs = new Map();

/* ------------------------------------------------------------------ */
/* ホスト -> Chrome                                                    */
/* ------------------------------------------------------------------ */
function send(msg) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(msg), 'utf8');
  } catch (e) {
    payload = Buffer.from(JSON.stringify({ type: 'error', message: 'JSON化に失敗: ' + e.message }), 'utf8');
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  try {
    process.stdout.write(Buffer.concat([head, payload]));
  } catch (e) {
    // Chrome 側が既に閉じている
  }
}

function fail(id, message, extra) {
  send(Object.assign({ type: 'error', id: id || null, message: String(message) }, extra || {}));
}

/* ------------------------------------------------------------------ */
/* Chrome -> ホスト                                                    */
/* ------------------------------------------------------------------ */
process.stdin.on('data', (chunk) => {
  // .NET 製ランチャ経由だと先頭に UTF-8 BOM が付くことがあるので読み飛ばす
  if (!bomChecked) {
    bomChecked = true;
    if (chunk.length >= 3 && chunk[0] === 0xEF && chunk[1] === 0xBB && chunk[2] === 0xBF) {
      chunk = chunk.subarray(3);
    }
  }

  rxBuf = Buffer.concat([rxBuf, chunk]);
  for (;;) {
    if (rxBuf.length < 4) return;
    const len = rxBuf.readUInt32LE(0);
    if (len === 0 || len > 64 * 1024 * 1024) {
      fail(null, '不正なメッセージ長です: ' + len);
      rxBuf = Buffer.alloc(0);
      return;
    }
    if (rxBuf.length < 4 + len) return;
    const text = rxBuf.subarray(4, 4 + len).toString('utf8');
    rxBuf = rxBuf.subarray(4 + len);

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      fail(null, 'メッセージをJSONとして解釈できません: ' + e.message);
      continue;
    }
    try {
      handleMessage(msg);
    } catch (e) {
      fail(msg && msg.id, (e && e.message) || String(e));
    }
  }
});

process.stdin.on('end', () => {
  // 拡張側が切断したら実行中ジョブを止めて終了する
  for (const job of jobs.values()) killQuietly(job.child);
  setTimeout(() => process.exit(0), 120);
});
process.stdin.on('error', () => process.exit(0));

/* ------------------------------------------------------------------ */
/* コマンド                                                            */
/* ------------------------------------------------------------------ */
function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ping':
      return send({
        type: 'pong',
        id: msg.id || null,
        host: 'm3u8-to-mp4',
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        tmpDir: TMP_DIR
      });
    case 'defaults':
      return send({
        type: 'defaults',
        id: msg.id || null,
        homedir: os.homedir(),
        outDir: defaultOutDir(),
        platform: process.platform
      });
    case 'probe-ffmpeg':
      return probeFfmpeg(msg);
    case 'start':
      return startJob(msg);
    case 'cancel':
      return cancelJob(msg);
    case 'open-folder':
      return openFolder(msg);
    default:
      return fail(msg.id, '不明なコマンドです: ' + msg.type);
  }
}

/* ffmpeg の存在確認 (`ffmpeg -version`) */
function probeFfmpeg(msg) {
  const exe = String((msg && msg.ffmpegPath) || '').trim() || 'ffmpeg';
  const id = (msg && msg.id) || null;
  const child = spawn(exe, ['-hide_banner', '-version'], { windowsHide: true });
  let out = '';
  let settled = false;

  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('error', (e) => {
    if (settled) return;
    settled = true;
    send({ type: 'ffmpeg-probe', id, ok: false, exe, message: 'ffmpegを起動できません: ' + e.message });
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    const firstLine = (out.split(/\r?\n/)[0] || '').trim();
    send({
      type: 'ffmpeg-probe',
      id,
      ok: code === 0,
      exe,
      code,
      version: firstLine,
      message: code === 0 ? '' : out.slice(-500)
    });
  });
}

/* ------------------------------------------------------------------ */
/* 変換ジョブ                                                          */
/* ------------------------------------------------------------------ */
function startJob(msg) {
  const id = msg.id || 'job-' + Date.now();

  if (jobs.has(id)) {
    fail(id, '同じIDのジョブが既に実行中です');
    return;
  }

  const ffmpegPath = String(msg.ffmpegPath || '').trim() || 'ffmpeg';
  const outDir = String(msg.outDir || '').trim() || defaultOutDir();
  const outName = ensureMp4Ext(String(msg.outName || '').trim() || defaultOutName());
  const output = path.join(outDir, outName);

  let resolved;
  try {
    resolved = resolveInput(id, msg.input || {});
  } catch (e) {
    fail(id, e.message);
    return;
  }

  const args = buildArgs({
    input: resolved.arg,
    output: output,
    forceHls: !!resolved.forceHls,
    referer: trimOrEmpty(msg.referer),
    userAgent: trimOrEmpty(msg.userAgent),
    cookies: trimOrEmpty(msg.cookies)
  });

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    cleanupTempFile(resolved.tempFile);
    fail(id, '出力フォルダを作成できません: ' + outDir + ' / ' + e.message);
    return;
  }

  send({ type: 'started', id: id, output: output, ffmpegPath: ffmpegPath, args: previewArgs(args) });

  let child;
  try {
    child = spawn(ffmpegPath, args, { windowsHide: true });
  } catch (e) {
    cleanupTempFile(resolved.tempFile);
    fail(id, 'ffmpegを起動できません: ' + ffmpegPath + ' / ' + e.message);
    return;
  }

  const job = {
    id: id,
    child: child,
    output: output,
    tempFile: resolved.tempFile,
    durationMs: 0,
    errLines: [],
    startedAt: Date.now(),
    cancelled: false,
    failed: false,
    progress: {}
  };
  jobs.set(id, job);

  attachProgressHandlers(job);
  attachExitHandlers(job, ffmpegPath);
}

function attachProgressHandlers(job) {
  let outBuf = '';
  job.child.stdout.setEncoding('utf8');
  job.child.stdout.on('data', (chunk) => {
    outBuf += chunk;
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      job.progress[key] = value;
      if (key === 'progress') emitProgress(job, value === 'end');
    }
  });

  let errBuf = '';
  job.child.stderr.setEncoding('utf8');
  job.child.stderr.on('data', (chunk) => {
    errBuf += chunk;
    let idx;
    while ((idx = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, idx).replace(/\r$/, '');
      errBuf = errBuf.slice(idx + 1);
      handleStderrLine(job, line);
    }
  });
}

function emitProgress(job, ended) {
  const p = job.progress;
  const outUs = Number(p.out_time_us || p.out_time_ms || 0);
  const outTimeMs = Math.round(outUs / 1000);
  let percent = null;
  if (job.durationMs > 0) {
    percent = Math.max(0, Math.min(100, (outTimeMs / job.durationMs) * 100));
  }
  send({
    type: 'progress',
    id: job.id,
    percent: percent,
    outTimeMs: outTimeMs,
    durationMs: job.durationMs,
    speed: p.speed || null,
    size: Number(p.total_size || 0),
    frame: p.frame ? Number(p.frame) : null,
    ended: !!ended
  });
}

function handleStderrLine(job, line) {
  const t = line.trim();
  if (!t) return;

  if (!job.durationMs) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
    if (m) {
      const ms = ((Number(m[1]) * 3600) + (Number(m[2]) * 60) + parseFloat(m[3])) * 1000;
      if (ms > 0) {
        job.durationMs = ms;
        send({ type: 'duration', id: job.id, durationMs: ms });
      }
    }
  }

  job.errLines.push(t.slice(0, MAX_LOG_LINE));
  if (job.errLines.length > ERR_LOG_KEEP) job.errLines.shift();

  // 進捗の定例行はUIに流さない
  if (/^(frame=|fps=|size=|bitrate=|total_size=|out_time)/.test(t)) return;
  send({ type: 'log', id: job.id, line: t.slice(0, MAX_LOG_LINE) });
}

function attachExitHandlers(job, ffmpegPath) {
  job.child.on('error', (e) => {
    if (job.failed) return;
    job.failed = true;
    jobs.delete(job.id);
    cleanupTempFile(job.tempFile);
    fail(job.id,
      'ffmpeg を起動できません（設定のパスを確認してください）: ' + ffmpegPath + ' / ' + e.message,
      { kind: 'spawn' });
  });

  job.child.on('close', (code, signal) => {
    if (job.failed) return;
    job.failed = true;
    jobs.delete(job.id);
    cleanupTempFile(job.tempFile);

    const elapsedMs = Date.now() - job.startedAt;

    if (job.cancelled) {
      send({ type: 'done', id: job.id, code: code, signal: signal, cancelled: true,
             output: job.output, elapsedMs: elapsedMs });
      return;
    }
    if (code === 0) {
      send({ type: 'done', id: job.id, code: 0, output: job.output,
             elapsedMs: elapsedMs, size: fileSize(job.output) });
    } else {
      send({ type: 'done', id: job.id, code: code, signal: signal, output: job.output,
             elapsedMs: elapsedMs,
             error: 'ffmpeg が異常終了しました (exit ' + code + (signal ? ', ' + signal : '') + ')',
             detail: job.errLines.slice(-15) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* 入力の解決                                                          */
/* ------------------------------------------------------------------ */
function resolveInput(id, input) {
  const kind = input.kind || 'url';

  if (kind === 'url') {
    const url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL は http:// または https:// で始まる必要があります');
    // ffmpeg は .m3u8 拡張子 / mpegurl な Content-Type でしか HLS を自動判定しないため、
    // 拡張子なしのURL（例: /channel_post_movies/982/streaming）は -f hls を強制する
    return { arg: url, forceHls: !/\.m3u8(\?|#|$)/i.test(url) };
  }

  if (kind === 'file') {
    const file = String(input.file || '').trim();
    if (!file) throw new Error('m3u8 ファイルのパスが空です');
    if (!fs.existsSync(file)) throw new Error('m3u8 ファイルが見つかりません: ' + file);
    return { arg: file };
  }

  if (kind === 'text') {
    const text = String(input.text || '').trim();
    if (text.indexOf('#EXTM3U') !== 0) {
      throw new Error('貼り付けた内容が m3u8（#EXTM3U で始まる）ではありません');
    }
    const body = absolutize(text, String(input.baseUrl || '').trim());
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const tmp = path.join(TMP_DIR, String(id).replace(/[^\w.-]/g, '_') + '.m3u8');
    fs.writeFileSync(tmp, body, 'utf8');
    return { arg: tmp, tempFile: tmp };
  }

  throw new Error('未知の入力種別です: ' + kind);
}

/* 相対パスのセグメント/鍵URIを base を基準に絶対パス/URLへ変換する
   ※ Windows の ffmpeg は file:///C:/... 形式を開けないため、
     ローカルの base は C:/... 形式へ変換する。 */
function absolutize(text, base) {
  if (!base) return text;

  const localDir = toLocalDir(base);
  const urlDir = localDir ? null : toUrlDir(base);
  if (!localDir && !urlDir) return text;

  const resolve = (raw) => {
    const v = String(raw).trim();
    if (!v) return null;
    return localDir ? resolveLocal(localDir, v) : safeUrl(v, urlDir);
  };

  const lines = text.split(/\r?\n/);

  return lines.map((line) => {
    const t = line.trim();
    if (!t) return line;

    if (t.charAt(0) === '#') {
      return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return whole;
        if (/^[a-zA-Z]:[\\/]/.test(uri)) return whole;
        const abs = resolve(uri);
        return abs ? 'URI="' + abs + '"' : whole;
      });
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return line;
    if (/^[a-zA-Z]:[\\/]/.test(t)) return t.replace(/\\/g, '/');

    const abs = resolve(t);
    return abs || line;
  }).join('\n');
}

/* "file:///C:/x/y/" や "C:\\x\\y" を "C:/x/y/" へ（ローカルでなければ null） */
function toLocalDir(base) {
  let p = String(base).trim();
  if (!p) return null;

  if (/^file:/i.test(p)) {
    p = p.replace(/^file:(\/\/)?/i, '');
    try { p = decodeURIComponent(p); } catch (e) { /* ignore */ }
    p = p.replace(/^\/([a-zA-Z]:)/, '$1');
  } else if (!/^[a-zA-Z]:[\\/]/.test(p) && p.indexOf('\\\\') !== 0) {
    return null;
  }

  p = p.replace(/\\/g, '/');
  return withTrailingSlash(dirPart(p));
}

/* ディレクトリ末尾を保証（最後の要素が拡張子付きならファイル名とみなして落とす） */
function dirPart(p) {
  const last = p.split('/').pop() || '';
  if (last && last.indexOf('.') >= 0) return p.replace(/[^/]*$/, '');
  return p + (p.charAt(p.length - 1) === '/' ? '' : '/');
}

function withTrailingSlash(p) {
  return p.charAt(p.length - 1) === '/' ? p : p + '/';
}

function toUrlDir(base) {
  const b = String(base).trim();
  if (!/^https?:\/\//i.test(b)) return null;
  try {
    const u = new URL(b);
    if (/\/$/.test(u.pathname)) return u.href;
    const last = u.pathname.split('/').pop() || '';
    if (last.indexOf('.') >= 0) {
      u.pathname = u.pathname.replace(/[^/]*$/, '');
    } else {
      u.pathname = u.pathname + '/';
    }
    return u.href;
  } catch (e) {
    return null;
  }
}

function resolveLocal(dir, rel) {
  try {
    const clean = String(rel).replace(/\\/g, '/').split('?')[0].split('#')[0];
    return path.posix.normalize(dir + clean);
  } catch (e) {
    return null;
  }
}

function safeUrl(rel, dirBase) {
  try {
    return new URL(rel, dirBase).href;
  } catch (e) {
    return null;
  }
}

function buildArgs(o) {
  const args = [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-loglevel', 'info',
    '-stats_period', '0.5',
    '-progress', 'pipe:1',
    '-nostats',
    '-protocol_whitelist', 'file,http,https,tcp,tls'
  ];

  const headers = [];
  if (o.referer) headers.push('Referer: ' + o.referer);
  if (headers.length) args.push('-headers', headers.join('\r\n') + '\r\n');
  if (o.userAgent) args.push('-user_agent', o.userAgent);
  if (o.cookies) args.push('-cookies', o.cookies);

  // 拡張子なし + text/plain のプレイリストは ffmpeg が自動判定できないので明示する
  if (o.forceHls) args.push('-f', 'hls');

  args.push('-i', o.input);
  args.push('-c', 'copy');
  args.push('-movflags', '+faststart');
  args.push(o.output);
  return args;
}

function previewArgs(args) {
  return args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ');
}


/* ------------------------------------------------------------------ */
/* キャンセル / フォルダを開く                                          */
/* ------------------------------------------------------------------ */
function cancelJob(msg) {
  const id = (msg && msg.id) || null;
  const job = id ? jobs.get(id) : Array.from(jobs.values())[0];

  if (!job) {
    send({ type: 'cancelled', id: id, message: '実行中のジョブはありません' });
    return;
  }
  job.cancelled = true;
  killQuietly(job.child);
  send({ type: 'cancelling', id: job.id });
}

function openFolder(msg) {
  const target = String((msg && msg.path) || '').trim();
  if (!target) {
    fail(msg && msg.id, 'パスが空です');
    return;
  }
  try {
    let isFile = false;
    try { isFile = fs.statSync(target).isFile(); } catch (e) { isFile = false; }

    if (isFile) {
      spawn('explorer.exe', ['/select,' + target], { detached: true, windowsHide: true }).unref();
    } else {
      const dir = fs.existsSync(target) ? target : path.dirname(target);
      spawn('explorer.exe', [dir], { detached: true, windowsHide: true }).unref();
    }
    send({ type: 'folder-opened', id: (msg && msg.id) || null, path: target });
  } catch (e) {
    fail(msg && msg.id, 'エクスプローラーを開けません: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                      */
/* ------------------------------------------------------------------ */
function killQuietly(child) {
  if (!child) return;
  try {
    child.kill('SIGKILL');
  } catch (e) {
    try { child.kill(); } catch (e2) { /* ignore */ }
  }
}

function cleanupTempFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
}

function ensureMp4Ext(name) {
  return /\.mp4$/i.test(name) ? name : name + '.mp4';
}

function defaultOutDir() {
  return path.join(os.homedir(), 'Videos', 'm3u8');
}

function defaultOutName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return 'video_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.mp4';
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return 0; }
}

/* ヘッダ injection 対策として改行を潰す */
function trimOrEmpty(v) {
  return String(v || '').replace(/[\r\n]+/g, ' ').trim();
}
