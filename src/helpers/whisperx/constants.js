// WhisperX reliable-notes pipeline — shared protocol constants.
// Pure module: no electron/fs imports so every consumer stays unit-testable.
// The Python sidecar mirrors these values; cross-language contract tests in
// tests/whisperx/ and tools/whisperx-sidecar/tests consume the same fixtures
// under tests/fixtures/whisperx-contracts/.

const WHISPERX_PROTOCOL_VERSION = 1;
const TRANSCRIPT_SCHEMA_VERSION = 1;
const NOTE_EXTRACTION_SCHEMA_VERSION = 1;

const RECORDING_PROFILES = ["memo", "meeting", "critical-interview"];
const RECORDING_LANGUAGES = ["auto", "en", "es"];
const WHISPERX_MODELS = ["large-v3-turbo", "large-v3"];
const COMPUTE_TYPES = ["float16", "int8"];
const DEVICES = ["cuda", "cpu"];
const BATCH_SIZES = [1, 2, 4, 8];
const DIARIZATION_PROVIDERS = ["pyannote-community-1", "openwhispr-local"];

const OUTPUT_FORMATS = [
  "canonical-json",
  "raw-txt",
  "speaker-markdown",
  "srt",
  "vtt",
];

const WORKER_STAGES = [
  "starting",
  "probing-audio",
  "normalizing-audio",
  "loading-asr",
  "transcribing",
  "unloading-asr",
  "loading-alignment",
  "aligning",
  "unloading-alignment",
  "loading-diarization",
  "diarizing",
  "unloading-diarization",
  "canonicalizing",
  "writing-artifacts",
  "complete",
];

const WORKER_EVENT_TYPES = [
  "ready",
  "heartbeat",
  "stage",
  "progress",
  "warning",
  "artifact",
  "complete",
  "error",
];

const PROGRESS_UNITS = ["seconds", "segments", "percent", "files"];

const ARTIFACT_KINDS = [
  "job-manifest",
  "source-reference",
  "canonical-transcript",
  "raw-transcript",
  "speaker-transcript",
  "srt",
  "vtt",
  "note-extraction",
  "notes-markdown",
  "warnings",
  "diagnostics",
];

const SEGMENT_FLAGS = [
  "unaligned",
  "partial-alignment",
  "possible-overlap",
  "possible-hallucination",
  "low-confidence",
  "manual-review",
];

const ACTION_ITEM_STATUSES = ["explicit", "proposed", "unclear"];

// Stable error codes (spec 03 §10). UI maps these through i18n keys; raw
// details stay in redacted local diagnostics.
const ERROR_CODES = [
  "RUNTIME_NOT_INSTALLED",
  "RUNTIME_VERSION_MISMATCH",
  "PYTHON_START_FAILED",
  "CUDA_UNAVAILABLE",
  "CUDA_OUT_OF_MEMORY",
  "MODEL_NOT_AVAILABLE_OFFLINE",
  "HF_TOKEN_REQUIRED",
  "DIARIZATION_MODEL_NOT_READY",
  "AUDIO_FILE_NOT_FOUND",
  "AUDIO_UNSUPPORTED",
  "AUDIO_PROBE_FAILED",
  "AUDIO_DECODE_FAILED",
  "SOURCE_HASH_MISMATCH",
  "OUTPUT_PATH_REJECTED",
  "DISK_SPACE_INSUFFICIENT",
  "WORKER_PROTOCOL_ERROR",
  "WORKER_TIMEOUT",
  "WORKER_CRASHED",
  "JOB_CANCELLED",
  "ALIGNMENT_UNAVAILABLE",
  "ALIGNMENT_PARTIAL",
  "DIARIZATION_FAILED",
  "TRANSCRIPT_SCHEMA_INVALID",
  "ARTIFACT_WRITE_FAILED",
  "ARTIFACT_HASH_MISMATCH",
  "NOTE_MODEL_UNAVAILABLE",
  "NOTE_SCHEMA_INVALID",
  "NOTE_EVIDENCE_INVALID",
  "NOTE_QUOTE_INVALID",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "DATABASE_WRITE_FAILED",
  "UNKNOWN_INTERNAL_ERROR",
];

const WARNING_CODES = [
  "ALIGNMENT_PARTIAL",
  "ALIGNMENT_UNAVAILABLE",
  "DIARIZATION_UNAVAILABLE",
  "DIARIZATION_FALLBACK_USED",
  "OOM_FALLBACK_USED",
  "POSSIBLE_OVERLAP",
  "LOW_CONFIDENCE_REGION",
  "CPU_FALLBACK_USED",
  "NOTE_CLAIMS_REQUIRE_REVIEW",
];

const NOTE_VALIDATION_ISSUE_CODES = [
  "MISSING_EVIDENCE",
  "UNKNOWN_SEGMENT",
  "EMPTY_CLAIM",
  "QUOTE_NOT_FOUND",
  "UNKNOWN_SPEAKER",
  "OWNER_NOT_EXPLICIT",
  "DATE_NOT_EXPLICIT",
  "DUPLICATE_ITEM",
  "UNSUPPORTED_CLAIM",
];

// Size caps enforced by validators (kept in one place so JS and the tests
// that pin the Python side agree on limits).
const LIMITS = {
  MAX_JSONL_LINE_BYTES: 1024 * 1024, // 1 MiB per protocol line
  MAX_HOTWORDS: 64,
  MAX_HOTWORD_LENGTH: 64,
  MAX_INITIAL_PROMPT_LENGTH: 2048,
  MAX_SEGMENT_TEXT_LENGTH: 8192,
  MAX_CLAIM_TEXT_LENGTH: 2000,
  MAX_SPEAKERS: 32,
  MAX_STDERR_CAPTURE_BYTES: 256 * 1024,
};

const NOTE_EXTRACTION_CATEGORIES = [
  "summaryClaims",
  "discussionPoints",
  "decisions",
  "proposals",
  "actionItems",
  "followUps",
  "openQuestions",
  "risksOrBlockers",
  "importantQuotes",
  "unresolvedAmbiguities",
];

module.exports = {
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
  ERROR_CODES,
  WARNING_CODES,
  NOTE_VALIDATION_ISSUE_CODES,
  NOTE_EXTRACTION_CATEGORIES,
  LIMITS,
};
