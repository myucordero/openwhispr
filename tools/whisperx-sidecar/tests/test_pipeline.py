"""Pipeline tests with injected fake backends (no torch/whisperx, no ffmpeg)."""

from __future__ import annotations

import json
import os

import pytest

from openwhispr_whisperx.errors import WorkerError
from openwhispr_whisperx.pipeline import run_pipeline
from openwhispr_whisperx.schemas import parse_job_request

from fake_backends import FakeAudio, FakeBackends


class RecordingEmitter:
    def __init__(self):
        self.events = []

    def emit_stage(self, stage):
        self.events.append({"type": "stage", "stage": stage})

    def emit_progress(self, stage, completed, total=None, unit=None):
        self.events.append({"type": "progress", "stage": stage, "completed": completed})

    def emit_warning(self, code, message, details=None):
        self.events.append({"type": "warning", "code": code})

    def emit_artifact(self, kind, relative_path, sha256, num_bytes, schema_version=None):
        self.events.append(
            {
                "type": "artifact",
                "kind": kind,
                "relativePath": relative_path,
                "sha256": sha256,
                "bytes": num_bytes,
            }
        )

    def emit_complete(self, result):
        self.events.append({"type": "complete", "result": result})

    def types(self):
        return [e["type"] for e in self.events]

    def warnings(self):
        return [e["code"] for e in self.events if e["type"] == "warning"]

    def complete(self):
        for e in self.events:
            if e["type"] == "complete":
                return e["result"]
        return None


def _run(request_dict, backends):
    request = parse_job_request(request_dict)
    emitter = RecordingEmitter()
    result = run_pipeline(request, backends, emitter, audio_ops=FakeAudio())
    return request, emitter, result


def _read_transcript(request_dict):
    path = os.path.join(request_dict["output"]["jobDirectory"], "transcript.raw.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def test_asr_only(make_request_dict):
    req = make_request_dict(
        alignment={"enabled": False},
        diarization={"enabled": False, "provider": "pyannote-community-1"},
    )
    _, emitter, result = _run(req, FakeBackends())
    assert "complete" in emitter.types()
    assert result["actualConfiguration"]["alignmentUsed"] is False
    assert result["actualConfiguration"]["diarizationUsed"] is False
    transcript = _read_transcript(req)
    assert transcript["speakers"] == []
    # speaker-markdown omitted without diarization
    kinds = [e["kind"] for e in emitter.events if e["type"] == "artifact"]
    assert "speaker-transcript" not in kinds
    assert "canonical-transcript" in kinds


def test_asr_plus_alignment(make_request_dict):
    req = make_request_dict(
        diarization={"enabled": False, "provider": "pyannote-community-1"},
    )
    _, emitter, result = _run(req, FakeBackends())
    assert result["actualConfiguration"]["alignmentUsed"] is True
    transcript = _read_transcript(req)
    assert all("unaligned" not in s["flags"] for s in transcript["segments"])


def test_asr_plus_diarization(make_request_dict):
    req = make_request_dict()
    _, emitter, result = _run(req, FakeBackends())
    assert result["actualConfiguration"]["diarizationUsed"] is True
    assert result["actualConfiguration"]["diarizationProvider"] == "pyannote-community-1"
    transcript = _read_transcript(req)
    assert [s["id"] for s in transcript["speakers"]] == ["SPEAKER_00", "SPEAKER_01"]
    kinds = [e["kind"] for e in emitter.events if e["type"] == "artifact"]
    assert "speaker-transcript" in kinds


def test_partial_alignment_warning(make_request_dict):
    req = make_request_dict(
        diarization={"enabled": False, "provider": "pyannote-community-1"},
    )
    _, emitter, _ = _run(req, FakeBackends(partial_alignment=True))
    assert "ALIGNMENT_PARTIAL" in emitter.warnings()


def test_diarization_failure_continues_without_speakers(make_request_dict):
    req = make_request_dict()
    _, emitter, result = _run(req, FakeBackends(diarize_fail=True))
    assert "DIARIZATION_UNAVAILABLE" in emitter.warnings()
    assert result["actualConfiguration"]["diarizationUsed"] is False
    transcript = _read_transcript(req)
    assert transcript["speakers"] == []


def test_oom_raises_cuda_out_of_memory(make_request_dict):
    req = make_request_dict()
    request = parse_job_request(req)
    emitter = RecordingEmitter()
    with pytest.raises(WorkerError) as exc:
        run_pipeline(request, FakeBackends(asr_oom=True), emitter, audio_ops=FakeAudio())
    assert exc.value.code == "CUDA_OUT_OF_MEMORY"
    assert "complete" not in emitter.types()


def test_arbitrary_value_error_not_classified_as_oom(make_request_dict):
    req = make_request_dict()
    request = parse_job_request(req)
    emitter = RecordingEmitter()
    with pytest.raises(ValueError):
        run_pipeline(
            request, FakeBackends(asr_valueerror=True), emitter, audio_ops=FakeAudio()
        )


def test_artifact_hashes_match_written_files(make_request_dict):
    import hashlib

    req = make_request_dict()
    _, emitter, _ = _run(req, FakeBackends())
    for event in emitter.events:
        if event["type"] != "artifact":
            continue
        path = os.path.join(req["output"]["jobDirectory"], event["relativePath"])
        with open(path, "rb") as fh:
            data = fh.read()
        assert hashlib.sha256(data).hexdigest() == event["sha256"]
        assert len(data) == event["bytes"]
