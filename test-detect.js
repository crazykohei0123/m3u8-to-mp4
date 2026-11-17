'use strict';
/*
 * extension/lib/detect.js の純関数テスト
 *   使い方: node test-detect.js
 */
const D = require('./extension/lib/detect.js');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('  PASS ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

console.log('== lib/detect.js test ==');

/* isPlaylistUrl */
check('.m3u8 を検出', D.isPlaylistUrl('https://x/a/index.m3u8'));
check('.m3u8?query を検出', D.isPlaylistUrl('https://x/a/index.m3u8?token=1'));
check('format=m3u8 を検出', D.isPlaylistUrl('https://x/play?format=m3u8'));
check('拡張子なしは isPlaylistUrl では false', !D.isPlaylistUrl('https://x/channel_post_movies/982/streaming'));

/* isPlaylistHint */
check('拡張子なし streaming をヒントとして検出', D.isPlaylistHint('https://api.x/channel_post_movies/982/streaming'));
check('セグメント(.ts)は除外', !D.isPlaylistHint('https://v2.x/a/out_00001.ts'));
check('鍵ファイル(.keyfile)は除外', !D.isPlaylistHint('https://v2.x/uploads/6/video.keyfile?expires=1'));
check('JS/CSS は除外', !D.isPlaylistHint('https://x/app.js') && !D.isPlaylistHint('https://x/a.css'));
check('無関係なAPIは除外', !D.isPlaylistHint('https://x/api/users/982'));

/* originPattern */
check('originPattern(http)', D.originPattern('https://api.example.com/a/b?x=1') === 'https://api.example.com/*');
check('originPattern(ポート付き)', D.originPattern('http://127.0.0.1:8080/x') === 'http://127.0.0.1:8080/*');
check('originPattern(file) は null', D.originPattern('file:///C:/x') === null);

/* looksLikePlaylistText */
check('#EXTM3U を検出', D.looksLikePlaylistText('#EXTM3U\n#EXT-X-VERSION:5\n'));
check('BOM 付き #EXTM3U を検出', D.looksLikePlaylistText('\uFEFF#EXTM3U\n'));
check('先頭が空白でも検出', D.looksLikePlaylistText('\n  #EXTM3U\n'));
check('JSON は false', !D.looksLikePlaylistText('{"a":1}'));
check('#EXTM3U が途中なら false', !D.looksLikePlaylistText('xxx#EXTM3U'));

/* classify */
const urls = [
  'https://cityheaven-tv.knip.jp/page',
  'https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming',
  'https://v2-storage.example.com/a/out_00001.ts',
  'https://v2-storage.example.com/a/video.keyfile?expires=1',
  'https://cdn.example.com/app.js',
  'https://cdn.example.com/master.m3u8',
  'https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming',
  'ftp://example.com/x.m3u8'
];
const c = D.classify(urls, 40);
check('classify: .m3u8 候補', c.playlists.length === 1 && /master\.m3u8$/.test(c.playlists[0]), JSON.stringify(c.playlists));
check('classify: 要検証ヒント', c.hints.length === 1 && /982\/streaming$/.test(c.hints[0]), JSON.stringify(c.hints));
check('classify: 重複と非httpを除外', c.playlists.length + c.hints.length === 2);

const capped = D.classify(urls.concat(['https://a/x/streaming', 'https://b/x/streaming']), 2);
check('classify: 上限を守る', capped.playlists.length + capped.hints.length <= 2);

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exitCode = failures === 0 ? 0 : 1;
