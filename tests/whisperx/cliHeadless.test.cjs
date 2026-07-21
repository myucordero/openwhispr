// Tests for the CLI's headless "local mode" (cli/openwhispr-whisperx.mjs):
// spawns the WhisperX sidecar worker directly, no desktop app / bridge file
// required. See CLAUDE.md §22 and the plan this implements.
//
// Integration mechanism: rather than the sidecar's Python
// OPENWHISPR_WORKER_FAKE_BACKENDS pytest mechanism (real `uv`/venv/torch
// required to even reach that switch) or a bespoke stub, these tests drive
// the CLI's real spawn -> JSONL event loop -> retry-ladder -> manifest path
// against the REPO'S EXISTING deterministic Node fake worker fixture
// (tests/fixtures/whisperx-fake-worker.cjs, already used by
// tests/whisperx/fakeWorker.test.cjs) via a new TEST-ONLY env override,
// OPENWHISPR_WORKER_CMD (documented as such in the CLI source). This needs
// neither `uv` nor a provisioned sidecar venv, so no `uv`-presence skip logic
// is required for these tests to run in CI.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const CLI_PATH = path.resolve(__dirname, "../../cli/openwhispr-whisperx.mjs");
const FAKE_WORKER_PATH = path.resolve(__dirname, "../fixtures/whisperx-fake-worker.cjs");
const SIDECAR_DIR = path.resolve(__dirname, "../../tools/whisperx-sidecar");

let cli;

test.before(async () => {
  cli = await import(pathToFileURL(CLI_PATH).href);
});

function baseOptions(overrides = {}) {
  return {
    sourcePath: "/tmp/source.wav",
    displayName: "source.wav",
    profile: "memo",
    language: "auto",
    overrides: {},
    hotwords: [],
    allowModelDownload: false,
    requestId: "req-1",
    jobId: "job-1",
    jobDirectory: "/tmp/job",
    modelCacheDirectory: "/tmp/models",
    temporaryDirectory: "/tmp/tmp",
    ...overrides,
  };
}

const CREDENTIAL_RE = /token|secret|api[-_]?key|password|credential|authorization/i;

function assertNoCredentialKeys(value, prefix = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    assert.ok(!CREDENTIAL_RE.test(key), `credential-shaped key found: ${prefix}${key}`);
    assertNoCredentialKeys(v, `${prefix}${key}.`);
  }
}

// --------------------------------------------------------------- unit tests

test("buildLocalRequest — profile defaults mirror src/helpers/whisperx/profiles.js", () => {
  const { request: memo } = cli.buildLocalRequest(baseOptions({ profile: "memo" }));
  assert.equal(memo.asr.model, "large-v3-turbo");
  assert.equal(memo.asr.computeType, "float16");
  assert.equal(memo.asr.batchSize, 4);
  assert.equal(memo.alignment.enabled, true);
  assert.equal(memo.diarization.enabled, false);
  assert.deepEqual(memo.output.formats, ["canonical-json", "raw-txt", "srt", "vtt"]);

  const { request: meeting } = cli.buildLocalRequest(baseOptions({ profile: "meeting" }));
  assert.equal(meeting.asr.model, "large-v3-turbo");
  assert.equal(meeting.asr.batchSize, 4);
  assert.equal(meeting.diarization.enabled, true);
  assert.deepEqual(meeting.output.formats, [
    "canonical-json",
    "raw-txt",
    "speaker-markdown",
    "srt",
    "vtt",
  ]);

  const { request: interview } = cli.buildLocalRequest(baseOptions({ profile: "critical-interview" }));
  assert.equal(interview.asr.model, "large-v3");
  assert.equal(interview.asr.computeType, "float16");
  assert.equal(interview.asr.batchSize, 2);
  assert.equal(interview.diarization.enabled, true);
});

test("buildLocalRequest — initialPrompt only set when hotwords non-empty", () => {
  const { request: noHotwords } = cli.buildLocalRequest(baseOptions());
  assert.deepEqual(noHotwords.asr.hotwords, []);
  assert.equal(noHotwords.asr.initialPrompt, undefined);
  assert.ok(!("initialPrompt" in noHotwords.asr));

  const { request: withHotwords } = cli.buildLocalRequest(
    baseOptions({ hotwords: ["Qdrant", "WhisperX"] })
  );
  assert.equal(withHotwords.asr.initialPrompt, "Qdrant, WhisperX");
});

test("buildLocalRequest — exactSpeakers vs min/max mutual exclusion", () => {
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ overrides: { exactSpeakers: 2, minSpeakers: 1 } })),
    /cannot be combined/
  );
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ overrides: { minSpeakers: 3, maxSpeakers: 1 } })),
    /must be <=/
  );
  const { request } = cli.buildLocalRequest(
    baseOptions({ overrides: { minSpeakers: 1, maxSpeakers: 3 } })
  );
  assert.equal(request.diarization.minSpeakers, 1);
  assert.equal(request.diarization.maxSpeakers, 3);
  assert.ok(!("exactSpeakers" in request.diarization));
});

test("buildLocalRequest — offline = !allowModelDownload", () => {
  const { request: offline } = cli.buildLocalRequest(baseOptions({ allowModelDownload: false }));
  assert.equal(offline.runtime.offline, true);
  const { request: online } = cli.buildLocalRequest(baseOptions({ allowModelDownload: true }));
  assert.equal(online.runtime.offline, false);
});

test("buildLocalRequest — device/computeType/batchSize overrides", () => {
  const { request } = cli.buildLocalRequest(
    baseOptions({ overrides: { device: "cpu", computeType: "int8", batchSize: 1 } })
  );
  assert.equal(request.asr.device, "cpu");
  assert.equal(request.asr.computeType, "int8");
  assert.equal(request.asr.batchSize, 1);
});

test("buildLocalRequest — rejects unknown enum values", () => {
  assert.throws(() => cli.buildLocalRequest(baseOptions({ overrides: { model: "nope" } })), /Unknown model/);
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ overrides: { computeType: "nope" } })),
    /compute-type/
  );
  assert.throws(() => cli.buildLocalRequest(baseOptions({ overrides: { batchSize: 3 } })), /batch-size/);
  assert.throws(() => cli.buildLocalRequest(baseOptions({ overrides: { device: "tpu" } })), /--device/);
  assert.throws(() => cli.buildLocalRequest(baseOptions({ profile: "nope" })), /Unknown profile/);
  assert.throws(() => cli.buildLocalRequest(baseOptions({ language: "fr" })), /Unknown language/);
});

test("buildLocalRequest — no credential-shaped keys anywhere in the built request", () => {
  const { request } = cli.buildLocalRequest(
    baseOptions({ profile: "meeting", hotwords: ["foo"], overrides: { exactSpeakers: 2 } })
  );
  assertNoCredentialKeys(request);
});

// ------------------------------------------------------------ integration

function writeTinyWav(filePath) {
  const sampleRate = 16000;
  const numSamples = sampleRate; // ~1s of silence
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, buffer);
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-home-"));
}

test("integration: transcribe --local via the fake worker fixture", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-"));
  const wavPath = path.join(tmpDir, "source.wav");
  writeTinyWav(wavPath);
  const homeDir = mkTempHome();

  try {
    const result = await runCli(["transcribe", wavPath, "--local", "--profile", "memo", "--text"], {
      HOME: homeDir,
      OPENWHISPR_SIDECAR_DIR: SIDECAR_DIR,
      OPENWHISPR_WORKER_CMD: `${process.execPath} ${FAKE_WORKER_PATH}`,
      OPENWHISPR_FAKE_WORKER_MODE: "success",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.trim().length > 0);

    const jobsRoot = path.join(homeDir, ".cache", "openwhispr", "headless-jobs");
    const jobDirs = fs.readdirSync(jobsRoot);
    assert.equal(jobDirs.length, 1);
    const jobDir = path.join(jobsRoot, jobDirs[0]);
    assert.ok(fs.existsSync(path.join(jobDir, "manifest.json")));
    assert.ok(fs.existsSync(path.join(jobDir, "transcript.raw.txt")));

    const manifest = JSON.parse(fs.readFileSync(path.join(jobDir, "manifest.json"), "utf8"));
    assert.equal(manifest.jobId, jobDirs[0]);
    assert.equal(manifest.settings.length, 1);
    assert.equal(manifest.settings[0].exitCode, 0);
    assert.ok(manifest.result);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("integration: --local retries on CUDA OOM (exit 3) then succeeds, records attempts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-oom-"));
  const wavPath = path.join(tmpDir, "source.wav");
  writeTinyWav(wavPath);
  const homeDir = mkTempHome();
  const oomStateFile = path.join(tmpDir, "oom-state");

  try {
    const result = await runCli(["transcribe", wavPath, "--local", "--profile", "memo"], {
      HOME: homeDir,
      OPENWHISPR_SIDECAR_DIR: SIDECAR_DIR,
      OPENWHISPR_WORKER_CMD: `${process.execPath} ${FAKE_WORKER_PATH}`,
      OPENWHISPR_FAKE_WORKER_MODE: "oom-once-then-success",
      OPENWHISPR_FAKE_WORKER_OOM_STATE_FILE: oomStateFile,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /CUDA out of memory/);

    const jobsRoot = path.join(homeDir, ".cache", "openwhispr", "headless-jobs");
    const jobDir = path.join(jobsRoot, fs.readdirSync(jobsRoot)[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(jobDir, "manifest.json"), "utf8"));
    assert.equal(manifest.settings.length, 2);
    assert.equal(manifest.settings[0].exitCode, 3);
    assert.equal(manifest.settings[0].asr.computeType, "float16");
    assert.equal(manifest.settings[1].exitCode, 0);
    assert.equal(manifest.settings[1].asr.computeType, "int8");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("integration: --local fails clearly when the sidecar dir is missing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-nosidecar-"));
  const wavPath = path.join(tmpDir, "source.wav");
  writeTinyWav(wavPath);

  try {
    const result = await runCli(["transcribe", wavPath, "--local"], {
      OPENWHISPR_SIDECAR_DIR: path.join(tmpDir, "does-not-exist-sidecar"),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /sidecar not found/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI help still works after the local-mode changes", async () => {
  const result = await runCli(["help"], {});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--local/);
});

// ------------------------------------------------------- fix-review coverage

test("buildLocalWorkerEnv — allowlist excludes an arbitrary parent env canary", () => {
  process.env.SECRET_CANARY = "1";
  try {
    const env = cli.buildLocalWorkerEnv(SIDECAR_DIR, path.dirname(CLI_PATH));
    assert.ok(!("SECRET_CANARY" in env), "canary env var leaked into the worker env allowlist");
  } finally {
    delete process.env.SECRET_CANARY;
  }
});

test("buildLocalRequest — hotword/speaker limits mirror schemas.py", () => {
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ overrides: { exactSpeakers: 33 } })),
    /--speakers must be an integer between 1 and 32/
  );
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ hotwords: Array.from({ length: 65 }, (_, i) => `w${i}`) })),
    /at most 64 words/
  );
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ hotwords: ["x".repeat(65)] })),
    /exceeds 64 characters/
  );
  assert.throws(
    () => cli.buildLocalRequest(baseOptions({ hotwords: ["bad\x01word"] })),
    /control characters/
  );
  // initialPrompt is truncated, not rejected, when the joined hotwords exceed 2048 chars.
  const longWords = Array.from({ length: 64 }, () => "x".repeat(64));
  const { request } = cli.buildLocalRequest(baseOptions({ hotwords: longWords }));
  assert.equal(request.asr.initialPrompt.length, 2048);
});

// A minimal Node stub worker (NOT the fixture, which has no modes for these
// failure paths). Consumes stdin fully first — like the real fake-worker
// fixture and the real Python worker — so the parent's stdin write/end never
// races an early exit. Mode selected via STUB_MODE, forwarded through the
// same OPENWHISPR_WORKER_CMD full-env-passthrough test-only mechanism.
const STUB_WORKER_SOURCE = `
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
  });
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
(async () => {
  await readStdin();
  const mode = process.env.STUB_MODE || "no-complete";
  emit({ type: "ready", protocolVersion: 1, workerVersion: "stub", whisperxVersion: "stub", pythonVersion: "stub" });
  if (mode === "no-complete") {
    emit({ type: "stage", stage: "transcribing", timestamp: new Date().toISOString() });
    process.exit(0);
  } else if (mode === "always-oom") {
    emit({ type: "stage", stage: "loading-asr", timestamp: new Date().toISOString() });
    emit({ type: "error", error: { code: "CUDA_OUT_OF_MEMORY", message: "CUDA out of memory (stub)" } });
    process.exit(3);
  } else if (mode === "leak-token") {
    process.stderr.write("auth token in use: hf_STUBSECRETTOKEN123456\\n");
    process.exit(1);
  } else {
    process.exit(1);
  }
})();
`;

function writeStubWorker(dir) {
  const stubPath = path.join(dir, "stub-worker.cjs");
  fs.writeFileSync(stubPath, STUB_WORKER_SOURCE);
  return stubPath;
}

test("integration: invocation via a symlink to the CLI still runs main()", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-symlink-"));
  const linkPath = path.join(tmpDir, "openwhispr-whisperx");
  try {
    fs.symlinkSync(CLI_PATH, linkPath);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [linkPath, "help"], { env: process.env });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("integration: worker exits 0 with no complete event -> CLI exit 1", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-nocomplete-"));
  const wavPath = path.join(tmpDir, "source.wav");
  writeTinyWav(wavPath);
  const stubPath = writeStubWorker(tmpDir);
  const homeDir = mkTempHome();

  try {
    const result = await runCli(["transcribe", wavPath, "--local"], {
      HOME: homeDir,
      OPENWHISPR_SIDECAR_DIR: SIDECAR_DIR,
      OPENWHISPR_WORKER_CMD: `${process.execPath} ${stubPath}`,
      STUB_MODE: "no-complete",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /worker exited without a complete event/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("integration: OOM on every attempt exhausts retries, exit 1, manifest records all attempts + error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-oomexhaust-"));
  const wavPath = path.join(tmpDir, "source.wav");
  writeTinyWav(wavPath);
  const stubPath = writeStubWorker(tmpDir);
  const homeDir = mkTempHome();

  try {
    const result = await runCli(["transcribe", wavPath, "--local", "--profile", "memo"], {
      HOME: homeDir,
      OPENWHISPR_SIDECAR_DIR: SIDECAR_DIR,
      OPENWHISPR_WORKER_CMD: `${process.execPath} ${stubPath}`,
      STUB_MODE: "always-oom",
    });
    assert.equal(result.code, 1);

    const jobsRoot = path.join(homeDir, ".cache", "openwhispr", "headless-jobs");
    const jobDir = path.join(jobsRoot, fs.readdirSync(jobsRoot)[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(jobDir, "manifest.json"), "utf8"));
    assert.equal(manifest.settings.length, 3); // initial attempt + 2 retries
    assert.ok(manifest.settings.every((a) => a.exitCode === 3));
    assert.equal(manifest.error.code, "CUDA_OUT_OF_MEMORY");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("integration: leaked hf_ token in worker stderr is redacted from CLI failure output", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-headless-redact-"));
  const wavPath = path.join(tmpDir, "source.wav");
  writeTinyWav(wavPath);
  const stubPath = writeStubWorker(tmpDir);
  const homeDir = mkTempHome();

  try {
    const result = await runCli(["transcribe", wavPath, "--local"], {
      HOME: homeDir,
      OPENWHISPR_SIDECAR_DIR: SIDECAR_DIR,
      OPENWHISPR_WORKER_CMD: `${process.execPath} ${stubPath}`,
      STUB_MODE: "leak-token",
    });
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes("hf_STUBSECRETTOKEN123456"), "raw HF token leaked into CLI stderr");
    assert.match(result.stderr, /\[redacted\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
