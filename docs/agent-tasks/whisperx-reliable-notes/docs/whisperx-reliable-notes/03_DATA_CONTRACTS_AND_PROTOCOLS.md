# 03 — Data Contracts and Protocols

The TypeScript and Python sides must share versioned fixtures. The exact syntax may be adapted to repository conventions, but semantics are normative.

## 1. Protocol Version

```ts
export const WHISPERX_PROTOCOL_VERSION = 1 as const;
export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const NOTE_EXTRACTION_SCHEMA_VERSION = 1 as const;
```

Reject unsupported major versions with `PROTOCOL_VERSION_UNSUPPORTED`.

## 2. Job Request

```ts
export type RecordingProfile = "memo" | "meeting" | "critical-interview";
export type RecordingLanguage = "auto" | "en" | "es";
export type WhisperXModel = "large-v3-turbo" | "large-v3";
export type ComputeType = "float16" | "int8";

export interface WhisperXJobRequest {
  protocolVersion: 1;
  requestId: string;
  jobId: string;

  source: {
    path: string;
    displayName: string;
    expectedSha256?: string;
  };

  output: {
    jobDirectory: string;
    preserveNormalizedAudio: boolean;
    formats: Array<
      | "canonical-json"
      | "raw-txt"
      | "speaker-markdown"
      | "srt"
      | "vtt"
    >;
  };

  profile: RecordingProfile;
  language: RecordingLanguage;

  asr: {
    model: WhisperXModel;
    computeType: ComputeType;
    batchSize: number;
    device: "cuda" | "cpu";
    hotwords: string[];
    initialPrompt?: string;
  };

  alignment: {
    enabled: boolean;
  };

  diarization: {
    enabled: boolean;
    provider: "pyannote-community-1" | "openwhispr-local";
    exactSpeakers?: number;
    minSpeakers?: number;
    maxSpeakers?: number;
  };

  runtime: {
    offline: boolean;
    modelCacheDirectory: string;
    temporaryDirectory: string;
  };
}
```

Validation rules:

- IDs are UUIDs or repository-standard opaque IDs.
- Source must be an existing regular file.
- Output directory must resolve inside the assigned job directory.
- Batch size is from an allowlist, not arbitrary.
- Exact speaker count cannot coexist inconsistently with min/max.
- `minSpeakers <= maxSpeakers`.
- Hotwords are length/count capped and control characters removed.
- No token or secret is present in the request JSON.
- CPU mode is explicit and not silently selected.
- `offline: true` forbids downloads/network calls.

## 3. Worker Events

```ts
export type WhisperXStage =
  | "starting"
  | "probing-audio"
  | "normalizing-audio"
  | "loading-asr"
  | "transcribing"
  | "unloading-asr"
  | "loading-alignment"
  | "aligning"
  | "unloading-alignment"
  | "loading-diarization"
  | "diarizing"
  | "unloading-diarization"
  | "canonicalizing"
  | "writing-artifacts"
  | "complete";

export type WorkerEvent =
  | {
      type: "ready";
      protocolVersion: 1;
      workerVersion: string;
      whisperxVersion: string;
      pythonVersion: string;
    }
  | {
      type: "heartbeat";
      timestamp: string;
      stage: WhisperXStage;
    }
  | {
      type: "stage";
      stage: WhisperXStage;
      timestamp: string;
    }
  | {
      type: "progress";
      stage: WhisperXStage;
      completed: number;
      total?: number;
      unit?: "seconds" | "segments" | "percent" | "files";
    }
  | {
      type: "warning";
      code: WhisperXWarningCode;
      message: string;
      details?: Record<string, unknown>;
    }
  | {
      type: "artifact";
      kind: ArtifactKind;
      relativePath: string;
      sha256: string;
      bytes: number;
    }
  | {
      type: "complete";
      result: WhisperXCompletion;
    }
  | {
      type: "error";
      error: WhisperXWorkerError;
    };
```

Progress must be monotonic within a stage. Renderer-visible progress may combine weighted stages, but estimated progress must be labeled as such.

## 4. Completion

```ts
export interface WhisperXCompletion {
  jobId: string;
  sourceSha256: string;
  durationSeconds: number;
  detectedLanguage?: string;
  actualConfiguration: {
    model: string;
    computeType: string;
    batchSize: number;
    device: string;
    alignmentUsed: boolean;
    diarizationUsed: boolean;
    diarizationProvider?: string;
    fallbackAttempts: Array<{
      model: string;
      computeType: string;
      batchSize: number;
      reason: string;
    }>;
  };
  transcript: {
    schemaVersion: 1;
    relativePath: string;
    sha256: string;
    segmentCount: number;
    wordCount: number;
  };
  artifacts: ArtifactDescriptor[];
  warnings: WhisperXWarning[];
  timingsMs: Record<string, number>;
}
```

## 5. Canonical Transcript

```ts
export interface CanonicalTranscript {
  schemaVersion: 1;
  jobId: string;

  source: {
    displayName: string;
    sha256: string;
    durationSeconds: number;
  };

  provenance: {
    engine: "whisperx";
    whisperxVersion: string;
    fasterWhisperVersion?: string;
    torchVersion?: string;
    pyannoteVersion?: string;
    model: string;
    modelRevision?: string;
    device: string;
    computeType: string;
    batchSize: number;
    languageRequested: RecordingLanguage;
    languageDetected?: string;
    alignmentModel?: string;
    diarizationModel?: string;
    createdAt: string;
  };

  speakers: Array<{
    id: string;
    displayName?: string;
  }>;

  segments: TranscriptSegment[];
  warnings: TranscriptWarning[];
}
```

```ts
export interface TranscriptSegment {
  id: string;
  sequence: number;
  start: number;
  end: number;
  speakerId?: string;
  text: string;
  words: TranscriptWord[];

  quality?: {
    avgLogProb?: number;
    noSpeechProb?: number;
    compressionRatio?: number;
    alignmentCoverage?: number;
  };

  flags: Array<
    | "unaligned"
    | "partial-alignment"
    | "possible-overlap"
    | "possible-hallucination"
    | "low-confidence"
    | "manual-review"
  >;
}
```

```ts
export interface TranscriptWord {
  text: string;
  start: number | null;
  end: number | null;
  score: number | null;
  speakerId?: string;
}
```

Validation:

- segments sorted by time then sequence;
- `start >= 0`, `end >= start`, and usually within source duration tolerance;
- IDs unique;
- speaker IDs defined in speaker collection;
- words remain ordered;
- no NaN/Infinity;
- text is UTF-8-compatible and size capped;
- unsupported quality fields are omitted, not fabricated.

## 6. Artifact Manifest

```ts
export type ArtifactKind =
  | "job-manifest"
  | "source-reference"
  | "canonical-transcript"
  | "raw-transcript"
  | "speaker-transcript"
  | "srt"
  | "vtt"
  | "note-extraction"
  | "notes-markdown"
  | "warnings"
  | "diagnostics";

export interface ArtifactDescriptor {
  kind: ArtifactKind;
  relativePath: string;
  sha256: string;
  bytes: number;
  schemaVersion?: number;
  createdAt: string;
}
```

`relativePath` must not contain drive roots, `..`, alternate data streams, device paths, or path separators that escape the job directory.

## 7. Note Extraction Schema

```ts
export interface EvidenceRef {
  segmentIds: string[];
}

export interface EvidenceClaim {
  id: string;
  text: string;
  evidence: EvidenceRef;
  reviewRequired?: boolean;
}

export interface ActionItem {
  id: string;
  task: string;
  ownerSpeakerId: string | null;
  dueDateText: string | null;
  dueDateIso: string | null;
  status: "explicit" | "proposed" | "unclear";
  evidence: EvidenceRef;
  reviewRequired?: boolean;
}

export interface ImportantQuote {
  id: string;
  quote: string;
  speakerId: string | null;
  evidence: EvidenceRef;
  reviewRequired?: boolean;
}

export interface NoteExtraction {
  schemaVersion: 1;
  jobId: string;
  sourceTranscriptSha256: string;
  promptVersion: string;
  generation: {
    provider: string;
    model: string;
    temperature: number;
    thinkingDisabled: boolean;
    createdAt: string;
  };

  summaryClaims: EvidenceClaim[];
  discussionPoints: EvidenceClaim[];
  decisions: EvidenceClaim[];
  proposals: EvidenceClaim[];
  actionItems: ActionItem[];
  followUps: EvidenceClaim[];
  openQuestions: EvidenceClaim[];
  risksOrBlockers: EvidenceClaim[];
  importantQuotes: ImportantQuote[];
  unresolvedAmbiguities: EvidenceClaim[];
}
```

No substantive text appears outside a schema field that supports evidence.

## 8. Note Validation Result

```ts
export interface NoteValidationIssue {
  code:
    | "MISSING_EVIDENCE"
    | "UNKNOWN_SEGMENT"
    | "EMPTY_CLAIM"
    | "QUOTE_NOT_FOUND"
    | "UNKNOWN_SPEAKER"
    | "OWNER_NOT_EXPLICIT"
    | "DATE_NOT_EXPLICIT"
    | "DUPLICATE_ITEM"
    | "UNSUPPORTED_CLAIM";
  itemId: string;
  message: string;
  severity: "error" | "review";
}

export interface NoteValidationResult {
  valid: boolean;
  issues: NoteValidationIssue[];
  extraction: NoteExtraction;
}
```

Errors block final rendering. Review issues render with a visible marker.

## 9. Database Contract

Use repository migration conventions. A conceptual SQL shape is:

```sql
CREATE TABLE recording_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_display_name TEXT NOT NULL,
  source_path TEXT,
  source_sha256 TEXT,
  profile TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  transcript_schema_version INTEGER,
  artifact_directory TEXT NOT NULL,
  error_code TEXT,
  warning_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE recording_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  schema_version INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES recording_jobs(id) ON DELETE CASCADE
);

CREATE TABLE note_generation_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  note_id INTEGER,
  status TEXT NOT NULL,
  source_transcript_sha256 TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  extraction_relative_path TEXT,
  notes_relative_path TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(job_id) REFERENCES recording_jobs(id) ON DELETE CASCADE
);
```

Adapt identifiers/types to the existing SQLite wrapper.

## 10. Stable Error Codes

At minimum:

```text
RUNTIME_NOT_INSTALLED
RUNTIME_VERSION_MISMATCH
PYTHON_START_FAILED
CUDA_UNAVAILABLE
CUDA_OUT_OF_MEMORY
MODEL_NOT_AVAILABLE_OFFLINE
HF_TOKEN_REQUIRED
DIARIZATION_MODEL_NOT_READY
AUDIO_FILE_NOT_FOUND
AUDIO_UNSUPPORTED
AUDIO_PROBE_FAILED
AUDIO_DECODE_FAILED
SOURCE_HASH_MISMATCH
OUTPUT_PATH_REJECTED
DISK_SPACE_INSUFFICIENT
WORKER_PROTOCOL_ERROR
WORKER_TIMEOUT
WORKER_CRASHED
JOB_CANCELLED
ALIGNMENT_UNAVAILABLE
ALIGNMENT_PARTIAL
DIARIZATION_FAILED
TRANSCRIPT_SCHEMA_INVALID
ARTIFACT_WRITE_FAILED
ARTIFACT_HASH_MISMATCH
NOTE_MODEL_UNAVAILABLE
NOTE_SCHEMA_INVALID
NOTE_EVIDENCE_INVALID
NOTE_QUOTE_INVALID
DATABASE_WRITE_FAILED
UNKNOWN_INTERNAL_ERROR
```

Errors exposed to the UI should map through i18n keys. Raw internal details remain in redacted local diagnostics.

## 11. Cross-Language Contract Tests

Store shared JSON fixtures in one location consumed by Node and Python tests:

```text
test/fixtures/whisperx-contracts/
  valid-job-request.json
  invalid-path-request.json
  ready-event.json
  progress-event.json
  valid-transcript.json
  invalid-transcript-duplicate-id.json
  valid-note-extraction.json
  invalid-note-missing-evidence.json
```

Both sides must accept valid fixtures and reject the same invalid fixtures.
