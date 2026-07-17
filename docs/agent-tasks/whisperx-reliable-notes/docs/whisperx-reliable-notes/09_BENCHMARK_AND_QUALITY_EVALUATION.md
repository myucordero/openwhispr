# 09 — Benchmark and Quality Evaluation

## 1. Goal

Choose defaults using measured performance and accuracy on representative private recordings rather than promotional claims.

The benchmark must compare transcript quality, speaker/timestamp quality, note grounding, speed, memory, and failure behavior.

## 2. Private Evaluation Set

Use at least three recordings not committed to Git:

### A — Personal Memo

```text
10–15 minutes
one speaker
Puerto Rican Spanish
some English technical terms
names, acronyms, dates, and numbers
```

### B — Work Meeting

```text
15–30 minutes
two or three speakers
Spanish/English code-switching
decisions and explicit action items
interruptions and short turns
```

### C — Difficult Recording

```text
10–20 minutes
background noise or distant microphone
overlap
unclear speech
multiple proper nouns and numbers
```

Optionally add a research interview fixture with explicit consent and strict local retention.

## 3. Systems to Compare

At minimum:

```text
OpenWhispr whisper.cpp base
OpenWhispr whisper.cpp turbo
OpenWhispr whisper.cpp large-v3
WhisperX large-v3-turbo
WhisperX large-v3
```

Optional:

```text
OpenWhispr Parakeet multilingual
WhisperX without diarization
WhisperX with exact speaker count
WhisperX auto vs explicit language
```

Use the same source file and record exact settings.

## 4. Reference Transcripts

Manually correct at least five representative minutes from each recording.

Reference requirements:

- preserve spoken language;
- mark numbers/dates exactly;
- use consistent rules for fillers/disfluencies;
- mark speaker turns;
- mark overlap/inaudible sections;
- do not “improve” grammar when measuring verbatim ASR.

Store references outside Git or in an ignored private benchmark directory.

## 5. Transcript Metrics

Implement:

- Word Error Rate;
- Character Error Rate;
- proper-noun error count/rate;
- acronym error count/rate;
- number/date error count/rate;
- omitted phrase count;
- code-switch error count;
- hallucinated text count;
- timestamp boundary error where reference timestamps exist;
- speaker attribution accuracy/DER where reference speaker timing exists.

WER/CER do not replace domain metrics. A transcript can have acceptable WER while getting the key date or decision wrong.

## 6. Note Metrics

Create a reference list of:

```text
decisions
proposals
action items
owners
due dates
open questions
risks/blockers
important quotes
```

Measure:

- supported note claims / total claims;
- evidence-free claims;
- unknown segment references;
- decision precision/recall;
- action-item precision/recall;
- owner correctness;
- due-date correctness;
- quote exactness;
- disagreement/uncertainty preservation;
- false decision/action/date/owner count;
- review-required count.

Hard gate:

```text
evidence-free rendered claims = 0
unknown evidence IDs = 0
invalid exact quotes = 0
```

## 7. Performance Metrics

Capture:

```text
audio duration
wall-clock duration
RTF
ASR/alignment/diarization times
note generation time
peak VRAM
peak RAM
fallback count
artifact size
```

Use `nvidia-smi` sampling or an available programmatic API. If unavailable, mark metric missing rather than inventing it.

## 8. Benchmark CLI

Add a command conceptually similar to:

```powershell
npm run benchmark:whisperx -- `
  --manifest "C:\private\openwhispr-benchmark\manifest.json" `
  --output "C:\private\openwhispr-benchmark\results" `
  --offline
```

Manifest example:

```json
{
  "cases": [
    {
      "id": "memo-es-tech",
      "audio": "memo.m4a",
      "referenceTranscript": "memo-reference.txt",
      "referenceSegments": "memo-reference.json",
      "referenceNotes": "memo-notes.json"
    }
  ],
  "configurations": [
    {
      "id": "whisperx-turbo-fp16-b4",
      "provider": "whisperx",
      "model": "large-v3-turbo",
      "computeType": "float16",
      "batchSize": 4,
      "diarization": false
    }
  ]
}
```

Output:

```text
results.json
results.csv
report.md
artifacts/<case>/<configuration>/
```

Redact/relativize private paths in the report.

## 9. Selection Rules

Default profile should:

- complete reliably without OOM;
- materially improve or match key-domain accuracy compared with the current base model;
- provide valid timestamps;
- preserve bilingual content;
- produce zero evidence-free note claims;
- meet acceptable user-perceived latency on the MSI.

Critical profile should prioritize:

- proper nouns;
- numbers/dates;
- quotations;
- decisions/actions;
- traceability.

Do not choose a model solely because it is faster.

## 10. Regression Fixture

After defaults are selected, create a small non-sensitive checked-in fixture and expected schema-level outputs.

Do not snapshot exact full ASR text from a nondeterministic real model in ordinary CI. Instead assert:

- protocol;
- artifact existence;
- schema validity;
- stable segment ID construction;
- citation validity;
- deterministic renderer output from a fixed transcript fixture.

Real-model benchmark remains opt-in.

## 11. Report Interpretation

Every report must identify:

```text
date/time
git commit
machine/GPU/driver
runtime lock hash
model/revision
configuration
network/offline state
recording/reference version
missing metrics
warnings/fallbacks
```

Do not generalize one machine's benchmark as a universal model ranking.
