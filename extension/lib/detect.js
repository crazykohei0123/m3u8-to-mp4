'use strict';
/**
 * 検出まわりの純関数（chrome API に依存しない）
 *  - service worker からは importScripts('lib/detect.js') で読み込み
 *  - Node のテストからは require() で読み込み
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.M3U8Detect = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var MEDIA_RE = /\.(ts|m4s|mp4|m4a|mp3|aac|vtt|key|jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|map)(\?|#|$)/i;
  var HINT_RE = /(m3u8|playlist|manifest|streaming|hls|master)/i;
  var PLAYLIST_RE = /\.m3u8(\?|#|$)/i;
  var PLAYLIST_QUERY_RE = /[?&](format|type|ext)=m3u8\b/i;

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  /* URL 自体がプレイリストだと分かるもの（拡張子・クエリ） */
  function isPlaylistUrl(url) {
    var u = String(url || '');
    return PLAYLIST_RE.test(u) || PLAYLIST_QUERY_RE.test(u);
  }

  /* 中身を見ないと分からないが、プレイリストの可能性が高いURL */
  function isPlaylistHint(url) {
    var u = String(url || '');
    if (!u || MEDIA_RE.test(u)) return false;
    return HINT_RE.test(u);
  }

  /* "https://host/path" -> "https://host/*" （chrome.permissions 用） */
  function originPattern(url) {
    try {
      var u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.protocol + '//' + u.host + '/*';
    } catch (e) {
      return null;
    }
  }

  /* 応答本文の先頭が #EXTM3U か（BOM・空白は許容） */
  function looksLikePlaylistText(text) {
    if (typeof text !== 'string' || !text) return false;
    var head = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    head = head.replace(/^\s+/, '');
    return head.indexOf('#EXTM3U') === 0;
  }

  /* スキャン結果を .m3u8候補 / 要検証ヒント に分類（重複除去・上限つき） */
  function classify(urls, limit) {
    var max = limit || 40;
    var playlists = [];
    var hints = [];
    var seen = {};
    var list = Array.isArray(urls) ? urls : [];

    for (var i = 0; i < list.length && (playlists.length + hints.length) < max; i++) {
      var u = list[i];
      if (typeof u !== 'string' || !isHttpUrl(u) || seen[u]) continue;
      seen[u] = true;
      if (isPlaylistUrl(u)) playlists.push(u);
      else if (isPlaylistHint(u)) hints.push(u);
    }
    return { playlists: playlists, hints: hints };
  }

  return {
    MEDIA_RE: MEDIA_RE,
    HINT_RE: HINT_RE,
    isHttpUrl: isHttpUrl,
    isPlaylistUrl: isPlaylistUrl,
    isPlaylistHint: isPlaylistHint,
    originPattern: originPattern,
    looksLikePlaylistText: looksLikePlaylistText,
    classify: classify
  };
});
