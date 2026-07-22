"""Direct unit tests for the lazy-loaded real backend adapters."""

from __future__ import annotations

import sys
from types import ModuleType

import pytest

from openwhispr_whisperx.errors import WorkerError
from openwhispr_whisperx.real_backends import RealBackends
from openwhispr_whisperx.schemas import WhisperXJobRequest


def _stub_ml_modules(monkeypatch, **whisperx_members):
    """Install import-compatible stubs without loading any ML package."""
    whisperx = ModuleType("whisperx")
    whisperx.__path__ = []
    for name, member in whisperx_members.items():
        setattr(whisperx, name, member)

    diarize = ModuleType("whisperx.diarize")
    pyannote = ModuleType("pyannote")
    pyannote.__path__ = []
    pyannote_audio = ModuleType("pyannote.audio")
    torch = ModuleType("torch")

    monkeypatch.setitem(sys.modules, "whisperx", whisperx)
    monkeypatch.setitem(sys.modules, "whisperx.diarize", diarize)
    monkeypatch.setitem(sys.modules, "pyannote", pyannote)
    monkeypatch.setitem(sys.modules, "pyannote.audio", pyannote_audio)
    monkeypatch.setitem(sys.modules, "torch", torch)
    return diarize


def test_load_asr_passes_prompt_and_joined_hotwords(monkeypatch, make_request_dict):
    calls = []
    model = object()

    def load_model(*args, **kwargs):
        calls.append((args, kwargs))
        return model

    _stub_ml_modules(monkeypatch, load_model=load_model)
    request_dict = make_request_dict()
    request_dict["asr"]["initialPrompt"] = "Prefer project terminology."
    request_dict["asr"]["hotwords"] = ["OpenWhispr", "WhisperX", "pyannote"]
    request = WhisperXJobRequest.model_validate(request_dict)

    loaded = RealBackends(request).load_asr()

    assert loaded is model
    assert calls == [
        (
            ("large-v3-turbo",),
            {
                "device": "cuda",
                "compute_type": "float16",
                "language": "es",
                "asr_options": {
                    "initial_prompt": "Prefer project terminology.",
                    "hotwords": "OpenWhispr WhisperX pyannote",
                },
            },
        )
    ]


@pytest.mark.parametrize(
    ("speaker_config", "expected_kwargs"),
    [
        ({"exactSpeakers": 3}, {"num_speakers": 3}),
        (
            {"minSpeakers": 2, "maxSpeakers": 5},
            {"min_speakers": 2, "max_speakers": 5},
        ),
    ],
)
def test_diarize_passes_configured_speaker_limits(
    monkeypatch, make_request_dict, speaker_config, expected_kwargs
):
    assigned_result = {"segments": [{"speaker": "SPEAKER_00"}]}
    assign_calls = []

    def assign_word_speakers(diarize_segments, result):
        assign_calls.append((diarize_segments, result))
        return assigned_result

    _stub_ml_modules(monkeypatch, assign_word_speakers=assign_word_speakers)
    request_dict = make_request_dict()
    request_dict["diarization"] = {
        "enabled": True,
        "provider": "pyannote-community-1",
        **speaker_config,
    }
    request = WhisperXJobRequest.model_validate(request_dict)
    pipeline_calls = []
    diarize_segments = object()

    def pipeline(audio_path, **kwargs):
        pipeline_calls.append((audio_path, kwargs))
        return diarize_segments

    backends = RealBackends(request)
    backends._diarize_pipeline = pipeline
    result = {"segments": [{"text": "hello"}]}

    output = backends.diarize("recording.wav", result)

    assert pipeline_calls == [("recording.wav", expected_kwargs)]
    assert assign_calls == [(diarize_segments, result)]
    assert output == assigned_result


def test_load_diarize_requires_hf_token(make_request_dict):
    request_dict = make_request_dict()
    request_dict["runtime"]["offline"] = False
    request = WhisperXJobRequest.model_validate(request_dict)

    with pytest.raises(WorkerError) as exc_info:
        RealBackends(request).load_diarize()

    assert exc_info.value.code == "HF_TOKEN_REQUIRED"
    assert exc_info.value.message == "Diarization requires a Hugging Face token"


def test_load_diarize_offline_without_hf_token_forwards_none(
    monkeypatch, make_request_dict
):
    calls = []
    pipeline = object()

    def diarization_pipeline(**kwargs):
        calls.append(kwargs)
        return pipeline

    diarize_module = _stub_ml_modules(monkeypatch)
    diarize_module.DiarizationPipeline = diarization_pipeline
    request = WhisperXJobRequest.model_validate(make_request_dict())

    loaded = RealBackends(request).load_diarize()

    assert loaded is pipeline
    assert calls == [
        {
            "model_name": "pyannote/speaker-diarization-community-1",
            "token": None,
            "device": "cuda",
            "cache_dir": request.runtime.model_cache_directory,
        }
    ]


def test_load_diarize_offline_cache_miss_is_model_not_ready(
    monkeypatch, make_request_dict
):
    def diarization_pipeline(**kwargs):
        raise RuntimeError("cache miss at /home/marco/.cache/huggingface/token")

    diarize_module = _stub_ml_modules(monkeypatch)
    diarize_module.DiarizationPipeline = diarization_pipeline
    request = WhisperXJobRequest.model_validate(make_request_dict())

    with pytest.raises(WorkerError) as exc_info:
        RealBackends(request).load_diarize()

    assert exc_info.value.code == "DIARIZATION_MODEL_NOT_READY"
    assert exc_info.value.message == (
        "Diarization model is not available in the offline cache"
    )


def test_load_diarize_rejects_openwhispr_local(make_request_dict):
    request_dict = make_request_dict()
    request_dict["diarization"]["provider"] = "openwhispr-local"
    request = WhisperXJobRequest.model_validate(request_dict)

    with pytest.raises(WorkerError) as exc_info:
        RealBackends(request).load_diarize()

    assert exc_info.value.code == "DIARIZATION_MODEL_NOT_READY"
    assert exc_info.value.message == (
        "Diarization provider 'openwhispr-local' is not handled by the WhisperX worker"
    )


def test_load_diarize_passes_runtime_model_cache_directory(
    monkeypatch, make_request_dict
):
    """Diarization forwards the cache dir; load_asr/load_align currently do not."""
    calls = []
    pipeline = object()

    def diarization_pipeline(**kwargs):
        calls.append(kwargs)
        return pipeline

    diarize_module = _stub_ml_modules(monkeypatch)
    diarize_module.DiarizationPipeline = diarization_pipeline
    request = WhisperXJobRequest.model_validate(make_request_dict())

    loaded = RealBackends(request, hf_token="test-token").load_diarize()

    assert loaded is pipeline
    assert calls == [
        {
            "model_name": "pyannote/speaker-diarization-community-1",
            "token": "test-token",
            "device": "cuda",
            "cache_dir": request.runtime.model_cache_directory,
        }
    ]
