"""Audio probing and normalization via ffprobe/ffmpeg.

All subprocess calls use list arguments with ``shell=False`` and a timeout
(spec 07 §5). No value from the job request is ever concatenated into a shell
string. ffprobe/ffmpeg paths come from the trusted runtime; the request only
supplies the source file path, which is passed as a single argv element.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from typing import Optional

from .errors import WorkerError

_PROBE_TIMEOUT_SECONDS = 60
_NORMALIZE_TIMEOUT_SECONDS = 60 * 30
_TARGET_SAMPLE_RATE = 16000
_TARGET_CHANNELS = 1


@dataclass
class AudioProbe:
    duration_seconds: float
    codec: Optional[str]
    sample_rate: Optional[int]
    channels: Optional[int]


def _ffprobe_path(ffmpeg_path: Optional[str]) -> str:
    """Derive an ffprobe path from an ffmpeg path, else fall back to PATH."""
    if not ffmpeg_path:
        return "ffprobe"
    directory, name = os.path.split(ffmpeg_path)
    probe_name = name.replace("ffmpeg", "ffprobe") if "ffmpeg" in name else "ffprobe"
    return os.path.join(directory, probe_name) if directory else probe_name


def sha256_file(path: str, chunk_size: int = 1024 * 1024) -> str:
    """Stream-hash a file to a lowercase hex SHA-256 digest."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_audio(path: str, ffmpeg_path: Optional[str] = None) -> AudioProbe:
    """Probe ``path`` with ffprobe. Raises WorkerError on missing file / failure."""
    if not os.path.isfile(path):
        raise WorkerError("AUDIO_FILE_NOT_FOUND", "Source audio file does not exist")

    argv = [
        _ffprobe_path(ffmpeg_path),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-select_streams",
        "a:0",
        path,
    ]
    try:
        proc = subprocess.run(
            argv,
            shell=False,
            capture_output=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise WorkerError("AUDIO_PROBE_FAILED", "ffprobe executable not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise WorkerError("AUDIO_PROBE_FAILED", "ffprobe timed out") from exc

    if proc.returncode != 0:
        raise WorkerError("AUDIO_PROBE_FAILED", "ffprobe failed to read the file")

    try:
        data = json.loads(proc.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        raise WorkerError("AUDIO_PROBE_FAILED", "ffprobe output was not valid JSON") from exc

    streams = data.get("streams") or []
    if not streams:
        raise WorkerError("AUDIO_UNSUPPORTED", "No audio stream found in file")
    stream = streams[0]
    fmt = data.get("format") or {}

    duration_raw = stream.get("duration") or fmt.get("duration")
    try:
        duration = float(duration_raw) if duration_raw is not None else 0.0
    except (TypeError, ValueError):
        duration = 0.0

    sample_rate = stream.get("sample_rate")
    try:
        sample_rate_int = int(sample_rate) if sample_rate is not None else None
    except (TypeError, ValueError):
        sample_rate_int = None

    channels = stream.get("channels")
    channels_int = channels if isinstance(channels, int) else None

    return AudioProbe(
        duration_seconds=duration,
        codec=stream.get("codec_name"),
        sample_rate=sample_rate_int,
        channels=channels_int,
    )


def needs_normalization(probe: AudioProbe) -> bool:
    """True unless the input is already mono 16 kHz PCM-s16 WAV."""
    return not (
        probe.codec == "pcm_s16le"
        and probe.sample_rate == _TARGET_SAMPLE_RATE
        and probe.channels == _TARGET_CHANNELS
    )


def normalize_audio(
    path: str, temp_dir: str, ffmpeg_path: Optional[str] = None
) -> str:
    """Decode ``path`` to 16 kHz mono PCM-s16 WAV inside ``temp_dir``.

    Returns the output path. Raises WorkerError on decode failure.
    """
    os.makedirs(temp_dir, exist_ok=True)
    out_path = os.path.join(temp_dir, "normalized-16k-mono.wav")
    argv = [
        ffmpeg_path or "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        "-ac",
        str(_TARGET_CHANNELS),
        "-ar",
        str(_TARGET_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        out_path,
    ]
    try:
        proc = subprocess.run(
            argv,
            shell=False,
            capture_output=True,
            timeout=_NORMALIZE_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise WorkerError("AUDIO_DECODE_FAILED", "ffmpeg executable not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise WorkerError("AUDIO_DECODE_FAILED", "ffmpeg timed out") from exc

    if proc.returncode != 0 or not os.path.isfile(out_path):
        raise WorkerError("AUDIO_DECODE_FAILED", "ffmpeg failed to normalize audio")
    return out_path
