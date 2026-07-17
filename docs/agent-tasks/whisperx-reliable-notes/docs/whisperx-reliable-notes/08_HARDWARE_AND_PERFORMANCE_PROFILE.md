# 08 — Hardware and Performance Profile

## 1. Target Machine

The supplied work-PC inventory reports:

```text
MSI Raider GE68HX 13VF
Windows 11 Home x64
Intel Core i9-13950HX
24 physical cores / 32 logical processors
31.71 GB usable RAM
NVIDIA GeForce RTX 4060 Laptop GPU
953.86 GB NVMe; approximately 356.15 GB free at capture time
```

WMI reports 4 GB adapter RAM for the NVIDIA GPU, which can be inaccurate. Runtime detection is authoritative.

## 2. Required Preflight

Run:

```powershell
nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv
```

And from the managed Python environment:

```powershell
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO CUDA'); print(round(torch.cuda.get_device_properties(0).total_memory/1024**3, 2) if torch.cuda.is_available() else 0)"
```

Persist only non-sensitive numeric/device diagnostics.

Do not assume CUDA is usable solely because the display driver exists.

## 3. Default Profiles

### Memo

```text
large-v3-turbo
CUDA float16
batch 4
alignment on
diarization off
```

### Meeting

```text
large-v3-turbo
CUDA float16
batch 4
alignment on
diarization on
```

### Critical/interview

```text
large-v3
CUDA float16
batch 2
alignment on
diarization on
```

## 4. GPU Scheduling

Expected stage order:

```text
stop/unload local llama.cpp if occupying GPU
→ ASR
→ unload ASR
→ alignment
→ unload alignment
→ diarization
→ unload diarization
→ worker exits
→ start/resume local llama.cpp
→ note extraction and verification
```

Do not load the local Qwen model while WhisperX/pyannote holds substantial VRAM.

## 5. Local Note Model

Preferred:

```text
Qwen3.5 9B Q4_K_M
16K runtime context initially
thinking disabled
temperature 0.0–0.1
sequential execution
```

Fallback:

```text
Qwen3.5 4B Q4_K_M
```

Do not use the model registry's theoretical 131K/262K context as the runtime default on an 8 GB-class GPU. Chunk the transcript.

## 6. OOM Strategy

Recognize CUDA OOM by explicit exception/category, not message substring alone where avoidable.

### Default profile

```text
float16 batch 4
float16 batch 2
int8 batch 4
int8 batch 2
```

### Critical profile

```text
large-v3 float16 batch 2
large-v3 float16 batch 1
large-v3 int8 batch 2
large-v3-turbo float16 batch 2, only as a disclosed profile fallback
```

After each attempt:

- release model references;
- run garbage collection;
- clear CUDA cache;
- allow a short cooldown;
- record attempt and peak memory if available.

No infinite retry.

## 7. CPU and RAM

The CPU/RAM are sufficient for:

- FFmpeg conversion;
- hashing;
- alignment fallback;
- CPU diarization fallback;
- partial local LLM offload;
- benchmark calculations.

Still:

- keep batch processing sequential;
- avoid holding multiple decoded WAVs in RAM;
- stream hashes/copies;
- use file-backed artifacts;
- page/virtualize long transcript UI;
- enforce bounded logs and IPC messages.

## 8. Disk Policy

Model/runtime caches and artifacts can grow.

Implement:

- preflight free-space check;
- estimated temporary requirement based on source duration/size;
- total managed-storage display;
- retention cleanup;
- separate runtime/model cache from recording artifacts;
- no model files in Git;
- no duplicate source copy for external files by default.

Suggested soft thresholds:

```text
warn when free disk < 20 GB
block a job when conservative estimated temp/output exceeds available space minus safety margin
```

Make thresholds configurable in code, not a magic UI string.

## 9. Power and Thermals

This is a laptop-class GPU.

- Prefer AC power for long jobs.
- Do not fail solely because the device is on battery.
- Surface a non-blocking warning for long/critical jobs on battery if battery APIs are already available.
- Record throttling only when measurable; do not guess.
- Avoid concurrent CPU/GPU stress from unrelated benchmark jobs.

## 10. Performance Metrics

Record per job:

```text
audio duration
total elapsed
ASR elapsed
alignment elapsed
diarization elapsed
artifact elapsed
note extraction elapsed
verification elapsed
real-time factor
peak VRAM when available
peak process RAM when available
fallback attempts
```

A lower real-time factor is faster:

```text
RTF = processing seconds / audio seconds
```

Do not impose a hard unbenchmarked SLA. Use the benchmark to establish expected performance on this exact MSI.

Soft target for the default profile on AC/CUDA:

```text
complete substantially faster than CPU-only processing
avoid OOM
avoid app unresponsiveness
```

Accuracy and evidence integrity take priority over marginal latency.

## 11. Dynamic Readiness

The UI should distinguish:

```text
GPU ready
GPU present but Torch CUDA unavailable
insufficient free VRAM for selected profile
CPU fallback available
runtime missing
model missing
diarization token/model missing
offline ready
network required for provisioning
```

Do not label the WMI-reported 4 GB value as definitive VRAM.
