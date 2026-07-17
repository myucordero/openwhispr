"""Protocol emission tests: single valid JSON lines, and stdout purity."""

from __future__ import annotations

import io
import json
import sys

from openwhispr_whisperx import protocol


def _lines(buf: io.StringIO) -> list[str]:
    return [ln for ln in buf.getvalue().split("\n") if ln != ""]


def test_each_emit_is_one_valid_json_line():
    out = io.StringIO()
    protocol.bind_stream(out)
    try:
        protocol.emit_ready("0.1.0", "3.8.6", "3.12.3")
        protocol.emit_stage("transcribing")
        protocol.emit_progress("transcribing", 5, 10, "segments")
        protocol.emit_warning("ALIGNMENT_PARTIAL", "partial", {"n": 1})
        protocol.emit_artifact("srt", "transcript.srt", "a" * 64, 42, None)
        protocol.emit_complete({"jobId": "job-1"})
        protocol.emit_error("JOB_CANCELLED", "cancelled")
    finally:
        protocol.bind_stream(sys.__stdout__)

    lines = _lines(out)
    assert len(lines) == 7
    for line in lines:
        parsed = json.loads(line)  # each line is standalone valid JSON
        assert "type" in parsed
    assert json.loads(lines[0])["protocolVersion"] == 1


def test_progress_omits_optional_fields_when_absent():
    out = io.StringIO()
    protocol.bind_stream(out)
    try:
        protocol.emit_progress("transcribing", 3)
    finally:
        protocol.bind_stream(sys.__stdout__)
    event = json.loads(_lines(out)[0])
    assert "total" not in event and "unit" not in event


def test_stray_print_goes_to_stderr_not_protocol_stdout(monkeypatch):
    """Mirror the worker's hygiene: real stdout is private to the protocol."""
    real_stdout = io.StringIO()
    fake_stderr = io.StringIO()
    # Worker does: real=sys.stdout; sys.stdout=sys.stderr; bind_stream(real)
    monkeypatch.setattr(sys, "stdout", fake_stderr)
    protocol.bind_stream(real_stdout)
    try:
        print("noisy third-party diagnostic")  # goes to sys.stdout == fake_stderr
        protocol.emit_stage("loading-asr")
    finally:
        protocol.bind_stream(sys.__stdout__)

    # Protocol stream contains only the JSON event.
    proto_lines = _lines(real_stdout)
    assert len(proto_lines) == 1
    assert json.loads(proto_lines[0])["type"] == "stage"
    # The stray print landed on stderr, never on the protocol stream.
    assert "noisy third-party diagnostic" in fake_stderr.getvalue()
    assert "noisy" not in real_stdout.getvalue()
