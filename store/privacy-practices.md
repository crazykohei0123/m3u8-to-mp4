# プライバシーへの取り組み（Chrome ウェブストア入力用・v1.2.0）

`[プライバシーへの取り組み]` タブに**そのまま貼り付け**できる文案です。

## このバージョンの権限構成

| 種別 | 権限 |
|---|---|
| 必須 | `activeTab` / `scripting` / `storage` / `nativeMessaging` |
| 任意（実行時に要求） | `cookies`、ホスト権限 `*://*/*` のうち**実際に使う配信元のみ** |
| 削除済み | `host_permissions: <all_urls>` / `webRequest` / `tabs` |

---

## 1. 単一用途の説明（Single purpose）

```
この拡張機能の単一の目的は、「現在のページで再生されている HLS（m3u8）プレイリストを検出し、ユーザーの PC にインストールされた ffmpeg で MP4 に変換・保存する」ことです。検出・変換・保存以外の機能は提供しません。
```

---

## 2. 権限を要求する理由

### activeTab
```
ユーザーがツールバーのアイコンを押したときだけ、そのタブのページを読み取ります。HLS プレイリストの候補 URL をページの performance 情報と HTML から収集し、変換対象を決めるために使用します。常時監視は行いません。
```

### scripting
```
上記の収集処理を、ユーザー操作があったタブに対してのみ実行するために使用します（chrome.scripting.executeScript）。対象は現在のタブのメインフレームに限られ、実行はユーザーがアイコンを押したときだけです。
```

### storage
```
ffmpeg のパス、出力フォルダ、ファイル名、Referer、User-Agent などのユーザー設定を chrome.storage.local に保存するために使用します。端末内にのみ保存し、同期・外部送信は行いません。
```

### nativeMessaging
```
ユーザーの PC にインストールされた ffmpeg.exe を起動するため、ローカルのネイティブホスト（m3u8host.exe）と通信します。この通信は端末内で完結し、外部サーバーへの送信はありません。
```

### cookies（任意・実行時に許可を要求）
```
任意機能です。既定では無効で、インストール時には要求しません。ユーザーが設定画面で「サイトの Cookie を渡す」を ON にしたときに限り、変換対象サイトの Cookie を取得し、端末内の ffmpeg に渡します。Cookie を保存したり、外部へ送信したりすることは一切ありません。
```

### ホスト権限（任意・実行時に許可を要求）
```
インストール時には要求しません。URL に .m3u8 が含まれないプレイリスト（例: /channel_post_movies/982/streaming）は、応答本文の先頭が #EXTM3U かどうかを確認しないと判定できません。この確認のため、ユーザーがポップアップの「配信元へのアクセスを許可」を押したときに限り、検出された配信元の origin（例: https://api.example.com/*）だけを chrome.permissions.request() で要求します。読み取るのは応答の先頭 64 バイトのみで、ページ本文や閲覧履歴の収集・外部送信は行いません。許可しなくても、URL の直接入力・m3u8 の貼り付け・.m3u8 形式の URL の変換は利用できます。
```

---

## 3. データの使用（Data usage）

- **「このアイテムはユーザー データを収集しません」を選択**
  （「収集」= 端末外への送信。本拡張は設定を `chrome.storage.local` に保存するだけで、
  開発者のサーバーは存在せず、いかなるデータも送信しません）
- プライバシーポリシー（同じ内容を記載）: https://crazykohei0123.github.io/m3u8-to-mp4/

---

## 4. デベロッパー プログラム ポリシーへの準拠表明

`[プライバシーへの取り組み]` タブ最下部のチェックボックスにチェックを入れてください。

---

## 5. パブリッシャーの連絡先メール

`[設定]` ページで連絡先メールアドレスを入力し、確認メールのリンクをクリックしてください（未確認だと公開できません）。

---

## 6. 審査で追加質問が来た場合の回答テンプレート（英語）

```
Thank you for the review. This extension has a single purpose: detect HLS (m3u8)
playlists on the page the user is viewing and convert them to MP4 using the user's
locally installed ffmpeg.

Requested permissions (install time):
- activeTab: we read the page only when the user clicks the toolbar icon. We collect
  candidate URLs from performance entries and the page HTML. No background monitoring.
- scripting: used to run that one-shot collection in the clicked tab.
- storage: stores the user's settings locally (chrome.storage.local).
- nativeMessaging: launches the user's own ffmpeg.exe through a local native host.
  There is no developer server.

Optional permissions (requested only on demand, never at install):
- cookies: only when the user explicitly enables "pass cookies". Cookies of the current
  site are handed to the local ffmpeg process and are never stored or transmitted.
- host permissions: when a playlist URL has no .m3u8 extension and no mpegurl content
  type, we must read the first 64 bytes of the response to test for #EXTM3U. On the
  user's click we request only the specific origin(s) of the detected media host
  (e.g. https://api.example.com/*). Declining still leaves manual URL / paste
  conversion fully functional.

We do not use <all_urls>, webRequest or the tabs permission, and we collect no data.

Privacy policy: https://crazykohei0123.github.io/m3u8-to-mp4/
```

---

## 7. 変更履歴（1.1.1 → 1.2.0）

| 権限 | 変更 |
|---|---|
| `host_permissions: <all_urls>` | **削除**（任意権限＋activeTabへ） |
| `webRequest` | **削除**（常時監視を廃止） |
| `tabs` | **削除**（`tabs.query` の `id` は権限不要） |
| `cookies` | 必須 → **任意**（ONにした時だけ要求） |
| `activeTab` / `scripting` / `storage` / `nativeMessaging` | 継続 |
