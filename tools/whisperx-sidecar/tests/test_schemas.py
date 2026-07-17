"""Schema tests: shared-fixture agreement + per-rule unit checks (spec 06 §3).

The JS validators in src/helpers/whisperx/contracts.js are the reference: valid
fixtures parse, the same invalid fixtures are rejected for the same reasons.
"""

from __future__ import annotations

import copy

import pytest
from pydantic import ValidationError

from openwhispr_whisperx.schemas import (
    parse_canonical_transcript,
    parse_job_request,
    parse_note_extraction,
)


# --- shared cross-language fixtures ---------------------------------------


def test_valid_job_request_fixture_parses(load_fixture):
    req = parse_job_request(load_fixture("valid-job-request.json"))
    assert req.job_id == "job-fixture-001"
    assert req.output.formats[0] == "canonical-json"


def test_invalid_path_request_fixture_rejected(load_fixture):
    # Missing canonical-json AND exactSpeakers combined with minSpeakers.
    with pytest.raises(ValidationError):
        parse_job_request(load_fixture("invalid-path-request.json"))


def test_invalid_secret_request_fixture_rejected(load_fixture):
    # asr.hfToken is a credential-shaped forbidden key.
    with pytest.raises(ValidationError) as exc:
        parse_job_request(load_fixture("invalid-secret-request.json"))
    assert "hfToken" in str(exc.value) or "credential" in str(exc.value)


def test_valid_transcript_fixture_parses(load_fixture):
    t = parse_canonical_transcript(load_fixture("valid-transcript.json"))
    assert len(t.segments) == 4
    # extra keys tolerated where JS is lenient: speaker.label, quality.averageLogProb
    assert t.speakers[0].id == "SPEAKER_00"


def test_invalid_transcript_duplicate_id_fixture_rejected(load_fixture):
    with pytest.raises(ValidationError) as exc:
        parse_canonical_transcript(load_fixture("invalid-transcript-duplicate-id.json"))
    assert "Duplicate segment id" in str(exc.value)


def test_valid_note_extraction_fixture_parses(load_fixture):
    note = parse_note_extraction(load_fixture("valid-note-extraction.json"))
    assert note.action_items[0].status == "explicit"


def test_invalid_note_missing_evidence_fixture_rejected(load_fixture):
    with pytest.raises(ValidationError) as exc:
        parse_note_extraction(load_fixture("invalid-note-missing-evidence.json"))
    assert "segmentIds" in str(exc.value)


# --- job request unit rules ----------------------------------------------


@pytest.fixture()
def valid_request(load_fixture):
    return copy.deepcopy(load_fixture("valid-job-request.json"))


def test_forbidden_key_anywhere_rejected(valid_request):
    valid_request["runtime"]["myAuthorizationToken"] = "x"
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)


def test_batch_size_allowlist(valid_request):
    valid_request["asr"]["batchSize"] = 3
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)
    for good in (1, 2, 4, 8):
        req = copy.deepcopy(valid_request)
        req["asr"]["batchSize"] = good
        assert parse_job_request(req).asr.batch_size == good


def test_canonical_json_mandatory(valid_request):
    valid_request["output"]["formats"] = ["raw-txt", "srt"]
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)


def test_hotword_caps_and_control_chars(valid_request):
    valid_request["asr"]["hotwords"] = ["a" * 65]
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)

    req = copy.deepcopy(valid_request)
    req["asr"]["hotwords"] = ["x"] * 65
    with pytest.raises(ValidationError):
        parse_job_request(req)

    req = copy.deepcopy(valid_request)
    req["asr"]["hotwords"] = ["bad\x00word"]
    with pytest.raises(ValidationError):
        parse_job_request(req)


def test_initial_prompt_length(valid_request):
    valid_request["asr"]["initialPrompt"] = "x" * 2049
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)


def test_speaker_count_validation(valid_request):
    # exact XOR min/max
    req = copy.deepcopy(valid_request)
    req["diarization"] = {
        "enabled": True,
        "provider": "pyannote-community-1",
        "exactSpeakers": 2,
        "minSpeakers": 1,
    }
    with pytest.raises(ValidationError):
        parse_job_request(req)

    # min > max
    req = copy.deepcopy(valid_request)
    req["diarization"] = {
        "enabled": True,
        "provider": "pyannote-community-1",
        "minSpeakers": 5,
        "maxSpeakers": 2,
    }
    with pytest.raises(ValidationError):
        parse_job_request(req)

    # out of 1..32 range
    req = copy.deepcopy(valid_request)
    req["diarization"] = {
        "enabled": True,
        "provider": "pyannote-community-1",
        "exactSpeakers": 33,
    }
    with pytest.raises(ValidationError):
        parse_job_request(req)


def test_offline_flag_must_be_boolean(valid_request):
    valid_request["runtime"]["offline"] = "yes"
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)


def test_device_must_be_explicit(valid_request):
    valid_request["asr"]["device"] = "auto"
    with pytest.raises(ValidationError):
        parse_job_request(valid_request)


# --- transcript unit rules -----------------------------------------------


@pytest.fixture()
def valid_transcript(load_fixture):
    return copy.deepcopy(load_fixture("valid-transcript.json"))


def test_transcript_rejects_nan(valid_transcript):
    valid_transcript["segments"][0]["start"] = float("nan")
    with pytest.raises(ValidationError):
        parse_canonical_transcript(valid_transcript)


def test_transcript_rejects_unknown_speaker(valid_transcript):
    valid_transcript["segments"][0]["speakerId"] = "SPEAKER_99"
    with pytest.raises(ValidationError) as exc:
        parse_canonical_transcript(valid_transcript)
    assert "not defined in speakers" in str(exc.value)


def test_transcript_rejects_out_of_order_segments(valid_transcript):
    # Reverse the (individually valid) segments so only ordering is wrong.
    valid_transcript["segments"] = list(reversed(valid_transcript["segments"]))
    with pytest.raises(ValidationError) as exc:
        parse_canonical_transcript(valid_transcript)
    assert "sorted" in str(exc.value)


def test_transcript_rejects_oversize_text(valid_transcript):
    valid_transcript["segments"][0]["text"] = "x" * 8193
    with pytest.raises(ValidationError):
        parse_canonical_transcript(valid_transcript)


# --- note extraction unit rules ------------------------------------------


@pytest.fixture()
def valid_note(load_fixture):
    return copy.deepcopy(load_fixture("valid-note-extraction.json"))


def test_note_duplicate_item_id_rejected(valid_note):
    valid_note["decisions"][0]["id"] = "claim-0001"  # collides with summaryClaims
    with pytest.raises(ValidationError) as exc:
        parse_note_extraction(valid_note)
    assert "Duplicate item id" in str(exc.value)


def test_note_due_date_requires_explicit_text(valid_note):
    valid_note["actionItems"][0]["dueDateIso"] = "2026-08-01"
    valid_note["actionItems"][0]["dueDateText"] = None
    with pytest.raises(ValidationError):
        parse_note_extraction(valid_note)


def test_note_empty_claim_text_rejected(valid_note):
    valid_note["summaryClaims"][0]["text"] = "   "
    with pytest.raises(ValidationError):
        parse_note_extraction(valid_note)
