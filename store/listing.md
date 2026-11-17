# Chrome ウェブストア 掲載情報（コピペ用）

最終更新: 2026-11-17 / manifest version: 1.2.0

- 「プライバシーへの取り組み」タブの回答一式 → [`store/privacy-practices.md`](privacy-practices.md)

---

## 1. 短い説明（132文字以内）

```
ページ内のHLS(m3u8)を自動検出し、ローカルのffmpegでMP4に変換・保存します。再エンコードなしで高速、変換はすべて端末内で完結します。
```

- 文字数: **74文字**（上限132）
- 英語版（任意）: `Detects HLS (m3u8) playlists and converts them to MP4 with your local ffmpeg. All processing stays on your PC.`

---

## 2. 詳細説明

```
■ 概要
動画ページが読み込む HLS プレイリスト（m3u8）を検出し、お使いの PC にインストールされた
ffmpeg で MP4 に変換・保存します。動画データは端末内でのみ処理され、外部サーバーへは送信しません。

■ 特長
・URL に .m3u8 が無いプレイリストにも対応（応答本文の #EXTM3U で判定）
・再エンコードなし（-c copy）で高速・無劣化
・進捗・速度・サイズを表示し、完了後はボタン1つでフォルダを開けます
・AES-128 / SAMPLE-AES（MPEG-TS）の復号は ffmpeg に任せるため追加設定は不要
・DRM（Widevine / FairPlay など）には対応しません
・閲覧中のページを常時監視しません（アイコンを押したときだけ読み取ります）

■ 必要なもの（Windows のみ）
1. Node.js（LTS）
2. ffmpeg（PATH に通すか、設定画面で ffmpeg.exe のフルパスを指定）
3. ネイティブホスト（配布ページの install.ps1 を実行して登録）

■ セットアップ
1. この拡張をインストールします
2. 配布ページからホスト用ファイルをダウンロードし、install.ps1 を実行します
   （拡張IDは自動検出されます。検出できない場合のみ -ExtensionId で指定）
3. 拡張の「設定」で ffmpeg.exe のパスを入力し「確認」を押します

■ 使い方
1. 動画ページで再生を開始します
2. ツールバーのアイコンをクリックします（この操作でページの読み取りが許可されます）
3. 候補が表示されたら選んで「変換開始」を押します
   ・初回は「配信元へのアクセスを許可」が出ることがあります。許可すると、
     拡張子なしプレイリストかどうかを自動判定できます（許可しなくても変換は可能）
   ・URL が分かっている場合は「URL」タブに直接入力できます
   ・m3u8 の中身を持っている場合は「貼り付け」タブが使えます

■ プライバシー
設定は端末内（chrome.storage.local）にのみ保存されます。解析・広告・外部送信はありません。
Cookie の引き継ぎは既定でOFFです。ONにした場合も、そのサイトのCookieを端末内の ffmpeg に
渡すだけで、どこにも送信しません。
詳細: https://crazykohei0123.github.io/m3u8-to-mp4/

■ ご注意
本拡張は、利用者が正当な視聴権を持つコンテンツの保存を目的としています。
各サイトの利用規約および著作権法を遵守してください。
```

---

## 3. 単一目的（Single purpose）

```
Detect HLS (m3u8) playlists on the current page and convert them to MP4 using the user's locally installed ffmpeg.
```

---

## 4. 権限の正当化（Permissions justification / 英語）

```
- activeTab:
  The page is read only when the user clicks the toolbar icon (one-shot). We collect
  candidate URLs from performance entries and the page HTML. No background monitoring.

- scripting:
  Used to run that one-shot collection in the clicked tab (chrome.scripting.executeScript).

- storage:
  Stores the user's settings locally (chrome.storage.local). No sync, no transmission.

- nativeMessaging:
  Starts the user's locally installed ffmpeg.exe through a small native host.
  No data leaves the device.

- optional: cookies (off by default, requested only when the user enables "pass cookies")
  Cookies of the current site are handed to the local ffmpeg process and never stored or
  transmitted anywhere else.

- optional: host permissions (requested only when the user clicks "allow media host")
  Playlist URLs without a .m3u8 extension and without an mpegurl content type can only be
  identified by reading the first 64 bytes of the response. We request only the specific
  origin(s) of the detected media host(s). Declining keeps manual URL/paste conversion
  fully functional. No page content or browsing history is collected or transmitted.
```

---

## 5. ストア入稿アセット

| スロット | ファイル | 状態 |
|---|---|---|
| ストア アイコン (128×128) | `extension/icons/icon128.png` | ✅ 同梱済み |
| スクリーンショット 1 | `store/screenshots/screenshot1.jpg` (1280×800) | ✅ |
| スクリーンショット 2 | `store/screenshots/screenshot2.jpg` (1280×800) | ✅ |
| プロモタイル (440×280) | 任意 | 未作成 |

- カテゴリ: **ツール / Tools**
- 言語: **日本語**（英語併記可）
- プライバシーポリシー URL: `https://crazykohei0123.github.io/m3u8-to-mp4/`
- ホームページ: `https://github.com/crazykohei0123/m3u8-to-mp4`
