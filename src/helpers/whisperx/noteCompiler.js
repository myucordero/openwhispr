// Reliable-notes compiler orchestrator (spec 04, spec 02 §13).
// Pipeline: chunk → schema-constrained extraction per chunk (one retry with
// validation feedback) → structural validation → deterministic merge →
// deterministic evidence validation → optional strict support verification →
// issue policy (drop/flag) → deterministic Markdown rendering.
// The LLM is injected: llm({ messages, maxTokens }) => Promise<string>.
// GPU sequencing (lease around the local model) is the caller's job.

const { NOTE_EXTRACTION_SCHEMA_VERSION, NOTE_EXTRACTION_CATEGORIES } = require("./constants");
const { validateNoteExtraction } = require("./contracts");
const { chunkSegments, serializeChunk } = require("./noteChunker");
const { mergeFragments } = require("./noteMerge");
const {
  validateEvidence,
  applyVerifierResults,
  applyIssuePolicy,
  normalizeForMatch,
} = require("./noteEvidence");
const { renderNotesMarkdown } = require("./noteRenderer");
const {
  EXTRACTION_PROMPT_VERSION,
  buildExtractionMessages,
  buildRetryMessages,
  buildVerifierMessages,
} = require("./notePrompts");

class NoteCompilationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NoteCompilationError";
    this.code = code;
    this.details = details;
  }
}

// Extracts the first JSON object from an LLM response (tolerates fenced
// code blocks; rejects anything without a parseable object).
function parseJsonObject(text) {
  if (typeof text !== "string") throw new Error("LLM returned no text");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in LLM response");
  return JSON.parse(candidate.slice(start, end + 1));
}

// Normalizes a chunk fragment: tolerate missing categories (fill []),
// strip unknown top-level fields, coerce evidence shape. Structural
// validation still applies afterwards on the assembled extraction.
function normalizeFragment(raw, chunkId) {
  const fragment = {};
  for (const category of NOTE_EXTRACTION_CATEGORIES) {
    const items = Array.isArray(raw[category]) ? raw[category] : [];
    fragment[category] = items
      .filter((item) => item && typeof item === "object")
      .map((item, index) => ({
        ...item,
        id: typeof item.id === "string" && item.id ? `${chunkId}:${item.id}` : `${chunkId}:auto-${index}`,
        evidence: {
          segmentIds: Array.isArray(item?.evidence?.segmentIds)
            ? item.evidence.segmentIds.filter((id) => typeof id === "string")
            : [],
        },
      }));
  }
  return fragment;
}

// Per-chunk structural gate before merge: every item must cite segments that
// exist INSIDE this chunk (spec 04 §6.2) and carry non-empty claim text.
function fragmentIssues(fragment, chunk) {
  const chunkSegmentIds = new Set(chunk.segments.map((s) => s.id));
  const issues = [];
  for (const category of NOTE_EXTRACTION_CATEGORIES) {
    for (const item of fragment[category]) {
      const text =
        category === "actionItems" ? item.task : category === "importantQuotes" ? item.quote : item.text;
      if (typeof text !== "string" || normalizeForMatch(text).length === 0) {
        issues.push(`${category}/${item.id}: empty claim text`);
      }
      if (item.evidence.segmentIds.length === 0) {
        issues.push(`${category}/${item.id}: no evidence segmentIds`);
      }
      for (const segId of item.evidence.segmentIds) {
        if (!chunkSegmentIds.has(segId)) {
          issues.push(`${category}/${item.id}: cites segment "${segId}" not present in this chunk`);
        }
      }
      if (category === "actionItems") {
        if (item.ownerSpeakerId === undefined) issues.push(`${category}/${item.id}: ownerSpeakerId missing (use null)`);
        if (item.dueDateText === undefined) issues.push(`${category}/${item.id}: dueDateText missing (use null)`);
        if (item.dueDateIso === undefined) issues.push(`${category}/${item.id}: dueDateIso missing (use null)`);
        if (!["explicit", "proposed", "unclear"].includes(item.status)) {
          issues.push(`${category}/${item.id}: invalid status`);
        }
      }
    }
  }
  return issues;
}

// options:
//   transcript        — canonical transcript (validated)
//   jobId
//   profile           — memo | meeting | critical-interview
//   llm               — async ({messages, maxTokens}) => string
//   generation        — { provider, model, temperature, thinkingDisabled }
//   glossary          — custom dictionary words (spelling reference)
//   speakerMappings   — manual display names
//   strictVerification— run the per-item support verifier (spec 04 §8)
//   strictness        — "drop-invalid" (default) | "fail-run"
//   now               — () => ISO string
//   maxOutputTokens   — per-chunk extraction budget (default 3000)
//   onProgress        — ({stage, completed, total}) callback
async function compileNotes({
  transcript,
  jobId,
  profile,
  llm,
  generation,
  glossary = [],
  speakerMappings = {},
  strictVerification = false,
  strictness = "drop-invalid",
  now = () => new Date().toISOString(),
  maxOutputTokens = 3000,
  onProgress = () => {},
}) {
  const chunks = chunkSegments(transcript.segments);
  if (chunks.length === 0) {
    throw new NoteCompilationError("NOTE_SCHEMA_INVALID", "Transcript has no segments to extract from");
  }

  // ---- per-chunk extraction with one validation-feedback retry -----------
  const fragments = [];
  const failedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onProgress({ stage: "note_extracting", completed: i, total: chunks.length });
    const messages = buildExtractionMessages({
      profile,
      chunkData: serializeChunk(chunk),
      glossary,
    });

    let fragment = null;
    let lastIssues = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const promptMessages =
        attempt === 0 ? messages : buildRetryMessages(messages, lastIssues.slice(0, 12).join("\n"));
      let raw;
      try {
        const text = await llm({ messages: promptMessages, maxTokens: maxOutputTokens });
        raw = parseJsonObject(text);
      } catch (error) {
        lastIssues = [`response was not valid JSON: ${error.message}`];
        continue;
      }
      const candidate = normalizeFragment(raw, chunk.chunkId);
      const issues = fragmentIssues(candidate, chunk);
      if (issues.length === 0) {
        fragment = candidate;
        break;
      }
      lastIssues = issues;
    }

    if (fragment) {
      fragments.push(fragment);
    } else {
      failedChunks.push({ chunkId: chunk.chunkId, issues: lastIssues });
    }
  }

  if (fragments.length === 0) {
    throw new NoteCompilationError("NOTE_SCHEMA_INVALID", "Every chunk failed schema-valid extraction", {
      failedChunks,
    });
  }

  // ---- deterministic merge + full-transcript assembly ---------------------
  onProgress({ stage: "note_validating", completed: 0, total: 1 });
  const mergedBody = mergeFragments(fragments, transcript);
  const transcriptArtifactSha = transcript.__artifactSha256 || "0".repeat(64);
  const extraction = {
    schemaVersion: NOTE_EXTRACTION_SCHEMA_VERSION,
    jobId,
    sourceTranscriptSha256: transcriptArtifactSha,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    generation: {
      provider: generation.provider,
      model: generation.model,
      temperature: generation.temperature ?? 0,
      thinkingDisabled: generation.thinkingDisabled !== false,
      createdAt: now(),
    },
    ...mergedBody,
  };

  const structural = validateNoteExtraction(extraction);
  if (!structural.valid) {
    throw new NoteCompilationError("NOTE_SCHEMA_INVALID", "Merged extraction failed structural validation", {
      errors: structural.errors.slice(0, 20),
    });
  }

  // ---- deterministic evidence validation ----------------------------------
  let validation = validateEvidence(extraction, transcript, { speakerMappings });

  // ---- optional strict per-item support verification ----------------------
  let verifierResults = [];
  if (strictVerification) {
    const segmentById = new Map(transcript.segments.map((s) => [s.id, s]));
    const allItems = [];
    for (const category of NOTE_EXTRACTION_CATEGORIES) {
      for (const item of extraction[category]) {
        allItems.push({ category, item });
      }
    }
    for (let i = 0; i < allItems.length; i++) {
      const { category, item } = allItems[i];
      onProgress({ stage: "note_validating", completed: i, total: allItems.length });
      const claimText =
        category === "actionItems" ? item.task : category === "importantQuotes" ? item.quote : item.text;
      const evidenceText = item.evidence.segmentIds
        .map((id) => segmentById.get(id))
        .filter(Boolean)
        .map((s) => `[${s.id}${s.speakerId ? ` ${s.speakerId}` : ""}] ${s.text}`)
        .join("\n");
      try {
        const text = await llm({
          messages: buildVerifierMessages({ itemId: item.id, claimText, evidenceText }),
          maxTokens: 400,
        });
        const parsed = parseJsonObject(text);
        if (
          parsed &&
          typeof parsed === "object" &&
          ["supported", "partially-supported", "unsupported", "unclear"].includes(parsed.result)
        ) {
          verifierResults.push({ itemId: item.id, result: parsed.result, reason: parsed.reason });
        } else {
          verifierResults.push({ itemId: item.id, result: "unclear", reason: "Verifier returned an invalid shape" });
        }
      } catch (error) {
        verifierResults.push({ itemId: item.id, result: "unclear", reason: `Verifier failed: ${error.message}` });
      }
    }
    validation = applyVerifierResults(validation, verifierResults);
  }

  // ---- issue policy + rendering -------------------------------------------
  const { extraction: finalExtraction, dropped } = applyIssuePolicy(extraction, validation.issues, {
    strictness,
  });
  if (!finalExtraction) {
    throw new NoteCompilationError("NOTE_EVIDENCE_INVALID", "Evidence validation failed in fail-run mode", {
      issues: validation.issues,
    });
  }
  const remainingItems = NOTE_EXTRACTION_CATEGORIES.reduce(
    (acc, c) => acc + finalExtraction[c].length,
    0
  );
  if (remainingItems === 0) {
    throw new NoteCompilationError("NOTE_EVIDENCE_INVALID", "No evidence-valid items survived validation", {
      issues: validation.issues,
      dropped,
    });
  }

  onProgress({ stage: "note_rendering", completed: 0, total: 1 });
  const markdown = renderNotesMarkdown(finalExtraction, {
    jobId,
    transcript,
    speakerMappings,
    linkMode: "app",
  });

  return {
    extraction: finalExtraction,
    markdown,
    validation,
    verifierResults,
    droppedItemIds: dropped,
    failedChunks,
    chunkCount: chunks.length,
  };
}

module.exports = { compileNotes, NoteCompilationError, parseJsonObject };
