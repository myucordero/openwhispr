#!/usr/bin/env node
"use strict";

// Deterministic fake WhisperX sidecar worker used ONLY by integration tests
// (tests/whisperx/fakeWorker.test.cjs) to exercise Electron-main orchestration
// without real models. Speaks the exact same JSONL protocol the real Python
// worker speaks (src/helpers/whisperx/{constants,contracts,jsonlProtocol}.js).
//
// Usage: node whisperx-fake-worker.cjs
//   - reads exactly one JSON line (a WhisperXJobRequest) from stdin
//   - env OPENWHISPR_FAKE_WORKER_MODE selects behavior (default "success")
//   - ALL protocol output goes to stdout as one JSON object per line
//   - diagnostics/noise go to stderr, never stdout
//
// Never requires electron: this must run under plain Node in CI.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { validateJobRequest } = require("../../src/helpers/whisperx/contracts");
const {
  WHISPERX_PROTOCOL_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
} = require("../../src/helpers/whisperx/constants");

// ---------------------------------------------------------------------------
// Protocol emission helpers
// ---------------------------------------------------------------------------

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readyEvent() {
  return {
    type: "ready",
    protocolVersion: WHISPERX_PROTOCOL_VERSION,
    workerVersion: "fake-worker-1.0.0",
    whisperxVersion: "0.0.0-fake",
    pythonVersion: "3.11.0-fake",
  };
}

function stageEvent(stage) {
  return { type: "stage", stage, timestamp: nowIso() };
}

function heartbeatEvent(stage) {
  return { type: "heartbeat", stage, timestamp: nowIso() };
}

function progressEvent(stage, completed, total) {
  return { type: "progress", stage, completed, total, unit: "segments" };
}

function errorEvent(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return { type: "error", error };
}

// ---------------------------------------------------------------------------
// stdin: read exactly one JSON line
// ---------------------------------------------------------------------------

function readStdinLine() {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (settled) return;
      data += chunk;
      const idx = data.indexOf("\n");
      if (idx !== -1) {
        settle(data.slice(0, idx));
        process.stdin.pause();
      }
    });
    process.stdin.on("end", () => settle(data));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Fake transcript fixture: small fictional bilingual (es/en) meeting,
// 4 segments, 2 speakers.
// ---------------------------------------------------------------------------

function wordsForSegment(text, start, end, speakerId) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const span = end - start;
  const step = span / tokens.length;
  return tokens.map((tok, i) => ({
    text: tok,
    start: Number((start + i * step).toFixed(3)),
    end: Number((start + (i + 1) * step).toFixed(3)),
    score: 0.9,
    speakerId,
  }));
}

function buildTranscript(request, { duplicateSegmentId = false } = {}, sourceSha256) {
  const speakers = [
    { id: "spk-1", displayName: "Speaker 1" },
    { id: "spk-2", displayName: "Speaker 2" },
  ];

  const raw = [
    { id: "seg-0", speakerId: "spk-1", start: 0.0, end: 3.2, text: "Buenos dias a todos, empecemos la reunion." },
    { id: "seg-1", speakerId: "spk-2", start: 3.4, end: 6.8, text: "Good morning. I have the quarterly numbers ready." },
    { id: "seg-2", speakerId: "spk-1", start: 7.0, end: 9.5, text: "Perfecto, comparte la pantalla por favor." },
    { id: "seg-3", speakerId: "spk-2", start: 9.6, end: 12.0, text: "Sure, let's dive into the report." },
  ];

  const segments = raw.map((seg, i) => ({
    id: duplicateSegmentId && i === raw.length - 1 ? raw[0].id : seg.id,
    sequence: i,
    start: seg.start,
    end: seg.end,
    speakerId: seg.speakerId,
    text: seg.text,
    words: wordsForSegment(seg.text, seg.start, seg.end, seg.speakerId),
    flags: [],
  }));

  const asr = request.asr || {};

  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    jobId: request.jobId,
    source: {
      displayName: request.source && request.source.displayName,
      sha256: sourceSha256,
      durationSeconds: 12.5,
    },
    provenance: {
      engine: "whisperx",
      whisperxVersion: "0.0.0-fake",
      model: asr.model,
      device: asr.device,
      computeType: asr.computeType,
      batchSize: asr.batchSize,
      languageRequested: request.language,
      languageDetected: "es",
      createdAt: nowIso(),
    },
    speakers,
    segments,
    warnings: [],
  };
}

function buildRawTxt(transcript) {
  return transcript.segments.map((s) => s.text).join("\n") + "\n";
}

function buildSpeakersMarkdown(transcript) {
  const bySpeaker = new Map(transcript.speakers.map((s) => [s.id, s]));
  return (
    transcript.segments
      .map((s) => {
        const speaker = bySpeaker.get(s.speakerId);
        const label = (speaker && speaker.displayName) || s.speakerId || "Unknown";
        return `**${label}:** ${s.text}`;
      })
      .join("\n\n") + "\n"
  );
}

function toSrtTimestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n, len) => String(n).padStart(len, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(millis, 3)}`;
}

function toVttTimestamp(seconds) {
  return toSrtTimestamp(seconds).replace(",", ".");
}

function buildSrt(transcript) {
  return (
    transcript.segments
      .map(
        (s, i) =>
          `${i + 1}\n${toSrtTimestamp(s.start)} --> ${toSrtTimestamp(s.end)}\n${s.text}\n`
      )
      .join("\n") + "\n"
  );
}

function buildVtt(transcript) {
  return (
    "WEBVTT\n\n" +
    transcript.segments
      .map(
        (s, i) =>
          `${i + 1}\n${toVttTimestamp(s.start)} --> ${toVttTimestamp(s.end)}\n${s.text}\n`
      )
      .join("\n") +
    "\n"
  );
}

function computeSourceSha256(request) {
  const sourcePath = request.source && request.source.path;
  try {
    if (sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
      return sha256Buffer(fs.readFileSync(sourcePath));
    }
  } catch {
    // fall through to fixed fake hash
  }
  return "ab".repeat(32); // 64 lowercase hex chars, deterministic fallback
}

// ---------------------------------------------------------------------------
// stderr noise (proves stderr is never parsed as protocol, and must be
// redacted upstream before ever reaching logs/UI).
// ---------------------------------------------------------------------------

function writeStderrNoise() {
  process.stderr.write(
    [
      "[fake-worker] loading model weights from cache",
      "[fake-worker] auth token in use: hf_FAKESECRETTOKEN12345",
      "[fake-worker] resolved local path: C:\\Users\\FakeUser\\audio.wav",
      "[fake-worker] noisy diagnostic line, ignore me",
    ].join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// Mode implementations
// ---------------------------------------------------------------------------

async function runSuccess(request, opts = {}) {
  const {
    slow = false,
    stderrNoise = false,
    hashMismatch = false,
    duplicateSegmentId = false,
  } = opts;
  const stageDelay = slow ? 150 : 0;

  emit(readyEvent());
  if (stderrNoise) writeStderrNoise();

  if (stageDelay) await sleep(stageDelay);
  emit(stageEvent("probing-audio"));
  if (stageDelay) await sleep(stageDelay);
  emit(stageEvent("loading-asr"));
  if (stageDelay) await sleep(stageDelay);
  emit(stageEvent("transcribing"));

  const total = 3;
  for (let completed = 1; completed <= total; completed++) {
    if (slow) {
      emit(heartbeatEvent("transcribing"));
      await sleep(100);
    }
    emit(progressEvent("transcribing", completed, total));
  }

  if (stageDelay) await sleep(stageDelay);
  emit(stageEvent("canonicalizing"));
  if (stageDelay) await sleep(stageDelay);
  emit(stageEvent("writing-artifacts"));

  const jobDirectory = request.output.jobDirectory;
  fs.mkdirSync(jobDirectory, { recursive: true });

  const sourceSha256 = computeSourceSha256(request);
  const transcript = buildTranscript(request, { duplicateSegmentId }, sourceSha256);

  const files = {
    "transcript.raw.json": {
      kind: "canonical-transcript",
      content: JSON.stringify(transcript, null, 2),
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    },
    "transcript.raw.txt": { kind: "raw-transcript", content: buildRawTxt(transcript) },
    "transcript.speakers.md": {
      kind: "speaker-transcript",
      content: buildSpeakersMarkdown(transcript),
    },
    "transcript.srt": { kind: "srt", content: buildSrt(transcript) },
    "transcript.vtt": { kind: "vtt", content: buildVtt(transcript) },
  };

  const artifacts = [];
  for (const [relativePath, spec] of Object.entries(files)) {
    const absPath = path.join(jobDirectory, relativePath);
    fs.writeFileSync(absPath, spec.content, "utf8");
    const bytes = Buffer.byteLength(spec.content, "utf8");
    let sha256 = sha256Buffer(Buffer.from(spec.content, "utf8"));
    if (hashMismatch && relativePath === "transcript.raw.json") {
      sha256 = "0".repeat(64);
    }
    const descriptor = {
      kind: spec.kind,
      relativePath,
      sha256,
      bytes,
      createdAt: nowIso(),
    };
    if (spec.schemaVersion !== undefined) descriptor.schemaVersion = spec.schemaVersion;
    emit({ type: "artifact", ...descriptor });
    artifacts.push(descriptor);
  }

  const transcriptDescriptor = artifacts.find((a) => a.relativePath === "transcript.raw.json");
  const wordCount = transcript.segments.reduce((acc, s) => acc + s.words.length, 0);

  const actualConfiguration = {
    model: request.asr.model,
    computeType: request.asr.computeType,
    batchSize: request.asr.batchSize,
    device: request.asr.device,
    alignmentUsed: !!(request.alignment && request.alignment.enabled),
    diarizationUsed: !!(request.diarization && request.diarization.enabled),
    fallbackAttempts: [],
  };
  if (request.diarization && request.diarization.enabled) {
    actualConfiguration.diarizationProvider = request.diarization.provider;
  }

  const result = {
    jobId: request.jobId,
    sourceSha256,
    durationSeconds: transcript.source.durationSeconds,
    detectedLanguage: "es",
    actualConfiguration,
    transcript: {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      relativePath: "transcript.raw.json",
      sha256: transcriptDescriptor.sha256,
      segmentCount: transcript.segments.length,
      wordCount,
    },
    artifacts,
    warnings: [],
    timingsMs: {
      total: slow ? 1200 : 50,
      transcribing: slow ? 600 : 20,
      canonicalizing: slow ? 200 : 10,
      writingArtifacts: slow ? 200 : 10,
    },
  };

  emit({ type: "complete", result });
  process.exitCode = 0;
}

function runMalformedJson() {
  emit(readyEvent());
  emit(stageEvent("probing-audio"));
  // Deliberately invalid JSON line to exercise ProtocolSession's malformed-json path.
  process.stdout.write("{this is not json\n");
  process.exitCode = 0;
}

function runCrash() {
  emit(readyEvent());
  emit(stageEvent("loading-asr"));
  process.exit(1); // abrupt, no complete/error — simulates a real crash
}

function runTimeout() {
  emit(readyEvent());
  emit(stageEvent("transcribing"));
  // Hang forever; only the orchestrator's watchdog (or a test) should kill us.
  setInterval(() => {}, 60 * 60 * 1000);
}

async function runOomOnceThenSuccess(request) {
  const stateFile =
    process.env.OPENWHISPR_FAKE_WORKER_OOM_STATE_FILE ||
    path.join(os.tmpdir(), "openwhispr-fake-worker-oom-state");

  if (!fs.existsSync(stateFile)) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, String(Date.now()));
    emit(readyEvent());
    emit(stageEvent("loading-asr"));
    emit(errorEvent("CUDA_OUT_OF_MEMORY", "CUDA out of memory (fake)"));
    process.exit(3);
    return;
  }

  await runSuccess(request);
}

function runCancelResistantChild(request) {
  emit(readyEvent());
  emit(stageEvent("transcribing"));

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const jobDirectory = request.output.jobDirectory;
  try {
    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(jobDirectory, "cancel-child.json"),
      JSON.stringify({ childPid: child.pid })
    );
  } catch (writeErr) {
    process.stderr.write(`[fake-worker] failed to write cancel-child.json: ${writeErr}\n`);
  }

  // Hang forever, resistant to a plain SIGTERM/kill of just this process —
  // the grandchild keeps running unless the caller kills the whole tree.
  setInterval(() => {}, 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const line = await readStdinLine();

  let request;
  try {
    request = JSON.parse(line);
  } catch (parseError) {
    emit(
      errorEvent("WORKER_PROTOCOL_ERROR", "Job request line was not valid JSON", {
        reason: "malformed-job-request",
        parseError: parseError.message,
      })
    );
    process.exitCode = 2;
    return;
  }

  const { valid, errors } = validateJobRequest(request);
  if (!valid) {
    emit(
      errorEvent("WORKER_PROTOCOL_ERROR", "Job request failed contract validation", {
        reason: "invalid-job-request",
        errors,
      })
    );
    process.exitCode = 2;
    return;
  }

  const mode = process.env.OPENWHISPR_FAKE_WORKER_MODE || "success";
  switch (mode) {
    case "success":
      await runSuccess(request);
      return;
    case "slow-success":
      await runSuccess(request, { slow: true });
      return;
    case "malformed-json":
      runMalformedJson();
      return;
    case "stderr-noise":
      await runSuccess(request, { stderrNoise: true });
      return;
    case "crash":
      runCrash();
      return;
    case "timeout":
      runTimeout();
      return;
    case "oom-once-then-success":
      await runOomOnceThenSuccess(request);
      return;
    case "artifact-hash-mismatch":
      await runSuccess(request, { hashMismatch: true });
      return;
    case "invalid-transcript":
      await runSuccess(request, { duplicateSegmentId: true });
      return;
    case "cancel-resistant-child":
      runCancelResistantChild(request);
      return;
    default:
      emit(
        errorEvent("WORKER_PROTOCOL_ERROR", `Unknown fake worker mode "${mode}"`, {
          reason: "unknown-mode",
        })
      );
      process.exitCode = 2;
  }
}

main().catch((fatal) => {
  try {
    process.stderr.write(`[fake-worker] fatal: ${(fatal && fatal.stack) || fatal}\n`);
  } catch {
    // ignore
  }
  process.exit(1);
});
