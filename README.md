# Cloudflare Email → Notion Inbox Worker

Cloudflare Email Routing で受信したメールを Cloudflare Workers の Email Worker で処理し、件名に **INBOX** が含まれるものだけ Notion の Inbox DB に追加します。

## セットアップ

### 1) Cloudflare Email Routing を Worker に接続

1. Cloudflare Dashboard → **Email** → **Email Routing** を有効化します。
2. **Routing rules** で受信アドレス（例: `inbox@your-domain.com`）を追加します。
3. **Actions** で **Send to a Worker** を選択し、この Worker を割り当てます。

### 2) 変数/シークレットの設定

以下を `wrangler` または Dashboard で設定してください。

```bash
# Secret
wrangler secret put NOTION_TOKEN
wrangler secret put INBOX_DB_ID
wrangler secret put WORKERS_BEARER_TOKEN

# Optional
wrangler secret put ALLOWED_FROM
wrangler secret put SOURCE_AS_RICH_TEXT
wrangler secret put NOTION_VERSION
wrangler secret put TITLE_PROPERTY
wrangler secret put CREATED_PROPERTY
wrangler secret put SOURCE_PROPERTY
wrangler secret put RAW_PROPERTY
wrangler secret put FINGERPRINT_PROPERTY
```

#### 設定値一覧

- `NOTION_TOKEN` (secret): Notion Integration Token
- `INBOX_DB_ID` (secret or var): Inbox DB の Database ID
- `WORKERS_BEARER_TOKEN` (secret): `/debug/email` エンドポイントの Bearer トークン
- `NOTION_VERSION` (var): Notion API Version（デフォルト `2022-06-28`）
- `ALLOWED_FROM` (var): 送信者 allowlist（例: `me@gmail.com,foo@bar.com`）
- `SOURCE_AS_RICH_TEXT` (var): `true` の場合 Source を `rich_text` として送信
- `TITLE_PROPERTY` (var): Title プロパティ名（デフォルト `Name`）
- `CREATED_PROPERTY` (var): Created プロパティ名（デフォルト `Created`）
- `SOURCE_PROPERTY` (var): Source プロパティ名（デフォルト `Source`）
- `RAW_PROPERTY` (var): Raw プロパティ名（デフォルト `Raw`）
- `FINGERPRINT_PROPERTY` (var): Fingerprint プロパティ名（デフォルト `Fingerprint`）

### 3) 開発起動

```bash
npm install
npm run dev
```

## 動作仕様

- 件名に **INBOX**（大文字小文字無視）が含まれるメールのみ Notion Inbox DB に追加します。
- Name には `INBOX` / `[INBOX]` / `INBOX:` / `INBOX -` などのプレフィックスを除去した件名を保存します。
- Source は常に `Email` を設定します（デフォルトは `select` 型、必要なら `SOURCE_AS_RICH_TEXT=true`）。
- Created は登録時刻（ISO 文字列）を設定します。
- Raw には本文先頭 1800 文字までを保存し、ページ本文（children）には全文を複数 paragraph に分割して保存します。
- Fingerprint に `from + subject + date + body hash` から作った SHA-256 指紋を保存します（冪等性のため）。
- Processed / Processed At は空のままです。

## トラブルシュート

### どこが壊れたらどこを見るか

- **Cloudflare Email Routing** 側: Dashboard → Email → Email Routing → Activities で受信・転送の結果を確認。
- **Worker ログ**: Dashboard → Workers → 対象 Worker → Logs で `email.*` / `notion.*` のログを確認。
- **Notion レスポンス**: `notion.response_error` に `status` / `errorCode` / `errorMessage` / `notionRequestId` が出ます。

### よくある失敗

- Notion API で `validation_error` が出る場合、`notion.response_error` の `missingProperty` を確認して DB プロパティ名を合わせてください。
- Source の型が違う場合は `SOURCE_AS_RICH_TEXT=true` を設定してください。
- 環境変数不足は `Missing required env vars` で落ちます。

## 手動検証（ローカル / CI）

### 1) wrangler dev で起動

```bash
npm install
npm run dev
```

### 2) /debug/email でテスト投入

```bash
curl -X POST http://localhost:8787/debug/email \
  -H "Authorization: Bearer $WORKERS_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @tests/fixtures/email-basic.json
```

### 3) ログの確認ポイント

- `email.event_shape` で受信イベントの概要（headers / from / to / subject / rawSize）
- `email.body_selected` で本文採用元と文字数
- `notion.request` で DB ID ハッシュ / title / raw の長さ
- `notion.response_success` or `notion.response_error` で Notion 側の結果
