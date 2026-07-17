"""Canonical transcript builder tests."""

from __future__ import annotations

from openwhispr_whisperx.schemas import parse_canonical_transcript
from openwhispr_whisperx.transcript import build_canonical_transcript

SHA = "a" * 64


def _provenance():
    return {
        "engine": "whisperx",
        "whisperxVersion": "0.0.0-fake",
        "model": "large-v3-turbo",
        "device": "cuda",
        "computeType": "float16",
        "batchSize": 4,
        "languageRequested": "es",
        "createdAt": "2026-07-16T14:32:05Z",
    }


def _raw():
    return [
        {
            "start": 0.0,
            "end": 3.0,
            "text": "Hola equipo.",
            "avg_logprob": -0.2,
            "compression_ratio": 1.1,
            "words": [{"word": "Hola"}, {"word": "equipo."}],
        },
        {
            "start": 3.2,
            "end": 6.0,
            "text": "Good morning.",
            "avg_logprob": -1.5,  # low-confidence
            "compression_ratio": 1.2,
            "words": [{"word": "Good"}, {"word": "morning."}],
        },
    ]


def _build(**kwargs):
    defaults = dict(
        job_id="job-1",
        source={"displayName": "M.wav", "sha256": SHA, "durationSeconds": 6.0},
        provenance=_provenance(),
        raw_segments=_raw(),
        alignment_used=False,
        diarization_used=False,
    )
    defaults.update(kwargs)
    t = build_canonical_transcript(**defaults)
    parse_canonical_transcript(t)  # must always validate against the schema
    return t


def test_asr_only_stable_ids_no_speakers_unaligned():
    t = _build()
    assert [s["id"] for s in t["segments"]] == ["seg-0000", "seg-0001"]
    assert t["speakers"] == []
    for seg in t["segments"]:
        assert "speakerId" not in seg
        assert "unaligned" in seg["flags"]
    # low-confidence flagged only on the second segment
    assert "low-confidence" in t["segments"][1]["flags"]
    assert "low-confidence" not in t["segments"][0]["flags"]


def test_quality_not_fabricated():
    raw = _raw()
    del raw[0]["avg_logprob"]  # backend did not provide it
    del raw[0]["compression_ratio"]
    t = _build(raw_segments=raw)
    assert "quality" not in t["segments"][0] or "avgLogProb" not in t["segments"][0].get("quality", {})
    # alignmentCoverage never present without alignment
    assert "alignmentCoverage" not in t["segments"][0].get("quality", {})


def test_alignment_fills_words_and_coverage():
    raw = _raw()
    for seg in raw:
        for i, w in enumerate(seg["words"]):
            w["start"] = seg["start"] + i * 0.5
            w["end"] = seg["start"] + (i + 1) * 0.5
            w["score"] = 0.9
    t = _build(raw_segments=raw, alignment_used=True)
    for seg in t["segments"]:
        assert "unaligned" not in seg["flags"]
        assert seg["quality"]["alignmentCoverage"] == 1.0
        assert all(w["start"] is not None for w in seg["words"])


def test_partial_alignment_flag():
    raw = _raw()
    # only the first segment gets word timestamps
    for i, w in enumerate(raw[0]["words"]):
        w["start"] = i * 0.5
        w["end"] = (i + 1) * 0.5
        w["score"] = 0.9
    t = _build(raw_segments=raw, alignment_used=True)
    assert "partial-alignment" in t["segments"][1]["flags"]


def test_diarization_assigns_sorted_speakers():
    raw = _raw()
    raw[0]["speaker"] = "SPEAKER_01"
    raw[1]["speaker"] = "SPEAKER_00"
    for w in raw[0]["words"]:
        w["speaker"] = "SPEAKER_01"
    for w in raw[1]["words"]:
        w["speaker"] = "SPEAKER_00"
    t = _build(raw_segments=raw, diarization_used=True)
    assert [s["id"] for s in t["speakers"]] == ["SPEAKER_00", "SPEAKER_01"]
    assert t["segments"][0]["speakerId"] == "SPEAKER_01"


def test_segments_sorted_by_start():
    raw = _raw()
    raw.reverse()  # feed out of order
    t = _build(raw_segments=raw)
    starts = [s["start"] for s in t["segments"]]
    assert starts == sorted(starts)
    assert [s["sequence"] for s in t["segments"]] == [0, 1]
