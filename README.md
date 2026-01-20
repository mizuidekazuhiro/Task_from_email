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

# Optional
wrangler secret put ALLOWED_FROM
wrangler secret put SOURCE_AS_RICH_TEXT
wrangler secret put NOTION_VERSION
```

#### 設定値一覧

- `NOTION_TOKEN` (secret): Notion Integration Token
- `INBOX_DB_ID` (secret or var): Inbox DB の Database ID
- `NOTION_VERSION` (var): Notion API Version（デフォルト `2022-06-28`）
- `ALLOWED_FROM` (var): 送信者 allowlist（例: `me@gmail.com,foo@bar.com`）
- `SOURCE_AS_RICH_TEXT` (var): `true` の場合 Source を `rich_text` として送信

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
- Processed / Processed At は空のままです。

## トラブルシュート

- Notion API で `validation_error` が出る場合、Worker のログ出力に含まれるレスポンス本文を確認してください。
- Source の型が違う場合は `SOURCE_AS_RICH_TEXT=true` を設定してください。

