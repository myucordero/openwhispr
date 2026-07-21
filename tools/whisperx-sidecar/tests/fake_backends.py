"""Deterministic fake backends + fake audio ops for offline pipeline tests.

Imports NO torch/whisperx. Usable two ways:
  - imported directly by ``test_pipeline`` (``FakeBackends(...)`` with kwargs);
  - loaded by file path by the worker subprocess via
    ``OPENWHISPR_WORKER_BACKENDS_MODULE`` (``make_backends`` + ``make_audio_ops``).

Behaviour is configured with constructor kwargs or, for the subprocess path,
environment variables (``OPENWHISPR_FAKE_*``).
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any, Callable, Optional


# Named exactly "OutOfMemoryError" so errors.classify_oom treats it as CUDA OOM
# (mirrors torch.cuda.OutOfMemoryError by class name, no torch needed).
class OutOfMemoryError(Exception):
    pass


_RAW_SEGMENTS: list[dict[str, Any]] = [
    {
        "start": 0.0,
        "end": 3.2,
        "text": "Buenos dias a todos, empecemos la reunion.",
        "avg_logprob": -0.2,
        "compression_ratio": 1.1,
        "no_speech_prob": 0.01,
        "words": [{"word": w} for w in "Buenos dias a todos, empecemos la reunion.".split()],
    },
    {
        "start": 3.4,
        "end": 6.8,
        "text": "Good morning, I have the numbers ready.",
        "avg_logprob": -1.5,  # < -1.0 -> low-confidence flag
        "compression_ratio": 1.2,
        "no_speech_prob": 0.02,
        "words": [{"word": w} for w in "Good morning, I have the numbers ready.".split()],
    },
]

_SPEAKER_BY_SEGMENT = ["SPEAKER_00", "SPEAKER_01"]


def _fresh_segments() -> list[dict[str, Any]]:
    out = []
    for seg in _RAW_SEGMENTS:
        clone = dict(seg)
        clone["words"] = [dict(w) for w in seg["words"]]
        out.append(clone)
    return out


class FakeProbe:
    def __init__(self) -> None:
        self.duration_seconds = 12.5
        self.codec = "pcm_s16le"
        self.sample_rate = 16000
        self.channels = 1


class FakeAudio:
    """Audio ops that never touch ffmpeg; input is treated as already-normalized."""

    def probe_audio(self, path: str, ffmpeg_path: Optional[str] = None) -> FakeProbe:
        return FakeProbe()

    def needs_normalization(self, probe: FakeProbe) -> bool:
        return False

    def normalize_audio(self, path, temp_dir, ffmpeg_path=None) -> str:  # pragma: no cover
        return path

    def sha256_file(self, path: str) -> str:
        try:
            with open(path, "rb") as handle:
                return hashlib.sha256(handle.read()).hexdigest()
        except OSError:
            return "ab" * 32


class FakeBackends:
    whisperx_version = "0.0.0-fake"
    torch_version = "0.0.0-fake"

    def __init__(
        self,
        *,
        align_available: bool = True,
        partial_alignment: bool = False,
        asr_oom: bool = False,
        asr_valueerror: bool = False,
        diarize_oom: bool = False,
        diarize_fail: bool = False,
        transcribe_sleep: bool = False,
    ) -> None:
        self.align_available = align_available
        self.partial_alignment = partial_alignment
        self.asr_oom = asr_oom
        self.asr_valueerror = asr_valueerror
        self.diarize_oom = diarize_oom
        self.diarize_fail = diarize_fail
        self.transcribe_sleep = transcribe_sleep
        self.calls: list[str] = []

    def load_asr(self) -> Any:
        self.calls.append("load_asr")
        return object()

    def transcribe(
        self, audio_path: str, progress: Callable[[float, Optional[float]], None]
    ) -> dict[str, Any]:
        self.calls.append("transcribe")
        if self.asr_oom:
            raise OutOfMemoryError("CUDA out of memory (fake)")
        if self.asr_valueerror:
            raise ValueError("some arbitrary failure, not OOM")
        if self.transcribe_sleep:
            # Long, cancellable window: progress() raises when cancel is set.
            for i in range(1, 101):
                progress(i, 100)
                time.sleep(0.1)
        else:
            progress(len(_RAW_SEGMENTS), len(_RAW_SEGMENTS))
        return {"segments": _fresh_segments(), "language": "es"}

    def unload_asr(self) -> None:
        self.calls.append("unload_asr")

    def load_align(self, language: Optional[str]) -> Any:
        self.calls.append("load_align")
        return object() if self.align_available else None

    def align(self, segments: list[dict[str, Any]], audio_path: str) -> dict[str, Any]:
        self.calls.append("align")
        for si, seg in enumerate(segments):
            span = (seg["end"] - seg["start"]) or 1.0
            words = seg.get("words") or []
            step = span / max(1, len(words))
            for wi, word in enumerate(words):
                # Partial: drop timestamps on the final segment's words.
                if self.partial_alignment and si == len(segments) - 1:
                    continue
                word["start"] = round(seg["start"] + wi * step, 3)
                word["end"] = round(seg["start"] + (wi + 1) * step, 3)
                word["score"] = 0.9
        return {"segments": segments}

    def unload_align(self) -> None:
        self.calls.append("unload_align")

    def load_diarize(self) -> Any:
        self.calls.append("load_diarize")
        if self.diarize_oom:
            raise OutOfMemoryError("CUDA out of memory during diarization (fake)")
        if self.diarize_fail:
            raise RuntimeError("simulated diarization failure")
        return object()

    def diarize(self, audio_path: str, result: dict[str, Any]) -> dict[str, Any]:
        self.calls.append("diarize")
        segments = result.get("segments", [])
        for si, seg in enumerate(segments):
            speaker = _SPEAKER_BY_SEGMENT[si % len(_SPEAKER_BY_SEGMENT)]
            seg["speaker"] = speaker
            for word in seg.get("words") or []:
                word["speaker"] = speaker
        return {"segments": segments}

    def unload_diarize(self) -> None:
        self.calls.append("unload_diarize")

    def gc_cuda(self) -> None:
        self.calls.append("gc_cuda")


def make_backends(request: Any, hf_token: Optional[str] = None) -> FakeBackends:
    return FakeBackends(
        align_available=os.environ.get("OPENWHISPR_FAKE_NO_ALIGN") != "1",
        partial_alignment=os.environ.get("OPENWHISPR_FAKE_PARTIAL_ALIGN") == "1",
        diarize_fail=os.environ.get("OPENWHISPR_FAKE_DIARIZE_FAIL") == "1",
        transcribe_sleep=os.environ.get("OPENWHISPR_FAKE_SLEEP") == "1",
    )


def make_audio_ops(request: Any) -> FakeAudio:
    return FakeAudio()
