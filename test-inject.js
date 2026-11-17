'use strict';
/*
 * inject.js (MAIN world) と content.js (ISOLATED) のロジックを
 * Node の vm で擬似ブラウザ環境に読み込んで検証する。
 *   使い方: node test-inject.js
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const injectSrc = fs.readFileSync(path.join(root, 'extension', 'inject.js'), 'utf8');
const contentSrc = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('  PASS ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

function FakeXHRClass() {
  class FakeXHR {
    constructor() {
      this._listeners = {};
      this.responseType = '';
      this.responseText = '';
      this.responseURL = '';
    }
    open(method, url) { this._url = url; }
    send() { /* no-op */ }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    emit(type) { (this._listeners[type] || []).forEach((fn) => fn.call(this)); }
  }
  return FakeXHR;
}

function fakeResponse(text, contentType, url) {
  return {
    ok: true,
    url: url,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    clone() { return { text: () => Promise.resolve(text) }; }
  };
}

function makeInjectEnv(fetchImpl) {
  const posted = [];
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.location = { href: 'https://cityheaven-tv.knip.jp/channels/d_melonplus/channel_posts/994' };
  sandbox.postMessage = (m) => posted.push(m);
  sandbox.XMLHttpRequest = FakeXHRClass();
  sandbox.fetch = fetchImpl || (() => Promise.reject(new Error('not stubbed')));
  sandbox.URL = URL;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(injectSrc, ctx);
  return { sandbox: sandbox, posted: posted, ctx: ctx };
}

function makeContentEnv(resourceEntries) {
  const sent = [];
  const listeners = [];
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
  sandbox.document = { readyState: 'complete', addEventListener: () => {} };
  sandbox.performance = { getEntriesByType: () => resourceEntries || [] };
  sandbox.setTimeout = () => 0;
  sandbox.console = console;
  sandbox.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => { sent.push(msg); if (cb) cb(); }
    }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(contentSrc, ctx);
  const ctxWindow = vm.runInContext('window', ctx);

  return {
    sent: sent,
    dispatch: (data, source) => listeners.forEach((fn) => fn({ data: data, source: source === undefined ? ctxWindow : source }))
  };
}

async function main() {
  console.log('== inject.js / content.js test ==');

  /* 1. XHR: 拡張子なしURL + 本文が #EXTM3U */
  const env1 = makeInjectEnv();
  const x1 = new env1.sandbox.XMLHttpRequest();
  x1.open('GET', '/channel_post_movies/982/streaming');
  x1.responseType = '';
  x1.responseText = '#EXTM3U\n#EXT-X-VERSION:5\n';
  x1.send();
  x1.emit('load');
  check('XHR(拡張子なし)を検出',
    env1.posted.length === 1 && /\/channel_post_movies\/982\/streaming$/.test(env1.posted[0].url),
    env1.posted.length ? env1.posted[0].url : 'no message');

  /* 2. XHR: セグメント(arraybuffer)は無視 */
  const x2 = new env1.sandbox.XMLHttpRequest();
  x2.open('GET', 'https://v2-storage.example.com/a/out_00001.ts');
  x2.send();
  x2.responseType = 'arraybuffer';
  x2.responseText = '#EXTM3U';
  x2.emit('load');
  check('XHR(セグメント)は無視', env1.posted.length === 1);

  /* 3. XHR: プレイリストでない本文は無視 */
  const x3 = new env1.sandbox.XMLHttpRequest();
  x3.open('GET', 'https://api.example.com/channel_post_movies/1/streaming');
  x3.responseText = '{"foo":1}';
  x3.send();
  x3.emit('load');
  check('XHR(非プレイリスト)は無視', env1.posted.length === 1);

  /* 4. fetch: text/plain の #EXTM3U を検出 */
  const env2 = makeInjectEnv(async () => fakeResponse('#EXTM3U\n#EXTINF:8,\n',
    'text/plain; charset=utf-8', 'https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming'));
  await env2.sandbox.fetch('/channel_post_movies/982/streaming');
  await new Promise((r) => setTimeout(r, 20));
  check('fetch(text/plain)を検出',
    env2.posted.length === 1 && /\/982\/streaming$/.test(env2.posted[0].url),
    env2.posted.length ? env2.posted[0].url : 'no message');

  /* 5. fetch: JSON は無視 */
  const env3 = makeInjectEnv(async () => fakeResponse('{"a":1}', 'application/json',
    'https://api.example.com/channel_post_movies/1/streaming'));
  await env3.sandbox.fetch('/api/channel_post_movies/1/streaming');
  await new Promise((r) => setTimeout(r, 20));
  check('fetch(JSON)は無視', env3.posted.length === 0);

  /* 6. 二重注入しても1回のfetchにつき1回しか報告しない */
  const before = env2.posted.length;
  vm.runInContext(injectSrc, env2.ctx);
  await env2.sandbox.fetch('/channel_post_movies/982/streaming');
  await new Promise((r) => setTimeout(r, 20));
  check('二重フックしない（1回のfetchで1報告）', env2.posted.length - before === 1,
    'delta=' + (env2.posted.length - before));

  /* 7. content.js: MAIN world からのメッセージを転送 */
  const c1 = makeContentEnv();
  c1.dispatch({ source: 'm3u8-to-mp4', type: 'playlist', url: 'https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming' });
  check('content.js が page-playlist を送信',
    c1.sent.length === 1 && c1.sent[0].type === 'page-playlist',
    c1.sent.length ? c1.sent[0].url : 'no message');

  /* 8. content.js: 同一URLの重複を送らない */
  c1.dispatch({ source: 'm3u8-to-mp4', type: 'playlist', url: 'https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming' });
  check('content.js は重複を送らない', c1.sent.length === 1);

  /* 9. content.js: 別オリジン(window以外)からのメッセージは無視 */
  c1.dispatch({ source: 'm3u8-to-mp4', type: 'playlist', url: 'https://evil.example.com/x/streaming' }, {});
  check('外部からのメッセージを無視', c1.sent.length === 1);

  /* 10. content.js: パフォーマンスタイムラインから候補を送る */
  const c2 = makeContentEnv([
    { name: 'https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming' },
    { name: 'https://v2-storage.example.com/a/out_00001.ts' },
    { name: 'https://cdn.example.com/app.css' }
  ]);
  check('performance から page-hints を送信',
    c2.sent.length === 1 && c2.sent[0].type === 'page-hints',
    c2.sent.length ? JSON.stringify(c2.sent[0].urls) : 'no message');
  check('page-hints は .ts/.css を除外',
    c2.sent.length === 1 && c2.sent[0].urls.length === 1,
    c2.sent.length ? JSON.stringify(c2.sent[0].urls) : 'no message');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('TEST ERROR: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
