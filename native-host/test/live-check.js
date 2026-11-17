/*
 * 実サイトでの簡易チェック（ホスト経由で開始→進捗が出たら中止）
 *   使い方: node test\live-check.js "https://example.com/path/to/streaming"
 * 先頭セグメント程度だけ取得して中止するので、大きなファイルは残りません。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = process.argv[2];
if (!URL_) {
  console.error('使い方: node test\\live-check.js "<m3u8 または プレイリストURL>"');
  process.exit(2);
}

const HOST = path.join(__dirname, '..', 'host.js');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });

let rx = Buffer.alloc(0);
const queue = [];
const waiters = [];

child.stdout.on('data', (chunk) => {
  rx = Buffer.concat([rx, chunk]);
  for (;;) {
    if (rx.length < 4) return;
    const len = rx.readUInt32LE(0);
    if (rx.length < 4 + len) return;
    const msg = JSON.parse(rx.subarray(4, 4 + len).toString('utf8'));
    rx = rx.subarray(4 + len);
    if (waiters.length) waiters.shift()(msg); else queue.push(msg);
  }
});

function send(obj) {
  const p = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32LE(p.length, 0);
  child.stdin.write(Buffer.concat([h, p]));
}

function next(t) {
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), t || 60000);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
}

(async () => {
  console.log('outDir = ' + outDir);
  send({ type: 'start', id: 'live', ffmpegPath: 'ffmpeg', outDir: outDir, outName: 'live.mp4',
    input: { kind: 'url', url: URL_ } });

  const started = await next();
  console.log('started: ' + JSON.stringify(started.args || started));

  const deadline = Date.now() + 45000;
  let progressed = false;
  while (Date.now() < deadline) {
    const m = await next(deadline - Date.now()).catch(() => null);
    if (!m) break;
    if (m.type === 'log') console.log('  log: ' + String(m.line).slice(0, 110));
    if (m.type === 'error') { console.log('  ERROR: ' + m.message); break; }
    if (m.type === 'done') { console.log('  DONE early: ' + JSON.stringify(m).slice(0, 200)); break; }
    if (m.type === 'progress' && m.outTimeMs > 0) {
      console.log('  progress: ' + (m.outTimeMs / 1000).toFixed(1) + 's, size=' + m.size);
      progressed = true;
      break;
    }
  }

  if (progressed) send({ type: 'cancel', id: 'live' });
  const fin = await next(30000).catch(() => null);
  console.log('finish: ' + JSON.stringify(fin).slice(0, 200));

  const f = path.join(outDir, 'live.mp4');
  const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  console.log('partial file size = ' + size);
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.rmdirSync(outDir);
  } catch (e) { /* ignore */ }
  console.log(progressed ? 'LIVE CHECK OK' : 'LIVE CHECK FAILED');

  try { child.stdin.end(); } catch (e) { /* ignore */ }
  setTimeout(() => {
    try { child.kill(); } catch (e) { /* ignore */ }
    process.exitCode = progressed ? 0 : 1;
  }, 300);
})().catch((e) => {
  console.error('ERROR ' + (e && e.message));
  try { child.kill(); } catch (e2) { /* ignore */ }
  process.exitCode = 1;
});
