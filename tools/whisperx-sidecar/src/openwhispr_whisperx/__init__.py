"""OpenWhispr WhisperX sidecar package.

Python worker that speaks the versioned JSONL protocol defined in
``docs/whisperx-reliable-notes/03_DATA_CONTRACTS_AND_PROTOCOLS.md`` and mirrored
by the JavaScript side in ``src/helpers/whisperx/``. The two implementations
share the fixtures under ``tests/fixtures/whisperx-contracts/`` and must agree on
which fixtures are valid and which are rejected.
"""

__version__ = "0.1.0"

# Wire protocol version. Mirrors WHISPERX_PROTOCOL_VERSION in
# src/helpers/whisperx/constants.js. Bumping this is a breaking change.
PROTOCOL_VERSION = 1

# Schema versions for the durable artifacts (spec 03 §1).
TRANSCRIPT_SCHEMA_VERSION = 1
NOTE_EXTRACTION_SCHEMA_VERSION = 1

__all__ = [
    "__version__",
    "PROTOCOL_VERSION",
    "TRANSCRIPT_SCHEMA_VERSION",
    "NOTE_EXTRACTION_SCHEMA_VERSION",
]
