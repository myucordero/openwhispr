"""Content-safe diagnostics redaction.

Python mirror of ``src/helpers/whisperx/redaction.js`` (spec 07 §7, §11).
Applied to every string destined for stderr diagnostics or a protocol error
message before it leaves the process. Transcript content never flows through
here; this guards incidental leaks of tokens, keys, and full home paths.
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"
REDACTED_HOME = "<home>"

_SENSITIVE_ENV_KEY_RE = re.compile(
    r"(token|secret|api[-_]?key|password|credential|authorization)", re.IGNORECASE
)

# Hugging Face tokens ("hf_" + alnum), generic bearer values, and common
# key=value / key: value assignments for sensitive-looking keys.
_HF_TOKEN_RE = re.compile(r"\bhf_[A-Za-z0-9]{10,}\b")
_BEARER_RE = re.compile(r"\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
_KEY_VALUE_RE = re.compile(
    r"\b([A-Za-z0-9_-]*(?:token|secret|api[-_]?key|password|credential|authorization)"
    r"[A-Za-z0-9_-]*)\s*([=:])\s*(\"[^\"]*\"|'[^']*'|[^\s,;]+)",
    re.IGNORECASE,
)

# Home directories on both platforms; keeps the tail of the path so diagnostics
# stay useful without leaking the user name.
_WIN_USER_PATH_RE = re.compile(r"[A-Za-z]:\\Users\\[^\\/:*?\"<>|\s]+")
_POSIX_HOME_RE = re.compile(r"/(?:home|Users)/[^/\s]+")


def redact_text(value: Any) -> Any:
    """Redact tokens, bearer values, key=value credentials, and home paths."""
    if not isinstance(value, str) or value == "":
        return value
    out = _HF_TOKEN_RE.sub(REDACTED, value)
    out = _BEARER_RE.sub(lambda m: f"{m.group(1)} {REDACTED}", out)
    out = _KEY_VALUE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", out)
    out = _WIN_USER_PATH_RE.sub(REDACTED_HOME, out)
    out = _POSIX_HOME_RE.sub(REDACTED_HOME, out)
    return out


def is_sensitive_env_key(key: str) -> bool:
    return bool(_SENSITIVE_ENV_KEY_RE.search(key))


def redact_object_strings(value: Any, depth: int = 0) -> Any:
    """Recursively redact strings; drop values under sensitive-looking keys."""
    if depth > 8:
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact_object_strings(v, depth + 1) for v in value]
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for k, v in value.items():
            out[k] = (
                REDACTED
                if isinstance(k, str) and is_sensitive_env_key(k)
                else redact_object_strings(v, depth + 1)
            )
        return out
    return value
