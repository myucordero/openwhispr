"""Pipeline orchestration.

``run_pipeline`` drives one job to completion, emitting protocol events at every
stage. Backends are injected (``load_asr``/``transcribe``/``unload_asr``/
``load_align``/``align``/``unload_align``/``load_diarize``/``diarize``/
``unload_diarize``/``gc_cuda``) so tests supply fakes and the real
implementation (``real_backends``) imports whisperx lazily. This worker makes a
single attempt at the requested config; the OOM fallback ladder lives in the
Electron main process, so a genuine CUDA OOM here raises
``WorkerError(CUDA_OUT_OF_MEMORY)`` and the worker exits 3 for the orchestrator
to retry.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

from pydantic import ValidationError

from . import audio as audio_module
from . import TRANSCRIPT_SCHEMA_VERSION
from .errors import JobCancelled, WorkerError, classify_oom
from .protocol import now_iso
from .schemas import CanonicalTranscript, WhisperXJobRequest
from .transcript import build_canonical_transcript
from .artifacts import FORMAT_TO_ARTIFACT, render_format, write_artifact


def _guard_oom(fn: Callable[[], Any]) -> Any:
    """Run ``fn``; convert a genuine CUDA OOM to WorkerError, re-raise the rest."""
    try:
        return fn()
    except (JobCancelled, WorkerError):
        raise
    except BaseException as exc:  # noqa: BLE001 - reclassified below
        if classify_oom(exc):
            raise WorkerError("CUDA_OUT_OF_MEMORY", "CUDA out of memory") from exc
        raise


def run_pipeline(
    request: WhisperXJobRequest,
    backends: Any,
    emit: Any,
    *,
    should_cancel: Optional[Callable[[], bool]] = None,
    audio_ops: Any = None,
    ffmpeg_path: Optional[str] = None,
) -> dict[str, Any]:
    """Execute the full transcription pipeline and return the completion dict.

    ``emit`` must expose ``emit_stage/emit_progress/emit_warning/emit_artifact/
    emit_complete``. ``audio_ops`` defaults to the real :mod:`audio` module;
    tests inject a fake to stay offline. ``should_cancel`` is polled at stage
    boundaries and during transcription progress.
    """
    audio_ops = audio_ops or audio_module
    should_cancel = should_cancel or (lambda: False)
    timings: dict[str, float] = {}
    warnings: list[dict[str, Any]] = []

    def _cancel_point() -> None:
        if should_cancel():
            raise JobCancelled("cancellation requested")

    def _warn(code: str, message: str, details: Optional[dict[str, Any]] = None) -> None:
        entry: dict[str, Any] = {"code": code, "message": message}
        if details is not None:
            entry["details"] = details
        warnings.append(entry)
        emit.emit_warning(code, message, details)

    def _stage(name: str) -> float:
        _cancel_point()
        emit.emit_stage(name)
        return time.monotonic()

    asr = request.asr
    source = request.source
    runtime = request.runtime

    # --- probing-audio ---
    t = _stage("probing-audio")
    probe = audio_ops.probe_audio(source.path, ffmpeg_path)
    source_sha256 = audio_ops.sha256_file(source.path)
    if source.expected_sha256 and source.expected_sha256 != source_sha256:
        raise WorkerError(
            "SOURCE_HASH_MISMATCH", "Source audio hash did not match expected value"
        )
    timings["probingAudio"] = _ms(t)

    audio_path = source.path
    if audio_ops.needs_normalization(probe):
        t = _stage("normalizing-audio")
        audio_path = audio_ops.normalize_audio(
            source.path, runtime.temporary_directory, ffmpeg_path
        )
        timings["normalizingAudio"] = _ms(t)

    # --- ASR ---
    t = _stage("loading-asr")
    _guard_oom(lambda: backends.load_asr())
    timings["loadingAsr"] = _ms(t)

    t = _stage("transcribing")

    def _progress(completed: float, total: Optional[float] = None) -> None:
        _cancel_point()
        emit.emit_progress("transcribing", completed, total, "segments")

    asr_result = _guard_oom(lambda: backends.transcribe(audio_path, _progress))
    segments: list[dict[str, Any]] = list(asr_result.get("segments", []))
    detected_language = asr_result.get("language")
    timings["transcribing"] = _ms(t)

    t = _stage("unloading-asr")
    backends.unload_asr()
    backends.gc_cuda()
    timings["unloadingAsr"] = _ms(t)

    # --- alignment ---
    alignment_used = False
    if request.alignment.enabled:
        t = _stage("loading-alignment")
        align_model = _guard_oom(lambda: backends.load_align(detected_language))
        timings["loadingAlignment"] = _ms(t)
        if align_model is None:
            _warn(
                "ALIGNMENT_UNAVAILABLE",
                "No alignment model for the detected language; keeping ASR segments",
                {"language": detected_language},
            )
        else:
            t = _stage("aligning")
            try:
                aligned = _guard_oom(lambda: backends.align(segments, audio_path))
                segments = list(aligned.get("segments", segments))
                alignment_used = True
            except (JobCancelled, WorkerError):
                raise
            except Exception:  # noqa: BLE001 - non-fatal, degrade gracefully
                _warn(
                    "ALIGNMENT_UNAVAILABLE",
                    "Alignment failed; keeping ASR segments",
                )
            timings["aligning"] = _ms(t)
            t = _stage("unloading-alignment")
            backends.unload_align()
            backends.gc_cuda()
            timings["unloadingAlignment"] = _ms(t)

    # --- diarization ---
    diarization_used = False
    if request.diarization.enabled:
        try:
            t = _stage("loading-diarization")
            _guard_oom(lambda: backends.load_diarize())
            timings["loadingDiarization"] = _ms(t)
            t = _stage("diarizing")
            diar = _guard_oom(
                lambda: backends.diarize(audio_path, {"segments": segments})
            )
            segments = list(diar.get("segments", segments))
            timings["diarizing"] = _ms(t)
            t = _stage("unloading-diarization")
            backends.unload_diarize()
            backends.gc_cuda()
            timings["unloadingDiarization"] = _ms(t)
            diarization_used = True
        except JobCancelled:
            raise
        except WorkerError as exc:
            if exc.code == "CUDA_OUT_OF_MEMORY":
                raise
            # Spec 00 §9: transcription proceeds without pyannote.
            _warn(
                "DIARIZATION_UNAVAILABLE",
                "Diarization unavailable; continuing without speaker labels",
                {"reason": exc.code},
            )
            _safe(lambda: backends.gc_cuda())
        except Exception:  # noqa: BLE001 - degrade gracefully, no speakers
            _warn(
                "DIARIZATION_UNAVAILABLE",
                "Diarization failed; continuing without speaker labels",
            )
            _safe(lambda: backends.gc_cuda())

    # --- canonicalizing ---
    t = _stage("canonicalizing")
    provenance = _build_provenance(request, backends, detected_language)
    transcript = build_canonical_transcript(
        job_id=request.job_id,
        source={
            "displayName": source.display_name,
            "sha256": source_sha256,
            "durationSeconds": probe.duration_seconds,
        },
        provenance=provenance,
        raw_segments=segments,
        alignment_used=alignment_used,
        diarization_used=diarization_used,
    )
    try:
        CanonicalTranscript.model_validate(transcript)
    except ValidationError as exc:
        raise WorkerError(
            "TRANSCRIPT_SCHEMA_INVALID",
            "Built transcript failed schema validation",
            {"errors": exc.error_count()},
        ) from exc

    if alignment_used and any(
        "partial-alignment" in seg.get("flags", []) for seg in transcript["segments"]
    ):
        _warn("ALIGNMENT_PARTIAL", "Some words could not be aligned")
    timings["canonicalizing"] = _ms(t)

    # --- writing-artifacts ---
    t = _stage("writing-artifacts")
    job_dir = request.output.job_directory
    artifacts: list[dict[str, Any]] = []
    transcript_descriptor: Optional[dict[str, Any]] = None
    for fmt in request.output.formats:
        content = render_format(fmt, transcript)
        if content is None:
            continue  # speaker-markdown without diarization
        relative_path, kind = FORMAT_TO_ARTIFACT[fmt]
        rel, sha256, num_bytes = write_artifact(job_dir, relative_path, content)
        schema_version = (
            TRANSCRIPT_SCHEMA_VERSION if fmt == "canonical-json" else None
        )
        emit.emit_artifact(kind, rel, sha256, num_bytes, schema_version)
        descriptor = {
            "kind": kind,
            "relativePath": rel,
            "sha256": sha256,
            "bytes": num_bytes,
            "createdAt": now_iso(),
        }
        if schema_version is not None:
            descriptor["schemaVersion"] = schema_version
        artifacts.append(descriptor)
        if fmt == "canonical-json":
            transcript_descriptor = {
                "relativePath": rel,
                "sha256": sha256,
                "bytes": num_bytes,
            }
    timings["writingArtifacts"] = _ms(t)

    word_count = sum(len(seg.get("words", [])) for seg in transcript["segments"])
    result: dict[str, Any] = {
        "jobId": request.job_id,
        "sourceSha256": source_sha256,
        "durationSeconds": probe.duration_seconds,
        "actualConfiguration": {
            "model": asr.model,
            "computeType": asr.compute_type,
            "batchSize": asr.batch_size,
            "device": asr.device,
            "alignmentUsed": alignment_used,
            "diarizationUsed": diarization_used,
            "fallbackAttempts": [],
        },
        "transcript": {
            "schemaVersion": TRANSCRIPT_SCHEMA_VERSION,
            "relativePath": (transcript_descriptor or {}).get(
                "relativePath", "transcript.raw.json"
            ),
            "sha256": (transcript_descriptor or {}).get("sha256", ""),
            "segmentCount": len(transcript["segments"]),
            "wordCount": word_count,
        },
        "artifacts": artifacts,
        "warnings": warnings,
        "timingsMs": {k: round(v) for k, v in timings.items()},
    }
    if detected_language is not None:
        result["detectedLanguage"] = detected_language
    if diarization_used:
        result["actualConfiguration"]["diarizationProvider"] = (
            request.diarization.provider
        )

    emit.emit_complete(result)
    return result


def _ms(start: float) -> float:
    return (time.monotonic() - start) * 1000.0


def _safe(fn: Callable[[], Any]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001 - best-effort cleanup
        pass


def _build_provenance(
    request: WhisperXJobRequest, backends: Any, detected_language: Optional[str]
) -> dict[str, Any]:
    provenance: dict[str, Any] = {
        "engine": "whisperx",
        "whisperxVersion": getattr(backends, "whisperx_version", None) or "unknown",
        "model": request.asr.model,
        "device": request.asr.device,
        "computeType": request.asr.compute_type,
        "batchSize": request.asr.batch_size,
        "languageRequested": request.language,
        "createdAt": now_iso(),
    }
    if detected_language:
        provenance["languageDetected"] = detected_language
    for attr, key in (
        ("faster_whisper_version", "fasterWhisperVersion"),
        ("torch_version", "torchVersion"),
        ("pyannote_version", "pyannoteVersion"),
    ):
        value = getattr(backends, attr, None)
        if value:
            provenance[key] = value
    return provenance
