# m3u8 → MP4 (Chrome拡張 + ローカルffmpeg)

- リポジトリ: <https://github.com/crazykohei0123/m3u8-to-mp4>
- プライバシーポリシー: <https://crazykohei0123.github.io/m3u8-to-mp4/>
- ストア掲載文（コピペ用）: [`store/listing.md`](store/listing.md)

ページが読み込む **m3u8 (HLS)** を検出し、**ローカルにインストールした ffmpeg** で MP4 に保存する Chrome / Vivaldi 拡張です。

```
[Chrome / Vivaldi 拡張 (MV3)]
  ページ内 inject.js (MAIN world) ── ページの XHR/fetch を監視し本文が #EXTM3U なら報告
        │ window.postMessage
        ▼
  content.js (ISOLATED) ── chrome.runtime.sendMessage
        ▼
  background.js (service worker) ── 候補を集約（必要なら応答本文を検証）
        │ chrome.runtime.connectNative()
        ▼
  [m3u8host.exe]  ← Native Messaging ホスト
        │ spawn(設定された ffmpeg.exe)
        ▼
  [ffmpeg.exe]  -i <m3u8 URL> -c copy -movflags +faststart out.mp4
```

---

## 1.0 自動検出の仕組み（3段構え）

| 経路 | 対象 | 追加通信 |
|---|---|---|
| ① URLパターン | `*.m3u8` / `format=m3u8` | なし |
| ② ページ内フック（`inject.js`, MAIN world） | hls.js 等が XHR/fetch で取得した**本文が `#EXTM3U` のもの**。**URLに拡張子が無くても検出可**（例: `/channel_post_movies/982/streaming`） | なし（既存レスポンスを読むだけ） |
| ③ 応答検証（service worker） | ②で拾えない経路（Worker/Service Worker 経由）や、`performance` タイムライン上の候補URL | 先頭64バイトだけ取得 |

③は `streaming` / `playlist` / `manifest` / `hls` / `master` を含むURLだけを対象にし、1タブ最大8件まで、
結果は15分キャッシュします。ポップアップの候補には `[自動]`（②）/`[検証]`（③）/`[URL]`（①）が付きます。

> **なぜ Content-Type では判定しないのか**
> この配信元の m3u8 は `Content-Type: text/plain; charset=utf-8` で返るため、ヘッダでは判別できません。
> そのため本文の先頭 `#EXTM3U` で判定しています。

---

## 1. なぜ「オンラインのm3u8コンバーター」は CORS で失敗するのか

CORS は **ブラウザがレスポンスをJSに渡すかどうか**の判定であり、サーバーが 200 を返していても失敗します。
実際に配信元のヘッダを確認すると次の状態でした（`v2-storage-cityheaven-tv.knip.jp` の `.ts`）。

| リクエスト | 応答 |
|---|---|
| `GET` + `Origin: https://example.com` | `200 OK` / **`Access-Control-Allow-Origin` なし** / `access-control-allow-credentials: true` / `Vary: Origin` |
| `GET`（Origin なし） | `200 OK` / ACAO なし |
| `OPTIONS`（プリフライト相当） | **`403 Forbidden`** / ACAO なし |
| `GET` + `Range` | `206 Partial Content` / ACAO なし |

- `Vary: Origin` → オリジンごとに許可を出し分ける設計。
- `access-control-allow-credentials: true` → 仕様上 `ACAO: *` は使えず、**完全一致のオリジン**しか許可できない。
- 結果として、**変換サイトのドメインは永久に許可されない** → `fetch()`/hls.js が本文を読めず CORS エラー。
- `OPTIONS` が 403 なので、独自ヘッダを足す実装はプリフライトで即死。

加えて、この配信は `#EXT-X-KEY:METHOD=SAMPLE-AES`（部分暗号化）で鍵URLが署名付き（`expires`/`mac`）です。
仮に CORS を通せても、Web Crypto では SAMPLE-AES を復号できず、`ffmpeg.wasm` も内部でブラウザの `fetch` を使うため CORS 制約をそのまま受けます。

**ローカルの ffmpeg はブラウザではない**ので、同一オリジンポリシー・CORS・プリフライトのどれも適用されません。
だから CLI では成功し、Web ページ上の JS では失敗する、という差が出ます。
本拡張も **ネットワーク取得はすべて ffmpeg に行わせる**ため、CORS の影響を受けません（拡張自身は `.ts` を fetch しません）。

---

## 2. 必要なもの

| 項目 | 内容 |
|---|---|
| ブラウザ | Vivaldi / Chrome / Edge など Chromium 111 以降（MV3 + Native Messaging） |
| Node.js | ネイティブホストの実行に使用（`node -v` で確認） |
| .NET Framework 4 | ランチャ `m3u8host.exe` のビルドに `csc.exe` を使用（Windows 標準） |
| ffmpeg | PATH にあるもの、またはフルパスを拡張の設定で指定 |

> Chrome の拡張機能（MV3）は JavaScript からプロセスを起動できません。
> そのため Chrome 公式の **Native Messaging** を使い、`m3u8host.exe` 経由で ffmpeg を起動しています。

---

## 3. セットアップ

### 3-1. 拡張を読み込む
1. `vivaldi://extensions`（Chrome なら `chrome://extensions`）を開く
2. 右上の **デベロッパーモード** を ON
3. **パッケージ化されていない拡張機能を読み込む** → `extension` フォルダを選択
4. 表示された **拡張ID**（32文字）をメモ（通常は次の手順で自動検出されます）

### 3-2. ネイティブホストを登録
```powershell
cd D:\Users\hkohei\Projects\m3u8-to-mp4\native-host
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
- 拡張IDは **Vivaldi / Chrome / Edge のプロファイル**から自動検出します（見つからない場合のみ `-ExtensionId <ID>` を指定）
- 何が行われるか:
  - `launcher\Launcher.cs` を `csc.exe` でビルド → `m3u8host.exe`
  - `node.exe` のフルパスを `node-path.txt` に記録（ブラウザ起動時の PATH 差異対策）
  - `com.local.m3u8mp4.json`（ホストマニフェスト）を生成
  - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.m3u8mp4` と
    `HKCU\Software\Vivaldi\NativeMessagingHosts\com.local.m3u8mp4` を登録
- オプション: `-DryRun`（書き込みなしで確認） / `-Edge`（Edge にも登録） / `-SkipBuild`

### 3-3. 拡張を再読み込みして設定
1. `vivaldi://extensions` で拡張の **更新**（🔄）を押す
2. ツールバーのアイコン → **設定** を開く
3. **ffmpeg.exe のパス** を入力（例: `C:\ffmpeg\bin\ffmpeg.exe`）→ **確認** を押して `OK: ffmpeg version ...` になれば準備完了
   - PATH に通っている場合は空欄でも動きます
4. **出力フォルダ**（空なら `%USERPROFILE%\Videos\m3u8`）と **ファイル名** を設定

---

## 4. 使い方

1. 対象ページで動画の再生を開始（hls.js が m3u8 を読むので検出されます）
2. 拡張アイコンをクリック → **自動検出** に m3u8 の候補が並ぶ
3. 必要なら **URL** タブで直接指定、**貼り付け** タブで m3u8 の中身を貼り付け（相対パスは「基準URL」で解決）
4. **変換開始** → 進捗・速度・残り時間が表示され、完了後に **フォルダを開く**

### 設定項目
| 項目 | 説明 |
|---|---|
| ffmpeg.exe のパス | 空なら PATH から `ffmpeg` を実行 |
| 出力フォルダ / ファイル名 | 拡張子 `.mp4` は自動補完 |
| サイトの Cookie を渡す | ログイン必須のサイト向け（`chrome.cookies` で取得し `-cookies` で渡す） |
| Referer / User-Agent | サイト側が検査する場合に指定（自分の視聴権の範囲で） |

### ffmpeg に渡している引数
```
-nostdin -hide_banner -y -loglevel info -stats_period 0.5 -progress pipe:1 -nostats
-protocol_whitelist file,http,https,tcp,tls
[-headers "Referer: ..."] [-user_agent ...] [-cookies ...]
[-f hls]                      ← URLが .m3u8 で終わらない場合に自動付与
-i <m3u8 URL / 一時ファイル>
-c copy -movflags +faststart <出力.mp4>
```
`-c copy` なので再エンコードなし（高速・無劣化）。進捗は `-progress pipe:1` の `out_time_us` と、
stderr の `Duration:` から % を算出しています。

> **`-f hls` が必要な理由**
> ffmpeg の HLS デマルチプレクサは「URLが `.m3u8` で終わる」または「Content-Type が
> `application/vnd.apple.mpegurl` / `application/x-mpegURL`」でしか自動認識しません。
> `https://api-cityheaven-tv.knip.jp/channel_post_movies/982/streaming` は
> 拡張子なし＋`text/plain` のため、
> `Not detecting m3u8/hls with non standard extension and non standard mime type`
> となり `Error opening input: I/O error`（exit -5）で失敗します。
> そのため、拡張子なしURLのときは自動で `-f hls` を挿入しています。


---

## 5. トラブルシューティング

| 症状 | 対処 |
|---|---|
| **拡張子なしのm3u8（`/channel_post_movies/982/streaming` 等）が候補に出ない** | v1.1 で検出対応。①動画を一度再生 → ②ポップアップを開く → ③「ページを再スキャン」。出ない場合は URL タブに直接入力するか、貼り付けタブを使用 |
| ヘッダが「接続エラー」/ ログに `Specified native messaging host not found` | `install.ps1` が未実行、または拡張IDが変わった。`install.ps1` を再実行（拡張フォルダのパスを変えるとIDも変わります） |
| ホストは繋がるが ffmpeg が動かない | 設定の **ffmpeg のパス** を確認 → **確認** ボタンで `OK:` になるか。`native-host\launcher.log` にエラーが残ります |
| `exit 4294967291`（= -5）+ `Not detecting m3u8/hls with non standard extension and non standard mime type` | 拡張子なし・`text/plain` のプレイリスト。**v1.1 のホストは自動で `-f hls` を付けます**。古い `host.js` のままなら再実行/更新してください |
| `exit 1` + `Server returned 403 Forbidden` | 署名付きURLの期限切れ（`expires`）。**再生ページを開き直して m3u8 を取り直す**。ログイン必須なら Cookie を ON |
| `Invalid data found when processing input` | m3u8 の取得に失敗、または鍵URLが失効。URL を開き直す |
| 変換は進むが音声/映像がおかしい | 配信側のタイムスタンプ由来。必要なら `-fflags +genpts` 等を追加（`host.js` の `buildArgs`） |
| 1080p を保存したい | マスター再生リスト（`#EXT-X-STREAM-INF`）が検出される場合、その URL を選ぶと最良品質になります |
| Edge でも使いたい | `.\install.ps1 -Edge` |

### 仕組みメモ（デバッグ用）
- ネイティブメッセージングのメッセージ形式: **4バイト リトルエンディアン長 + UTF-8 JSON**
- .NET のランチャが子プロセスの stdin に UTF-8 BOM を付けることがあるため、`host.js` 側で先頭 BOM を読み飛ばしています
- メッセージ種別（拡張 → ホスト）: `ping` / `defaults` / `probe-ffmpeg` / `start` / `cancel` / `open-folder`
- メッセージ種別（ホスト → 拡張）: `pong` / `defaults` / `ffmpeg-probe` / `started` / `duration` / `progress` / `log` / `done` / `error`

---

## 6. テスト

```powershell
cd native-host
node test\test-host.js          # node host.js を直接起動して検証
node test\test-host.js --exe    # m3u8host.exe 経由（Chrome と同じ起動形態）で検証
```
テスト内容: ping / defaults / ffmpeg 検出 / **テスト用HLSを生成して実際にMP4へ変換** / 相対URL解決 / 入力エラー / ffmpegパス不正。

ページ内フック（`inject.js` / `content.js`）の検出ロジックは、Node の `vm` で擬似ブラウザ環境を作って検証します。
```powershell
node test-inject.js
```
テスト内容: XHR(fetch)で**拡張子なしの `#EXTM3U`** を検出 / セグメント(`arraybuffer`)と非プレイリストを無視 /
二重フックしない / content.js の転送・重複排除・外部オリジン無視 / performance からの候補抽出。

UI の要素IDと JS の参照が一致しているかは次で確認できます。
```powershell
node check-ui.js
```

実サイトでの疎通確認（先頭セグメントだけ取得して自動中止・後片付けします）。
```powershell
node native-host\test\live-check.js "https://…/streaming"
```

---

## 7. 制限と注意

- **DRM（EME / Widevine / FairPlay）には対応しません。** ffmpeg が取得・復号できる通常の HLS（AES-128 / SAMPLE-AES の TS）が対象です。
- 署名付きURLは**短時間で失効**します（例: `expires=1794977125` は 2026-11-18 13:45 JST）。古い m3u8 を使い回さず、毎回取得してください。
- 変換中にポップアップを閉じても処理は継続します（service worker がポートを保持）。ただし Chrome 自体を終了すると中断されます。
- **自分が視聴権を持つコンテンツにのみ使用してください。** サイトの利用規約・著作権を確認のうえ、自己責任でご利用ください。

---

## 8. Chrome ウェブストア公開手順

### 8-0. 先に知っておくべき制約（重要）

| 制約 | 内容 | 対策（実装済み） |
|---|---|---|
| **ネイティブホストは同梱できない** | 拡張のパッケージに入れられるのは拡張だけ。`m3u8host.exe` はユーザーが別途インストールする必要がある | 未接続時にポップアップへ登録手順を表示。README/掲載文に手順を明記 |
| **拡張IDが固定される** | ストア版のIDは開発者ダッシュボードで決まる。開発版（unpacked）のIDとは別 | `install.ps1` が**ストア版・開発版の両IDを自動検出**して `allowed_origins` に登録。ポップアップにID表示＋コピー機能 |
| **Windows 専用** | ホストは PowerShell + Node + .NET で動く（macOS/Linux 不可） | 掲載文に「Windows のみ」と明記 |
| **権限が強い** | `<all_urls>` / `nativeMessaging` / `webRequest` / `cookies` | 下記の「権限の正当化」文をダッシュボードに記入 |
| **ポリシー上のリスク** | 動画のダウンロード系は通報されやすい（著作権・サイト規約） | 掲載文を「ユーザーがアクセス権を持つHLSの変換」に限定して表現。DRM非対応であることを明記 |

### 8-1. アカウント準備（初回のみ）

1. https://chrome.google.com/webstore/devconsole にアクセス
2. Google アカウントでログイン → **デベロッパー登録（初回 $5 / クレジットカード）**
3. メールアドレス認証、**2段階認証（2SV）を有効化**（必須）
4. 公開プロフィール（開発者名・連絡先メール）を設定
5. EU 向けに **Trader / Non-trader の申告**（個人なら Non-trader を選択）

### 8-2. 用意するアセット

| 種類 | 仕様 | 本リポジトリでの用意 |
|---|---|---|
| 拡張アイコン | 128×128 PNG（透過可） | `extension/icons/icon128.png` をそのままアップロード |
| スクリーンショット | 1280×800 または 640×400、1〜5枚 | `store/screenshots/`（`screenshot-01/04/05` が1280×800で有効。02/03は寸法不足） |
| プロモタイル | 440×280（任意） | アイコン＋タイトルで作成 |
| 短い説明 | 132文字以内 | `store/listing.md`（74文字版を用意済み） |
| 詳細説明 | 自由 | `store/listing.md` の「詳細説明」をそのまま貼付 |
| プライバシーポリシー URL | 必須（`nativeMessaging` 等を使うため） | **公開済み**: https://crazykohei0123.github.io/m3u8-to-mp4/ （ソース: `docs/index.md`） |

**短い説明（例）**
```
ページのHLS(m3u8)を検出し、ローカルのffmpegでMP4に保存します。変換はすべて端末内で完結します。
```

**詳細説明（例）**
```
■ 概要
動画ページが読み込む HLS プレイリスト（m3u8）を検出し、お使いのPCにインストールされた
ffmpeg で MP4 に変換して保存します。動画データは端末内でのみ処理され、外部サーバーへは送信しません。

■ 特長
・URLに .m3u8 が無いプレイリストも検出（本文の #EXTM3U で判定）
・再エンコードなし（-c copy）で高速・無劣化
・進捗・速度・残り時間を表示
・DRM（Widevine/FairPlay等）には対応しません

■ 必要なもの（Windows のみ）
1. Node.js
2. ffmpeg（PATH または パス指定）
3. ネイティブホスト（別途ダウンロードして install.ps1 を実行）

■ セットアップ
配布ページの手順に従い install.ps1 を実行後、拡張の設定で ffmpeg.exe のパスを指定してください。

■ ご注意
本拡張は、利用者が正当な視聴権を持つコンテンツの保存を目的としています。
各サイトの利用規約および著作権法を遵守してください。
```

**権限の正当化（英語・ダッシュボード入力用）**
```
- host permissions (<all_urls>):
  To detect HLS playlist requests on any site the user is watching, and to verify a
  playlist by reading the first bytes of an extension-less URL. The extension never
  uploads page content.

- nativeMessaging:
  Required to start the user's locally installed ffmpeg.exe (a small native host
  relays messages). No data leaves the device.

- webRequest:
  Observational only; used to notice .m3u8 requests and extension-less playlist URLs.

- cookies (optional feature, off by default):
  When the user explicitly enables "pass cookies", the cookies of the current site
  are handed to the local ffmpeg process so that login-protected playlists can be
  fetched. They are never transmitted anywhere else.

- tabs / scripting:
  To identify the active tab and to scan the current page for playlist URLs when the
  user clicks "rescan".
```

**単一目的（Single purpose）の記述**
```
Detect HLS (m3u8) playlists on the current page and convert them to MP4 using the
user's locally installed ffmpeg.
```

### 8-3. zip を作る

```powershell
cd D:\Users\hkohei\Projects\m3u8-to-mp4
powershell -ExecutionPolicy Bypass -File .\make-store-zip.ps1
# → dist\m3u8-to-mp4-1.1.1.zip （manifest.json が直下、パス区切りは "/"）
```
> `extension` フォルダを右クリックで圧縮すると `extension\` が1階層入ってしまい審査で弾かれます。
> 必ずこのスクリプト（または中身を直接zip）を使ってください。

### 8-4. アップロードと審査

1. デベロッパー ダッシュボード → **新しいアイテム**
2. zip をアップロード（エラーが出たら manifest の記述を修正）
3. **ストアの掲載情報** を入力（上記アセット・説明・カテゴリ「ツール」・言語 `日本語`）
4. **プライバシー** タブ: 単一目的／権限の正当化／データ使用（収集なし）／プライバシーポリシーURL
5. **配布** タブ: 公開範囲（公開 / 限定公開）、地域
6. **審査のために送信** → 通常数日、広いホスト権限がある場合は 1〜数週間かかることがあります

### 8-5. 公開後にやること（重要）

ストアで割り当てられた **拡張ID** を控え、ホスト登録に反映します。

```powershell
# ストア版ID（と開発版ID）を明示して登録
powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1 -ExtensionId "<ストアのID>,<開発版のID>"
# もしくはストア版をインストール済みなら自動検出（manifest.name で一致）
powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1
```
`allowed_origins` に複数IDが入るため、**開発版とストア版を同じPCで併用できます**。

ユーザー向けの配布物（ホスト側）:
```
m3u8-to-mp4-host.zip
  ├─ host.js / launcher/ / install.ps1 / uninstall.ps1 / node-path.txt(自動生成)
```
※ `m3u8host.exe` は `install.ps1` が自動ビルドします。

### 8-6. バージョン更新

1. `extension/manifest.json` の `version` を上げる（例 1.1.2）
2. `make-store-zip.ps1` を再実行
3. ダッシュボードの該当アイテム → **パッケージ** → 新しいzipをアップロード → 審査依頼

### 8-7. 審査が通らない場合の代替配布

| 方法 | 審査 | 向いているケース |
|---|---|---|
| **限定公開（Unlisted）** | あり（一般公開より目立たない） | 身内・サークル内配布 |
| **GitHub Releases + 手動インストール** | なし | 自分/上級者向け。`chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」 |
| **Edge アドオン** | あり（比較的通りやすい） | Windows ユーザー向けの代替チャネル |

> 自分用・身内用なら **GitHub で配布（unpacked）** が最も確実で、ストア審査やポリシー変更の影響を受けません。
