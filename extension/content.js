/*
 * ISOLATED world のブリッジ（content script）
 *
 *  - MAIN world のフックからの window.postMessage を拡張へ転送する
 *  - Worker 経由などで取得された場合に備え、パフォーマンスタイムラインの
 *    候補URLを送る（判定は service worker 側で応答本文を見て行う）
 */
(function () {
  'use strict';

  var TAG = 'm3u8-to-mp4';
  var HINT = /(m3u8|playlist|manifest|streaming|hls|master)/i;
  var MEDIA = /\.(ts|m4s|mp4|m4a|mp3|aac|vtt|key|jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|map)(\?|#|$)/i;
  var sent = {};

  function post(payload) {
    try {
      chrome.runtime.sendMessage(payload, function () {
        // 受信側が応答しない場合の lastError を握りつぶす
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 拡張コンテキストが無効 */ }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.source !== TAG || d.type !== 'playlist') return;
    if (typeof d.url !== 'string' || !/^https?:/i.test(d.url)) return;
    if (sent[d.url]) return;
    sent[d.url] = true;
    post({ type: 'page-playlist', url: d.url });
  }, false);

  function scanPerformance() {
    try {
      var out = [];
      var entries = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < entries.length && out.length < 12; i++) {
        var name = entries[i].name;
        if (!name || sent[name]) continue;
        if (!/^https?:/i.test(name)) continue;
        if (MEDIA.test(name)) continue;
        if (!HINT.test(name)) continue;
        sent[name] = true;
        out.push(name);
      }
      if (out.length) post({ type: 'page-hints', urls: out });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanPerformance, false);
  } else {
    scanPerformance();
  }
  setTimeout(scanPerformance, 2000);
  setTimeout(scanPerformance, 6000);
})();
