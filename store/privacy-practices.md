# プライバシーへの取り組み（Chrome ウェブストア入力用）

`[プライバシーへの取り組み]` タブの各欄に**そのまま貼り付け**できる文案です。
（言語: 日本語で入力可。英語が必要な場合は末尾の English 版を使用）

---

## 1. 単一用途の説明（Single purpose）

```
この拡張機能の単一の目的は、「現在のページで再生されている HLS（m3u8）プレイリストを検出し、
ユーザーの PC にインストールされた ffmpeg で MP4 に変換・保存する」ことです。
検出・変換・保存以外の機能は提供しません。
```

---

## 2. 権限を要求する理由

### ホスト権限（`<all_urls>`）
```
動画の視聴ページは任意のドメインに存在し、事前に列挙できません。HLS プレイリストの取得要求を
検出するため、すべてのサイトへのアクセスが必要です。
読み取るのは (1) リクエスト URL と (2) URL に拡張子が無い場合の応答先頭 64 バイト
（#EXTM3U かどうかの判定）のみです。ページ本文・入力内容・閲覧履歴を収集したり、
外部へ送信したりすることはありません。より狭い権限では、ユーザーが視聴する任意のサイトで
動作できないため、この権限が必要です。
```

### webRequest
```
HLS プレイリスト（.m3u8）への通信を監視し、変換候補を見つけるために使用します。
リクエストの改変・ブロック・リダイレクトは行わず、URL の参照のみです。
```

### nativeMessaging
```
ユーザーの PC にインストールされた ffmpeg.exe を起動するため、ローカルのネイティブホスト
（m3u8host.exe）と通信します。この通信は端末内で完結し、外部サーバーへの送信はありません。
```

### scripting
```
ポップアップの「ページを再スキャン」を押したときに、現在のタブの HTML と
performance リソース一覧からプレイリスト URL を読み取るために使用します。
実行はユーザー操作時のみで、読み取った値は URL の抽出にのみ使用します。
```

### storage
```
ffmpeg のパス、出力フォルダ、ファイル名、Referer、User-Agent などのユーザー設定を
chrome.storage.local に保存するために使用します。端末内にのみ保存し、同期・外部送信は行いません。
```

### tabs
```
ポップアップで操作対象のタブ（現在アクティブなタブ）を特定し、そのタブで検出した
プレイリスト候補を表示するために使用します。タブの URL やタイトルを外部へ送信することはありません。
```

### cookies
```
任意機能です。既定では無効です。ユーザーが設定画面で「サイトの Cookie を渡す」を明示的に
ON にした場合に限り、変換対象サイトの Cookie を取得し、端末内で起動する ffmpeg に渡します。
Cookie を保存したり、開発者や第三者へ送信したりすることは一切ありません。
```

---

## 3. データの使用（Data usage）

- **「このアイテムはユーザー データを収集しません」を選択**
  （データの「収集」とは端末外への送信を指します。本拡張は設定を `chrome.storage.local` に
  保存するだけで、開発者のサーバーは存在せず、いかなるデータも送信しません）
- 参考: プライバシーポリシーの表と一致しています
  → https://crazykohei0123.github.io/m3u8-to-mp4/
- もし「ウェブ閲覧アクティビティ」等を選択する運用にする場合は、以下の注記を
  「データ使用の説明」欄に追記してください：
  ```
  リクエスト URL はプレイリスト検出のためにブラウザ内で参照するのみで、保存・送信は行いません。
  ```

---

## 4. デベロッパー プログラム ポリシーへの準拠表明

`[プライバシーへの取り組み]` タブ最下部のチェックボックス
（「データの使用が Google のデベロッパー プログラム ポリシーに準拠していることを表明します」）に
チェックを入れてください。

---

## 5. パブリッシャーの連絡先メール

`[設定]` ページ → **連絡先メールアドレス** を入力 → 届いた確認メールのリンクをクリック（未確認だと公開できません）。
ストア上に表示するメールアドレスと、非公開の連絡先を分けて設定できます。

---

## 6. 審査で追加質問が来た場合の回答テンプレート（英語）

```
Thank you for the review. This extension has a single purpose: detect HLS (m3u8)
playlists on the page the user is viewing and convert them to MP4 using the user's
locally installed ffmpeg.

1) Host permissions: video pages exist on arbitrary domains, so an allow-list is not
   possible. We read only (a) request URLs and (b) the first 64 bytes of a response
   for URLs without a .m3u8 extension, solely to test whether it starts with #EXTM3U.
   No page content, form data, or browsing history is collected, stored, or transmitted.

2) nativeMessaging: used to launch the user's own ffmpeg.exe through a local native
   host. All processing happens on the device; there is no developer server.

3) cookies: optional and OFF by default. Only when the user explicitly enables
   "pass cookies" do we read cookies of the current site and hand them to the local
   ffmpeg process so that login-protected playlists can be fetched. They are never
   stored or transmitted elsewhere.

4) Data collection: none. Settings are stored locally in chrome.storage.local.
   The extension contains no analytics, ads, or remote code.

Privacy policy: https://crazykohei0123.github.io/m3u8-to-mp4/
```

---

## 7. 補足: 権限を減らす選択肢（次バージョン案）

審査を軽くしたい場合、以下の変更で要求権限を減らせます。

| 権限 | 代替案 | 影響 |
|---|---|---|
| `tabs` | 不要（`chrome.tabs.query` の `id` は権限なしで取得可能） | manifest から削除するだけでOK（要動作確認） |
| `cookies` | `optional_permissions: ["cookies"]` にして、設定でONにした時に `chrome.permissions.request()` | インストール時の警告から外れる（実装変更が必要） |
| `scripting` | 既にページ内に挿入している `content.js` へメッセージしてスキャンさせる | 「再スキャン」の実装変更が必要 |

> 今回は**すでにアップロード済みのパッケージ**で審査を通すのが早道です。
> 上記は次回アップデート時に検討してください。
