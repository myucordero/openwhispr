# OpenWhispr WhisperX Reliable-Notes — Codex Agent Package

**Package version:** 1.0  
**Prepared:** 2026-07-16  
**Target:** the user's local OpenWhispr fork on a Windows 11 MSI Raider GE68HX 13VF  
**Primary outcome:** implement a fully local, reproducible pipeline that turns recorded audio into a structured, timestamped transcript and evidence-grounded Markdown notes.

## Start Here

Place this package inside the OpenWhispr repository without replacing any existing repository instructions. A suitable location is:

```text
docs/agent-tasks/whisperx-reliable-notes/
```

Then give Codex this instruction:

```text
Read the repository's existing AGENTS.md/CLAUDE.md instructions first. Then read
this package's CODEX_START_HERE.md and every referenced specification. Fully
implement the task in the current repository, following the TDD, security,
validation, and reporting requirements. Do not overwrite unrelated work.
```

`CODEX_START_HERE.md` is the executable task contract. The remaining files are normative specifications.

## Package Contents

| File | Purpose |
|---|---|
| `CODEX_START_HERE.md` | Master Codex execution prompt and completion contract |
| `COPY_PASTE_LAUNCH_PROMPT.md` | Minimal launch instruction to paste into Codex |
| `AGENTS.md` | Task-specific agent rules to merge with, not blindly replace, existing repo instructions |
| `TASK_TRACKER.md` | Living checklist Codex must update during implementation |
| `docs/whisperx-reliable-notes/00_MASTER_IMPLEMENTATION_SPEC.md` | Authoritative scope and target behavior |
| `docs/whisperx-reliable-notes/01_PRODUCT_REQUIREMENTS.md` | Functional and non-functional requirements |
| `docs/whisperx-reliable-notes/02_ARCHITECTURE_AND_DATA_FLOW.md` | Target architecture and module boundaries |
| `docs/whisperx-reliable-notes/03_DATA_CONTRACTS_AND_PROTOCOLS.md` | TypeScript/Python/JSONL contracts and error model |
| `docs/whisperx-reliable-notes/04_RELIABLE_NOTES_COMPILER.md` | Evidence-bound note extraction, validation, and rendering |
| `docs/whisperx-reliable-notes/05_IMPLEMENTATION_PHASES.md` | Ordered implementation plan with phase exit criteria |
| `docs/whisperx-reliable-notes/06_TDD_AND_VALIDATION_PLAN.md` | Required unit, contract, integration, hardware, and packaging tests |
| `docs/whisperx-reliable-notes/07_SECURITY_PRIVACY_THREAT_MODEL.md` | Trust boundaries, threats, mitigations, and security tests |
| `docs/whisperx-reliable-notes/08_HARDWARE_AND_PERFORMANCE_PROFILE.md` | MSI-specific model/runtime defaults and OOM strategy |
| `docs/whisperx-reliable-notes/09_BENCHMARK_AND_QUALITY_EVALUATION.md` | Reproducible accuracy and note-quality benchmark |
| `docs/whisperx-reliable-notes/10_OPERATIONS_AND_TROUBLESHOOTING.md` | Setup, model provisioning, diagnostics, recovery, and maintenance |
| `docs/whisperx-reliable-notes/11_ACCEPTANCE_CRITERIA.md` | Definition of done |
| `docs/whisperx-reliable-notes/12_FINAL_REPORT_TEMPLATE.md` | Exact final implementation report expected from Codex |
| `docs/whisperx-reliable-notes/13_DECISION_LOG.md` | Locked decisions, assumptions to verify, and exclusions |
| `references/` | Source setup, hardening, and hardware documents supplied by the user |

## Non-Negotiable Design Principles

1. **Local first.** Recorded audio, raw transcripts, structured transcript artifacts, and generated notes remain on the machine unless the user deliberately selects a cloud provider.
2. **Raw evidence is immutable.** LLM cleanup or note generation never overwrites the canonical transcript.
3. **Every note claim is traceable.** Decisions, action items, dates, owners, numbers, quotes, and substantive summary statements cite transcript segment IDs and timestamps.
4. **WhisperX is an upload/recording engine, not a replacement for low-latency dictation.**
5. **GPU-heavy stages are sequential.** WhisperX, diarization, and the local LLM do not compete for the RTX 4060 at the same time.
6. **TDD and reproducibility are required.** Contracts and failure behavior are tested before implementation.
7. **The current repository is authoritative.** File paths in this package are likely targets, not permission to ignore newer upstream or fork changes.
8. **No secret leakage.** Hugging Face tokens and other credentials stay in Electron secure storage and never appear in tracked files, command lines, diagnostics, or transcript artifacts.
9. **No unsupported completion claims.** Codex must distinguish passed tests, hardware-verified behavior, unexecuted manual checks, and pre-existing failures.

## Source Context

The local setup already prefers local transcription, reproducible `npm ci` installs, narrow IPC, private defaults, and a clean upstream-sync workflow. The hardening work already follows tests-first implementation and requires test/lint/build verification. The MSI work PC provides a high-core-count Intel CPU, 32 GB RAM, an RTX 4060 Laptop GPU, and sufficient NVMe free space for this design.

The copied source Markdown files under `references/` are informational inputs. They may contain version assumptions—especially Node.js—that Codex must verify against the actual repository before changing anything.
