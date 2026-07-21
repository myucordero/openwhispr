"""End-to-end worker subprocess tests using the fake backends module.

The worker imports real_backends normally; here we point it at
tests/fake_backends.py via OPENWHISPR_WORKER_FAKE_BACKENDS so no torch/whisperx/
ffmpeg is needed. stdout carries only the JSONL protocol.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.join(os.path.dirname(_HERE), "src")
_FAKE_BACKENDS = os.path.join(_HERE, "fake_backends.py")


def _env(**extra):
    env = os.environ.copy()
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["OPENWHISPR_WORKER_FAKE_BACKENDS"] = "1"
    env["OPENWHISPR_WORKER_BACKENDS_MODULE"] = _FAKE_BACKENDS
    env.update(extra)
    return env


def _request(tmp_path, **overrides):
    source = tmp_path / "source.wav"
    source.write_bytes(b"RIFFfakewavdata")
    job_dir = tmp_path / "job"
    job_dir.mkdir(exist_ok=True)
    temp_dir = tmp_path / "tmp"
    temp_dir.mkdir(exist_ok=True)
    req = {
        "protocolVersion": 1,
        "requestId": "req-1",
        "jobId": "job-1",
        "source": {"path": str(source), "displayName": "Meeting.wav"},
        "output": {
            "jobDirectory": str(job_dir),
            "preserveNormalizedAudio": False,
            "formats": ["canonical-json", "raw-txt", "speaker-markdown", "srt", "vtt"],
        },
        "profile": "meeting",
        "language": "es",
        "asr": {
            "model": "large-v3-turbo",
            "computeType": "float16",
            "batchSize": 4,
            "device": "cuda",
            "hotwords": [],
        },
        "alignment": {"enabled": True},
        "diarization": {
            "enabled": True,
            "provider": "pyannote-community-1",
            "minSpeakers": 1,
            "maxSpeakers": 2,
        },
        "runtime": {
            "offline": True,
            "modelCacheDirectory": str(tmp_path / "models"),
            "temporaryDirectory": str(temp_dir),
        },
    }
    req.update(overrides)
    return req


def _parse_events(stdout: str):
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if line:
            events.append(json.loads(line))  # every protocol line is valid JSON
    return events


def test_valid_request_full_event_stream(tmp_path):
    req = _request(tmp_path)
    proc = subprocess.run(
        [sys.executable, "-m", "openwhispr_whisperx.worker"],
        input=json.dumps(req) + "\n",
        capture_output=True,
        text=True,
        env=_env(),
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    events = _parse_events(proc.stdout)
    types = [e["type"] for e in events]
    assert types[0] == "ready"
    assert "complete" in types
    assert events[0]["protocolVersion"] == 1

    # Artifacts written with real hashes.
    import hashlib

    artifact_events = [e for e in events if e["type"] == "artifact"]
    assert artifact_events
    for a in artifact_events:
        path = os.path.join(req["output"]["jobDirectory"], a["relativePath"])
        with open(path, "rb") as fh:
            data = fh.read()
        assert hashlib.sha256(data).hexdigest() == a["sha256"]


def test_invalid_request_exits_2(tmp_path):
    req = _request(tmp_path)
    req["output"]["formats"] = ["raw-txt"]  # missing mandatory canonical-json
    proc = subprocess.run(
        [sys.executable, "-m", "openwhispr_whisperx.worker"],
        input=json.dumps(req) + "\n",
        capture_output=True,
        text=True,
        env=_env(),
        timeout=60,
    )
    assert proc.returncode == 2
    events = _parse_events(proc.stdout)
    assert any(
        e["type"] == "error" and e["error"]["code"] == "WORKER_PROTOCOL_ERROR"
        for e in events
    )


def test_sigterm_mid_run_cancels(tmp_path):
    req = _request(tmp_path)
    proc = subprocess.Popen(
        [sys.executable, "-m", "openwhispr_whisperx.worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_env(OPENWHISPR_FAKE_SLEEP="1"),  # transcribe loops, cancellable
    )
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    # Keep stdin open: the worker already has its line (newline-terminated), and
    # communicate() will flush/close it for us.

    time.sleep(1.5)  # let it reach the transcribing loop
    proc.send_signal(signal.SIGTERM)
    stdout, stderr = proc.communicate(timeout=30)

    assert proc.returncode == 130, stderr
    events = _parse_events(stdout)
    assert any(
        e["type"] == "error" and e["error"]["code"] == "JOB_CANCELLED" for e in events
    )
