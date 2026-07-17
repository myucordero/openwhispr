// WhisperX contract validators — pure functions, no electron/fs imports.
// Every validator returns { valid: boolean, errors: [{ code, path, message }] }.
// Filesystem-dependent rules (source exists, output dir resolves inside the
// job directory on disk) live in the managers; these validators are the
// shared structural contract mirrored by the Python sidecar's Pydantic models.

const {
  WHISPERX_PROTOCOL_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  NOTE_EXTRACTION_SCHEMA_VERSION,
  RECORDING_PROFILES,
  RECORDING_LANGUAGES,
  WHISPERX_MODELS,
  COMPUTE_TYPES,
  DEVICES,
  BATCH_SIZES,
  DIARIZATION_PROVIDERS,
  OUTPUT_FORMATS,
  WORKER_STAGES,
  WORKER_EVENT_TYPES,
  PROGRESS_UNITS,
  ARTIFACT_KINDS,
  SEGMENT_FLAGS,
  ACTION_ITEM_STATUSES,
  NOTE_EXTRACTION_CATEGORIES,
  LIMITS,
} = require("./constants");

const { isRelativeArtifactPathSafe } = require("./pathConfinement");

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
// Keys that must never appear anywhere in a job request (secrets travel via
// a restricted worker environment, never protocol JSON).
const FORBIDDEN_KEY_RE = /(token|secret|api[-_]?key|password|credential|authorization)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function err(code, path, message) {
  return { code, path, message };
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function result(errors) {
  return { valid: errors.length === 0, errors };
}

function findForbiddenKeys(value, path, errors, depth = 0) {
  if (depth > 16) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      findForbiddenKeys(item, `${path}[${i}]`, errors, depth + 1)
    );
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) {
      errors.push(
        err(
          "FORBIDDEN_FIELD",
          `${path}.${key}`,
          `Field name "${key}" looks like a credential and must not appear in protocol JSON`
        )
      );
    }
    findForbiddenKeys(value[key], `${path}.${key}`, errors, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Job request (spec 03 §2)
// ---------------------------------------------------------------------------

function validateJobRequest(request) {
  const errors = [];
  if (!isPlainObject(request)) {
    return result([err("INVALID_TYPE", "$", "Job request must be an object")]);
  }

  if (request.protocolVersion !== WHISPERX_PROTOCOL_VERSION) {
    errors.push(
      err(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "$.protocolVersion",
        `Expected protocolVersion ${WHISPERX_PROTOCOL_VERSION}`
      )
    );
  }
  for (const field of ["requestId", "jobId"]) {
    if (!isNonEmptyString(request[field])) {
      errors.push(err("MISSING_FIELD", `$.${field}`, `${field} is required`));
    }
  }

  const source = request.source;
  if (!isPlainObject(source)) {
    errors.push(err("MISSING_FIELD", "$.source", "source is required"));
  } else {
    if (!isNonEmptyString(source.path)) {
      errors.push(err("MISSING_FIELD", "$.source.path", "source.path is required"));
    }
    if (!isNonEmptyString(source.displayName)) {
      errors.push(
        err("MISSING_FIELD", "$.source.displayName", "source.displayName is required")
      );
    }
    if (
      source.expectedSha256 !== undefined &&
      !(typeof source.expectedSha256 === "string" && SHA256_RE.test(source.expectedSha256))
    ) {
      errors.push(
        err("INVALID_VALUE", "$.source.expectedSha256", "expectedSha256 must be 64 lowercase hex chars")
      );
    }
  }

  const output = request.output;
  if (!isPlainObject(output)) {
    errors.push(err("MISSING_FIELD", "$.output", "output is required"));
  } else {
    if (!isNonEmptyString(output.jobDirectory)) {
      errors.push(
        err("MISSING_FIELD", "$.output.jobDirectory", "output.jobDirectory is required")
      );
    }
    if (typeof output.preserveNormalizedAudio !== "boolean") {
      errors.push(
        err(
          "INVALID_VALUE",
          "$.output.preserveNormalizedAudio",
          "preserveNormalizedAudio must be a boolean"
        )
      );
    }
    if (!Array.isArray(output.formats) || output.formats.length === 0) {
      errors.push(
        err("INVALID_VALUE", "$.output.formats", "formats must be a non-empty array")
      );
    } else {
      output.formats.forEach((f, i) => {
        if (!OUTPUT_FORMATS.includes(f)) {
          errors.push(err("INVALID_VALUE", `$.output.formats[${i}]`, `Unknown format "${f}"`));
        }
      });
      if (!output.formats.includes("canonical-json")) {
        errors.push(
          err(
            "INVALID_VALUE",
            "$.output.formats",
            "canonical-json is mandatory in output formats"
          )
        );
      }
    }
  }

  if (!RECORDING_PROFILES.includes(request.profile)) {
    errors.push(err("INVALID_VALUE", "$.profile", `profile must be one of ${RECORDING_PROFILES.join(", ")}`));
  }
  if (!RECORDING_LANGUAGES.includes(request.language)) {
    errors.push(err("INVALID_VALUE", "$.language", `language must be one of ${RECORDING_LANGUAGES.join(", ")}`));
  }

  const asr = request.asr;
  if (!isPlainObject(asr)) {
    errors.push(err("MISSING_FIELD", "$.asr", "asr is required"));
  } else {
    if (!WHISPERX_MODELS.includes(asr.model)) {
      errors.push(err("INVALID_VALUE", "$.asr.model", `model must be one of ${WHISPERX_MODELS.join(", ")}`));
    }
    if (!COMPUTE_TYPES.includes(asr.computeType)) {
      errors.push(err("INVALID_VALUE", "$.asr.computeType", `computeType must be one of ${COMPUTE_TYPES.join(", ")}`));
    }
    if (!BATCH_SIZES.includes(asr.batchSize)) {
      errors.push(
        err("INVALID_VALUE", "$.asr.batchSize", `batchSize must be one of ${BATCH_SIZES.join(", ")}`)
      );
    }
    if (!DEVICES.includes(asr.device)) {
      errors.push(err("INVALID_VALUE", "$.asr.device", "device must be explicitly cuda or cpu"));
    }
    if (!Array.isArray(asr.hotwords)) {
      errors.push(err("INVALID_VALUE", "$.asr.hotwords", "hotwords must be an array"));
    } else {
      if (asr.hotwords.length > LIMITS.MAX_HOTWORDS) {
        errors.push(
          err("INVALID_VALUE", "$.asr.hotwords", `At most ${LIMITS.MAX_HOTWORDS} hotwords allowed`)
        );
      }
      asr.hotwords.forEach((w, i) => {
        if (typeof w !== "string" || w.length === 0 || w.length > LIMITS.MAX_HOTWORD_LENGTH) {
          errors.push(
            err(
              "INVALID_VALUE",
              `$.asr.hotwords[${i}]`,
              `Hotwords must be non-empty strings of at most ${LIMITS.MAX_HOTWORD_LENGTH} chars`
            )
          );
        } else if (CONTROL_CHAR_RE.test(w) || w.includes("\n") || w.includes("\r")) {
          errors.push(
            err("INVALID_VALUE", `$.asr.hotwords[${i}]`, "Hotwords must not contain control characters")
          );
        }
      });
    }
    if (asr.initialPrompt !== undefined) {
      if (
        typeof asr.initialPrompt !== "string" ||
        asr.initialPrompt.length > LIMITS.MAX_INITIAL_PROMPT_LENGTH ||
        CONTROL_CHAR_RE.test(asr.initialPrompt)
      ) {
        errors.push(
          err(
            "INVALID_VALUE",
            "$.asr.initialPrompt",
            `initialPrompt must be a control-character-free string of at most ${LIMITS.MAX_INITIAL_PROMPT_LENGTH} chars`
          )
        );
      }
    }
  }

  const alignment = request.alignment;
  if (!isPlainObject(alignment) || typeof alignment.enabled !== "boolean") {
    errors.push(err("INVALID_VALUE", "$.alignment", "alignment.enabled boolean is required"));
  }

  const diarization = request.diarization;
  if (!isPlainObject(diarization) || typeof diarization.enabled !== "boolean") {
    errors.push(err("INVALID_VALUE", "$.diarization", "diarization.enabled boolean is required"));
  } else {
    if (!DIARIZATION_PROVIDERS.includes(diarization.provider)) {
      errors.push(
        err(
          "INVALID_VALUE",
          "$.diarization.provider",
          `provider must be one of ${DIARIZATION_PROVIDERS.join(", ")}`
        )
      );
    }
    const counts = ["exactSpeakers", "minSpeakers", "maxSpeakers"];
    for (const field of counts) {
      const v = diarization[field];
      if (v !== undefined) {
        if (!Number.isInteger(v) || v < 1 || v > LIMITS.MAX_SPEAKERS) {
          errors.push(
            err(
              "INVALID_VALUE",
              `$.diarization.${field}`,
              `${field} must be an integer between 1 and ${LIMITS.MAX_SPEAKERS}`
            )
          );
        }
      }
    }
    if (
      diarization.exactSpeakers !== undefined &&
      (diarization.minSpeakers !== undefined || diarization.maxSpeakers !== undefined)
    ) {
      errors.push(
        err(
          "INVALID_VALUE",
          "$.diarization.exactSpeakers",
          "exactSpeakers cannot be combined with minSpeakers/maxSpeakers"
        )
      );
    }
    if (
      Number.isInteger(diarization.minSpeakers) &&
      Number.isInteger(diarization.maxSpeakers) &&
      diarization.minSpeakers > diarization.maxSpeakers
    ) {
      errors.push(
        err("INVALID_VALUE", "$.diarization.minSpeakers", "minSpeakers must be <= maxSpeakers")
      );
    }
  }

  const runtime = request.runtime;
  if (!isPlainObject(runtime)) {
    errors.push(err("MISSING_FIELD", "$.runtime", "runtime is required"));
  } else {
    if (typeof runtime.offline !== "boolean") {
      errors.push(err("INVALID_VALUE", "$.runtime.offline", "runtime.offline must be a boolean"));
    }
    for (const field of ["modelCacheDirectory", "temporaryDirectory"]) {
      if (!isNonEmptyString(runtime[field])) {
        errors.push(err("MISSING_FIELD", `$.runtime.${field}`, `runtime.${field} is required`));
      }
    }
  }

  findForbiddenKeys(request, "$", errors);
  return result(errors);
}

// ---------------------------------------------------------------------------
// Worker events (spec 03 §3)
// ---------------------------------------------------------------------------

function validateWorkerEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) {
    return result([err("INVALID_TYPE", "$", "Worker event must be an object")]);
  }
  if (!WORKER_EVENT_TYPES.includes(event.type)) {
    return result([err("UNKNOWN_EVENT_TYPE", "$.type", `Unknown event type "${event.type}"`)]);
  }

  switch (event.type) {
    case "ready": {
      if (event.protocolVersion !== WHISPERX_PROTOCOL_VERSION) {
        errors.push(
          err(
            "PROTOCOL_VERSION_UNSUPPORTED",
            "$.protocolVersion",
            `Expected protocolVersion ${WHISPERX_PROTOCOL_VERSION}`
          )
        );
      }
      for (const field of ["workerVersion", "whisperxVersion", "pythonVersion"]) {
        if (!isNonEmptyString(event[field])) {
          errors.push(err("MISSING_FIELD", `$.${field}`, `${field} is required on ready`));
        }
      }
      break;
    }
    case "heartbeat": {
      if (!isNonEmptyString(event.timestamp)) {
        errors.push(err("MISSING_FIELD", "$.timestamp", "timestamp is required on heartbeat"));
      }
      if (!WORKER_STAGES.includes(event.stage)) {
        errors.push(err("INVALID_VALUE", "$.stage", `Unknown stage "${event.stage}"`));
      }
      break;
    }
    case "stage": {
      if (!WORKER_STAGES.includes(event.stage)) {
        errors.push(err("INVALID_VALUE", "$.stage", `Unknown stage "${event.stage}"`));
      }
      if (!isNonEmptyString(event.timestamp)) {
        errors.push(err("MISSING_FIELD", "$.timestamp", "timestamp is required on stage"));
      }
      break;
    }
    case "progress": {
      if (!WORKER_STAGES.includes(event.stage)) {
        errors.push(err("INVALID_VALUE", "$.stage", `Unknown stage "${event.stage}"`));
      }
      if (!isFiniteNumber(event.completed) || event.completed < 0) {
        errors.push(err("INVALID_VALUE", "$.completed", "completed must be a number >= 0"));
      }
      if (event.total !== undefined) {
        if (!isFiniteNumber(event.total) || event.total < 0) {
          errors.push(err("INVALID_VALUE", "$.total", "total must be a number >= 0"));
        } else if (isFiniteNumber(event.completed) && event.completed > event.total) {
          errors.push(err("INVALID_VALUE", "$.completed", "completed must be <= total"));
        }
      }
      if (event.unit !== undefined && !PROGRESS_UNITS.includes(event.unit)) {
        errors.push(err("INVALID_VALUE", "$.unit", `Unknown unit "${event.unit}"`));
      }
      break;
    }
    case "warning": {
      if (!isNonEmptyString(event.code)) {
        errors.push(err("MISSING_FIELD", "$.code", "code is required on warning"));
      }
      if (!isNonEmptyString(event.message)) {
        errors.push(err("MISSING_FIELD", "$.message", "message is required on warning"));
      }
      if (event.details !== undefined && !isPlainObject(event.details)) {
        errors.push(err("INVALID_VALUE", "$.details", "details must be an object when present"));
      }
      break;
    }
    case "artifact": {
      const artifactErrors = validateArtifactDescriptor({
        kind: event.kind,
        relativePath: event.relativePath,
        sha256: event.sha256,
        bytes: event.bytes,
        createdAt: event.createdAt || "1970-01-01T00:00:00Z",
      }).errors;
      errors.push(...artifactErrors);
      break;
    }
    case "complete": {
      if (!isPlainObject(event.result)) {
        errors.push(err("MISSING_FIELD", "$.result", "result is required on complete"));
      }
      break;
    }
    case "error": {
      if (!isPlainObject(event.error)) {
        errors.push(err("MISSING_FIELD", "$.error", "error object is required on error event"));
      } else {
        if (!isNonEmptyString(event.error.code)) {
          errors.push(err("MISSING_FIELD", "$.error.code", "error.code is required"));
        }
        if (!isNonEmptyString(event.error.message)) {
          errors.push(err("MISSING_FIELD", "$.error.message", "error.message is required"));
        }
      }
      break;
    }
    default:
      break;
  }
  return result(errors);
}

// ---------------------------------------------------------------------------
// Artifact descriptor (spec 03 §6)
// ---------------------------------------------------------------------------

function validateArtifactDescriptor(artifact) {
  const errors = [];
  if (!isPlainObject(artifact)) {
    return result([err("INVALID_TYPE", "$", "Artifact descriptor must be an object")]);
  }
  if (!ARTIFACT_KINDS.includes(artifact.kind)) {
    errors.push(err("INVALID_VALUE", "$.kind", `Unknown artifact kind "${artifact.kind}"`));
  }
  if (!isNonEmptyString(artifact.relativePath)) {
    errors.push(err("MISSING_FIELD", "$.relativePath", "relativePath is required"));
  } else if (!isRelativeArtifactPathSafe(artifact.relativePath)) {
    errors.push(
      err("OUTPUT_PATH_REJECTED", "$.relativePath", "relativePath escapes the job directory or uses a forbidden form")
    );
  }
  if (!(typeof artifact.sha256 === "string" && SHA256_RE.test(artifact.sha256))) {
    errors.push(err("INVALID_VALUE", "$.sha256", "sha256 must be 64 lowercase hex chars"));
  }
  if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
    errors.push(err("INVALID_VALUE", "$.bytes", "bytes must be a non-negative integer"));
  }
  if (artifact.schemaVersion !== undefined && !Number.isInteger(artifact.schemaVersion)) {
    errors.push(err("INVALID_VALUE", "$.schemaVersion", "schemaVersion must be an integer"));
  }
  if (!isNonEmptyString(artifact.createdAt)) {
    errors.push(err("MISSING_FIELD", "$.createdAt", "createdAt is required"));
  }
  return result(errors);
}

// ---------------------------------------------------------------------------
// Canonical transcript (spec 03 §5)
// ---------------------------------------------------------------------------

function validateCanonicalTranscript(transcript) {
  const errors = [];
  if (!isPlainObject(transcript)) {
    return result([err("INVALID_TYPE", "$", "Transcript must be an object")]);
  }
  if (transcript.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) {
    errors.push(
      err(
        "TRANSCRIPT_SCHEMA_INVALID",
        "$.schemaVersion",
        `Expected schemaVersion ${TRANSCRIPT_SCHEMA_VERSION}`
      )
    );
  }
  if (!isNonEmptyString(transcript.jobId)) {
    errors.push(err("MISSING_FIELD", "$.jobId", "jobId is required"));
  }

  const source = transcript.source;
  if (!isPlainObject(source)) {
    errors.push(err("MISSING_FIELD", "$.source", "source is required"));
  } else {
    if (!isNonEmptyString(source.displayName)) {
      errors.push(err("MISSING_FIELD", "$.source.displayName", "source.displayName is required"));
    }
    if (!(typeof source.sha256 === "string" && SHA256_RE.test(source.sha256))) {
      errors.push(err("INVALID_VALUE", "$.source.sha256", "source.sha256 must be 64 lowercase hex chars"));
    }
    if (!isFiniteNumber(source.durationSeconds) || source.durationSeconds < 0) {
      errors.push(
        err("INVALID_VALUE", "$.source.durationSeconds", "durationSeconds must be a number >= 0")
      );
    }
  }

  const provenance = transcript.provenance;
  if (!isPlainObject(provenance)) {
    errors.push(err("MISSING_FIELD", "$.provenance", "provenance is required"));
  } else {
    if (provenance.engine !== "whisperx") {
      errors.push(err("INVALID_VALUE", "$.provenance.engine", 'engine must be "whisperx"'));
    }
    for (const field of ["whisperxVersion", "model", "device", "computeType", "createdAt"]) {
      if (!isNonEmptyString(provenance[field])) {
        errors.push(err("MISSING_FIELD", `$.provenance.${field}`, `provenance.${field} is required`));
      }
    }
    if (!Number.isInteger(provenance.batchSize) || provenance.batchSize < 1) {
      errors.push(err("INVALID_VALUE", "$.provenance.batchSize", "batchSize must be a positive integer"));
    }
    if (!RECORDING_LANGUAGES.includes(provenance.languageRequested)) {
      errors.push(
        err("INVALID_VALUE", "$.provenance.languageRequested", "languageRequested must be a known language option")
      );
    }
  }

  const speakerIds = new Set();
  if (!Array.isArray(transcript.speakers)) {
    errors.push(err("INVALID_VALUE", "$.speakers", "speakers must be an array"));
  } else {
    transcript.speakers.forEach((sp, i) => {
      if (!isPlainObject(sp) || !isNonEmptyString(sp.id)) {
        errors.push(err("INVALID_VALUE", `$.speakers[${i}]`, "Each speaker needs a non-empty id"));
        return;
      }
      if (speakerIds.has(sp.id)) {
        errors.push(err("INVALID_VALUE", `$.speakers[${i}].id`, `Duplicate speaker id "${sp.id}"`));
      }
      speakerIds.add(sp.id);
    });
  }

  if (!Array.isArray(transcript.segments)) {
    errors.push(err("INVALID_VALUE", "$.segments", "segments must be an array"));
    return result(errors);
  }

  const segmentIds = new Set();
  let prevStart = -Infinity;
  let prevSequence = -Infinity;
  transcript.segments.forEach((seg, i) => {
    const p = `$.segments[${i}]`;
    if (!isPlainObject(seg)) {
      errors.push(err("INVALID_VALUE", p, "Segment must be an object"));
      return;
    }
    if (!isNonEmptyString(seg.id)) {
      errors.push(err("MISSING_FIELD", `${p}.id`, "Segment id is required"));
    } else if (segmentIds.has(seg.id)) {
      errors.push(err("TRANSCRIPT_SCHEMA_INVALID", `${p}.id`, `Duplicate segment id "${seg.id}"`));
    } else {
      segmentIds.add(seg.id);
    }
    if (!Number.isInteger(seg.sequence) || seg.sequence < 0) {
      errors.push(err("INVALID_VALUE", `${p}.sequence`, "sequence must be a non-negative integer"));
    }
    if (!isFiniteNumber(seg.start) || seg.start < 0) {
      errors.push(err("INVALID_VALUE", `${p}.start`, "start must be a number >= 0"));
    }
    if (!isFiniteNumber(seg.end) || (isFiniteNumber(seg.start) && seg.end < seg.start)) {
      errors.push(err("INVALID_VALUE", `${p}.end`, "end must be a number >= start"));
    }
    if (isFiniteNumber(seg.start)) {
      if (seg.start < prevStart || (seg.start === prevStart && seg.sequence < prevSequence)) {
        errors.push(
          err("TRANSCRIPT_SCHEMA_INVALID", `${p}.start`, "Segments must be sorted by time then sequence")
        );
      }
      prevStart = seg.start;
      prevSequence = seg.sequence;
    }
    if (seg.speakerId !== undefined && !speakerIds.has(seg.speakerId)) {
      errors.push(
        err("TRANSCRIPT_SCHEMA_INVALID", `${p}.speakerId`, `speakerId "${seg.speakerId}" not defined in speakers`)
      );
    }
    if (typeof seg.text !== "string" || seg.text.length > LIMITS.MAX_SEGMENT_TEXT_LENGTH) {
      errors.push(
        err(
          "INVALID_VALUE",
          `${p}.text`,
          `text must be a string of at most ${LIMITS.MAX_SEGMENT_TEXT_LENGTH} chars`
        )
      );
    }
    if (!Array.isArray(seg.words)) {
      errors.push(err("INVALID_VALUE", `${p}.words`, "words must be an array"));
    } else {
      let prevWordStart = -Infinity;
      seg.words.forEach((word, wi) => {
        const wp = `${p}.words[${wi}]`;
        if (!isPlainObject(word) || typeof word.text !== "string") {
          errors.push(err("INVALID_VALUE", wp, "Word must be an object with text"));
          return;
        }
        for (const field of ["start", "end", "score"]) {
          const v = word[field];
          if (v !== null && v !== undefined && !isFiniteNumber(v)) {
            errors.push(err("INVALID_VALUE", `${wp}.${field}`, `${field} must be a finite number or null`));
          }
        }
        if (isFiniteNumber(word.start)) {
          if (word.start < prevWordStart) {
            errors.push(err("TRANSCRIPT_SCHEMA_INVALID", `${wp}.start`, "Words must remain time-ordered"));
          }
          prevWordStart = word.start;
        }
        if (word.speakerId !== undefined && !speakerIds.has(word.speakerId)) {
          errors.push(
            err("TRANSCRIPT_SCHEMA_INVALID", `${wp}.speakerId`, `speakerId "${word.speakerId}" not defined in speakers`)
          );
        }
      });
    }
    if (seg.quality !== undefined) {
      if (!isPlainObject(seg.quality)) {
        errors.push(err("INVALID_VALUE", `${p}.quality`, "quality must be an object when present"));
      } else {
        for (const [k, v] of Object.entries(seg.quality)) {
          if (v !== undefined && !isFiniteNumber(v)) {
            errors.push(err("INVALID_VALUE", `${p}.quality.${k}`, "quality values must be finite numbers"));
          }
        }
      }
    }
    if (!Array.isArray(seg.flags)) {
      errors.push(err("INVALID_VALUE", `${p}.flags`, "flags must be an array"));
    } else {
      seg.flags.forEach((flag, fi) => {
        if (!SEGMENT_FLAGS.includes(flag)) {
          errors.push(err("INVALID_VALUE", `${p}.flags[${fi}]`, `Unknown flag "${flag}"`));
        }
      });
    }
  });

  if (!Array.isArray(transcript.warnings)) {
    errors.push(err("INVALID_VALUE", "$.warnings", "warnings must be an array"));
  }

  return result(errors);
}

// ---------------------------------------------------------------------------
// Note extraction (spec 03 §7) — structural validation only. Evidence
// resolution against a transcript lives in noteEvidence.js.
// ---------------------------------------------------------------------------

function validateEvidenceRef(evidence, path, errors) {
  if (!isPlainObject(evidence) || !Array.isArray(evidence.segmentIds)) {
    errors.push(err("MISSING_EVIDENCE", path, "evidence.segmentIds array is required"));
    return;
  }
  if (evidence.segmentIds.length === 0) {
    errors.push(err("MISSING_EVIDENCE", path, "evidence.segmentIds must not be empty"));
    return;
  }
  evidence.segmentIds.forEach((id, i) => {
    if (!isNonEmptyString(id)) {
      errors.push(err("INVALID_VALUE", `${path}.segmentIds[${i}]`, "segment ids must be non-empty strings"));
    }
  });
}

function validateClaimText(text, path, errors) {
  if (!isNonEmptyString(text) || text.trim().length === 0) {
    errors.push(err("EMPTY_CLAIM", path, "Claim text must be non-empty"));
  } else if (text.length > LIMITS.MAX_CLAIM_TEXT_LENGTH) {
    errors.push(
      err("INVALID_VALUE", path, `Claim text must be at most ${LIMITS.MAX_CLAIM_TEXT_LENGTH} chars`)
    );
  }
}

function validateNoteExtraction(extraction) {
  const errors = [];
  if (!isPlainObject(extraction)) {
    return result([err("INVALID_TYPE", "$", "Note extraction must be an object")]);
  }
  if (extraction.schemaVersion !== NOTE_EXTRACTION_SCHEMA_VERSION) {
    errors.push(
      err(
        "NOTE_SCHEMA_INVALID",
        "$.schemaVersion",
        `Expected schemaVersion ${NOTE_EXTRACTION_SCHEMA_VERSION}`
      )
    );
  }
  if (!isNonEmptyString(extraction.jobId)) {
    errors.push(err("MISSING_FIELD", "$.jobId", "jobId is required"));
  }
  if (!(typeof extraction.sourceTranscriptSha256 === "string" && SHA256_RE.test(extraction.sourceTranscriptSha256))) {
    errors.push(
      err("INVALID_VALUE", "$.sourceTranscriptSha256", "sourceTranscriptSha256 must be 64 lowercase hex chars")
    );
  }
  if (!isNonEmptyString(extraction.promptVersion)) {
    errors.push(err("MISSING_FIELD", "$.promptVersion", "promptVersion is required"));
  }
  const generation = extraction.generation;
  if (!isPlainObject(generation)) {
    errors.push(err("MISSING_FIELD", "$.generation", "generation metadata is required"));
  } else {
    for (const field of ["provider", "model", "createdAt"]) {
      if (!isNonEmptyString(generation[field])) {
        errors.push(err("MISSING_FIELD", `$.generation.${field}`, `generation.${field} is required`));
      }
    }
    if (!isFiniteNumber(generation.temperature) || generation.temperature < 0 || generation.temperature > 2) {
      errors.push(err("INVALID_VALUE", "$.generation.temperature", "temperature must be a number in [0,2]"));
    }
    if (typeof generation.thinkingDisabled !== "boolean") {
      errors.push(err("INVALID_VALUE", "$.generation.thinkingDisabled", "thinkingDisabled must be a boolean"));
    }
  }

  const seenItemIds = new Set();
  const checkItemId = (id, path) => {
    if (!isNonEmptyString(id)) {
      errors.push(err("MISSING_FIELD", path, "item id is required"));
      return;
    }
    if (seenItemIds.has(id)) {
      errors.push(err("DUPLICATE_ITEM", path, `Duplicate item id "${id}"`));
    }
    seenItemIds.add(id);
  };

  for (const category of NOTE_EXTRACTION_CATEGORIES) {
    const items = extraction[category];
    const base = `$.${category}`;
    if (!Array.isArray(items)) {
      errors.push(err("NOTE_SCHEMA_INVALID", base, `${category} must be an array (use [] when empty)`));
      continue;
    }
    items.forEach((item, i) => {
      const p = `${base}[${i}]`;
      if (!isPlainObject(item)) {
        errors.push(err("INVALID_VALUE", p, "Item must be an object"));
        return;
      }
      checkItemId(item.id, `${p}.id`);
      validateEvidenceRef(item.evidence, `${p}.evidence`, errors);
      if (item.reviewRequired !== undefined && typeof item.reviewRequired !== "boolean") {
        errors.push(err("INVALID_VALUE", `${p}.reviewRequired`, "reviewRequired must be a boolean"));
      }
      if (category === "actionItems") {
        validateClaimText(item.task, `${p}.task`, errors);
        if (!(item.ownerSpeakerId === null || isNonEmptyString(item.ownerSpeakerId))) {
          errors.push(err("INVALID_VALUE", `${p}.ownerSpeakerId`, "ownerSpeakerId must be a string or null"));
        }
        if (!(item.dueDateText === null || isNonEmptyString(item.dueDateText))) {
          errors.push(err("INVALID_VALUE", `${p}.dueDateText`, "dueDateText must be a string or null"));
        }
        if (item.dueDateIso === null || item.dueDateIso === undefined) {
          if (item.dueDateIso === undefined) {
            errors.push(err("INVALID_VALUE", `${p}.dueDateIso`, "dueDateIso must be a string or explicit null"));
          }
        } else if (!(typeof item.dueDateIso === "string" && ISO_DATE_RE.test(item.dueDateIso))) {
          errors.push(err("INVALID_VALUE", `${p}.dueDateIso`, "dueDateIso must be an ISO date string or null"));
        }
        if (item.dueDateIso !== null && item.dueDateIso !== undefined && item.dueDateText === null) {
          errors.push(
            err("DATE_NOT_EXPLICIT", `${p}.dueDateIso`, "dueDateIso requires the explicit dueDateText it was derived from")
          );
        }
        if (!ACTION_ITEM_STATUSES.includes(item.status)) {
          errors.push(err("INVALID_VALUE", `${p}.status`, `status must be one of ${ACTION_ITEM_STATUSES.join(", ")}`));
        }
      } else if (category === "importantQuotes") {
        validateClaimText(item.quote, `${p}.quote`, errors);
        if (!(item.speakerId === null || isNonEmptyString(item.speakerId))) {
          errors.push(err("INVALID_VALUE", `${p}.speakerId`, "speakerId must be a string or null"));
        }
      } else {
        validateClaimText(item.text, `${p}.text`, errors);
      }
    });
  }

  return result(errors);
}

module.exports = {
  validateJobRequest,
  validateWorkerEvent,
  validateArtifactDescriptor,
  validateCanonicalTranscript,
  validateNoteExtraction,
  // exported for reuse/tests
  isPlainObject,
  SHA256_RE,
};
