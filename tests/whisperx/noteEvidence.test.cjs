const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  validateEvidence,
  applyVerifierResults,
  applyIssuePolicy,
  normalizeForMatch,
} = require("../../src/helpers/whisperx/noteEvidence");

const fixturesDir = path.resolve(__dirname, "../fixtures/whisperx-contracts");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

function transcript() {
  return loadFixture("valid-transcript.json");
}

function noteExtraction() {
  return loadFixture("valid-note-extraction.json");
}

test("validateEvidence: fixture pair", async (t) => {
  await t.test("valid-note-extraction against valid-transcript passes clean", () => {
    const r = validateEvidence(noteExtraction(), transcript());
    assert.equal(r.valid, true);
    assert.deepEqual(r.issues, []);
  });

  await t.test("unknown segment id -> UNKNOWN_SEGMENT", () => {
    const extraction = {
      summaryClaims: [
        {
          id: "s1",
          text: "Some claim.",
          evidence: { segmentIds: ["seg-9999"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === "UNKNOWN_SEGMENT" && i.itemId === "s1"));
  });

  await t.test("empty segmentIds -> MISSING_EVIDENCE", () => {
    const extraction = {
      summaryClaims: [{ id: "s1", text: "Some claim.", evidence: { segmentIds: [] } }],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === "MISSING_EVIDENCE" && i.itemId === "s1"));
  });

  await t.test("quote with different punctuation/case/whitespace passes (normalized match)", () => {
    const extraction = {
      importantQuotes: [
        {
          id: "q1",
          quote: "buenos   DIAS a todos empecemos con el proyecto atlas",
          speakerId: "SPEAKER_00",
          evidence: { segmentIds: ["seg-0001"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, true);
    assert.deepEqual(r.issues, []);
  });

  await t.test("quote with a changed word -> QUOTE_NOT_FOUND", () => {
    const extraction = {
      importantQuotes: [
        {
          id: "q1",
          quote: "Buenos dias a todos, empecemos con el proyecto Mercury.",
          speakerId: "SPEAKER_00",
          evidence: { segmentIds: ["seg-0001"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === "QUOTE_NOT_FOUND" && i.itemId === "q1"));
  });

  await t.test("quote spanning two adjacent cited segments passes", () => {
    // Tail of seg-0001 + head of seg-0002, punctuation-normalized.
    const extraction = {
      importantQuotes: [
        {
          id: "q1",
          quote: "proyecto Atlas. Sounds good.",
          speakerId: null,
          evidence: { segmentIds: ["seg-0002", "seg-0001"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, true);
    assert.deepEqual(r.issues, []);
  });

  await t.test("importantQuote speakerId who never speaks in cited segments -> UNKNOWN_SPEAKER", () => {
    const extraction = {
      importantQuotes: [
        {
          id: "q1",
          quote: "Buenos dias a todos, empecemos con el proyecto Atlas.",
          speakerId: "SPEAKER_01",
          evidence: { segmentIds: ["seg-0001"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, false);
    assert.ok(
      r.issues.some(
        (i) => i.code === "UNKNOWN_SPEAKER" && i.itemId === "q1" && i.severity === "error"
      )
    );
  });

  await t.test("actionItem ownerSpeakerId not speaking, no mapping -> OWNER_NOT_EXPLICIT", () => {
    const extraction = {
      actionItems: [
        {
          id: "a1",
          task: "Do the thing.",
          ownerSpeakerId: "SPEAKER_00",
          dueDateText: null,
          evidence: { segmentIds: ["seg-0002"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === "OWNER_NOT_EXPLICIT" && i.itemId === "a1"));
  });

  await t.test("owner not speaking but speakerMappings names them in cited text -> passes", () => {
    const extraction = {
      actionItems: [
        {
          id: "a1",
          task: "Do something related to Atlas.",
          ownerSpeakerId: "SPEAKER_01",
          dueDateText: null,
          evidence: { segmentIds: ["seg-0001"] },
        },
      ],
    };
    // seg-0001 text mentions "Atlas"; map the (non-speaking) owner id to that name.
    const r = validateEvidence(extraction, transcript(), {
      speakerMappings: { SPEAKER_01: "Atlas" },
    });
    assert.equal(r.valid, true);
    assert.deepEqual(r.issues, []);
  });

  await t.test("actionItem dueDateText not present in cited text -> DATE_NOT_EXPLICIT", () => {
    const extraction = {
      actionItems: [
        {
          id: "a1",
          task: "Prepare a migration plan.",
          ownerSpeakerId: "SPEAKER_01",
          dueDateText: "next Friday",
          evidence: { segmentIds: ["seg-0004"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.code === "DATE_NOT_EXPLICIT" && i.itemId === "a1"));
  });

  await t.test("dueDateText exactly quoted (punctuation differences) -> passes", () => {
    const extraction = {
      actionItems: [
        {
          id: "a1",
          task: "Prepare a migration plan.",
          ownerSpeakerId: "SPEAKER_01",
          dueDateText: "before next sprint",
          evidence: { segmentIds: ["seg-0004"] },
        },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, true);
    assert.deepEqual(r.issues, []);
  });

  await t.test("two items, same category, same normalized text -> DUPLICATE_ITEM (review), valid stays true", () => {
    const extraction = {
      summaryClaims: [
        { id: "s1", text: "We decided on SQLite.", evidence: { segmentIds: ["seg-0003"] } },
        { id: "s2", text: "we decided on sqlite!!", evidence: { segmentIds: ["seg-0003"] } },
      ],
    };
    const r = validateEvidence(extraction, transcript());
    assert.equal(r.valid, true);
    const dup = r.issues.find((i) => i.code === "DUPLICATE_ITEM");
    assert.ok(dup, "expected a DUPLICATE_ITEM issue");
    assert.equal(dup.severity, "review");
    assert.equal(dup.itemId, "s2");
  });
});

test("normalizeForMatch unit cases", async (t) => {
  await t.test("NFC-normalizes accented characters (decomposed vs precomposed)", () => {
    const decomposed = "cafe\u0301"; // e + combining acute accent (NFD)
    const precomposed = "caf\u00e9"; // single precomposed codepoint (NFC)
    assert.equal(normalizeForMatch(decomposed), normalizeForMatch(precomposed));
    assert.equal(normalizeForMatch(precomposed), "caf\u00e9");
  });

  await t.test("strips punctuation", () => {
    assert.equal(normalizeForMatch("Hello, World!!"), "hello world");
  });

  await t.test("casefolds", () => {
    assert.equal(normalizeForMatch("HELLO"), "hello");
  });

  await t.test("collapses whitespace and trims", () => {
    assert.equal(normalizeForMatch("  a   b\tc  "), "a b c");
  });

  await t.test("non-string input returns empty string", () => {
    assert.equal(normalizeForMatch(null), "");
    assert.equal(normalizeForMatch(undefined), "");
  });
});

test("applyIssuePolicy", async (t) => {
  await t.test("drop-invalid removes error items, flags review items, returns dropped ids", () => {
    const extraction = {
      summaryClaims: [
        { id: "keep-1", text: "Kept claim." },
        { id: "err-1", text: "Bad claim." },
        { id: "review-1", text: "Needs review claim." },
      ],
      decisions: [],
    };
    const issues = [
      { code: "UNKNOWN_SEGMENT", itemId: "err-1", severity: "error" },
      { code: "DUPLICATE_ITEM", itemId: "review-1", severity: "review" },
    ];
    const { extraction: out, dropped } = applyIssuePolicy(extraction, issues, {
      strictness: "drop-invalid",
    });
    const ids = out.summaryClaims.map((i) => i.id);
    assert.deepEqual(ids, ["keep-1", "review-1"]);
    assert.deepEqual(dropped, ["err-1"]);
    const reviewItem = out.summaryClaims.find((i) => i.id === "review-1");
    assert.equal(reviewItem.reviewRequired, true);
    const keptItem = out.summaryClaims.find((i) => i.id === "keep-1");
    assert.equal(keptItem.reviewRequired, undefined);
  });

  await t.test("fail-run with errors -> extraction is null", () => {
    const extraction = { summaryClaims: [{ id: "err-1", text: "Bad claim." }] };
    const issues = [{ code: "UNKNOWN_SEGMENT", itemId: "err-1", severity: "error" }];
    const { extraction: out, dropped } = applyIssuePolicy(extraction, issues, {
      strictness: "fail-run",
    });
    assert.equal(out, null);
    assert.deepEqual(dropped, ["err-1"]);
  });

  await t.test("fail-run with only review issues -> extraction kept", () => {
    const extraction = { summaryClaims: [{ id: "review-1", text: "Needs review." }] };
    const issues = [{ code: "DUPLICATE_ITEM", itemId: "review-1", severity: "review" }];
    const { extraction: out, dropped } = applyIssuePolicy(extraction, issues, {
      strictness: "fail-run",
    });
    assert.notEqual(out, null);
    assert.equal(out.summaryClaims[0].id, "review-1");
    assert.equal(out.summaryClaims[0].reviewRequired, true);
    assert.deepEqual(dropped, []);
  });
});

test("applyVerifierResults", async (t) => {
  function baseValidation() {
    return { valid: true, issues: [], extraction: { schemaVersion: 1 } };
  }

  await t.test("unsupported -> error issue added, valid false", () => {
    const r = applyVerifierResults(baseValidation(), [
      { itemId: "a1", result: "unsupported", reason: "No evidence for this." },
    ]);
    assert.equal(r.valid, false);
    const issue = r.issues.find((i) => i.itemId === "a1");
    assert.equal(issue.code, "UNSUPPORTED_CLAIM");
    assert.equal(issue.severity, "error");
  });

  await t.test("partially-supported -> review issue, valid stays true", () => {
    const r = applyVerifierResults(baseValidation(), [
      { itemId: "a1", result: "partially-supported", reason: "Half of it checks out." },
    ]);
    assert.equal(r.valid, true);
    const issue = r.issues.find((i) => i.itemId === "a1");
    assert.equal(issue.code, "UNSUPPORTED_CLAIM");
    assert.equal(issue.severity, "review");
  });

  await t.test("unclear -> review issue, valid stays true", () => {
    const r = applyVerifierResults(baseValidation(), [
      { itemId: "a1", result: "unclear", reason: "Ambiguous." },
    ]);
    assert.equal(r.valid, true);
    assert.equal(r.issues.find((i) => i.itemId === "a1").severity, "review");
  });

  await t.test("supported -> nothing added", () => {
    const r = applyVerifierResults(baseValidation(), [
      { itemId: "a1", result: "supported", reason: "Matches evidence." },
    ]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.issues, []);
  });
});
