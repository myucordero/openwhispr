// Integration + unit tests for the WhisperX worker process manager
// (src/helpers/whisperx/whisperxProcessManager.js).
//
// These spawn the REAL deterministic fake worker
// (tests/fixtures/whisperx-fake-worker.cjs) under plain Node, so the whole
// spawn -> JSONL protocol -> watchdog -> process-tree-kill path is exercised
// without any real model. The worker mode is selected through `extraEnv`
// (the manager spawns with an env allowlist, so plain process.env would NOT
// reach the worker).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  WhisperXProcessRun,
  WhisperXProcessError,
  buildWorkerEnv,
  killProcessTree,
} = require("../../src/helpers/whisperx/whisperxProcessManager.js");

const WORKER_PATH = path.resolve(__dirname, "../fixtures/whisperx-fake-worker.cjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkJobDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-pm-"));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

function buildRequest(jobDirectory) {
  return {
    protocolVersion: 1,
    requestId: "req-1",
    jobId: "job-1",
    source: {
      path: path.join(jobDirectory, "source.wav"),
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

function makeRun(jobDirectory, { mode, hfToken, heartbeatTimeoutMs, absoluteTimeoutMs, extraEnv } = {}) {
  return new WhisperXProcessRun({
    command: process.execPath,
    args: [WORKER_PATH],
    cwd: REPO_ROOT,
    request: buildRequest(jobDirectory),
    hfToken: hfToken ?? null,
    extraEnv: { OPENWHISPR_FAKE_WORKER_MODE: mode, ...(extraEnv || {}) },
    heartbeatTimeoutMs: heartbeatTimeoutMs ?? 30000,
    absoluteTimeoutMs: absoluteTimeoutMs ?? 60000,
  });
}

test("success mode resolves with completion, artifacts, events, stderr string", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  try {
    const result = await makeRun(dir, { mode: "success" }).run();
    assert.ok(result.completion, "expected a completion result");
    assert.equal(result.completion.jobId, "job-1");
    assert.equal(result.artifacts.length, 5);
    assert.ok(result.events.some((e) => e.type === "ready"));
    assert.ok(result.events.some((e) => e.type === "complete"));
    assert.equal(typeof result.stderr, "string");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stderr-noise mode completes but returned stderr is redacted", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  try {
    const result = await makeRun(dir, { mode: "stderr-noise" }).run();
    assert.ok(result.completion, "expected a completion result");
    assert.ok(!result.stderr.includes("hf_FAKESECRETTOKEN12345"), "HF token must be redacted");
    assert.ok(!result.stderr.includes("C:\\Users\\FakeUser"), "Windows user path must be redacted");
    assert.ok(result.stderr.includes("<home>"), "user path should collapse to <home>");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed-json mode rejects with WORKER_PROTOCOL_ERROR", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  try {
    await assert.rejects(
      makeRun(dir, { mode: "malformed-json" }).run(),
      (e) => e instanceof WhisperXProcessError && e.code === "WORKER_PROTOCOL_ERROR"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crash mode rejects with WORKER_CRASHED and details.exitCode 1", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  try {
    await assert.rejects(
      makeRun(dir, { mode: "crash" }).run(),
      (e) => {
        assert.ok(e instanceof WhisperXProcessError);
        assert.equal(e.code, "WORKER_CRASHED");
        assert.equal(e.details.exitCode, 1);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout mode rejects with WORKER_TIMEOUT and the child is killed", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  try {
    const run = makeRun(dir, { mode: "timeout", heartbeatTimeoutMs: 1500 });
    const promise = run.run();
    const pid = run.child.pid;
    await assert.rejects(
      promise,
      (e) => e instanceof WhisperXProcessError && e.code === "WORKER_TIMEOUT"
    );
    assert.equal(await waitUntilDead(pid), true, "worker process must be dead after timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "cancel-resistant-child: cancel kills the worker AND the detached grandchild (process-tree proof)",
  { timeout: 20000 },
  async () => {
    const dir = mkJobDir();
    let grandPid;
    let workerPid;
    try {
      const run = makeRun(dir, { mode: "cancel-resistant-child" });
      const promise = run.run();
      workerPid = run.child.pid;

      const pidFile = path.join(dir, "cancel-child.json");
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(pidFile)) {
        if (Date.now() > deadline) throw new Error("grandchild pid file never appeared");
        await sleep(50);
      }
      grandPid = JSON.parse(fs.readFileSync(pidFile, "utf8")).childPid;
      assert.ok(Number.isInteger(grandPid));

      await run.cancel();
      await assert.rejects(
        promise,
        (e) => e instanceof WhisperXProcessError && e.code === "JOB_CANCELLED"
      );

      // The process-tree termination guarantee: neither process may survive.
      const workerDead = await waitUntilDead(workerPid);
      const grandDead = await waitUntilDead(grandPid);
      assert.equal(workerDead, true, "worker process must be dead after cancel");
      assert.equal(
        grandDead,
        true,
        "detached grandchild must be dead after cancel (process-tree kill)"
      );
    } finally {
      // Never leak the grandchild, even if the assertion above failed.
      for (const pid of [grandPid, workerPid]) {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("oom-once-then-success: first run rejects with CUDA_OUT_OF_MEMORY", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  const stateFile = path.join(dir, "oom-state.json");
  try {
    await assert.rejects(
      makeRun(dir, {
        mode: "oom-once-then-success",
        extraEnv: { OPENWHISPR_FAKE_WORKER_OOM_STATE_FILE: stateFile },
      }).run(),
      (e) => e instanceof WhisperXProcessError && e.code === "CUDA_OUT_OF_MEMORY"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildWorkerEnv: allowlist only, HF token, extraEnv, PYTHONUNBUFFERED", () => {
  const env = buildWorkerEnv({
    baseEnv: { PATH: "/usr/bin", SECRET_SAUCE: "leak-me", HOME: "/home/tester" },
    extraEnv: { HF_HUB_OFFLINE: "1" },
    hfToken: "hf_unittoken1234567890",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.SECRET_SAUCE, undefined, "non-allowlisted base env must be dropped");
  assert.equal(env.HF_TOKEN, "hf_unittoken1234567890");
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.PYTHONUNBUFFERED, "1");
});

test("killProcessTree on an already-exited child resolves 'already-exited'", { timeout: 10000 }, async () => {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const how = await killProcessTree(child);
  assert.equal(how, "already-exited");
});

test("env isolation: HF token never appears in stderr or event JSON", { timeout: 15000 }, async () => {
  const dir = mkJobDir();
  const token = "hf_secretvalue123456789";
  try {
    const result = await makeRun(dir, { mode: "success", hfToken: token }).run();
    assert.ok(result.completion, "run should still succeed with an HF token");
    assert.ok(!result.stderr.includes(token), "token must not leak into stderr");
    assert.ok(
      !JSON.stringify(result.events).includes(token),
      "token must not leak into any protocol event"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
