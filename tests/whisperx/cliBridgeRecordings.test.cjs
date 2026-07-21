const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// cliBridge → debugLogger requires electron's `app`; stub it so the bridge is
// testable under plain Node (same reason recordingJobsRepo tests shim sqlite).
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => os.tmpdir(),
        getVersion: () => "0.0.0",
        isPackaged: false,
        on() {},
      },
    };
  }
  return originalLoad.call(this, request, ...args);
};

const CliBridge = require("../../src/helpers/cliBridge.js");

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function makeFakeWhisperxMain() {
  const calls = { startJob: [], generateNotes: [] };
  return {
    calls,
    async getReadiness() {
      return { runtimeInstalled: true, blockers: [] };
    },
    async startJob(payload) {
      calls.startJob.push(payload);
      return { job: { id: "job-1", status: "queued", profile: payload.profile || "memo" } };
    },
    getJob(jobId) {
      if (jobId !== "job-1") throw makeError("UNKNOWN_INTERNAL_ERROR", "Job not found");
      return {
        job: { id: "job-1", status: "transcript_complete", profile: "memo" },
        artifacts: [{ relativePath: "transcript.raw.txt" }],
        speakerMappings: [],
      };
    },
    listJobs(opts) {
      return { jobs: [{ id: "job-1", status: "queued", opts }] };
    },
    async cancelJob(jobId) {
      return { id: jobId, status: "cancelled" };
    },
    retryJob(jobId) {
      return { job: { id: jobId, status: "queued" } };
    },
    deleteJob() {
      return { deleted: true };
    },
    readTranscriptPage({ jobId, offset, limit }) {
      return { jobId, offset, limit, segments: [] };
    },
    readArtifactText({ jobId, relativePath }) {
      if (relativePath === "missing.txt") throw makeError("OUTPUT_PATH_REJECTED", "Artifact path rejected");
      return { text: `contents of ${relativePath} for ${jobId}`, bytes: 10 };
    },
    async generateNotes(jobId, options) {
      calls.generateNotes.push({ jobId, options });
      if (jobId === "job-busy") throw makeError("NOTE_MODEL_UNAVAILABLE", 'Notes cannot be generated while the job is "transcribing"');
      return { noteRun: { id: "run-1" } };
    },
    listNoteRuns() {
      return { noteRuns: [{ id: "run-1" }] };
    },
  };
}

async function startBridge(t, { whisperxMain } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-bridge-test-"));
  const bridge = new CliBridge({
    databaseManager: {},
    audioStorageManager: {},
    whisperxMain,
    broadcastToWindows() {},
    _asyncVectorUpsert() {},
    _asyncMirrorWrite() {},
  });
  // Keep the test away from the real ~/.openwhispr/cli-bridge.json.
  bridge.bridgeFilePath = path.join(tmpDir, "cli-bridge.json");
  await bridge.start();
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${bridge.port}`;
  // Each test starts a fresh bridge on the same port; Connection: close keeps
  // undici from reusing a dead pooled socket from the previous test's server.
  const call = (method, pathname, body) =>
    fetch(`${base}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        Connection: "close",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { bridge, base, call };
}

test("recordings routes require the bearer token", async (t) => {
  const { base } = await startBridge(t, { whisperxMain: makeFakeWhisperxMain() });
  const res = await fetch(`${base}/v1/recordings/list`, {
    headers: { Connection: "close" },
  });
  assert.equal(res.status, 401);
});

test("readiness returns the data envelope", async (t) => {
  const { call } = await startBridge(t, { whisperxMain: makeFakeWhisperxMain() });
  const res = await call("GET", "/v1/recordings/readiness");
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.data.runtimeInstalled, true);
});

test("create validates the source path before reaching the engine", async (t) => {
  const fake = makeFakeWhisperxMain();
  const { call } = await startBridge(t, { whisperxMain: fake });

  let res = await call("POST", "/v1/recordings/create", {});
  assert.equal(res.status, 400);

  res = await call("POST", "/v1/recordings/create", { source_path: "relative/a.wav" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /absolute/);

  res = await call("POST", "/v1/recordings/create", {
    source_path: path.join(os.tmpdir(), "evil.exe"),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Unsupported source extension/);

  assert.equal(fake.calls.startJob.length, 0);
});

test("create maps snake_case body onto the startJob payload", async (t) => {
  const fake = makeFakeWhisperxMain();
  const { call } = await startBridge(t, { whisperxMain: fake });
  const sourcePath = path.join(os.tmpdir(), "meeting.m4a");
  const res = await call("POST", "/v1/recordings/create", {
    source_path: sourcePath,
    display_name: "Weekly sync",
    profile: "meeting",
    overrides: { language: "es", diarization: true, minSpeakers: 2, maxSpeakers: 4 },
    custom_dictionary: ["OpenWhispr", "WhisperX"],
    allow_model_download: true,
    note_generation: { provider: "claude-cli", model: "default" },
  });
  assert.equal(res.status, 201);
  const payload = await res.json();
  assert.equal(payload.data.id, "job-1");

  assert.equal(fake.calls.startJob.length, 1);
  const forwarded = fake.calls.startJob[0];
  assert.equal(forwarded.sourcePath, sourcePath);
  assert.equal(forwarded.displayName, "Weekly sync");
  assert.equal(forwarded.profile, "meeting");
  assert.deepEqual(forwarded.overrides, {
    language: "es",
    diarization: true,
    minSpeakers: 2,
    maxSpeakers: 4,
  });
  assert.deepEqual(forwarded.customDictionary, ["OpenWhispr", "WhisperX"]);
  assert.equal(forwarded.allowModelDownload, true);
  assert.deepEqual(forwarded.noteGeneration, { provider: "claude-cli", model: "default" });
});

test("get job returns 404 for unknown jobs via the error mapping", async (t) => {
  const { call } = await startBridge(t, { whisperxMain: makeFakeWhisperxMain() });
  let res = await call("GET", "/v1/recordings/job-1");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.job.id, "job-1");

  res = await call("GET", "/v1/recordings/nope");
  assert.equal(res.status, 404);
});

test("artifact route requires the path parameter and maps rejection to 400", async (t) => {
  const { call } = await startBridge(t, { whisperxMain: makeFakeWhisperxMain() });
  let res = await call("GET", "/v1/recordings/job-1/artifact");
  assert.equal(res.status, 400);

  res = await call("GET", "/v1/recordings/job-1/artifact?path=transcript.srt");
  assert.equal(res.status, 200);
  assert.match((await res.json()).data.text, /transcript\.srt/);

  res = await call("GET", "/v1/recordings/job-1/artifact?path=missing.txt");
  assert.equal(res.status, 400);
});

test("notes conflicts map to 409 and generate forwards llm config", async (t) => {
  const fake = makeFakeWhisperxMain();
  const { call } = await startBridge(t, { whisperxMain: fake });
  let res = await call("POST", "/v1/recordings/job-busy/notes", {});
  assert.equal(res.status, 409);

  res = await call("POST", "/v1/recordings/job-1/notes", {
    provider: "claude-cli",
    strict: true,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(fake.calls.generateNotes.at(-1), {
    jobId: "job-1",
    options: { llm: { provider: "claude-cli" }, strict: true },
  });
});

test("recordings routes report 503 when WhisperX is unavailable", async (t) => {
  const { call } = await startBridge(t, { whisperxMain: undefined });
  const res = await call("GET", "/v1/recordings/list");
  assert.equal(res.status, 503);
});

test("multibyte body split across chunks round-trips byte-exactly", async (t) => {
  const http = require("node:http");
  const fake = makeFakeWhisperxMain();
  const { bridge } = await startBridge(t, { whisperxMain: fake });
  const displayName = "café con acción y ñandú";
  const body = Buffer.from(
    JSON.stringify({
      source_path: path.join(os.tmpdir(), "reunión.m4a"),
      display_name: displayName,
    }),
    "utf8"
  );
  // Split inside the multi-byte "é" (0xC3 0xA9) to force the corruption the
  // old string-concat parser produced.
  const splitAt = body.indexOf(0xc3) + 1;
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        method: "POST",
        path: "/v1/recordings/create",
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          "Content-Type": "application/json",
          "Content-Length": body.length,
          Connection: "close",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.write(body.subarray(0, splitAt));
    setTimeout(() => {
      req.end(body.subarray(splitAt));
    }, 20);
  });
  assert.equal(status, 201);
  assert.equal(fake.calls.startJob[0].displayName, displayName);
});

test("null and array JSON bodies are rejected as validation errors", async (t) => {
  const fake = makeFakeWhisperxMain();
  const { base, bridge } = await startBridge(t, { whisperxMain: fake });
  for (const raw of ["null", "[1,2]"]) {
    const res = await fetch(`${base}/v1/recordings/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        "Content-Type": "application/json",
        Connection: "close",
      },
      body: raw,
    });
    assert.equal(res.status, 400, `body ${raw} should 400`);
  }
  assert.equal(fake.calls.startJob.length, 0);
});

test("notes flags accept only real booleans", async (t) => {
  const fake = makeFakeWhisperxMain();
  const { call } = await startBridge(t, { whisperxMain: fake });
  const res = await call("POST", "/v1/recordings/job-1/notes", {
    provider: "claude-cli",
    strict: "false",
    disable_thinking: "false",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(fake.calls.generateNotes.at(-1), {
    jobId: "job-1",
    options: { llm: { provider: "claude-cli" }, strict: undefined },
  });
});
