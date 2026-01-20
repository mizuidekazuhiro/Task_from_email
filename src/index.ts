import PostalMime from "postal-mime";

const RAW_PREVIEW_LIMIT = 1800;
const CHILD_BLOCK_LIMIT = 1500;
const DEFAULT_NOTION_VERSION = "2022-06-28";

interface Env {
  NOTION_TOKEN: string;
  INBOX_DB_ID: string;
  NOTION_VERSION?: string;
  ALLOWED_FROM?: string;
  SOURCE_AS_RICH_TEXT?: string;
}

interface ForwardableEmailMessage {
  raw: ReadableStream;
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
    const parser = new PostalMime();
    const raw = await new Response(message.raw).arrayBuffer();
    const mail = await parser.parse(raw);

    const subject = mail.subject ?? "";
    if (!/inbox/i.test(subject)) {
      console.log("Skipping email: subject does not contain INBOX", {
        subject,
      });
      return;
    }

    const fromAddress = extractFromAddress(mail.from);
    const allowlist = parseAllowlist(env.ALLOWED_FROM);
    if (allowlist && (!fromAddress || !allowlist.has(fromAddress.toLowerCase()))) {
      console.log("Skipping email: sender not in allowlist", {
        from: fromAddress ?? "(unknown)",
      });
      return;
    }

    const rawText = resolveMailText(mail.text, mail.html);
    const rawPreview = rawText.slice(0, RAW_PREVIEW_LIMIT);

    const title = normalizeTitle(subject);
    const createdAt = new Date().toISOString();

    const properties: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: { content: title },
          },
        ],
      },
      Created: {
        date: { start: createdAt },
      },
      Source: buildSourceProperty(env.SOURCE_AS_RICH_TEXT),
      Raw: {
        rich_text: [
          {
            type: "text",
            text: { content: rawPreview },
          },
        ],
      },
    };

    const children = buildChildrenBlocks(rawText, fromAddress);

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
      console.error("Notion API error", {
        status: response.status,
        body: responseBody,
      });
      throw new Error(`Notion API error: ${response.status}`);
    }

    console.log("Notion page created", {
      status: response.status,
      body: responseBody,
    });
  },
};

function normalizeTitle(subject: string): string {
  const cleaned = subject
    .replace(/^\s*(?:\[\s*inbox\s*\]|inbox)\s*[:\-–—]*\s*/i, "")
    .trim();
  return cleaned.length ? cleaned : "(No title)";
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

function resolveMailText(text?: string, html?: string): string {
  if (text && text.trim().length) {
    return text.trim();
  }
  if (html && html.trim().length) {
    return htmlToText(html).trim();
  }
  return "";
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
