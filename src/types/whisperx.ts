// WhisperX reliable-notes pipeline — renderer-facing types (spec 03).
// Runtime validation lives in src/helpers/whisperx/contracts.js (main
// process); these types mirror that contract for UI/store code.

export const WHISPERX_PROTOCOL_VERSION = 1 as const;
export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const NOTE_EXTRACTION_SCHEMA_VERSION = 1 as const;

export type RecordingProfile = "memo" | "meeting" | "critical-interview";
export type RecordingLanguage = "auto" | "en" | "es";
export type WhisperXModel = "large-v3-turbo" | "large-v3";
export type ComputeType = "float16" | "int8";
export type WhisperXDevice = "cuda" | "cpu";
export type DiarizationProvider = "pyannote-community-1" | "openwhispr-local";

export type RecordingJobStatus =
  | "created"
  | "queued"
  | "validating"
  | "preparing"
  | "transcribing"
  | "aligning"
  | "diarizing"
  | "canonicalizing"
  | "persisting"
  | "transcript_complete"
  | "note_extracting"
  | "note_validating"
  | "note_rendering"
  | "complete"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "transcript_complete_note_failed";

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

export interface WhisperXJobSettings {
  profile: RecordingProfile;
  language: RecordingLanguage;
  model: WhisperXModel;
  computeType: ComputeType;
  batchSize: number;
  device: WhisperXDevice;
  alignment: boolean;
  diarization: boolean;
  diarizationProvider: DiarizationProvider;
  exactSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  strictNotes: boolean;
}

export interface RecordingJobSummary {
  id: string;
  status: RecordingJobStatus;
  sourceType: "external" | "managed";
  sourceDisplayName: string;
  sourcePath: string | null;
  sourceSha256: string | null;
  profile: RecordingProfile;
  settingsJson: string;
  protocolVersion: number;
  transcriptSchemaVersion: number | null;
  artifactDirectory: string;
  errorCode: string | null;
  warningJson: string | null;
  durationSeconds: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RecordingJobProgressEvent {
  jobId: string;
  status: RecordingJobStatus;
  stage?: WhisperXStage;
  completed?: number;
  total?: number;
  unit?: "seconds" | "segments" | "percent" | "files";
  estimated?: boolean;
  warning?: { code: string; message: string };
}

export interface TranscriptWord {
  text: string;
  start: number | null;
  end: number | null;
  score: number | null;
  speakerId?: string;
}

export type SegmentFlag =
  | "unaligned"
  | "partial-alignment"
  | "possible-overlap"
  | "possible-hallucination"
  | "low-confidence"
  | "manual-review";

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
  flags: SegmentFlag[];
}

export interface CanonicalTranscript {
  schemaVersion: 1;
  jobId: string;
  source: { displayName: string; sha256: string; durationSeconds: number };
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
  speakers: Array<{ id: string; displayName?: string }>;
  segments: TranscriptSegment[];
  warnings: Array<{ code: string; message: string }>;
}

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

export interface WhisperXReadiness {
  runtimeInstalled: boolean;
  runtimeVersion: string | null;
  pythonVersion: string | null;
  cudaAvailable: boolean;
  gpuName: string | null;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  asrModelReady: boolean;
  alignmentModelReady: boolean;
  diarizationTokenConfigured: boolean;
  diarizationModelReady: boolean;
  offlineReady: boolean;
  ffmpegAvailable: boolean;
  storageWritable: boolean;
  freeDiskBytes: number | null;
  blockers: Array<{ code: string; message: string }>;
}

export interface SpeakerMapping {
  [speakerId: string]: string;
}

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
