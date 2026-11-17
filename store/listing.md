# Chrome ウェブストア 掲載情報（コピペ用）

最終更新: 2026-11-17 / manifest version: 1.1.1

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
・URL に .m3u8 が無いプレイリストも検出（応答本文の #EXTM3U で判定）
・再エンコードなし（-c copy）で高速・無劣化
・進捗・速度・サイズを表示し、完了後はボタン1つでフォルダを開けます
・AES-128 / SAMPLE-AES（MPEG-TS）の復号は ffmpeg に任せるため追加設定は不要
・DRM（Widevine / FairPlay など）には対応しません

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
2. ツールバーのアイコンをクリックします
3. 「自動検出」に表示されたプレイリストを選び「変換開始」を押します
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
- host permissions (<all_urls>):
  To detect HLS playlist requests on any site the user is viewing, and to verify an
  extension-less playlist URL by reading the first bytes of its response. No page content
  is uploaded anywhere.

- nativeMessaging:
  Required to start the user's locally installed ffmpeg.exe through a small native host.
  No data leaves the device.

- webRequest:
  Observational only; used to notice .m3u8 requests and extension-less playlist URLs.

- cookies (optional, off by default):
  When the user explicitly enables "pass cookies", cookies of the current site are handed
  to the local ffmpeg process so that login-protected playlists can be fetched. They are
  never transmitted anywhere else.

- tabs / scripting:
  To identify the active tab and to scan the current page for playlist URLs when the user
  clicks "rescan".
```

---

## 5. ストア入稿アセット

| スロット | ファイル | 状態 |
|---|---|---|
| ストア アイコン (128×128) | `extension/icons/icon128.png` | ✅ 同梱済み |
| スクリーンショット 1 | `store/screenshots/screenshot-01.png` (1280×800) | ✅ |
| スクリーンショット 2 | `store/screenshots/screenshot-04.png` (1280×800) | ✅ |
| スクリーンショット 3 | `store/screenshots/screenshot-05.png` (1280×800) | ✅ |
| （参考） | `screenshot-02.png` (546×568) / `screenshot-03.png` (547×453) | ❌ 1280×800 か 640×400 に作り直しが必要 |
| プロモタイル (440×280) | 任意 | 未作成 |

- カテゴリ: **ツール / Tools**
- 言語: **日本語**（英語併記可）
- プライバシーポリシー URL: `https://crazykohei0123.github.io/m3u8-to-mp4/`
- ホームページ: `https://github.com/crazykohei0123/m3u8-to-mp4`
