import PostalMime from "postal-mime";

const RAW_PREVIEW_LIMIT = 1800;
const CHILD_BLOCK_LIMIT = 1500;
const DEFAULT_NOTION_VERSION = "2022-06-28";
const LOG_PREVIEW_LIMIT = 120;
const HEADER_SAMPLE_LIMIT = 20;
const TITLE_LIMIT = 200;
const FINGERPRINT_PROPERTY_DEFAULT = "Fingerprint";
const RAW_PROPERTY_DEFAULT = "Raw";
const SOURCE_PROPERTY_DEFAULT = "Source";
const CREATED_PROPERTY_DEFAULT = "Created";
const TITLE_PROPERTY_DEFAULT = "Name";

interface Env {
  NOTION_TOKEN: string;
  INBOX_DB_ID: string;
  NOTION_VERSION?: string;
  ALLOWED_FROM?: string;
  SOURCE_AS_RICH_TEXT?: string;
  WORKERS_BEARER_TOKEN?: string;
  TITLE_PROPERTY?: string;
  CREATED_PROPERTY?: string;
  SOURCE_PROPERTY?: string;
  RAW_PROPERTY?: string;
  FINGERPRINT_PROPERTY?: string;
}

interface ForwardableEmailMessage {
  raw: ReadableStream;
  from?: string;
  to?: string;
  headers?: Headers;
}

interface NotionParagraphBlock {
  object: "block";
  type: "paragraph";
  paragraph: {
    rich_text: Array<{
      type: "text";
      text: { content: string };
    }>;
  };
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const requestId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    logInfo("email.received", { requestId, receivedAt });
    validateEnv(env, requestId);

    const parser = new PostalMime();
    const raw = await new Response(message.raw).arrayBuffer();
    const rawSize = raw.byteLength;
    const rawFallback = decodeRawText(raw);
    const mail = await parser.parse(raw);

    const subject = mail.subject ?? "";
    await logEventShape(message, mail, subject, rawSize, rawFallback, requestId);

    const resolved = resolveMailText(mail.text, mail.html, rawFallback);
    await logBodySelection(resolved, requestId);
    await handleNotionCreate({
      env,
      requestId,
      receivedAt,
      mail,
      resolved,
      messageFrom: message.from ?? null,
    });
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    logInfo("http.received", { requestId, receivedAt, url: request.url });
    validateEnv(env, requestId);

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/debug/email") {
      return new Response("Not found", { status: 404 });
    }

    const authError = requireBearerAuth(request, env.WORKERS_BEARER_TOKEN ?? "");
    if (authError) {
      logInfo("http.auth_failed", { requestId, reason: authError });
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      logInfo("http.invalid_payload", { requestId });
      return new Response("Invalid payload", { status: 400 });
    }

    const mail = payload as {
      subject?: string;
      text?: string;
      html?: string;
      from?: string;
      to?: string;
      date?: string;
      raw?: string;
    };

    const rawFallback = typeof mail.raw === "string" ? mail.raw : "";
    await logEventShape(
      { raw: new ReadableStream(), from: mail.from, to: mail.to },
      mail as unknown as PostalMime.Email,
      mail.subject ?? "",
      rawFallback.length,
      rawFallback,
      requestId
    );

    const resolved = resolveMailText(mail.text, mail.html, rawFallback);
    await logBodySelection(resolved, requestId);

    await handleNotionCreate({
      env,
      requestId,
      receivedAt,
      mail: mail as unknown as PostalMime.Email,
      resolved,
    });

    return new Response("OK", { status: 200 });
  },
};

function normalizeTitle(subject: string): string {
  const cleaned = subject
    .replace(/^\s*(?:\[\s*inbox\s*\]|inbox)\s*[:\-–—]*\s*/i, "")
    .trim();
  return cleaned;
}

function buildTitle(subject: string, receivedAt: string): string {
  const normalized = normalizeTitle(subject);
  if (normalized.length) {
    return normalized;
  }
  const date = receivedAt.slice(0, 10);
  return `Inbox email ${date}`;
}

async function handleNotionCreate(input: {
  env: Env;
  requestId: string;
  receivedAt: string;
  mail: PostalMime.Email;
  resolved: { text: string; source: "text" | "html" | "raw" | "empty" };
  messageFrom?: string | null;
}): Promise<void> {
  const { env, requestId, receivedAt, mail, resolved } = input;
  const subject = mail.subject ?? "";

  const fromAddress = extractFromAddress(mail.from) ?? input.messageFrom ?? null;
  const allowlist = parseAllowlist(env.ALLOWED_FROM);
  if (allowlist && (!fromAddress || !allowlist.has(fromAddress.toLowerCase()))) {
    logInfo("email.skipped_allowlist", {
      requestId,
      fromPresent: Boolean(fromAddress),
      fromHash: fromAddress ? await sha256Hex(fromAddress.toLowerCase()) : null,
    });
    return;
  }

  const rawText = resolved.text;
  const rawPreview = truncateText(rawText, RAW_PREVIEW_LIMIT);
  const createdAt = new Date().toISOString();
  const title = truncateText(buildTitle(subject, receivedAt), TITLE_LIMIT);

  const fingerprint = await buildFingerprint({
    from: fromAddress,
    subject,
    date: mail.date ? new Date(mail.date).toISOString() : createdAt,
    body: rawText,
  });

  const propertyNames = resolvePropertyNames(env);
  const properties: Record<string, unknown> = {
    [propertyNames.title]: {
      title: [
        {
          type: "text",
          text: { content: title },
        },
      ],
    },
    [propertyNames.created]: {
      date: { start: createdAt },
    },
    [propertyNames.source]: buildSourceProperty(env.SOURCE_AS_RICH_TEXT),
    [propertyNames.raw]: {
      rich_text: [
        {
          type: "text",
          text: { content: rawPreview },
        },
      ],
    },
    [propertyNames.fingerprint]: {
      rich_text: [
        {
          type: "text",
          text: { content: fingerprint },
        },
      ],
    },
  };

  const children = buildChildrenBlocks(rawText, fromAddress);
  await logNotionRequest({
    requestId,
    dbId: env.INBOX_DB_ID,
    title,
    rawPreview,
    fingerprint,
    childrenCount: children.length,
    propertyNames,
  });

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": env.NOTION_VERSION ?? DEFAULT_NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { database_id: env.INBOX_DB_ID },
      properties,
      children: children.length ? children : undefined,
    }),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    await logNotionError(response, responseBody, requestId);
    const parsed = safeJsonParse(responseBody);
    const missingProperty = extractMissingProperty(parsed?.message ?? "");
    if (missingProperty) {
      throw new Error(`Notion property missing: ${missingProperty}`);
    }
    throw new Error(`Notion API error: ${response.status}`);
  }

  await logNotionSuccess(response, responseBody, requestId);
}

function parseAllowlist(allowedFrom?: string): Set<string> | null {
  if (!allowedFrom) {
    return null;
  }
  const entries = allowedFrom
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? new Set(entries) : null;
}

function extractFromAddress(from: unknown): string | null {
  if (!from) {
    return null;
  }
  if (typeof from === "string") {
    return extractEmailFromString(from);
  }
  if (Array.isArray(from)) {
    return extractFromAddress(from[0]);
  }
  if (typeof from === "object") {
    const record = from as { address?: string; value?: unknown };
    if (record.address) {
      return record.address;
    }
    if (record.value) {
      return extractFromAddress(record.value);
    }
  }
  return null;
}

function extractEmailFromString(value: string): string {
  const match = value.match(/[\w.+-]+@[\w.-]+/);
  return match ? match[0] : value.trim();
}

function resolveMailText(
  text?: string,
  html?: string,
  rawFallback?: string
): { text: string; source: "text" | "html" | "raw" | "empty" } {
  if (text && text.trim().length) {
    return { text: text.trim(), source: "text" };
  }
  if (html && html.trim().length) {
    return { text: htmlToText(html).trim(), source: "html" };
  }
  if (rawFallback && rawFallback.trim().length) {
    return { text: rawFallback.trim(), source: "raw" };
  }
  return { text: "", source: "empty" };
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n")
    .replace(/<\s*\/div\s*>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(stripped);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function buildSourceProperty(sourceAsRichText?: string): Record<string, unknown> {
  if (sourceAsRichText?.toLowerCase() === "true") {
    return {
      rich_text: [
        {
          type: "text",
          text: { content: "Email" },
        },
      ],
    };
  }
  return { select: { name: "Email" } };
}

function buildChildrenBlocks(text: string, fromAddress: string | null): NotionParagraphBlock[] {
  const blocks: NotionParagraphBlock[] = [];
  if (fromAddress) {
    blocks.push(buildParagraph(`From: ${fromAddress}`));
  }

  const chunks = splitIntoChunks(text, CHILD_BLOCK_LIMIT);
  for (const chunk of chunks) {
    if (!chunk.trim().length) {
      continue;
    }
    blocks.push(buildParagraph(chunk));
  }

  return blocks;
}

function splitIntoChunks(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

function buildParagraph(content: string): NotionParagraphBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content },
        },
      ],
    },
  };
}

function truncateText(value: string, limit: number): string {
  if (!value) {
    return "";
  }
  return value.length > limit ? value.slice(0, limit) : value;
}

function decodeRawText(raw: ArrayBuffer): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  const headerSplit = decoded.match(/\r?\n\r?\n/);
  if (!headerSplit) {
    return decoded;
  }
  const index = decoded.indexOf(headerSplit[0]);
  return decoded.slice(index + headerSplit[0].length);
}

function resolvePropertyNames(env: Env): {
  title: string;
  created: string;
  source: string;
  raw: string;
  fingerprint: string;
} {
  return {
    title: env.TITLE_PROPERTY ?? TITLE_PROPERTY_DEFAULT,
    created: env.CREATED_PROPERTY ?? CREATED_PROPERTY_DEFAULT,
    source: env.SOURCE_PROPERTY ?? SOURCE_PROPERTY_DEFAULT,
    raw: env.RAW_PROPERTY ?? RAW_PROPERTY_DEFAULT,
    fingerprint: env.FINGERPRINT_PROPERTY ?? FINGERPRINT_PROPERTY_DEFAULT,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildFingerprint(input: {
  from: string | null;
  subject: string;
  date: string;
  body: string;
}): Promise<string> {
  const bodyHash = await sha256Hex(input.body ?? "");
  const material = `${input.from ?? ""}|${input.subject ?? ""}|${input.date}|${bodyHash}`;
  return sha256Hex(material);
}

function getHeaderNames(headers?: Headers): string[] {
  if (!headers) {
    return [];
  }
  return Array.from(headers.keys()).slice(0, HEADER_SAMPLE_LIMIT);
}

async function logEventShape(
  message: ForwardableEmailMessage,
  mail: PostalMime.Email,
  subject: string,
  rawSize: number,
  rawFallback: string,
  requestId: string
): Promise<void> {
  const fromAddress = extractFromAddress(mail.from) ?? message.from ?? null;
  const toAddress = extractFromAddress(mail.to) ?? message.to ?? null;
  const subjectHash = subject ? await sha256Hex(subject) : null;
  const rawFallbackHash = rawFallback ? await sha256Hex(rawFallback.slice(0, LOG_PREVIEW_LIMIT)) : null;
  logInfo("email.event_shape", {
    requestId,
    headers: getHeaderNames(message.headers),
    fromPresent: Boolean(fromAddress),
    fromHash: fromAddress ? await sha256Hex(fromAddress.toLowerCase()) : null,
    toPresent: Boolean(toAddress),
    toHash: toAddress ? await sha256Hex(toAddress.toLowerCase()) : null,
    subjectPresent: Boolean(subject),
    subjectLength: subject.length,
    subjectHash,
    rawSize,
    rawFallbackPreviewHash: rawFallbackHash,
    rawFallbackPreviewLength: Math.min(rawFallback.length, LOG_PREVIEW_LIMIT),
  });
}

async function logBodySelection(
  resolved: { text: string; source: "text" | "html" | "raw" | "empty" },
  requestId: string
): Promise<void> {
  const preview = resolved.text.slice(0, LOG_PREVIEW_LIMIT);
  const hash = preview ? await sha256Hex(preview) : null;
  logInfo("email.body_selected", {
    requestId,
    source: resolved.source,
    length: resolved.text.length,
    previewLength: preview.length,
    previewHash: hash,
  });
}

async function logNotionRequest(input: {
  requestId: string;
  dbId: string;
  title: string;
  rawPreview: string;
  fingerprint: string;
  childrenCount: number;
  propertyNames: ReturnType<typeof resolvePropertyNames>;
}): Promise<void> {
  logInfo("notion.request", {
    requestId: input.requestId,
    dbIdHash: await sha256Hex(input.dbId),
    titleLength: input.title.length,
    titleHash: input.title ? await sha256Hex(input.title) : null,
    rawPreviewLength: input.rawPreview.length,
    rawPreviewHash: input.rawPreview ? await sha256Hex(input.rawPreview) : null,
    childrenCount: input.childrenCount,
    propertyNames: input.propertyNames,
    fingerprint: input.fingerprint,
  });
}

async function logNotionError(
  response: Response,
  responseBody: string,
  requestId: string
): Promise<void> {
  const notionRequestId = response.headers.get("x-request-id");
  const parsed = safeJsonParse(responseBody);
  const missingProperty = extractMissingProperty(parsed?.message ?? "");
  logInfo("notion.response_error", {
    requestId,
    status: response.status,
    notionRequestId,
    errorCode: parsed?.code ?? null,
    errorMessage: parsed?.message ?? responseBody.slice(0, LOG_PREVIEW_LIMIT),
    missingProperty,
  });
}

async function logNotionSuccess(
  response: Response,
  responseBody: string,
  requestId: string
): Promise<void> {
  const notionRequestId = response.headers.get("x-request-id");
  const parsed = safeJsonParse(responseBody);
  logInfo("notion.response_success", {
    requestId,
    status: response.status,
    notionRequestId,
    pageId: parsed?.id ?? null,
  });
}

function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractMissingProperty(message: string): string | null {
  const match = message.match(/property(?:\s+name)?\s+"?([A-Za-z0-9 _-]+)"?\s+does not exist/i);
  return match ? match[1] : null;
}

function logInfo(message: string, payload: Record<string, unknown>): void {
  console.log(message, payload);
}

function validateEnv(env: Env, requestId: string): void {
  const missing = [];
  if (!env.NOTION_TOKEN) {
    missing.push("NOTION_TOKEN");
  }
  if (!env.INBOX_DB_ID) {
    missing.push("INBOX_DB_ID");
  }
  if (!env.WORKERS_BEARER_TOKEN) {
    missing.push("WORKERS_BEARER_TOKEN");
  }
  if (missing.length) {
    console.error("Missing required env vars", { requestId, missing });
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function requireBearerAuth(request: Request, token: string): string | null {
  if (!token) {
    return "missing_token";
  }
  const header = request.headers.get("Authorization");
  if (!header) {
    return "missing_header";
  }
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || value !== token) {
    return "invalid_token";
  }
  return null;
}

export {
  buildFingerprint,
  buildTitle,
  decodeRawText,
  normalizeTitle,
  resolveMailText,
  truncateText,
};
