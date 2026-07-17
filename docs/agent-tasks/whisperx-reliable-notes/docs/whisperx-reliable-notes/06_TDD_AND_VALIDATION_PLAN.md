# 06 — TDD and Validation Plan

## 1. Test Philosophy

- Add tests before implementation for each contract and failure mode.
- Test boundaries, not only happy-path components.
- Keep ordinary tests offline and deterministic.
- Gate real GPU/model tests behind explicit environment variables.
- Record baseline failures and do not absorb them into feature work.
- Never report skipped hardware tests as passed.

## 2. TypeScript/JavaScript Unit Tests

### Profiles and settings

- defaults for memo/meeting/critical;
- advanced override validation;
- incompatible speaker settings rejected;
- custom dictionary hotword normalization and caps;
- safe persistence excludes secrets;
- existing provider settings unaffected.

### JSONL parser

- valid ready/progress/warning/artifact/complete;
- partial lines across data chunks;
- multiple lines in one chunk;
- malformed JSON;
- unknown event type;
- unsupported protocol;
- duplicate completion;
- event after terminal state;
- non-monotonic progress;
- oversized line;
- stderr is not parsed as protocol.

### Job state machine

- valid transition path;
- invalid transition rejected;
- cancellation from every active state;
- retry from failed/cancelled;
- transcript-complete/note-failed state;
- renderer navigation does not cancel;
- startup recovery;
- stale running job becomes interrupted, not complete.

### Path and artifact store

- valid relative artifact;
- `..` traversal;
- absolute Windows path;
- UNC/device path;
- alternate data stream;
- symlink/reparse escape;
- hash mismatch;
- atomic finalize;
- temp cleanup;
- external source deletion protection;
- managed source deletion.

### GPU coordinator

- FIFO lease;
- one holder at a time;
- cancelled queued job removed;
- holder crash releases lease;
- note job waits for ASR;
- watchdog clears stale lease;
- no renderer bypass.

### Evidence notes

- valid extraction;
- missing evidence;
- unknown segment;
- unknown speaker;
- exact quote match;
- quote whitespace/punctuation normalization;
- quote mismatch;
- explicit owner;
- inferred owner rejected;
- explicit due date;
- inferred date rejected;
- duplicate overlap merge;
- disagreement preserved;
- deterministic ordering;
- prompt-injection text treated as content;
- Markdown contains citations for every claim;
- empty sections omitted;
- note regeneration uses transcript hash.

### Database

- migration from existing schema;
- migration idempotence according to repo conventions;
- job CRUD;
- artifact cascade;
- external source path preservation;
- note run references transcript hash;
- restart state recovery;
- transaction rollback on artifact/database failure.

## 3. Python Tests

Use `pytest`.

### Protocol/schema

- shared valid fixtures accepted;
- shared invalid fixtures rejected;
- no secret field allowed;
- output path confinement;
- speaker count validation;
- offline mode validation.

### Pipeline with mocked backends

- ASR-only;
- ASR + alignment;
- ASR + diarization;
- partial alignment;
- diarization failure fallback policy;
- canonical segment IDs stable;
- words/timestamps sorted;
- quality fields omitted when unavailable;
- artifact hashes correct;
- stdout JSONL only;
- stderr redaction;
- OOM classified precisely;
- arbitrary exception not classified as OOM;
- cleanup after error/cancel.

### Real model tests, opt-in

Environment gates such as:

```text
RUN_WHISPERX_GPU_TESTS=1
RUN_WHISPERX_DIARIZATION_TESTS=1
OPENWHISPR_TEST_AUDIO=<private path>
```

Test:

- Torch detects CUDA;
- model loads;
- short local fixture transcribes;
- canonical schema validates;
- diarization runs when token/model ready;
- worker exits and VRAM is released.

Do not require token-gated tests in normal CI.

## 4. Contract Tests

Both Node and Python consume identical fixtures. Add a script such as:

```text
npm run test:whisperx-contracts
```

It must fail if the two implementations disagree on a valid or invalid fixture.

## 5. Fake Sidecar Integration

Implement a deterministic fake worker capable of modes:

```text
success
slow-success
malformed-json
stderr-noise
crash
timeout
oom-once-then-success
artifact-hash-mismatch
invalid-transcript
cancel-resistant-child
```

Use it to test Electron main orchestration without models.

The cancel-resistant mode should spawn a child so process-tree termination is proven.

## 6. Renderer Integration

Test:

- profile selection;
- readiness state;
- disabled start when runtime unavailable;
- stage progress;
- warnings;
- cancellation;
- retry;
- completed tabs;
- evidence citation click;
- speaker rename;
- delete confirmation;
- batch queue;
- accessibility labels and keyboard operation.

Use existing project test libraries and avoid brittle implementation-detail assertions.

## 7. End-to-End Smoke Paths

### Offline fake path

```text
upload fixture
→ choose WhisperX
→ fake worker completes
→ artifacts persist
→ note fixture extracts
→ Markdown displays
→ citation opens transcript timestamp
→ delete job preserves external source
```

### Real GPU path

```text
private 1–3 minute audio
→ large-v3-turbo CUDA float16 batch 4
→ alignment
→ optional diarization
→ transcript artifacts
→ local note model
→ citations
→ app restart/reopen
```

### OOM path

Can be simulated through fake worker. A real OOM test is not required if it would destabilize the machine.

## 8. Benchmark Test Harness

Unit-test metrics using known reference/hypothesis strings:

- WER;
- CER;
- proper noun error;
- number/date error;
- speaker attribution;
- decision/action capture;
- evidence coverage;
- unsupported claim count.

## 9. Validation Commands

Codex must discover current commands. Expected additions may include:

```bash
npm ci
npm test
npm run lint
npm run build
npm run doctor:local
npm run test:whisperx
npm run test:whisperx-contracts
npm run doctor:whisperx
npm run build:local:win
```

Python:

```powershell
cd tools/whisperx-sidecar
uv sync --frozen
uv run pytest
```

Do not invent a passing command if the repository uses a different script. Add scripts only when useful and documented.

## 10. Coverage Expectations

Do not chase a superficial global percentage. Critical modules should have high branch coverage:

- request/event validation;
- job state transitions;
- path confinement;
- cancellation;
- OOM fallback;
- evidence validation;
- deterministic merge/render;
- retention/delete.

Report the actual coverage tool/result if the repo uses one.

## 11. Baseline and Regression Handling

Before edits, record:

```text
command
exit code
pass/fail count
relevant error
whether failure is pre-existing
```

After edits:

- rerun the same commands;
- new failures are regressions until explained/fixed;
- do not “fix” unrelated baseline failures;
- if a baseline build failure blocks dependent tests, report the dependency and run all independent tests.

## 12. Test Data Policy

- Do not commit personal meetings/interviews.
- Use small synthetic or deliberately created non-sensitive fixtures.
- Keep large model files outside Git.
- Keep test transcripts fictional.
- Ensure fixture licenses permit inclusion.
- Redact paths and user names from snapshots.
