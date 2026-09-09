import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadSkillBundle, readSkillBundleFile } from "../build/skill-bundle.mjs";
import { canonicalPrompt } from "../build/runtime-support.mjs";

const root = resolve(import.meta.dirname, "../../../skills/odai");

test("canonical rendering omits metadata while retaining body, source identity, and selection notices", () => {
  const bundle = loadSkillBundle(resolve(root, "SKILL.md"));
  const prompt = canonicalPrompt({ mode: "bundled", status: "selected", reasonCode: "bundled-configured", bundle, rejections: [] });
  assert.ok(prompt.endsWith(bundle.skillBody));
  assert.ok(bundle.skillText.startsWith("---\nname: odai\n"));
  assert.doesNotMatch(prompt, /^name: odai$|^description:/mu);
  assert.match(prompt, /controller owns final delivery; delegate only for a real independent gap with observable net benefit/u);
  assert.match(prompt, /already loaded by this runtime; do not call the skill tool/u);
  assert.ok(prompt.includes(`Canonical source: ${bundle.source} (${bundle.provider})`));
  assert.ok(prompt.includes(`runtime contract: ${bundle.manifest.runtimeContract}; digest: ${bundle.digest}`));
  assert.deepEqual(readSkillBundleFile(bundle, "SKILL.md"), readFileSync(resolve(root, "SKILL.md")));

  const selected = canonicalPrompt({
    mode: "auto", status: "fallback", reasonCode: "candidate-invalid", detail: "incompatible source", bundle, rejections: [],
    evolution: { status: "active", generationId: "generation-test", baseDigest: "base", upstreamDigest: "upstream", rebaseRequired: true },
  });
  assert.match(selected, /Selection fallback: candidate-invalid \(incompatible source\)/u);
  assert.match(selected, /User evolution: generation generation-test; base digest base; current upstream digest upstream; rebase required: true/u);
});

test("metadata remains part of the bundle digest and immutable source snapshot", (t) => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-prompt-snapshot-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  cpSync(root, scratch, { recursive: true });
  const entry = resolve(scratch, "SKILL.md");
  const before = readFileSync(entry, "utf8");
  const first = loadSkillBundle(entry);
  const after = before.replace("name: odai\n", "name: odai\nx-note: metadata-only-change\n");
  assert.notEqual(after, before);
  writeFileSync(entry, after);
  const second = loadSkillBundle(entry);
  assert.equal(first.skillBody, second.skillBody);
  assert.notEqual(first.digest, second.digest);
  assert.equal(readSkillBundleFile(first, "SKILL.md").toString("utf8"), before);
  assert.equal(readSkillBundleFile(second, "SKILL.md").toString("utf8"), after);
});

test("body extraction preserves LF, CRLF, and Markdown separators and rejects invalid entries", (t) => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-prompt-body-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  cpSync(root, scratch, { recursive: true });
  const entry = resolve(scratch, "SKILL.md");
  for (const newline of ["\n", "\r\n"]) {
    const body = ["Governance body", "", "---", "", "Keep all body content."].join(newline);
    const source = ["---", "name: odai", "---", "", body, ""].join(newline);
    writeFileSync(entry, source);
    const bundle = loadSkillBundle(entry);
    assert.equal(bundle.skillBody, body);
    assert.equal(readSkillBundleFile(bundle, "SKILL.md").toString("utf8"), source);
  }
  for (const source of ["name: odai\nBody", "---\nname: other\n---\nBody", "---\nname: odai\nBody"]) {
    writeFileSync(entry, source);
    assert.throws(() => loadSkillBundle(entry), /does not declare name odai/u);
  }
  writeFileSync(entry, "---\nname: odai\n---\n");
  assert.throws(() => loadSkillBundle(entry), /skill body is empty/u);
});
