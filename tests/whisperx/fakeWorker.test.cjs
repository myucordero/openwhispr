// Integration tests for the deterministic fake WhisperX sidecar worker
// (tests/fixtures/whisperx-fake-worker.cjs). These prove the fake worker's
// JSONL output satisfies the exact same protocol contract
// (src/helpers/whisperx/{contracts,jsonlProtocol}.js) that the real Python
// sidecar and Electron-main orchestrator must agree on — without spawning
// any real model.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const {
  JsonlLineReader,
  ProtocolSession,
  ProtocolError,
} = require("../../src/helpers/whisperx/jsonlProtocol");
const {
  validateArtifactDescriptor,
  validateCanonicalTranscript,
} = require("../../src/helpers/whisperx/contracts");

const WORKER_PATH = path.resolve(__dirname, "../fixtures/whisperx-fake-worker.cjs");
const DEFAULT_TIMEOUT_MS = 10000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-fake-worker-"));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildJobRequest(jobDirectory, overrides = {}) {
  return {
    protocolVersion: 1,
    requestId: "test-request-1",
    jobId: "test-job-1",
    source: {
      path: overrides.sourcePath || path.join(jobDirectory, "source-not-present.wav"),
      displayName: "fake-meeting.wav",
    },
    output: {
      jobDirectory,
      preserveNormalizedAudio: false,
      formats: ["canonical-json", "raw-txt", "speaker-markdown", "srt", "vtt"],
    },
    profile: "meeting",
    language: "auto",
    asr: {
      model: "large-v3-turbo",
      computeType: "int8",
      batchSize: 1,
      device: "cpu",
      hotwords: [],
    },
    alignment: { enabled: true },
    diarization: { enabled: true, provider: "openwhispr-local" },
    runtime: {
      offline: true,
      modelCacheDirectory: jobDirectory,
      temporaryDirectory: jobDirectory,
    },
  };
}

function sha256OfFile(absPath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

// Spawns the fake worker, feeds it `request` on stdin, and replays stdout
// through the real JsonlLineReader + ProtocolSession so tests observe exactly
// what the orchestrator would observe (including thrown ProtocolErrors).
function runWorker({ mode, request, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      env: { ...process.env, OPENWHISPR_FAKE_WORKER_MODE: mode, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const reader = new JsonlLineReader();
    const session = new ProtocolSession();
    const events = [];
    let stderrBuf = "";
    let thrownError = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`fake worker (mode=${mode}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (thrownError) return;
      let lines;
      try {
        lines = reader.feed(chunk);
      } catch (e) {
        thrownError = e;
        return;
      }
      for (const line of lines) {
        if (thrownError) break;
        try {
          events.push(session.acceptLine(line));
        } catch (e) {
          thrownError = e;
          break;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ events, exitCode, stderr: stderrBuf, thrownError, session });
    });

    child.stdin.write(JSON.stringify(request) + "\n");
    child.stdin.end();
  });
}

test("success mode: valid artifacts, monotonic progress, clean completion", async () => {
  const dir = makeTempDir();
  try {
    const sourcePath = path.join(dir, "source.wav");
    fs.writeFileSync(sourcePath, "fake-audio-bytes-not-real-wav");
    const request = buildJobRequest(dir, { sourcePath });

    const { events, exitCode, thrownError, session } = await runWorker({
      mode: "success",
      request,
    });

    assert.equal(thrownError, null, thrownError && thrownError.message);
    assert.equal(exitCode, 0);
    assert.equal(session.isTerminal(), true);

    const readyEvt = events.find((e) => e.type === "ready");
    assert.ok(readyEvt, "expected a ready event");

    const completeEvt = events.find((e) => e.type === "complete");
    assert.ok(completeEvt, "expected a complete event");
    const result = completeEvt.result;
    assert.equal(result.jobId, request.jobId);
    assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.sourceSha256, sha256OfFile(sourcePath));
    assert.equal(result.actualConfiguration.model, request.asr.model);
    assert.equal(result.actualConfiguration.alignmentUsed, true);
    assert.equal(result.actualConfiguration.diarizationUsed, true);
    assert.deepEqual(result.actualConfiguration.fallbackAttempts, []);

    const artifactEvents = events.filter((e) => e.type === "artifact");
    assert.equal(artifactEvents.length, 5);

    for (const artifactEvt of artifactEvents) {
      const { valid, errors } = validateArtifactDescriptor(artifactEvt);
      assert.equal(valid, true, JSON.stringify(errors));
      const absPath = path.join(dir, artifactEvt.relativePath);
      assert.ok(fs.existsSync(absPath), `${artifactEvt.relativePath} should exist on disk`);
      assert.equal(
        sha256OfFile(absPath),
        artifactEvt.sha256,
        `${artifactEvt.relativePath} sha256 must match real file content`
      );
    }

    const transcript = JSON.parse(
      fs.readFileSync(path.join(dir, "transcript.raw.json"), "utf8")
    );
    const { valid: transcriptValid, errors: transcriptErrors } =
      validateCanonicalTranscript(transcript);
    assert.equal(transcriptValid, true, JSON.stringify(transcriptErrors));

    // Progress monotonicity is enforced by ProtocolSession itself: if it had
    // thrown, thrownError above would be non-null. We also sanity-check the
    // raw progress sequence here.
    const progressCompletedValues = events
      .filter((e) => e.type === "progress" && e.stage === "transcribing")
      .map((e) => e.completed);
    assert.deepEqual(progressCompletedValues, [1, 2, 3]);
  } finally {
    cleanupDir(dir);
  }
});

test("malformed-json mode: ProtocolSession rejects the bad line", async () => {
  const dir = makeTempDir();
  try {
    const request = buildJobRequest(dir);
    const { thrownError, events } = await runWorker({ mode: "malformed-json", request });

    assert.ok(thrownError instanceof ProtocolError, "expected a ProtocolError to be thrown");
    assert.equal(thrownError.details.reason, "malformed-json");
    // The ready + one stage event before the bad line must have parsed fine.
    assert.ok(events.some((e) => e.type === "ready"));
    assert.ok(events.some((e) => e.type === "stage"));
  } finally {
    cleanupDir(dir);
  }
});

test("crash mode: exits 1 without ever reaching a terminal event", async () => {
  const dir = makeTempDir();
  try {
    const request = buildJobRequest(dir);
    const { exitCode, thrownError, session } = await runWorker({ mode: "crash", request });

    assert.equal(exitCode, 1);
    assert.equal(thrownError, null, thrownError && thrownError.message);
    assert.equal(session.isTerminal(), false);
  } finally {
    cleanupDir(dir);
  }
});

test("oom-once-then-success mode: first run OOMs, retry (same state file) succeeds cleanly", async () => {
  const dir = makeTempDir();
  try {
    const stateFile = path.join(dir, "oom-state.json");
    const request = buildJobRequest(dir);

    const first = await runWorker({
      mode: "oom-once-then-success",
      request,
      env: { OPENWHISPR_FAKE_WORKER_OOM_STATE_FILE: stateFile },
    });
    assert.equal(first.thrownError, null, first.thrownError && first.thrownError.message);
    assert.equal(first.exitCode, 3);
    const errorEvt = first.events.find((e) => e.type === "error");
    assert.ok(errorEvt, "expected an error event on first run");
    assert.equal(errorEvt.error.code, "CUDA_OUT_OF_MEMORY");
    assert.equal(first.session.isTerminal(), true);
    assert.equal(first.session.terminal, "error");

    const second = await runWorker({
      mode: "oom-once-then-success",
      request,
      env: { OPENWHISPR_FAKE_WORKER_OOM_STATE_FILE: stateFile },
    });
    assert.equal(second.thrownError, null, second.thrownError && second.thrownError.message);
    assert.equal(second.exitCode, 0);
    const completeEvt = second.events.find((e) => e.type === "complete");
    assert.ok(completeEvt, "expected a complete event on retry");
    assert.equal(completeEvt.result.jobId, request.jobId);
  } finally {
    cleanupDir(dir);
  }
});

test("artifact-hash-mismatch mode: reported sha256 does not match the real file", async () => {
  const dir = makeTempDir();
  try {
    const request = buildJobRequest(dir);
    const { events, exitCode, thrownError } = await runWorker({
      mode: "artifact-hash-mismatch",
      request,
    });

    assert.equal(thrownError, null, thrownError && thrownError.message);
    assert.equal(exitCode, 0);
    assert.ok(events.some((e) => e.type === "complete"));

    const artifactEvt = events.find(
      (e) => e.type === "artifact" && e.relativePath === "transcript.raw.json"
    );
    assert.ok(artifactEvt);

    const absPath = path.join(dir, "transcript.raw.json");
    const actualHash = sha256OfFile(absPath);
    assert.notEqual(
      actualHash,
      artifactEvt.sha256,
      "the mismatch must be detectable by recomputing the file hash"
    );
  } finally {
    cleanupDir(dir);
  }
});

test("invalid-transcript mode: written transcript fails canonical-transcript validation", async () => {
  const dir = makeTempDir();
  try {
    const request = buildJobRequest(dir);
    const { events, exitCode, thrownError } = await runWorker({
      mode: "invalid-transcript",
      request,
    });

    assert.equal(thrownError, null, thrownError && thrownError.message);
    assert.equal(exitCode, 0);
    assert.ok(events.some((e) => e.type === "complete"));

    const transcript = JSON.parse(
      fs.readFileSync(path.join(dir, "transcript.raw.json"), "utf8")
    );
    const { valid, errors } = validateCanonicalTranscript(transcript);
    assert.equal(valid, false);
    assert.ok(
      errors.some((e) => /Duplicate segment id/.test(e.message)),
      JSON.stringify(errors)
    );
  } finally {
    cleanupDir(dir);
  }
});

test("stderr-noise mode: completes cleanly; stdout stays protocol-only while stderr carries noise", async () => {
  const dir = makeTempDir();
  try {
    const request = buildJobRequest(dir);
    const { events, exitCode, thrownError, stderr } = await runWorker({
      mode: "stderr-noise",
      request,
    });

    assert.equal(thrownError, null, thrownError && thrownError.message);
    assert.equal(exitCode, 0);
    assert.ok(events.some((e) => e.type === "complete"));
    assert.match(stderr, /hf_FAKESECRETTOKEN12345/);
    assert.match(stderr, /C:\\Users\\FakeUser\\audio\.wav/);
  } finally {
    cleanupDir(dir);
  }
});

test("timeout mode: emits ready then hangs, must be killed externally", async () => {
  const dir = makeTempDir();
  let child;
  try {
    const request = buildJobRequest(dir);
    child = spawn(process.execPath, [WORKER_PATH], {
      env: { ...process.env, OPENWHISPR_FAKE_WORKER_MODE: "timeout" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const reader = new JsonlLineReader();
    const session = new ProtocolSession();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not receive ready in time")), 5000);
      child.stdout.on("data", (chunk) => {
        try {
          for (const line of reader.feed(chunk)) {
            const evt = session.acceptLine(line);
            if (evt.type === "ready") {
              clearTimeout(timer);
              resolve();
              return;
            }
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
      child.stdin.write(JSON.stringify(request) + "\n");
      child.stdin.end();
    });

    assert.equal(session.readyReceived, true);
    assert.equal(session.isTerminal(), false);
  } finally {
    try {
      child && child.kill("SIGKILL");
    } catch {
      // ignore
    }
    cleanupDir(dir);
  }
});

test("cancel-resistant-child mode: spawns a detached grandchild whose pid is recorded", async () => {
  const dir = makeTempDir();
  let child;
  let childPid;
  try {
    const request = buildJobRequest(dir);
    child = spawn(process.execPath, [WORKER_PATH], {
      env: { ...process.env, OPENWHISPR_FAKE_WORKER_MODE: "cancel-resistant-child" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const reader = new JsonlLineReader();
    const session = new ProtocolSession();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not receive ready in time")), 5000);
      child.stdout.on("data", (chunk) => {
        try {
          for (const line of reader.feed(chunk)) {
            const evt = session.acceptLine(line);
            if (evt.type === "ready") {
              clearTimeout(timer);
              resolve();
              return;
            }
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
      child.stdin.write(JSON.stringify(request) + "\n");
      child.stdin.end();
    });

    const pidFile = path.join(dir, "cancel-child.json");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile)) {
      if (Date.now() > deadline) {
        throw new Error("cancel-child.json was not written in time");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    ({ childPid } = JSON.parse(fs.readFileSync(pidFile, "utf8")));
    assert.ok(Number.isInteger(childPid));
  } finally {
    try {
      child && child.kill("SIGKILL");
    } catch {
      // ignore
    }
    try {
      if (childPid) process.kill(childPid, "SIGKILL");
    } catch {
      // ignore — grandchild may already be gone
    }
    cleanupDir(dir);
  }
});
