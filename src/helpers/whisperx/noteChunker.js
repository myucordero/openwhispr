// Segment-aware transcript chunker (spec 04 §3).
// Chunks by WHOLE segments with a small overlap of complete segments, using
// a conservative character-based token estimate. Never splits a segment
// unless that single segment alone exceeds the budget (then it goes into its
// own oversized chunk — the extraction prompt still receives it whole).

const CHARS_PER_TOKEN = 3.2; // conservative for bilingual es/en text

function estimateTokens(text) {
  return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

// Serialized form each segment takes inside the prompt (id + timestamps +
// speaker + text) — the estimate must count that envelope, not just text.
function segmentPromptLength(segment) {
  const speaker = segment.speakerId ? segment.speakerId.length + 3 : 0;
  return segment.id.length + 24 + speaker + (segment.text || "").length;
}

// options:
//   maxInputTokens   — default 9000 (16K runtime context minus prompt/output)
//   overlapSegments  — default 2 complete segments carried into the next chunk
function chunkSegments(segments, { maxInputTokens = 9000, overlapSegments = 2 } = {}) {
  const maxChars = maxInputTokens * CHARS_PER_TOKEN;
  const chunks = [];
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentChars = 0;
  };

  for (const segment of segments) {
    const size = segmentPromptLength(segment);
    if (size > maxChars) {
      // Oversized single segment: it gets its own chunk, is never split, and
      // never enters an overlap window (it would otherwise be re-sent to the
      // LLM once per subsequent chunk).
      flush();
      chunks.push([segment]);
      continue;
    }
    if (currentChars + size > maxChars && current.length > 0) {
      const overlap = current.slice(-overlapSegments);
      flush();
      // Seed the next chunk with the overlap (never counted as "new" — they
      // are deduplicated after extraction by the deterministic merge).
      current = [...overlap];
      currentChars = overlap.reduce((acc, s) => acc + segmentPromptLength(s), 0);
    }
    current.push(segment);
    currentChars += size;
  }
  flush();

  return chunks.map((chunkSegments_, index) => ({
    chunkId: `chunk-${String(index + 1).padStart(3, "0")}`,
    index,
    segments: chunkSegments_,
    segmentIdRange: {
      first: chunkSegments_[0].id,
      last: chunkSegments_[chunkSegments_.length - 1].id,
    },
    estimatedTokens: Math.ceil(
      chunkSegments_.reduce((acc, s) => acc + segmentPromptLength(s), 0) / CHARS_PER_TOKEN
    ),
  }));
}

// Serializes a chunk into the data block handed to the extraction prompt.
// Transcript text is DATA — it is fenced and never concatenated into
// instructions (spec 07 §9). Spoken text that happens to contain the fence
// sentinel is neutralized so it cannot close the data block early.
function serializeChunk(chunk) {
  const lines = chunk.segments.map((segment) => {
    const speaker = segment.speakerId ? ` speaker=${segment.speakerId}` : "";
    const text = segment.text.replace(/TRANSCRIPT>>>/g, "TRANSCRIPT>»>").replace(/<<<TRANSCRIPT/g, "<«<TRANSCRIPT");
    return `[${segment.id} start=${segment.start.toFixed(2)} end=${segment.end.toFixed(2)}${speaker}] ${text}`;
  });
  return lines.join("\n");
}

module.exports = { chunkSegments, serializeChunk, estimateTokens, CHARS_PER_TOKEN };
