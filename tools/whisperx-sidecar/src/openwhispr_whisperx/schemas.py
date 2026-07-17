"""Pydantic v2 models mirroring the WhisperX data contracts (spec 03).

The JavaScript validators in ``src/helpers/whisperx/contracts.js`` are the
reference. These models must accept every ``valid-*`` shared fixture and reject
every ``invalid-*`` fixture for the same reason. Field names are Python
snake_case and serialise/parse as camelCase via ``to_camel``.

Design notes:
- Request models use ``extra="forbid"`` so an unexpected key — including a
  credential-shaped one like ``hfToken`` — is rejected. A recursive pre-scan
  additionally rejects credential-shaped key names anywhere in the request,
  mirroring ``findForbiddenKeys`` in contracts.js.
- Transcript ``Speaker`` and ``Quality`` use ``extra="allow"`` because the JS
  side accepts extra keys there and the shared ``valid-transcript.json`` fixture
  carries ``label`` on speakers and ``averageLogProb``/``noSpeechProb`` in
  quality. ``Quality`` still validates that every value (declared or extra) is a
  finite number, exactly like the JS validator.
- NaN/Infinity are rejected on numeric fields via ``allow_inf_nan=False`` plus
  explicit finiteness checks in the transcript validators.
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Any, Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# Enums / limits — mirror constants.js exactly.
# ---------------------------------------------------------------------------

RECORDING_PROFILES = ("memo", "meeting", "critical-interview")
RECORDING_LANGUAGES = ("auto", "en", "es")
WHISPERX_MODELS = ("large-v3-turbo", "large-v3")
COMPUTE_TYPES = ("float16", "int8")
DEVICES = ("cuda", "cpu")
BATCH_SIZES = (1, 2, 4, 8)
DIARIZATION_PROVIDERS = ("pyannote-community-1", "openwhispr-local")
OUTPUT_FORMATS = ("canonical-json", "raw-txt", "speaker-markdown", "srt", "vtt")
SEGMENT_FLAGS = (
    "unaligned",
    "partial-alignment",
    "possible-overlap",
    "possible-hallucination",
    "low-confidence",
    "manual-review",
)
ACTION_ITEM_STATUSES = ("explicit", "proposed", "unclear")
ARTIFACT_KINDS = (
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
)
NOTE_EXTRACTION_CATEGORIES = (
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
)

PROTOCOL_VERSION = 1
TRANSCRIPT_SCHEMA_VERSION = 1
NOTE_EXTRACTION_SCHEMA_VERSION = 1

# LIMITS (constants.js)
MAX_JSONL_LINE_BYTES = 1024 * 1024
MAX_HOTWORDS = 64
MAX_HOTWORD_LENGTH = 64
MAX_INITIAL_PROMPT_LENGTH = 2048
MAX_SEGMENT_TEXT_LENGTH = 8192
MAX_CLAIM_TEXT_LENGTH = 2000
MAX_SPEAKERS = 32

SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ISO_DATE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$"
)
# Credential-shaped key names that must never appear in a job request.
FORBIDDEN_KEY_RE = re.compile(
    r"(token|secret|api[-_]?key|password|credential|authorization)", re.IGNORECASE
)
# Control chars rejected in hotwords / initialPrompt (matches CONTROL_CHAR_RE in
# contracts.js: 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f, 0x7f — i.e. tab/newline/CR are
# NOT in this class).
CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

NonEmptyStr = Annotated[str, StringConstraints(min_length=1)]
FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]


def _find_forbidden_keys(value: Any, depth: int = 0) -> Optional[str]:
    """Return the first credential-shaped key path found, else None (depth<=16)."""
    if depth > 16:
        return None
    if isinstance(value, list):
        for item in value:
            hit = _find_forbidden_keys(item, depth + 1)
            if hit:
                return hit
        return None
    if isinstance(value, dict):
        for key in value:
            if isinstance(key, str) and FORBIDDEN_KEY_RE.search(key):
                return key
            hit = _find_forbidden_keys(value[key], depth + 1)
            if hit:
                return hit
    return None


# ---------------------------------------------------------------------------
# Job request (spec 03 §2)
# ---------------------------------------------------------------------------


class _RequestModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )


class SourceSpec(_RequestModel):
    path: NonEmptyStr
    display_name: NonEmptyStr
    expected_sha256: Optional[str] = None

    @field_validator("expected_sha256")
    @classmethod
    def _check_sha(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not SHA256_RE.match(v):
            raise ValueError("expectedSha256 must be 64 lowercase hex chars")
        return v


class OutputSpec(_RequestModel):
    job_directory: NonEmptyStr
    preserve_normalized_audio: StrictBool
    formats: list[Literal[OUTPUT_FORMATS]]  # type: ignore[valid-type]

    @field_validator("formats")
    @classmethod
    def _check_formats(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("formats must be a non-empty array")
        if "canonical-json" not in v:
            raise ValueError("canonical-json is mandatory in output formats")
        return v


class AsrConfig(_RequestModel):
    model: Literal[WHISPERX_MODELS]  # type: ignore[valid-type]
    compute_type: Literal[COMPUTE_TYPES]  # type: ignore[valid-type]
    batch_size: Literal[BATCH_SIZES]  # type: ignore[valid-type]
    device: Literal[DEVICES]  # type: ignore[valid-type]
    hotwords: list[str]
    initial_prompt: Optional[str] = None

    @field_validator("hotwords")
    @classmethod
    def _check_hotwords(cls, v: list[str]) -> list[str]:
        if len(v) > MAX_HOTWORDS:
            raise ValueError(f"At most {MAX_HOTWORDS} hotwords allowed")
        for w in v:
            if not isinstance(w, str) or len(w) == 0 or len(w) > MAX_HOTWORD_LENGTH:
                raise ValueError(
                    f"Hotwords must be non-empty strings of at most "
                    f"{MAX_HOTWORD_LENGTH} chars"
                )
            if CONTROL_CHAR_RE.search(w) or "\n" in w or "\r" in w:
                raise ValueError("Hotwords must not contain control characters")
        return v

    @field_validator("initial_prompt")
    @classmethod
    def _check_prompt(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if len(v) > MAX_INITIAL_PROMPT_LENGTH or CONTROL_CHAR_RE.search(v):
            raise ValueError(
                "initialPrompt must be a control-character-free string of at most "
                f"{MAX_INITIAL_PROMPT_LENGTH} chars"
            )
        return v


class AlignmentConfig(_RequestModel):
    enabled: StrictBool


class DiarizationConfig(_RequestModel):
    enabled: StrictBool
    provider: Literal[DIARIZATION_PROVIDERS]  # type: ignore[valid-type]
    exact_speakers: Optional[int] = None
    min_speakers: Optional[int] = None
    max_speakers: Optional[int] = None

    @field_validator("exact_speakers", "min_speakers", "max_speakers")
    @classmethod
    def _check_count(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 1 or v > MAX_SPEAKERS):
            raise ValueError(f"speaker count must be an integer between 1 and {MAX_SPEAKERS}")
        return v

    @model_validator(mode="after")
    def _check_combo(self) -> "DiarizationConfig":
        if self.exact_speakers is not None and (
            self.min_speakers is not None or self.max_speakers is not None
        ):
            raise ValueError(
                "exactSpeakers cannot be combined with minSpeakers/maxSpeakers"
            )
        if (
            self.min_speakers is not None
            and self.max_speakers is not None
            and self.min_speakers > self.max_speakers
        ):
            raise ValueError("minSpeakers must be <= maxSpeakers")
        return self


class RuntimeConfig(_RequestModel):
    offline: StrictBool
    model_cache_directory: NonEmptyStr
    temporary_directory: NonEmptyStr


class WhisperXJobRequest(_RequestModel):
    protocol_version: Literal[1]
    request_id: NonEmptyStr
    job_id: NonEmptyStr
    source: SourceSpec
    output: OutputSpec
    profile: Literal[RECORDING_PROFILES]  # type: ignore[valid-type]
    language: Literal[RECORDING_LANGUAGES]  # type: ignore[valid-type]
    asr: AsrConfig
    alignment: AlignmentConfig
    diarization: DiarizationConfig
    runtime: RuntimeConfig

    @model_validator(mode="before")
    @classmethod
    def _reject_forbidden_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            hit = _find_forbidden_keys(data)
            if hit:
                raise ValueError(
                    f'Field name "{hit}" looks like a credential and must not '
                    "appear in protocol JSON"
                )
        return data


# ---------------------------------------------------------------------------
# Canonical transcript (spec 03 §5)
# ---------------------------------------------------------------------------


class _StrictModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )


class _LenientModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="allow"
    )


class TranscriptWord(_StrictModel):
    text: str
    start: Optional[FiniteFloat] = None
    end: Optional[FiniteFloat] = None
    score: Optional[FiniteFloat] = None
    speaker_id: Optional[str] = None


class Quality(_LenientModel):
    # Spec §5 quality fields; extras are allowed but every value must be finite.
    avg_log_prob: Optional[FiniteFloat] = None
    no_speech_prob: Optional[FiniteFloat] = None
    compression_ratio: Optional[FiniteFloat] = None
    alignment_coverage: Optional[FiniteFloat] = None

    @model_validator(mode="after")
    def _check_finite(self) -> "Quality":
        extras = self.__pydantic_extra__ or {}
        for key, value in extras.items():
            if value is None:
                continue
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"quality value {key!r} must be a finite number")
            if not math.isfinite(value):
                raise ValueError(f"quality value {key!r} must be a finite number")
        return self


class TranscriptSegment(_StrictModel):
    id: NonEmptyStr
    sequence: int = Field(ge=0)
    start: FiniteFloat = Field(ge=0)
    end: FiniteFloat
    speaker_id: Optional[str] = None
    text: Annotated[str, StringConstraints(max_length=MAX_SEGMENT_TEXT_LENGTH)]
    words: list[TranscriptWord]
    quality: Optional[Quality] = None
    flags: list[Literal[SEGMENT_FLAGS]]  # type: ignore[valid-type]

    @model_validator(mode="after")
    def _check_end(self) -> "TranscriptSegment":
        if self.end < self.start:
            raise ValueError("end must be a number >= start")
        return self


class TranscriptSource(_StrictModel):
    display_name: NonEmptyStr
    sha256: str
    duration_seconds: FiniteFloat = Field(ge=0)

    @field_validator("sha256")
    @classmethod
    def _check_sha(cls, v: str) -> str:
        if not SHA256_RE.match(v):
            raise ValueError("source.sha256 must be 64 lowercase hex chars")
        return v


class Provenance(_StrictModel):
    engine: Literal["whisperx"]
    whisperx_version: NonEmptyStr
    faster_whisper_version: Optional[str] = None
    torch_version: Optional[str] = None
    pyannote_version: Optional[str] = None
    model: NonEmptyStr
    model_revision: Optional[str] = None
    device: NonEmptyStr
    compute_type: NonEmptyStr
    batch_size: int = Field(ge=1)
    language_requested: Literal[RECORDING_LANGUAGES]  # type: ignore[valid-type]
    language_detected: Optional[str] = None
    alignment_model: Optional[str] = None
    diarization_model: Optional[str] = None
    created_at: NonEmptyStr

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        protected_namespaces=(),
    )


class Speaker(_LenientModel):
    id: NonEmptyStr
    display_name: Optional[str] = None


class CanonicalTranscript(_StrictModel):
    schema_version: Literal[1]
    job_id: NonEmptyStr
    source: TranscriptSource
    provenance: Provenance
    speakers: list[Speaker]
    segments: list[TranscriptSegment]
    warnings: list[dict[str, Any]] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_structure(self) -> "CanonicalTranscript":
        speaker_ids: set[str] = set()
        for sp in self.speakers:
            if sp.id in speaker_ids:
                raise ValueError(f'Duplicate speaker id "{sp.id}"')
            speaker_ids.add(sp.id)

        segment_ids: set[str] = set()
        prev_start = float("-inf")
        prev_sequence = float("-inf")
        for seg in self.segments:
            if seg.id in segment_ids:
                raise ValueError(f'Duplicate segment id "{seg.id}"')
            segment_ids.add(seg.id)

            if seg.start < prev_start or (
                seg.start == prev_start and seg.sequence < prev_sequence
            ):
                raise ValueError("Segments must be sorted by time then sequence")
            prev_start = seg.start
            prev_sequence = seg.sequence

            if seg.speaker_id is not None and seg.speaker_id not in speaker_ids:
                raise ValueError(
                    f'speakerId "{seg.speaker_id}" not defined in speakers'
                )

            prev_word_start = float("-inf")
            for word in seg.words:
                if word.start is not None:
                    if word.start < prev_word_start:
                        raise ValueError("Words must remain time-ordered")
                    prev_word_start = word.start
                if word.speaker_id is not None and word.speaker_id not in speaker_ids:
                    raise ValueError(
                        f'speakerId "{word.speaker_id}" not defined in speakers'
                    )
        return self


# ---------------------------------------------------------------------------
# Note extraction (spec 03 §7)
# ---------------------------------------------------------------------------


class EvidenceRef(_StrictModel):
    segment_ids: list[NonEmptyStr]

    @field_validator("segment_ids")
    @classmethod
    def _non_empty(cls, v: list[str]) -> list[str]:
        if len(v) == 0:
            raise ValueError("evidence.segmentIds must not be empty")
        return v


def _validate_claim_text(v: str) -> str:
    if not isinstance(v, str) or v.strip() == "":
        raise ValueError("Claim text must be non-empty")
    if len(v) > MAX_CLAIM_TEXT_LENGTH:
        raise ValueError(f"Claim text must be at most {MAX_CLAIM_TEXT_LENGTH} chars")
    return v


class EvidenceClaim(_StrictModel):
    id: NonEmptyStr
    text: str
    evidence: EvidenceRef
    review_required: Optional[StrictBool] = None

    _check_text = field_validator("text")(_validate_claim_text)


class ActionItem(_StrictModel):
    id: NonEmptyStr
    task: str
    owner_speaker_id: Optional[str]
    due_date_text: Optional[str]
    due_date_iso: Optional[str]
    status: Literal[ACTION_ITEM_STATUSES]  # type: ignore[valid-type]
    evidence: EvidenceRef
    review_required: Optional[StrictBool] = None

    _check_task = field_validator("task")(_validate_claim_text)

    @field_validator("due_date_iso")
    @classmethod
    def _check_iso(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not ISO_DATE_RE.match(v):
            raise ValueError("dueDateIso must be an ISO date string or null")
        return v

    @model_validator(mode="after")
    def _date_explicit(self) -> "ActionItem":
        if self.due_date_iso is not None and self.due_date_text is None:
            raise ValueError(
                "dueDateIso requires the explicit dueDateText it was derived from"
            )
        return self


class ImportantQuote(_StrictModel):
    id: NonEmptyStr
    quote: str
    speaker_id: Optional[str]
    evidence: EvidenceRef
    review_required: Optional[StrictBool] = None

    _check_quote = field_validator("quote")(_validate_claim_text)


class Generation(_StrictModel):
    provider: NonEmptyStr
    model: NonEmptyStr
    temperature: float
    thinking_disabled: StrictBool
    created_at: NonEmptyStr

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        protected_namespaces=(),
    )

    @field_validator("temperature")
    @classmethod
    def _check_temp(cls, v: float) -> float:
        if not math.isfinite(v) or v < 0 or v > 2:
            raise ValueError("temperature must be a number in [0,2]")
        return v


class NoteExtraction(_StrictModel):
    schema_version: Literal[1]
    job_id: NonEmptyStr
    source_transcript_sha256: str
    prompt_version: NonEmptyStr
    generation: Generation
    summary_claims: list[EvidenceClaim]
    discussion_points: list[EvidenceClaim]
    decisions: list[EvidenceClaim]
    proposals: list[EvidenceClaim]
    action_items: list[ActionItem]
    follow_ups: list[EvidenceClaim]
    open_questions: list[EvidenceClaim]
    risks_or_blockers: list[EvidenceClaim]
    important_quotes: list[ImportantQuote]
    unresolved_ambiguities: list[EvidenceClaim]

    @field_validator("source_transcript_sha256")
    @classmethod
    def _check_sha(cls, v: str) -> str:
        if not SHA256_RE.match(v):
            raise ValueError(
                "sourceTranscriptSha256 must be 64 lowercase hex chars"
            )
        return v

    @model_validator(mode="after")
    def _unique_item_ids(self) -> "NoteExtraction":
        seen: set[str] = set()
        groups = [
            self.summary_claims,
            self.discussion_points,
            self.decisions,
            self.proposals,
            self.action_items,
            self.follow_ups,
            self.open_questions,
            self.risks_or_blockers,
            self.important_quotes,
            self.unresolved_ambiguities,
        ]
        for group in groups:
            for item in group:
                if item.id in seen:
                    raise ValueError(f'Duplicate item id "{item.id}"')
                seen.add(item.id)
        return self


# ---------------------------------------------------------------------------
# Parse helpers (raise pydantic.ValidationError on invalid input)
# ---------------------------------------------------------------------------


def parse_job_request(data: dict[str, Any]) -> WhisperXJobRequest:
    return WhisperXJobRequest.model_validate(data)


def parse_canonical_transcript(data: dict[str, Any]) -> CanonicalTranscript:
    return CanonicalTranscript.model_validate(data)


def parse_note_extraction(data: dict[str, Any]) -> NoteExtraction:
    return NoteExtraction.model_validate(data)
