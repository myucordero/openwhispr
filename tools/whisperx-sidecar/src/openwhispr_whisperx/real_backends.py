"""Real WhisperX / pyannote backends.

All heavy imports (torch, whisperx, faster-whisper, pyannote) happen lazily
inside methods so the test suite — and ``ready`` emission — never import them.
The pipeline talks to this object through the duck-typed backends interface.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from .errors import WorkerError
from .schemas import WhisperXJobRequest


def make_backends(
    request: WhisperXJobRequest, hf_token: Optional[str] = None
) -> "RealBackends":
    return RealBackends(request, hf_token)


class RealBackends:
    def __init__(
        self, request: WhisperXJobRequest, hf_token: Optional[str] = None
    ) -> None:
        self.request = request
        self.hf_token = hf_token
        self.device = request.asr.device
        self._asr_model: Any = None
        self._align_model: Any = None
        self._align_metadata: Any = None
        self._diarize_pipeline: Any = None
        # Version strings populated lazily for provenance.
        self.whisperx_version: Optional[str] = None
        self.torch_version: Optional[str] = None
        self.faster_whisper_version: Optional[str] = None
        self.pyannote_version: Optional[str] = None
        self._populate_versions()

    def _populate_versions(self) -> None:
        from importlib import metadata

        for dist, attr in (
            ("whisperx", "whisperx_version"),
            ("torch", "torch_version"),
            ("faster-whisper", "faster_whisper_version"),
            ("pyannote.audio", "pyannote_version"),
        ):
            try:
                setattr(self, attr, metadata.version(dist))
            except Exception:
                pass

    # --- ASR ---
    def load_asr(self) -> Any:
        import whisperx  # lazy

        language = self.request.language
        asr_options: dict[str, Any] = {}
        if self.request.asr.initial_prompt:
            asr_options["initial_prompt"] = self.request.asr.initial_prompt
        if self.request.asr.hotwords:
            asr_options["hotwords"] = " ".join(self.request.asr.hotwords)
        self._asr_model = whisperx.load_model(
            self.request.asr.model,
            device=self.device,
            compute_type=self.request.asr.compute_type,
            language=None if language == "auto" else language,
            asr_options=asr_options or None,
        )
        return self._asr_model

    def transcribe(
        self, audio_path: str, progress: Callable[[float, Optional[float]], None]
    ) -> dict[str, Any]:
        import whisperx  # lazy

        audio = whisperx.load_audio(audio_path)
        result = self._asr_model.transcribe(
            audio, batch_size=self.request.asr.batch_size
        )
        segments = result.get("segments", [])
        total = len(segments)
        if total:
            progress(total, total)
        return {"segments": segments, "language": result.get("language")}

    def unload_asr(self) -> None:
        self._asr_model = None

    # --- alignment ---
    def load_align(self, language: Optional[str]) -> Any:
        import whisperx  # lazy

        if not language:
            return None
        try:
            self._align_model, self._align_metadata = whisperx.load_align_model(
                language_code=language, device=self.device
            )
        except Exception:
            # No alignment model for this language (spec 00 §9).
            self._align_model = None
            self._align_metadata = None
            return None
        return self._align_model

    def align(
        self, segments: list[dict[str, Any]], audio_path: str
    ) -> dict[str, Any]:
        import whisperx  # lazy

        audio = whisperx.load_audio(audio_path)
        result = whisperx.align(
            segments,
            self._align_model,
            self._align_metadata,
            audio,
            self.device,
            return_char_alignments=False,
        )
        return {"segments": result.get("segments", segments)}

    def unload_align(self) -> None:
        self._align_model = None
        self._align_metadata = None

    # --- diarization ---
    _DIARIZATION_MODELS = {
        "pyannote-community-1": "pyannote/speaker-diarization-community-1",
    }

    def load_diarize(self) -> Any:
        provider = self.request.diarization.provider
        model_name = self._DIARIZATION_MODELS.get(provider)
        if model_name is None:
            # openwhispr-local is the JS-side sherpa-onnx fallback; the Python
            # worker only implements pyannote. Degrade with a precise reason.
            raise WorkerError(
                "DIARIZATION_MODEL_NOT_READY",
                f"Diarization provider '{provider}' is not handled by the WhisperX worker",
            )
        if not self.hf_token:
            raise WorkerError(
                "HF_TOKEN_REQUIRED", "Diarization requires a Hugging Face token"
            )
        try:
            from whisperx.diarize import DiarizationPipeline  # lazy
        except Exception as exc:  # pragma: no cover - import path varies by version
            raise WorkerError(
                "DIARIZATION_MODEL_NOT_READY", "Diarization backend unavailable"
            ) from exc
        # whisperx 3.8.x signature: (model_name=None, token=None, device=..., cache_dir=None)
        self._diarize_pipeline = DiarizationPipeline(
            model_name=model_name,
            token=self.hf_token,
            device=self.device,
            cache_dir=self.request.runtime.model_cache_directory,
        )
        return self._diarize_pipeline

    def diarize(
        self, audio_path: str, result: dict[str, Any]
    ) -> dict[str, Any]:
        import whisperx  # lazy

        diar = self.request.diarization
        kwargs: dict[str, Any] = {}
        if diar.exact_speakers is not None:
            kwargs["num_speakers"] = diar.exact_speakers
        if diar.min_speakers is not None:
            kwargs["min_speakers"] = diar.min_speakers
        if diar.max_speakers is not None:
            kwargs["max_speakers"] = diar.max_speakers
        diarize_segments = self._diarize_pipeline(audio_path, **kwargs)
        assigned = whisperx.assign_word_speakers(diarize_segments, result)
        return {"segments": assigned.get("segments", result.get("segments", []))}

    def unload_diarize(self) -> None:
        self._diarize_pipeline = None

    # --- resource management ---
    def gc_cuda(self) -> None:
        import gc

        gc.collect()
        if self.device == "cuda":
            try:
                import torch  # lazy

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
