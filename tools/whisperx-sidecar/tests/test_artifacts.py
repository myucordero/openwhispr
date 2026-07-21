"""Artifact renderer + writer + path confinement tests (golden outputs)."""

from __future__ import annotations

import hashlib

import pytest

from openwhispr_whisperx import artifacts
from openwhispr_whisperx.errors import WorkerError


def _transcript(with_speakers: bool = True):
    seg = {
        "id": "seg-0000",
        "sequence": 0,
        "start": 0.0,
        "end": 1.5,
        "text": "Hola",
        "words": [],
        "flags": [],
    }
    speakers = []
    if with_speakers:
        seg["speakerId"] = "SPEAKER_00"
        speakers = [{"id": "SPEAKER_00"}]
    return {
        "schemaVersion": 1,
        "jobId": "job-1",
        "source": {"displayName": "M.wav", "sha256": "a" * 64, "durationSeconds": 1.5},
        "provenance": {},
        "speakers": speakers,
        "segments": [seg],
        "warnings": [],
    }


def test_raw_txt_golden():
    assert artifacts.render_raw_txt(_transcript()) == "Hola\n"


def test_srt_golden():
    assert artifacts.render_srt(_transcript()) == (
        "1\n00:00:00,000 --> 00:00:01,500\nHola\n\n"
    )


def test_vtt_golden():
    assert artifacts.render_vtt(_transcript()) == (
        "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nHola\n\n"
    )


def test_speaker_markdown_golden():
    assert artifacts.render_speaker_markdown(_transcript()) == (
        "[00:00:00] SPEAKER_00: Hola\n"
    )


def test_speaker_markdown_omitted_without_diarization():
    assert artifacts.render_speaker_markdown(_transcript(with_speakers=False)) is None


def test_canonical_json_sorted_keys_and_trailing_newline():
    out = artifacts.render_canonical_json({"b": 1, "a": 2})
    assert out == '{\n  "a": 2,\n  "b": 1\n}\n'


def test_write_artifact_returns_correct_hash_and_bytes(tmp_path):
    content = "Hola\n"
    rel, sha, nbytes = artifacts.write_artifact(str(tmp_path), "transcript.raw.txt", content)
    assert rel == "transcript.raw.txt"
    assert nbytes == len(content.encode("utf-8"))
    assert sha == hashlib.sha256(content.encode("utf-8")).hexdigest()
    written = (tmp_path / "transcript.raw.txt").read_text(encoding="utf-8")
    assert written == content


@pytest.mark.parametrize(
    "bad",
    [
        "../escape.txt",
        "/etc/passwd",
        "C:\\Windows\\x.txt",
        "stream:data",
        "con.txt",
        "nul",
        "sub/../../x",
        "trailingdot.",
        "trailing ",
        "",
    ],
)
def test_unsafe_relative_paths_rejected(bad):
    assert artifacts.is_relative_artifact_path_safe(bad) is False


@pytest.mark.parametrize("good", ["transcript.srt", "sub/dir/file.json", "a.txt"])
def test_safe_relative_paths_accepted(good):
    assert artifacts.is_relative_artifact_path_safe(good) is True


def test_write_artifact_rejects_escape(tmp_path):
    with pytest.raises(WorkerError) as exc:
        artifacts.write_artifact(str(tmp_path), "../evil.txt", "x")
    assert exc.value.code == "OUTPUT_PATH_REJECTED"


def test_confine_rejects_symlink_escape(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = root / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    with pytest.raises(WorkerError):
        artifacts.confine(str(root), "link/child.txt")
