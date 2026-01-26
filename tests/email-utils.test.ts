import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildFingerprint, buildTitle, resolveMailText } from "../src/index.ts";

const fixturePath = new URL("./fixtures/email-basic.json", import.meta.url);
const fixtureNoSubjectPath = new URL("./fixtures/email-no-subject.json", import.meta.url);

test("buildTitle strips inbox prefix and falls back when missing", async () => {
  const raw = await readFile(fixturePath, "utf-8");
  const mail = JSON.parse(raw) as { subject?: string; date?: string };
  const title = buildTitle(mail.subject ?? "", mail.date ?? "2024-01-02T00:00:00.000Z");
  assert.equal(title, "Hello from unit test");

  const rawNoSubject = await readFile(fixtureNoSubjectPath, "utf-8");
  const mailNoSubject = JSON.parse(rawNoSubject) as { subject?: string; date?: string };
  const fallbackTitle = buildTitle(mailNoSubject.subject ?? "", mailNoSubject.date ?? "2024-02-03T00:00:00.000Z");
  assert.equal(fallbackTitle, "Inbox email 2024-02-03");
});

test("resolveMailText prefers text then html then raw", () => {
  const textResult = resolveMailText("plain", "<p>html</p>", "raw");
  assert.equal(textResult.source, "text");
  assert.equal(textResult.text, "plain");

  const htmlResult = resolveMailText("", "<p>html</p>", "raw");
  assert.equal(htmlResult.source, "html");
  assert.equal(htmlResult.text.includes("html"), true);

  const rawResult = resolveMailText("", "", "raw fallback");
  assert.equal(rawResult.source, "raw");
  assert.equal(rawResult.text, "raw fallback");
});

test("buildFingerprint is deterministic for identical inputs", async () => {
  const raw = await readFile(fixturePath, "utf-8");
  const mail = JSON.parse(raw) as { subject?: string; from?: string; date?: string; text?: string };
  const fingerprintA = await buildFingerprint({
    from: mail.from ?? null,
    subject: mail.subject ?? "",
    date: mail.date ?? "2024-01-02T00:00:00.000Z",
    body: mail.text ?? "",
  });
  const fingerprintB = await buildFingerprint({
    from: mail.from ?? null,
    subject: mail.subject ?? "",
    date: mail.date ?? "2024-01-02T00:00:00.000Z",
    body: mail.text ?? "",
  });
  assert.equal(fingerprintA, fingerprintB);
});
