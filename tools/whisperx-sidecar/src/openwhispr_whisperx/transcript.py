"""Canonical transcript builder.

Turns raw WhisperX segments (plus optional alignment and diarization results)
into the canonical transcript dict defined in spec 03 §5. The output is a plain
dict with camelCase keys so it can be validated by
``schemas.CanonicalTranscript`` and serialised verbatim to ``transcript.raw.json``.

Rules (mirroring the JS side and spec):
- Stable segment ids ``seg-<zero-padded sequence>``; sequence is the position in
  the time-sorted order.
- Speakers come only from diarization. With diarization off, ``speakers`` is
  empty and segments carry no ``speakerId`` (never a fabricated SPEAKER_00).
- Flags: ``unaligned`` / ``partial-alignment`` from missing word timestamps,
  ``possible-overlap`` from diarization overlap info, ``low-confidence`` when
  avg_logprob < -1.0 or compression_ratio > 2.4 (whisper convention).
- Quality fields are emitted only when the backend actually provided them.
"""

from __future__ import annotations

from typing import Any, Optional

from . import TRANSCRIPT_SCHEMA_VERSION

_LOW_CONFIDENCE_LOGPROB = -1.0
_HIGH_COMPRESSION_RATIO = 2.4


def _seg_id(sequence: int) -> str:
    return f"seg-{sequence:04d}"


def _as_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f


def _word_speaker(word: dict[str, Any]) -> Optional[str]:
    spk = word.get("speaker") or word.get("speakerId")
    return spk if isinstance(spk, str) and spk else None


def _seg_speaker(seg: dict[str, Any]) -> Optional[str]:
    spk = seg.get("speaker") or seg.get("speakerId")
    return spk if isinstance(spk, str) and spk else None


def _word_text(word: dict[str, Any]) -> str:
    text = word.get("word", word.get("text", ""))
    return text if isinstance(text, str) else ""


def build_canonical_transcript(
    *,
    job_id: str,
    source: dict[str, Any],
    provenance: dict[str, Any],
    raw_segments: list[dict[str, Any]],
    alignment_used: bool,
    diarization_used: bool,
    warnings: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Build the canonical transcript dict (camelCase keys)."""
    # Time-sort segments; keep original order as tiebreak for equal starts.
    indexed = list(enumerate(raw_segments))
    indexed.sort(key=lambda pair: (_as_float(pair[1].get("start")) or 0.0, pair[0]))

    speaker_ids: list[str] = []

    def _register_speaker(spk: Optional[str]) -> None:
        if spk and spk not in speaker_ids:
            speaker_ids.append(spk)

    segments: list[dict[str, Any]] = []
    for sequence, (_orig_index, seg) in enumerate(indexed):
        start = _as_float(seg.get("start")) or 0.0
        end = _as_float(seg.get("end"))
        if end is None or end < start:
            end = start
        text = seg.get("text", "")
        if not isinstance(text, str):
            text = str(text)
        text = text.strip()

        seg_speaker = _seg_speaker(seg) if diarization_used else None

        words_out: list[dict[str, Any]] = []
        aligned_count = 0
        raw_words = seg.get("words") or []
        for word in raw_words:
            if not isinstance(word, dict):
                continue
            w_start = _as_float(word.get("start"))
            w_end = _as_float(word.get("end"))
            w_score = _as_float(word.get("score"))
            if w_start is not None:
                aligned_count += 1
            word_out: dict[str, Any] = {
                "text": _word_text(word),
                "start": w_start,
                "end": w_end,
                "score": w_score,
            }
            if diarization_used:
                w_spk = _word_speaker(word)
                if w_spk:
                    _register_speaker(w_spk)
                    word_out["speakerId"] = w_spk
            words_out.append(word_out)

        if diarization_used:
            _register_speaker(seg_speaker)

        # Flags.
        flags: list[str] = []
        total_words = len(words_out)
        if not alignment_used:
            flags.append("unaligned")
        elif total_words > 0 and aligned_count < total_words:
            flags.append("partial-alignment")
        if diarization_used and seg.get("overlap"):
            flags.append("possible-overlap")

        avg_logprob = _as_float(seg.get("avg_logprob"))
        compression_ratio = _as_float(seg.get("compression_ratio"))
        no_speech_prob = _as_float(seg.get("no_speech_prob"))
        low_conf = (
            avg_logprob is not None and avg_logprob < _LOW_CONFIDENCE_LOGPROB
        ) or (
            compression_ratio is not None
            and compression_ratio > _HIGH_COMPRESSION_RATIO
        )
        if low_conf:
            flags.append("low-confidence")

        # Quality: only backend-provided measures.
        quality: dict[str, Any] = {}
        if avg_logprob is not None:
            quality["avgLogProb"] = avg_logprob
        if no_speech_prob is not None:
            quality["noSpeechProb"] = no_speech_prob
        if compression_ratio is not None:
            quality["compressionRatio"] = compression_ratio
        if alignment_used and total_words > 0:
            quality["alignmentCoverage"] = aligned_count / total_words

        segment_out: dict[str, Any] = {
            "id": _seg_id(sequence),
            "sequence": sequence,
            "start": start,
            "end": end,
            "text": text,
            "words": words_out,
            "flags": flags,
        }
        if seg_speaker:
            segment_out["speakerId"] = seg_speaker
        if quality:
            segment_out["quality"] = quality
        segments.append(segment_out)

    speakers = (
        [{"id": spk} for spk in sorted(speaker_ids)] if diarization_used else []
    )

    return {
        "schemaVersion": TRANSCRIPT_SCHEMA_VERSION,
        "jobId": job_id,
        "source": source,
        "provenance": provenance,
        "speakers": speakers,
        "segments": segments,
        "warnings": warnings or [],
    }
