import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseResearchPacket,
  renderResearchPacket,
  verifyResearchPacketSources,
} from "../build/research-packet.mjs";

function packet(overrides = {}) {
  return {
    schemaVersion: 1,
    question: "Which facts determine whether client retries are safe?",
    facts: [
      {
        claim: "The client already retries once.",
        excerpt: "retries=1",
        source: { path: "config/checkout.json", line: 4 },
        authority: "runtime configuration",
      },
      {
        claim: "Duplicate charges were observed after timeouts.",
        excerpt: "duplicate after timeout",
        source: { path: "logs/incidents.md", line: 12 },
        authority: "incident record",
      },
    ],
    conflicts: [],
    unknowns: ["Provider idempotency behavior is not documented."],
    stop: "The configured retry and duplicate-charge evidence is established; provider behavior remains explicit unknown.",
    ...overrides,
  };
}

test("research packet validates, freezes, hashes, and renders provenance", () => {
  const parsed = parseResearchPacket(JSON.stringify(packet()));
  assert.equal(parsed.sourceCount, 2);
  assert.equal(parsed.digest.length, 64);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.facts));
  assert.ok(Object.isFrozen(parsed.facts[0].source));
  assert.equal(parseResearchPacket(`\`\`\`json\n${JSON.stringify(packet())}\n\`\`\``).digest, parsed.digest);
  const rendered = renderResearchPacket(parsed);
  assert.match(rendered, new RegExp(`sha256:${parsed.digest}`, "u"));
  assert.match(rendered, /retrieval index, not authority, planning, acceptance, or permission to act/u);
});

test("research packet verifies source existence, boundaries, line numbers, and exact excerpts", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-research-packet-"));
  const outside = mkdtempSync(resolve(tmpdir(), "odai-research-outside-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    mkdirSync(resolve(root, "logs"), { recursive: true });
    writeFileSync(resolve(root, "config/checkout.json"), ["", "", "", "  retries=1  ", ""].join("\n"));
    writeFileSync(resolve(root, "logs/incidents.md"), [
      "", "", "", "", "", "", "", "", "", "", "", "duplicate after timeout", "",
    ].join("\n"));
    writeFileSync(resolve(outside, "secret.md"), "retries=1\n");
    const parsed = parseResearchPacket(JSON.stringify(packet()));
    const verified = verifyResearchPacketSources(parsed, root);
    assert.equal(verified.sourcesVerified, true);
    const single = parseResearchPacket(JSON.stringify(packet({ facts: [packet().facts[0]] })));
    assert.equal(verifyResearchPacketSources(single, root).sourceCount, 1);
    assert.throws(() => verifyResearchPacketSources(parseResearchPacket(JSON.stringify(packet({
      facts: [{ ...packet().facts[0], excerpt: "different" }],
    }))), root), /does not match/u);
    assert.throws(
      () => verifyResearchPacketSources(parseResearchPacket(JSON.stringify(packet({ facts: [
        packet().facts[0],
        { ...packet().facts[1], source: { path: "logs/missing.md", line: 1 } },
      ] }))), root),
      /does not exist/u,
    );
    assert.throws(
      () => verifyResearchPacketSources(parseResearchPacket(JSON.stringify(packet({ facts: [
        packet().facts[0],
        { ...packet().facts[1], source: { path: "logs/incidents.md", line: 99 } },
      ] }))), root),
      /outside the source file/u,
    );
    assert.throws(
      () => verifyResearchPacketSources(parseResearchPacket(JSON.stringify(packet({ facts: [
        { ...packet().facts[0], excerpt: "different" },
        packet().facts[1],
      ] }))), root),
      /does not match/u,
    );
    try {
      symlinkSync(resolve(outside, "secret.md"), resolve(root, "config/escaped.md"));
      assert.throws(
        () => verifyResearchPacketSources(parseResearchPacket(JSON.stringify(packet({ facts: [
          { ...packet().facts[0], source: { path: "config/escaped.md", line: 1 } },
          packet().facts[1],
        ] }))), root),
        /outside the project root/u,
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string"
        || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      t.diagnostic(`symlink escape assertion unavailable in this environment (${error.code})`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("research packet accepts a single source without requiring padding and keeps capacity bounds", () => {
  for (const facts of [
    [packet().facts[0]],
    packet().facts.map((fact, index) => ({ ...fact, source: { path: "config/checkout.json", line: index + 1 } })),
  ]) {
    const parsed = parseResearchPacket(JSON.stringify(packet({ facts })));
    assert.equal(parsed.sourceCount, 1);
    assert.equal(parsed.facts.length, facts.length);
  }
  for (const facts of [[], Array.from({ length: 13 }, () => packet().facts[0])]) {
    assert.throws(() => parseResearchPacket(JSON.stringify(packet({ facts }))), /source-backed facts/u);
  }
});

test("research packet rejects weak or unsafe provenance", () => {
  assert.throws(() => parseResearchPacket(JSON.stringify(packet({ facts: [
    packet().facts[0],
    { ...packet().facts[1], source: { path: "../private.md", line: 1 } },
  ] }))), /may not traverse parent directories/u);
  assert.throws(() => parseResearchPacket(JSON.stringify(packet({ facts: [
    packet().facts[0],
    { ...packet().facts[1], source: { path: "logs/incidents.md", line: 0 } },
  ] }))), /positive integer/u);
  assert.throws(() => parseResearchPacket(JSON.stringify({ ...packet(), recommendation: "retry three times" })), /unknown fields/u);
  assert.throws(() => parseResearchPacket("not json"), /Unexpected token|JSON/u);
});
