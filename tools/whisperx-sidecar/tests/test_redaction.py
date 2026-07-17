"""Redaction tests — no secret or full home path survives (spec 07 §7, §11)."""

from __future__ import annotations

from openwhispr_whisperx.errors import classify_oom
from openwhispr_whisperx.redaction import (
    is_sensitive_env_key,
    redact_object_strings,
    redact_text,
)


def test_hf_token_redacted():
    out = redact_text("using token hf_abc1234567890XYZ now")
    assert "hf_abc1234567890XYZ" not in out
    assert "[REDACTED]" in out


def test_bearer_redacted():
    out = redact_text("Authorization: Bearer sk-abcdef1234567890")
    assert "sk-abcdef1234567890" not in out


def test_key_value_credentials_redacted():
    out = redact_text('api_key=supersecretvalue123 password: "hunter2"')
    assert "supersecretvalue123" not in out
    assert "hunter2" not in out


def test_home_paths_redacted():
    assert "/home/marco" not in redact_text("path /home/marco/audio.wav")
    assert "marco" not in redact_text("path /home/marco/audio.wav")
    win = redact_text(r"path C:\Users\FakeUser\audio.wav")
    assert "FakeUser" not in win


def test_redact_object_strings_drops_sensitive_keys():
    obj = {"hfToken": "hf_secretsecret123", "note": "hello /home/marco/x"}
    out = redact_object_strings(obj)
    assert out["hfToken"] == "[REDACTED]"
    assert "marco" not in out["note"]


def test_is_sensitive_env_key():
    assert is_sensitive_env_key("HF_TOKEN")
    assert is_sensitive_env_key("MY_API_KEY")
    assert not is_sensitive_env_key("PATH")


# --- OOM classification precision (errors.classify_oom) -------------------


class OutOfMemoryError(Exception):
    pass


def test_classify_oom_by_class_name():
    assert classify_oom(OutOfMemoryError("boom")) is True


def test_classify_oom_by_runtime_message():
    assert classify_oom(RuntimeError("CUDA out of memory. Tried to allocate...")) is True
    assert classify_oom(RuntimeError("cublas alloc failed")) is True


def test_value_error_not_classified_as_oom():
    assert classify_oom(ValueError("bad input")) is False
    assert classify_oom(RuntimeError("some unrelated runtime error")) is False
