// Evidence validation for note extractions (spec 04 §6, FR-053..057, 11 §E).
// Deterministic, code-level checks that run REGARDLESS of strict-mode LLM
// verification: every claim must resolve to real transcript segments, quotes
// must match cited text (whitespace/punctuation-normalized), owners and due
// dates must be explicit in the cited evidence. Errors block rendering;
// review issues render only with a visible marker.

const { NOTE_EXTRACTION_CATEGORIES } = require("./constants");

// Whitespace/punctuation normalization for quote + due-date matching.
// NFC-normalizes, strips punctuation, collapses whitespace, casefolds.
// This is intentionally the ONLY looseness allowed by spec 04 §4 rule 8.
const PUNCT_RE = /[.,;:!?¿¡"'“”‘’«»…()\-–—[\]{}<>\/\\*_~`|]/g;

function normalizeForMatch(text) {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFC")
    .replace(PUNCT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function itemsWithCategory(extraction) {
  const out = [];
  for (const category of NOTE_EXTRACTION_CATEGORIES) {
    const items = extraction[category];
    if (!Array.isArray(items)) continue;
    for (const item of items) out.push({ category, item });
  }
  return out;
}

function claimTextOf(category, item) {
  if (category === "actionItems") return item.task;
  if (category === "importantQuotes") return item.quote;
  return item.text;
}

// Validates a structurally-valid NoteExtraction against its canonical
// transcript. Returns { valid, issues: NoteValidationIssue[], extraction }.
// `speakerMappings` (optional {SPEAKER_00: "Name"}) widens owner matching to
// manually mapped display names.
function validateEvidence(extraction, transcript, { speakerMappings = {} } = {}) {
  const issues = [];
  const push = (code, itemId, message, severity) =>
    issues.push({ code, itemId, message, severity });

  const segmentById = new Map();
  for (const segment of transcript.segments || []) {
    segmentById.set(segment.id, segment);
  }
  const speakerIds = new Set((transcript.speakers || []).map((s) => s.id));

  const seenNormalizedByCategory = new Map();

  for (const { category, item } of itemsWithCategory(extraction)) {
    const itemId = item.id || "(missing-id)";

    // --- evidence resolution -------------------------------------------
    const segmentIds = item.evidence && Array.isArray(item.evidence.segmentIds)
      ? item.evidence.segmentIds
      : [];
    if (segmentIds.length === 0) {
      push("MISSING_EVIDENCE", itemId, "Item cites no evidence segments", "error");
      continue;
    }
    const citedSegments = [];
    let unknown = false;
    for (const segId of segmentIds) {
      const segment = segmentById.get(segId);
      if (!segment) {
        push("UNKNOWN_SEGMENT", itemId, `Evidence segment "${segId}" does not exist`, "error");
        unknown = true;
      } else {
        citedSegments.push(segment);
      }
    }
    if (unknown) continue;
    citedSegments.sort((a, b) => a.start - b.start || a.sequence - b.sequence);
    const citedTextNormalized = normalizeForMatch(
      citedSegments.map((s) => s.text).join(" ")
    );

    // --- claim text ------------------------------------------------------
    const claimText = claimTextOf(category, item);
    if (typeof claimText !== "string" || claimText.trim().length === 0) {
      push("EMPTY_CLAIM", itemId, "Claim text is empty", "error");
      continue;
    }

    // --- duplicates (post-merge safety net) ------------------------------
    const dupKey = normalizeForMatch(claimText);
    const seenSet = seenNormalizedByCategory.get(category) || new Set();
    if (seenSet.has(dupKey)) {
      push("DUPLICATE_ITEM", itemId, "Duplicate item within category", "review");
    }
    seenSet.add(dupKey);
    seenNormalizedByCategory.set(category, seenSet);

    // --- quotes must be verbatim (normalized) in cited text ---------------
    if (category === "importantQuotes") {
      const quoteNormalized = normalizeForMatch(item.quote);
      if (quoteNormalized.length === 0 || !citedTextNormalized.includes(quoteNormalized)) {
        push(
          "QUOTE_NOT_FOUND",
          itemId,
          "Quote is not a whitespace/punctuation-normalized match of the cited transcript text",
          "error"
        );
      }
      if (item.speakerId !== null && item.speakerId !== undefined) {
        if (!speakerIds.has(item.speakerId)) {
          push("UNKNOWN_SPEAKER", itemId, `Speaker "${item.speakerId}" not in transcript`, "error");
        } else {
          const speakerCited = citedSegments.some((s) => s.speakerId === item.speakerId);
          if (!speakerCited) {
            push(
              "UNKNOWN_SPEAKER",
              itemId,
              "Attributed speaker does not speak in any cited segment",
              "error"
            );
          }
        }
      }
    }

    // --- action items: owner + due date must be explicit ------------------
    if (category === "actionItems") {
      if (item.ownerSpeakerId !== null && item.ownerSpeakerId !== undefined) {
        if (!speakerIds.has(item.ownerSpeakerId)) {
          push(
            "UNKNOWN_SPEAKER",
            itemId,
            `Owner speaker "${item.ownerSpeakerId}" not in transcript`,
            "error"
          );
        } else {
          const ownerSpeaks = citedSegments.some((s) => s.speakerId === item.ownerSpeakerId);
          const mappedName = speakerMappings[item.ownerSpeakerId];
          const nameMentioned =
            mappedName && citedTextNormalized.includes(normalizeForMatch(mappedName));
          if (!ownerSpeaks && !nameMentioned) {
            push(
              "OWNER_NOT_EXPLICIT",
              itemId,
              "Owner is not evidenced by the cited segments (owner never speaks there and no mapped name is mentioned)",
              "error"
            );
          }
        }
      }
      if (item.dueDateText !== null && item.dueDateText !== undefined) {
        const dueNormalized = normalizeForMatch(item.dueDateText);
        if (dueNormalized.length === 0 || !citedTextNormalized.includes(dueNormalized)) {
          push(
            "DATE_NOT_EXPLICIT",
            itemId,
            "dueDateText does not appear in the cited transcript text",
            "error"
          );
        }
      }
    }
  }

  const hasError = issues.some((i) => i.severity === "error");
  return { valid: !hasError, issues, extraction };
}

// Applies strict-verifier results (spec 04 §8) onto a validation result:
// unsupported → error issue (blocks); partially-supported/unclear → review.
function applyVerifierResults(validation, verifierResults) {
  const issues = [...validation.issues];
  for (const result of verifierResults || []) {
    if (result.result === "supported") continue;
    if (result.result === "unsupported") {
      issues.push({
        code: "UNSUPPORTED_CLAIM",
        itemId: result.itemId,
        message: result.reason || "Strict verification found the claim unsupported",
        severity: "error",
      });
    } else {
      issues.push({
        code: "UNSUPPORTED_CLAIM",
        itemId: result.itemId,
        message: result.reason || `Strict verification: ${result.result}`,
        severity: "review",
      });
    }
  }
  const hasError = issues.some((i) => i.severity === "error");
  return { valid: !hasError, issues, extraction: validation.extraction };
}

// Marks reviewRequired on items with review-severity issues and DROPS items
// with error-severity issues (strictness "drop-invalid") or fails the whole
// run (strictness "fail-run"). Never silently keeps unsupported text.
function applyIssuePolicy(extraction, issues, { strictness = "drop-invalid" } = {}) {
  const errorIds = new Set(issues.filter((i) => i.severity === "error").map((i) => i.itemId));
  const reviewIds = new Set(issues.filter((i) => i.severity === "review").map((i) => i.itemId));

  if (strictness === "fail-run" && errorIds.size > 0) {
    return { extraction: null, dropped: [...errorIds] };
  }
  const out = { ...extraction };
  const dropped = [];
  for (const category of NOTE_EXTRACTION_CATEGORIES) {
    const items = extraction[category];
    if (!Array.isArray(items)) continue;
    out[category] = items
      .filter((item) => {
        if (errorIds.has(item.id)) {
          dropped.push(item.id);
          return false;
        }
        return true;
      })
      .map((item) => (reviewIds.has(item.id) ? { ...item, reviewRequired: true } : item));
  }
  return { extraction: out, dropped };
}

module.exports = {
  validateEvidence,
  applyVerifierResults,
  applyIssuePolicy,
  normalizeForMatch,
};
