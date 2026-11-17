/*
 * MAIN world で動く検出フック（ページのJSより先に評価される）
 *
 * hls.js などは m3u8 を XHR / fetch で取得する。URL に .m3u8 が無くても
 * 応答本文が "#EXTM3U" で始まっていればプレイリストと判定できる。
 * 取得済みのレスポンスを読むだけなので、追加の通信は発生しない。
 */
(function () {
  'use strict';

  if (window.__m3u8mp4hooked) return;
  window.__m3u8mp4hooked = true;

  var TAG = 'm3u8-to-mp4';
  var MEDIA = /\.(ts|m4s|mp4|m4a|mp3|aac|vtt|key|jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|map)(\?|#|$)/i;

  function absolute(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch (e) {
      return null;
    }
  }

  function report(url) {
    if (!url) return;
    try {
      window.postMessage({ source: TAG, type: 'playlist', url: String(url) }, '*');
    } catch (e) { /* ignore */ }
  }

  function looksLikePlaylist(text) {
    if (typeof text !== 'string' || text.length < 7) return false;
    var head = text.charAt(0) === '\uFEFF' ? text.slice(1) : text;
    head = head.replace(/^\s+/, '');
    return head.indexOf('#EXTM3U') === 0;
  }

  /* ---------------- XMLHttpRequest ---------------- */
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__m3u8mp4) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__m3u8mp4url = absolute(url);
      } catch (e) {
        this.__m3u8mp4url = null;
      }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      var self = this;
      var url = self.__m3u8mp4url;

      if (url && !MEDIA.test(url)) {
        self.addEventListener('load', function () {
          try {
            var type = self.responseType;
            // arraybuffer/blob はセグメント等なので読まない
            if (type && type !== 'text') return;
            if (looksLikePlaylist(self.responseText)) {
              report(self.responseURL || url);
            }
          } catch (e) { /* ignore */ }
        });
      }
      return origSend.apply(this, arguments);
    };

    XHR.prototype.__m3u8mp4 = true;
  }

  /* ---------------- fetch ---------------- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function' && !origFetch.__m3u8mp4) {
    var wrapped = function (input) {
      var p = origFetch.apply(this, arguments);
      try {
        var raw = typeof input === 'string' ? input : (input && input.url) || '';
        var url = raw ? absolute(raw) : null;

        if (url && !MEDIA.test(url)) {
          p.then(function (res) {
            try {
              var ct = (res.headers.get('content-type') || '').toLowerCase();
              if (/json|javascript|image\/|font\/|text\/html/.test(ct)) return;

              var cl = Number(res.headers.get('content-length') || 0);
              if (cl > 262144) return;

              res.clone().text().then(function (text) {
                if (looksLikePlaylist(text)) report(res.url || url);
              }).catch(function () { /* ignore */ });
            } catch (e) { /* ignore */ }
          }).catch(function () { /* ignore */ });
        }
      } catch (e) { /* ignore */ }

      return p;
    };
    wrapped.__m3u8mp4 = true;
    window.fetch = wrapped;
  }
})();
