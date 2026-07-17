const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  wer,
  cer,
  domainErrorMetrics,
  speakerAttributionAccuracy,
  timestampBoundaryError,
  noteGroundingMetrics,
} = require("../../src/helpers/whisperx/benchmarkMetrics.js");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "whisperx-contracts");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

// --------------------------------------------------------------------------
// wer
// --------------------------------------------------------------------------

test("wer: single substitution", () => {
  const result = wer("a b c", "a x c");
  assert.equal(result.substitutions, 1);
  assert.equal(result.insertions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.referenceWords, 3);
  assert.equal(result.wer, 1 / 3);
});

test("wer: insertion in hypothesis", () => {
  // reference "a b c" vs hypothesis "a b x c" -> one insertion.
  const result = wer("a b c", "a b x c");
  assert.equal(result.insertions, 1);
  assert.equal(result.substitutions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.wer, 1 / 3);
});

test("wer: deletion (word missing from hypothesis)", () => {
  // reference "a b c" vs hypothesis "a c" -> one deletion.
  const result = wer("a b c", "a c");
  assert.equal(result.deletions, 1);
  assert.equal(result.substitutions, 0);
  assert.equal(result.insertions, 0);
  assert.equal(result.wer, 1 / 3);
});

test("wer: identical text is zero error, punctuation/case-insensitive", () => {
  const result = wer("Hello, World!", "hello world");
  assert.equal(result.wer, 0);
  assert.equal(result.referenceWords, 2);
});

test("wer: empty reference guard — empty hypothesis is a perfect match", () => {
  const result = wer("", "");
  assert.equal(result.referenceWords, 0);
  assert.equal(result.wer, 0);
});

test("wer: empty reference guard — non-empty hypothesis has no meaningful rate", () => {
  const result = wer("", "some words here");
  assert.equal(result.referenceWords, 0);
  assert.equal(result.wer, null);
  assert.equal(result.insertions, 3);
});

// --------------------------------------------------------------------------
// cer
// --------------------------------------------------------------------------

test("cer: single character substitution", () => {
  const result = cer("cat", "cot");
  assert.equal(result.substitutions, 1);
  assert.equal(result.referenceChars, 3);
  assert.equal(result.cer, 1 / 3);
});

test("cer: whitespace collapsed before diffing", () => {
  const result = cer("a  b   c", "a b c");
  assert.equal(result.cer, 0);
});

test("cer: empty reference guard", () => {
  const result = cer("", "abc");
  assert.equal(result.cer, null);
  assert.equal(result.referenceChars, 0);
});

// --------------------------------------------------------------------------
// domainErrorMetrics
// --------------------------------------------------------------------------

test("domainErrorMetrics: finds terms despite punctuation/case variance", () => {
  const result = domainErrorMetrics(
    ["Atlas", "SQLite", "2026-07-16"],
    "we're using SQLITE, per the ATLAS plan, from 2026-07-16."
  );
  assert.equal(result.totalTerms, 3);
  assert.equal(result.foundCount, 3);
  assert.equal(result.missedCount, 0);
  assert.equal(result.hitRate, 1);
  assert.ok(result.terms.every((t) => t.found));
});

test("domainErrorMetrics: reports missed terms", () => {
  const result = domainErrorMetrics(["Atlas", "Neptune"], "the atlas project is on track");
  assert.equal(result.foundCount, 1);
  assert.equal(result.missedCount, 1);
  assert.equal(result.hitRate, 0.5);
  const neptune = result.terms.find((t) => t.term === "Neptune");
  assert.equal(neptune.found, false);
});

test("domainErrorMetrics: empty term list has null hitRate", () => {
  const result = domainErrorMetrics([], "anything");
  assert.equal(result.totalTerms, 0);
  assert.equal(result.hitRate, null);
});

// --------------------------------------------------------------------------
// speakerAttributionAccuracy
// --------------------------------------------------------------------------

test("speakerAttributionAccuracy: perfect agreement is 1.0", () => {
  const reference = [
    { start: 0, end: 5, speaker: "A" },
    { start: 5, end: 10, speaker: "B" },
  ];
  const hypothesis = [
    { start: 0, end: 5, speaker: "SPEAKER_00" },
    { start: 5, end: 10, speaker: "SPEAKER_01" },
  ];
  const result = speakerAttributionAccuracy(reference, hypothesis);
  assert.equal(result.agreement, 1);
  assert.deepEqual(result.mappedSpeakers, { SPEAKER_00: "A", SPEAKER_01: "B" });
});

test("speakerAttributionAccuracy: swapped hypothesis labels still map to 1.0", () => {
  // Hypothesis consistently calls speaker A "SPEAKER_01" and speaker B
  // "SPEAKER_00" — a relabeling, not a diarization error. Greedy overlap
  // mapping should recover the correct correspondence.
  const reference = [
    { start: 0, end: 5, speaker: "A" },
    { start: 5, end: 10, speaker: "B" },
    { start: 10, end: 15, speaker: "A" },
  ];
  const hypothesis = [
    { start: 0, end: 5, speaker: "SPEAKER_01" },
    { start: 5, end: 10, speaker: "SPEAKER_00" },
    { start: 10, end: 15, speaker: "SPEAKER_01" },
  ];
  const result = speakerAttributionAccuracy(reference, hypothesis);
  assert.equal(result.agreement, 1);
  assert.deepEqual(result.mappedSpeakers, { SPEAKER_01: "A", SPEAKER_00: "B" });
});

test("speakerAttributionAccuracy: partial mismatch scores below 1.0", () => {
  const reference = [
    { start: 0, end: 5, speaker: "A" },
    { start: 5, end: 10, speaker: "B" },
  ];
  const hypothesis = [
    // First half correctly attributed to A, second half wrongly stays "A"
    // instead of switching to the mapped equivalent of B.
    { start: 0, end: 5, speaker: "SPEAKER_00" },
    { start: 5, end: 10, speaker: "SPEAKER_00" },
  ];
  const result = speakerAttributionAccuracy(reference, hypothesis);
  assert.ok(result.agreement < 1);
  assert.ok(result.agreement > 0);
});

test("speakerAttributionAccuracy: no overlap returns null agreement", () => {
  const reference = [{ start: 0, end: 5, speaker: "A" }];
  const hypothesis = [{ start: 100, end: 105, speaker: "SPEAKER_00" }];
  const result = speakerAttributionAccuracy(reference, hypothesis);
  assert.equal(result.agreement, null);
  assert.deepEqual(result.mappedSpeakers, {});
});

// --------------------------------------------------------------------------
// timestampBoundaryError
// --------------------------------------------------------------------------

test("timestampBoundaryError: exact match is zero error", () => {
  const reference = [
    { start: 0, end: 4 },
    { start: 4, end: 9 },
  ];
  const hypothesis = [
    { start: 0, end: 4 },
    { start: 4, end: 9 },
  ];
  const result = timestampBoundaryError(reference, hypothesis);
  assert.equal(result.meanStartError, 0);
  assert.equal(result.matchedCount, 2);
});

test("timestampBoundaryError: uniform 0.5s shift averages to 0.5", () => {
  const reference = [
    { start: 0, end: 4 },
    { start: 4, end: 9 },
  ];
  const hypothesis = [
    { start: 0.5, end: 4.5 },
    { start: 4.5, end: 9.5 },
  ];
  const result = timestampBoundaryError(reference, hypothesis);
  assert.equal(result.meanStartError, 0.5);
  assert.equal(result.matchedCount, 2);
});

test("timestampBoundaryError: no segments on either side is unmatched", () => {
  const result = timestampBoundaryError([], []);
  assert.equal(result.meanStartError, null);
  assert.equal(result.matchedCount, 0);
});

// --------------------------------------------------------------------------
// noteGroundingMetrics
// --------------------------------------------------------------------------

test("noteGroundingMetrics: valid fixture pair has zero evidence-free items", () => {
  const transcript = loadFixture("valid-transcript.json");
  const extraction = loadFixture("valid-note-extraction.json");
  const result = noteGroundingMetrics(extraction, transcript);

  const expectedTotal = 5; // 1 summaryClaim + 1 decision + 1 actionItem + 1 openQuestion + 1 quote
  assert.equal(result.totalItems, expectedTotal);
  assert.equal(result.itemsWithValidEvidence, expectedTotal);
  assert.equal(result.evidenceFreeItems, 0);
  assert.equal(result.unknownSegmentRefs, 0);
  assert.equal(result.invalidQuotes, 0);
  assert.equal(result.reviewRequired, 0);
});

test("noteGroundingMetrics: unknown segment reference is counted, not silently dropped", () => {
  const transcript = loadFixture("valid-transcript.json");
  const extraction = loadFixture("valid-note-extraction.json");
  // Corrupt one evidence reference to a segment id that doesn't exist.
  extraction.decisions[0].evidence.segmentIds = ["seg-does-not-exist"];

  const result = noteGroundingMetrics(extraction, transcript);
  assert.equal(result.totalItems, 5);
  assert.equal(result.unknownSegmentRefs, 1);
  assert.equal(result.itemsWithValidEvidence, 4);
});

test("noteGroundingMetrics: missing evidence array is counted as evidence-free", () => {
  const transcript = loadFixture("valid-transcript.json");
  const extraction = loadFixture("valid-note-extraction.json");
  extraction.importantQuotes[0].evidence = { segmentIds: [] };

  const result = noteGroundingMetrics(extraction, transcript);
  assert.equal(result.evidenceFreeItems, 1);
  assert.equal(result.itemsWithValidEvidence, 4);
});
