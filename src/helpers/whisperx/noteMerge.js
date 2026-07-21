// Deterministic merge of per-chunk note extraction fragments (spec 04 §7).
// Code merges — the LLM never merges unvalidated chunk outputs. Rules:
// normalize whitespace/case for duplicate detection, keep the earliest
// occurrence's wording, union evidence IDs in transcript order, never merge
// action items that differ materially (owner/status/due date), preserve
// disagreement, sort by earliest evidence timestamp, assign stable final IDs.

const { NOTE_EXTRACTION_CATEGORIES } = require("./constants");
const { normalizeForMatch } = require("./noteEvidence");

const CATEGORY_ID_PREFIX = {
  summaryClaims: "summary",
  discussionPoints: "discussion",
  decisions: "decision",
  proposals: "proposal",
  actionItems: "action",
  followUps: "followup",
  openQuestions: "question",
  risksOrBlockers: "risk",
  importantQuotes: "quote",
  unresolvedAmbiguities: "ambiguity",
};

function claimTextOf(category, item) {
  if (category === "actionItems") return item.task;
  if (category === "importantQuotes") return item.quote;
  return item.text;
}

function dedupeKey(category, item) {
  const base = normalizeForMatch(claimTextOf(category, item));
  if (category === "actionItems") {
    // Materially different action items must never merge (spec 04 §7).
    return [
      base,
      item.ownerSpeakerId || "null",
      item.status || "unclear",
      normalizeForMatch(item.dueDateText || ""),
    ].join("|");
  }
  if (category === "importantQuotes") {
    return [base, item.speakerId || "null"].join("|");
  }
  return base;
}

function earliestEvidenceStart(item, segmentStartById) {
  let earliest = Infinity;
  for (const id of item.evidence.segmentIds) {
    const start = segmentStartById.get(id);
    if (start !== undefined && start < earliest) earliest = start;
  }
  return earliest;
}

// fragments: NoteExtraction-shaped objects (chunk outputs, already
// structurally validated). transcript supplies evidence ordering.
// Returns a merged extraction body (categories only — caller adds metadata).
function mergeFragments(fragments, transcript) {
  const segmentStartById = new Map();
  const segmentOrderById = new Map();
  (transcript.segments || []).forEach((segment, index) => {
    segmentStartById.set(segment.id, segment.start);
    segmentOrderById.set(segment.id, index);
  });

  const merged = {};
  for (const category of NOTE_EXTRACTION_CATEGORIES) {
    const byKey = new Map();

    for (const fragment of fragments) {
      const items = fragment[category];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const key = dedupeKey(category, item);
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, {
            ...item,
            evidence: { segmentIds: [...new Set(item.evidence.segmentIds)] },
          });
        } else {
          // Union evidence; keep earliest wording (first occurrence wins —
          // fragments arrive in chunk order, which follows transcript order).
          const union = new Set([...existing.evidence.segmentIds, ...item.evidence.segmentIds]);
          existing.evidence.segmentIds = [...union];
          existing.reviewRequired = existing.reviewRequired || item.reviewRequired || undefined;
        }
      }
    }

    const items = [...byKey.values()];
    // Evidence IDs in transcript order.
    for (const item of items) {
      item.evidence.segmentIds.sort(
        (a, b) => (segmentOrderById.get(a) ?? Infinity) - (segmentOrderById.get(b) ?? Infinity)
      );
    }
    // Items sorted by earliest cited timestamp, then normalized text for
    // total determinism.
    items.sort((a, b) => {
      const delta =
        earliestEvidenceStart(a, segmentStartById) - earliestEvidenceStart(b, segmentStartById);
      if (delta !== 0) return delta;
      // Codepoint comparison, NOT localeCompare: the tiebreak (and therefore
      // final item ids and rendered bytes) must not vary with the host locale.
      const ta = normalizeForMatch(claimTextOf(category, a));
      const tb = normalizeForMatch(claimTextOf(category, b));
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    // Stable final IDs.
    const prefix = CATEGORY_ID_PREFIX[category];
    items.forEach((item, index) => {
      item.id = `${prefix}-${String(index + 1).padStart(3, "0")}`;
    });
    merged[category] = items;
  }
  return merged;
}

module.exports = { mergeFragments, dedupeKey };
