'use strict';
/*
 * host.js / m3u8host.exe の動作テスト
 *   使い方: node test-host.js           (node host.js を直接起動)
 *           node test-host.js --exe     (m3u8host.exe 経由 = ランチャ検証)
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USE_EXE = process.argv.includes('--exe');
const HOST_JS = path.join(__dirname, '..', 'host.js');
const HOST_EXE = path.join(__dirname, '..', 'm3u8host.exe');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  PASS ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function createClient(child) {
  let rx = Buffer.alloc(0);
  const queue = [];
  const waiters = [];

  child.stdout.on('data', (chunk) => {
    if (process.env.DEBUG_HOST_TEST) { console.error('RAW chunk ' + chunk.length); }
    try {
      rx = Buffer.concat([rx, chunk]);
      for (;;) {
        if (rx.length < 4) return;
        const len = rx.readUInt32LE(0);
        if (rx.length < 4 + len) return;
        let msg;
        try { msg = JSON.parse(rx.subarray(4, 4 + len).toString('utf8')); } catch (e) { msg = { type: 'parse-error' }; }
        rx = rx.subarray(4 + len);
        if (waiters.length) waiters.shift()(msg);
        else queue.push(msg);
      }
    } catch (e) {
      console.error('parse error: ' + e.message);
    }
  });

  child.stderr.on('data', (d) => { process.stderr.write('[host stderr] ' + d); });

  return {
    send(obj) {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(payload.length, 0);
      child.stdin.write(Buffer.concat([head, payload]));
    },
    next(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs || 20000);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 60000);
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) throw new Error('waitFor timeout');
        const msg = await this.next(remain);
        if (predicate(msg)) return msg;
      }
    },
    close() { try { child.stdin.end(); } catch (e) { /* ignore */ } }
  };
}

async function main() {
  const cmd = USE_EXE ? HOST_EXE : process.execPath;
  const args = USE_EXE ? [] : [HOST_JS];
  if (USE_EXE && !fs.existsSync(HOST_EXE)) {
    console.error('m3u8host.exe not found. Build it with csc or install.ps1 first.');
    process.exit(2);
  }

  console.log('== host test (' + (USE_EXE ? 'm3u8host.exe' : 'node host.js') + ') ==');
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = createClient(child);
  if (process.env.DEBUG_HOST_TEST) {
    child.stdout.on('data', (d) => console.error('RAW stdout ' + d.length));
    child.on('exit', (c, s) => console.error('child exit ' + c + '/' + s));
  }

  /* 1. ping */
  client.send({ type: 'ping', id: 'p1' });
  const pong = await client.waitFor((m) => m.type === 'pong');
  check('ping -> pong', !!pong.node, 'node ' + pong.node);

  /* 2. defaults */
  client.send({ type: 'defaults', id: 'd1' });
  const defs = await client.waitFor((m) => m.type === 'defaults');
  check('defaults', typeof defs.outDir === 'string' && defs.outDir.length > 0, defs.outDir);

  /* 3. ffmpeg probe */
  client.send({ type: 'probe-ffmpeg', id: 'f1', ffmpegPath: 'ffmpeg' });
  const probe = await client.waitFor((m) => m.type === 'ffmpeg-probe');
  check('probe-ffmpeg', probe.ok === true, probe.version || probe.message);

  if (process.argv.includes('--quick')) {
    client.close();
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    console.log(failures === 0 ? '\nQUICK OK' : '\n' + failures + ' FAILED');
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  /* 4. テスト用 HLS を生成 */
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8test-'));
  const srcDir = path.join(workDir, 'src');
  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(srcDir);
  const playlist = path.join(srcDir, 'playlist.m3u8');

  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(srcDir, 'seg%03d.ts'),
    playlist
  ], { stdio: 'inherit' });
  check('generate test HLS', fs.existsSync(playlist));

  /* 5. kind:'file' で変換 */
  let sawPercent = false;
  client.send({
    type: 'start', id: 'job-file', ffmpegPath: 'ffmpeg', outDir: outDir,
    outName: 'from-file.mp4', input: { kind: 'file', file: playlist }
  });
  const started1 = await client.waitFor((m) => m.type === 'started' && m.id === 'job-file');
  const done1 = await client.waitFor((m) => {
    if (m.type === 'progress' && typeof m.percent === 'number') sawPercent = true;
    return m.type === 'done' && m.id === 'job-file';
  }, 120000);
  check('convert (file input)', done1.code === 0, 'exit=' + done1.code + ' ' + (done1.error || ''));
  check('progress percent computed', sawPercent, started1.output);

  const out1 = path.join(outDir, 'from-file.mp4');
  check('output file created', fs.existsSync(out1));

  if (fs.existsSync(out1)) {
    const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', out1]).toString().trim();
    check('output duration ~6s', Math.abs(parseFloat(dur) - 6.0) < 1.0, dur + 's');
  }

  /* 6. kind:'text' + 相対パス解決 */
  const text = fs.readFileSync(playlist, 'utf8');
  const baseUrl = 'file:///' + srcDir.replace(/\\/g, '/') + '/';
  client.send({
    type: 'start', id: 'job-text', ffmpegPath: 'ffmpeg', outDir: outDir,
    outName: 'from-text.mp4', input: { kind: 'text', text: text, baseUrl: baseUrl }
  });
  await client.waitFor((m) => m.type === 'started' && m.id === 'job-text');
  const done2 = await client.waitFor((m) => m.type === 'done' && m.id === 'job-text', 120000);
  check('convert (text input + relative URI)', done2.code === 0, 'exit=' + done2.code + ' ' + (done2.error || ''));
  check('text input output', fs.existsSync(path.join(outDir, 'from-text.mp4')));

  /* 7. 不正入力のエラー処理 */
  client.send({ type: 'start', id: 'job-bad', ffmpegPath: 'ffmpeg', input: { kind: 'text', text: 'hello' } });
  const bad = await client.waitFor((m) => m.type === 'error' && m.id === 'job-bad');
  check('invalid input -> error', /#EXTM3U/.test(bad.message), bad.message);

  /* 8. 存在しないffmpegパス */
  client.send({
    type: 'start', id: 'job-nopath', ffmpegPath: 'C:\\no\\such\\ffmpeg.exe',
    outDir: outDir, outName: 'x.mp4', input: { kind: 'file', file: playlist }
  });
  const nopath = await client.waitFor((m) => m.type === 'error' && m.id === 'job-nopath', 30000);
  check('bad ffmpeg path -> error', !!nopath.message, nopath.message);

  /* 9. 拡張子なしURLには -f hls を付与する */
  client.send({
    type: 'start', id: 'job-force', ffmpegPath: 'ffmpeg', outDir: outDir, outName: 'force.mp4',
    input: { kind: 'url', url: 'http://127.0.0.1:1/channel_post_movies/1/streaming' }
  });
  const startedForce = await client.waitFor((m) => m.type === 'started' && m.id === 'job-force');
  check('extensionless URL gets -f hls', / -f hls -i /.test(startedForce.args), startedForce.args.slice(0, 160));

  /* 10. .m3u8 付きURLには -f hls を付けない */
  client.send({
    type: 'start', id: 'job-noforce', ffmpegPath: 'ffmpeg', outDir: outDir, outName: 'noforce.mp4',
    input: { kind: 'url', url: 'http://127.0.0.1:1/hls/master.m3u8' }
  });
  const startedNo = await client.waitFor((m) => m.type === 'started' && m.id === 'job-noforce');
  check('.m3u8 URL keeps auto-detect', !/ -f hls -i /.test(startedNo.args), startedNo.args.slice(0, 160));

  client.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('TEST ERROR: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
