"""Shared test setup: make the package importable and locate shared fixtures."""

from __future__ import annotations

import json
import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SIDECAR_ROOT = os.path.dirname(_HERE)
_SRC = os.path.join(_SIDECAR_ROOT, "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

# Shared cross-language fixtures: tools/whisperx-sidecar/tests -> repo root.
_REPO_ROOT = os.path.dirname(os.path.dirname(_SIDECAR_ROOT))
CONTRACT_FIXTURES_DIR = os.path.join(
    _REPO_ROOT, "tests", "fixtures", "whisperx-contracts"
)


@pytest.fixture(scope="session")
def contract_fixtures_dir() -> str:
    assert os.path.isdir(CONTRACT_FIXTURES_DIR), (
        f"Shared contract fixtures not found at {CONTRACT_FIXTURES_DIR}"
    )
    return CONTRACT_FIXTURES_DIR


@pytest.fixture(scope="session")
def load_fixture(contract_fixtures_dir):
    def _load(name: str):
        with open(os.path.join(contract_fixtures_dir, name), encoding="utf-8") as fh:
            return json.load(fh)

    return _load


@pytest.fixture()
def make_request_dict(tmp_path):
    """Build a valid job-request dict with real temp paths; override sub-dicts."""

    def _make(**overrides):
        source = tmp_path / "source.wav"
        source.write_bytes(b"RIFFfakewavdata")
        job_dir = tmp_path / "job"
        job_dir.mkdir(exist_ok=True)
        temp_dir = tmp_path / "tmp"
        temp_dir.mkdir(exist_ok=True)
        models_dir = tmp_path / "models"
        models_dir.mkdir(exist_ok=True)
        req = {
            "protocolVersion": 1,
            "requestId": "req-1",
            "jobId": "job-1",
            "source": {"path": str(source), "displayName": "Meeting.wav"},
            "output": {
                "jobDirectory": str(job_dir),
                "preserveNormalizedAudio": False,
                "formats": [
                    "canonical-json",
                    "raw-txt",
                    "speaker-markdown",
                    "srt",
                    "vtt",
                ],
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
                "modelCacheDirectory": str(models_dir),
                "temporaryDirectory": str(temp_dir),
            },
        }
        req.update(overrides)
        return req

    return _make
