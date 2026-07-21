// Deterministic Markdown renderer for validated note extractions
// (spec 04 §9). Application code renders — the LLM never writes the final
// document. Rules: no uncited substantive line, owner names only from the
// manual speaker mapping, review-required items visibly marked, empty
// sections omitted deterministically, citations link into the app via the
// internal openwhispr:// route with plain-timestamp fallback for export.

const { NOTE_EXTRACTION_CATEGORIES } = require("./constants");

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const SECTION_ORDER = [
  { category: "summaryClaims", heading: "Summary", bullet: false },
  { category: "discussionPoints", heading: "Key Discussion Points", bullet: true },
  { category: "decisions", heading: "Decisions Made", bullet: true },
  { category: "proposals", heading: "Proposals", bullet: true },
  { category: "actionItems", heading: "Action Items", bullet: true },
  { category: "followUps", heading: "Follow-ups", bullet: true },
  { category: "openQuestions", heading: "Open Questions", bullet: true },
  { category: "risksOrBlockers", heading: "Risks and Blockers", bullet: true },
  { category: "importantQuotes", heading: "Important Quotes", bullet: true },
  { category: "unresolvedAmbiguities", heading: "Unresolved Ambiguities", bullet: true },
];

// Per-profile section restriction (spec 00 §5 / profiles noteSections would
// be ideal, but the extraction schema is shared — profiles simply leave
// unused categories empty and empty sections are omitted anyway).
const REVIEW_MARKER = "⚠️ *Needs review*";

// Permanent provenance notice (spec §20): evidence-linked ≠ human-verified.
const PROVENANCE_NOTICE =
  "> Generated from automated transcription. Evidence-linked does not mean human-verified.";

class NoteRenderError extends Error {
  constructor(message, itemId) {
    super(message);
    this.name = "NoteRenderError";
    this.itemId = itemId;
  }
}

// options:
//   jobId              — for internal citation links
//   transcript         — canonical transcript (segment timestamps)
//   speakerMappings    — {SPEAKER_00: "Marco"} manual display names
//   linkMode           — "app" (openwhispr:// links) | "plain" (timestamps only)
//   maxCitationsPerItem — default 3
function renderNotesMarkdown(extraction, options) {
  const {
    jobId,
    transcript,
    speakerMappings = {},
    linkMode = "app",
    maxCitationsPerItem = 3,
    title = null,
  } = options;

  const segmentById = new Map();
  for (const segment of transcript.segments || []) segmentById.set(segment.id, segment);

  const citation = (segmentIds, itemId) => {
    const cited = segmentIds
      .map((id) => segmentById.get(id))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.sequence - b.sequence)
      .slice(0, maxCitationsPerItem);
    if (cited.length === 0) {
      // Validation must have caught this; refuse to render uncited content.
      throw new NoteRenderError("Refusing to render an uncited item", itemId);
    }
    return cited
      .map((segment) => {
        const ts = formatTimestamp(segment.start);
        if (linkMode === "app") {
          return `[${ts}](openwhispr://recording/${jobId}/t/${segment.id})`;
        }
        return `[${ts}]`;
      })
      .join(" ");
  };

  const speakerName = (speakerId) => {
    if (!speakerId) return null;
    return speakerMappings[speakerId] || speakerId;
  };

  const lines = [];
  if (title) {
    lines.push(`# ${title}`, "");
  }
  lines.push(PROVENANCE_NOTICE, "");

  for (const section of SECTION_ORDER) {
    const items = extraction[section.category];
    if (!Array.isArray(items) || items.length === 0) continue; // deterministic omission

    lines.push(`## ${section.heading}`, "");

    for (const item of items) {
      const cite = citation(item.evidence.segmentIds, item.id);
      const review = item.reviewRequired ? ` ${REVIEW_MARKER}` : "";

      if (section.category === "actionItems") {
        const owner = speakerName(item.ownerSpeakerId);
        const ownerPrefix = owner ? `${owner}: ` : "";
        const due =
          item.dueDateText !== null && item.dueDateText !== undefined
            ? `Due: ${item.dueDateText}.`
            : "Due date: **Not stated**.";
        lines.push(`- [ ] ${ownerPrefix}${item.task}${review}`);
        lines.push(`  ${due} ${cite}`);
      } else if (section.category === "importantQuotes") {
        const who = speakerName(item.speakerId);
        const attribution = who ? ` — ${who}` : "";
        lines.push(`- > ${item.quote}${attribution}${review}`);
        lines.push(`  ${cite}`);
      } else if (section.bullet) {
        lines.push(`- ${item.text}${review}`);
        lines.push(`  ${cite}`);
      } else {
        // Summary: prose paragraphs, each sentence-claim cited inline.
        lines.push(`${item.text}${review} ${cite}`);
      }
      lines.push("");
    }
  }

  // Trim the trailing blank line for byte-stable output.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

module.exports = {
  renderNotesMarkdown,
  formatTimestamp,
  NoteRenderError,
  SECTION_ORDER,
  REVIEW_MARKER,
  PROVENANCE_NOTICE,
  NOTE_EXTRACTION_CATEGORIES,
};
