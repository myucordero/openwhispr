const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { chunkSegments, serializeChunk } = require("../../src/helpers/whisperx/noteChunker");

const fixturesDir = path.resolve(__dirname, "../fixtures/whisperx-contracts");

function segments() {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, "valid-transcript.json"), "utf8"))
    .segments;
}

test("chunkSegments: few short segments fit in a single chunk", () => {
  const segs = segments();
  const chunks = chunkSegments(segs);
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    chunks[0].segments.map((s) => s.id),
    segs.map((s) => s.id)
  );
  assert.equal(chunks[0].chunkId, "chunk-001");
  assert.equal(chunks[0].segmentIdRange.first, "seg-0001");
  assert.equal(chunks[0].segmentIdRange.last, "seg-0004");
  assert.ok(chunks[0].estimatedTokens > 0);
});

test("chunkSegments: tiny maxInputTokens forces multiple overlapping chunks", () => {
  const segs = segments();
  // 80 tokens keeps every fixture segment under the per-segment budget, so
  // the plain-overlap invariant below holds. (At 60, seg-0004 is oversized
  // and correctly gets an isolated no-overlap chunk — covered by the
  // dedicated oversized-segment test.)
  const chunks = chunkSegments(segs, { maxInputTokens: 80 });

  assert.ok(chunks.length > 1, "expected multiple chunks");

  // Sequential, zero-padded chunk ids.
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.chunkId, `chunk-${String(index + 1).padStart(3, "0")}`);
    assert.equal(chunk.index, index);
    assert.ok(chunk.estimatedTokens > 0);
    assert.equal(chunk.segmentIdRange.first, chunk.segments[0].id);
    assert.equal(chunk.segmentIdRange.last, chunk.segments[chunk.segments.length - 1].id);
  });

  // No segment lost: union of every chunk's segments covers the whole transcript.
  const union = new Set();
  for (const chunk of chunks) {
    for (const s of chunk.segments) union.add(s.id);
  }
  assert.deepEqual([...union].sort(), segs.map((s) => s.id).sort());

  // Each chunk after the first starts with the previous chunk's trailing
  // overlap segments (up to 2, or fewer if the previous chunk was shorter).
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].segments;
    const overlapCount = Math.min(2, prev.length);
    const expectedOverlapIds = prev.slice(-overlapCount).map((s) => s.id);
    const actualPrefixIds = chunks[i].segments.slice(0, overlapCount).map((s) => s.id);
    assert.deepEqual(
      actualPrefixIds,
      expectedOverlapIds,
      `chunk ${i} should start with chunk ${i - 1}'s last ${overlapCount} segment(s)`
    );
  }
});

test("chunkSegments: a single oversized segment gets its own chunk and is never split (spec 04 §3)", () => {
  const segs = segments();
  const huge = {
    id: "seg-huge",
    sequence: 10,
    start: 30,
    end: 90,
    speakerId: "SPEAKER_00",
    text: "x".repeat(5000),
  };
  // Insert the oversized segment in the middle of otherwise-normal segments.
  const all = [segs[0], segs[1], huge, segs[2], segs[3]];
  const chunks = chunkSegments(all, { maxInputTokens: 100 });

  // The oversized segment's text must never be split across chunk boundaries:
  // it must appear, whole, in exactly one chunk...
  const chunksWithHuge = chunks.filter((c) => c.segments.some((s) => s.id === "seg-huge"));
  assert.equal(
    chunksWithHuge.length,
    1,
    "the oversized segment must not be duplicated across multiple chunks"
  );

  // ...and per the module's own contract ("goes into its own oversized
  // chunk"), that chunk must contain ONLY the oversized segment, not bundled
  // together with unrelated overlap segments from neighboring chunks.
  assert.deepEqual(
    chunksWithHuge[0].segments.map((s) => s.id),
    ["seg-huge"],
    "the oversized segment should be isolated into its own chunk, not merged with overlap segments"
  );
});

test("serializeChunk: line format matches fixture numbers exactly", () => {
  const segs = segments();
  const chunk = { segments: [segs[0], segs[1]] };
  const serialized = serializeChunk(chunk);
  const expected = [
    "[seg-0001 start=0.00 end=4.20 speaker=SPEAKER_00] Buenos dias a todos, empecemos con el proyecto Atlas.",
    "[seg-0002 start=4.00 end=9.50 speaker=SPEAKER_01] Sounds good. I think we should finalize the database choice today.",
  ].join("\n");
  assert.equal(serialized, expected);
});

test("serializeChunk: segments without speakerId omit ' speaker='", () => {
  const segs = segments();
  const noSpeaker = { ...segs[0], speakerId: undefined };
  const serialized = serializeChunk({ segments: [noSpeaker] });
  assert.equal(
    serialized,
    "[seg-0001 start=0.00 end=4.20] Buenos dias a todos, empecemos con el proyecto Atlas."
  );
  assert.ok(!serialized.includes(" speaker="));
});
