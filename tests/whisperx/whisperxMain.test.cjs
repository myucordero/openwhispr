const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WhisperXMain = require("../../src/helpers/whisperx/whisperxMain.js");
const { resolveModelCacheRoots } = require("../../src/helpers/whisperx/whisperxMain.js");
const {
  applyRecordingJobsSchema,
  createRecordingJobsRepo,
} = require("../../src/helpers/whisperx/recordingJobsRepo.js");

// Same node:sqlite fallback used by recordingJobsRepo.test.cjs: node_modules
// is typically rebuilt for Electron's ABI, so better-sqlite3 cannot load under
// plain Node. node:sqlite is real SQLite with a thin better-sqlite3 shim.
function openMemoryDb() {
  try {
    const Database = require("better-sqlite3");
    return new Database(":memory:");
  } catch {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    return {
      exec: (sql) => raw.exec(sql),
      pragma: (directive) => raw.exec(`PRAGMA ${directive}`),
      prepare: (sql) => raw.prepare(sql),
      transaction(fn) {
        return (...args) => {
          raw.exec("BEGIN");
          try {
            const result = fn(...args);
            raw.exec("COMMIT");
            return result;
          } catch (error) {
            raw.exec("ROLLBACK");
            throw error;
          }
        };
      },
    };
  }
}

function makeRepo() {
  const db = openMemoryDb();
  applyRecordingJobsSchema(db);
  return createRecordingJobsRepo(db);
}

function seedJob(repo, id = "job-1") {
  repo.createJob({
    id,
    status: "transcript_complete",
    sourceType: "external",
    sourceDisplayName: "meeting.wav",
    sourcePath: "/tmp/meeting.wav",
    sourceSha256: "sha-src",
    profile: "meeting",
    settingsJson: "{}",
    protocolVersion: 1,
    artifactDirectory: `/jobs/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return id;
}

// Fake runtime manager with call counters; installed toggle drives readiness.
class FakeRuntime {
  constructor({ installed = false } = {}) {
    this.installed = installed;
    this.statusCalls = 0;
    this.cudaCalls = 0;
  }
  async getStatus() {
    this.statusCalls += 1;
    return {
      installed: this.installed,
      pythonVersion: this.installed ? "Python 3.12.0" : null,
      lockHash: this.installed ? "lock-hash" : null,
      sidecarVersion: this.installed ? "1.0.0" : null,
      uvAvailable: this.installed,
      blockers: this.installed ? [] : [{ code: "RUNTIME_NOT_INSTALLED", message: "not installed" }],
    };
  }
  async checkCuda() {
    this.cudaCalls += 1;
    return { cuda: false, device: null, vramGb: null };
  }
}

function makeMain(opts = {}) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wxmain-"));
  const app = { getPath: () => tmpdir, isPackaged: false };
  const environmentManager = { getHuggingFaceToken: () => opts.token ?? "" };
  const databaseManager = { recordingJobs: opts.repo || null };
  const main = new WhisperXMain({
    app,
    databaseManager,
    environmentManager,
    getWindows: () => [],
    now: () => "2026-01-01T00:00:00.000Z",
    uuid: () => "uuid-fixed",
    runtimeManager: opts.runtimeManager,
    artifactStore: opts.artifactStore,
    coordinator: opts.coordinator,
    jobManager: opts.jobManager,
    env: opts.env,
    homeDir: opts.homeDir,
  });
  return { main, tmpdir };
}

const READINESS_KEYS = [
  "runtimeInstalled",
  "runtimeVersion",
  "pythonVersion",
  "cudaAvailable",
  "gpuName",
  "vramTotalMb",
  "vramFreeMb",
  "asrModelReady",
  "alignmentModelReady",
  "diarizationTokenConfigured",
  "diarizationModelReady",
  "offlineReady",
  "ffmpegAvailable",
  "storageWritable",
  "freeDiskBytes",
  "blockers",
];

test("getReadiness returns the full WhisperXReadiness shape when runtime is missing", async () => {
  const runtime = new FakeRuntime({ installed: false });
  const { main } = makeMain({ runtimeManager: runtime, token: "" });
  const readiness = await main.getReadiness();

  for (const key of READINESS_KEYS) {
    assert.ok(key in readiness, `missing readiness field: ${key}`);
  }
  assert.equal(readiness.runtimeInstalled, false);
  assert.equal(readiness.offlineReady, false);
  assert.equal(readiness.diarizationTokenConfigured, false);
  assert.equal(readiness.storageWritable, true);
  assert.ok(readiness.freeDiskBytes === null || typeof readiness.freeDiskBytes === "number");
  assert.ok(readiness.blockers.some((b) => b.code === "RUNTIME_NOT_INSTALLED"));
  // CUDA is only probed when the runtime is installed.
  assert.equal(runtime.cudaCalls, 0);
  assert.equal(readiness.cudaAvailable, false);
  assert.equal(readiness.gpuName, null);
});

test("getReadiness flips diarizationTokenConfigured when an HF token is set", async () => {
  const { main } = makeMain({ runtimeManager: new FakeRuntime(), token: "hf_examplevalue123456" });
  const readiness = await main.getReadiness();
  assert.equal(readiness.diarizationTokenConfigured, true);
});

test("getReadiness caches results for 5s (getStatus called once)", async () => {
  const runtime = new FakeRuntime({ installed: false });
  const { main } = makeMain({ runtimeManager: runtime });
  await main.getReadiness();
  await main.getReadiness();
  assert.equal(runtime.statusCalls, 1);
});

// ----------------------------------------------------- resolveModelCacheRoots

test("resolveModelCacheRoots falls back to the HF/torch default caches under homeDir", () => {
  const roots = resolveModelCacheRoots({
    modelCacheDirectory: "/managed/whisperx-models",
    env: {},
    homeDir: "/home/fake",
  });
  assert.deepEqual(roots, [
    "/managed/whisperx-models",
    path.join("/home/fake", ".cache", "huggingface", "hub"),
    path.join("/home/fake", ".cache", "torch", "hub", "checkpoints"),
  ]);
});

test("resolveModelCacheRoots prefers HUGGINGFACE_HUB_CACHE over HF_HOME and the default", () => {
  const roots = resolveModelCacheRoots({
    modelCacheDirectory: "/managed/whisperx-models",
    env: { HUGGINGFACE_HUB_CACHE: "/custom/hub-cache", HF_HOME: "/custom/hf-home" },
    homeDir: "/home/fake",
  });
  assert.equal(roots[1], "/custom/hub-cache");
});

test("resolveModelCacheRoots derives the hub cache from HF_HOME when HUGGINGFACE_HUB_CACHE is unset", () => {
  const roots = resolveModelCacheRoots({
    modelCacheDirectory: "/managed/whisperx-models",
    env: { HF_HOME: "/custom/hf-home" },
    homeDir: "/home/fake",
  });
  assert.equal(roots[1], path.join("/custom/hf-home", "hub"));
});

test("resolveModelCacheRoots de-duplicates roots that coincide", () => {
  const roots = resolveModelCacheRoots({
    modelCacheDirectory: "/home/fake/.cache/huggingface/hub",
    env: {},
    homeDir: "/home/fake",
  });
  assert.deepEqual(roots, [
    "/home/fake/.cache/huggingface/hub",
    path.join("/home/fake", ".cache", "torch", "hub", "checkpoints"),
  ]);
});

// --------------------------------------------- multi-root model cache scan

test("asrModelReady is true when the model only exists in the fake HF hub cache", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxmain-home-"));
  const hubDir = path.join(homeDir, ".cache", "huggingface", "hub");
  const modelDir = path.join(hubDir, "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo");
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "snapshot.bin"), "data");

  const { main } = makeMain({ runtimeManager: new FakeRuntime(), env: {}, homeDir });
  const readiness = await main.getReadiness();

  assert.equal(readiness.asrModelReady, true);
  assert.ok(!readiness.blockers.some((b) => b.code === "MODEL_NOT_AVAILABLE_OFFLINE"));
});

test("alignmentModelReady is true when only a non-empty torch checkpoint file exists", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxmain-home-"));
  const checkpointsDir = path.join(homeDir, ".cache", "torch", "hub", "checkpoints");
  fs.mkdirSync(checkpointsDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointsDir, "wav2vec2_voxpopuli_base_10k_asr_es.pt"), "weights");

  const { main } = makeMain({ runtimeManager: new FakeRuntime(), env: {}, homeDir });
  const readiness = await main.getReadiness();

  assert.equal(readiness.alignmentModelReady, true);
});

test("alignmentModelReady is false when the torch checkpoint file is empty", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxmain-home-"));
  const checkpointsDir = path.join(homeDir, ".cache", "torch", "hub", "checkpoints");
  fs.mkdirSync(checkpointsDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointsDir, "wav2vec2_voxpopuli_base_10k_asr_es.pt"), "");

  const { main } = makeMain({ runtimeManager: new FakeRuntime(), env: {}, homeDir });
  const readiness = await main.getReadiness();

  assert.equal(readiness.alignmentModelReady, false);
});

test("all model-ready flags are false and MODEL_NOT_AVAILABLE_OFFLINE blocks when every cache root is empty", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxmain-home-"));
  const { main } = makeMain({ runtimeManager: new FakeRuntime(), env: {}, homeDir });
  const readiness = await main.getReadiness();

  assert.equal(readiness.asrModelReady, false);
  assert.equal(readiness.alignmentModelReady, false);
  assert.equal(readiness.diarizationModelReady, false);
  assert.equal(readiness.offlineReady, false);
  assert.ok(readiness.blockers.some((b) => b.code === "MODEL_NOT_AVAILABLE_OFFLINE"));
});

test("startJob validates the renderer payload", async () => {
  const created = [];
  const jobManager = {
    createJob: async (opts) => {
      created.push(opts);
      return { id: "job-x" };
    },
    queueSnapshot: () => ({ running: null, queued: [] }),
  };
  const { main } = makeMain({ jobManager, runtimeManager: new FakeRuntime() });

  await assert.rejects(() => main.startJob({}), /sourcePath/);
  await assert.rejects(
    () => main.startJob({ sourcePath: "/a.wav", customDictionary: "nope" }),
    /customDictionary/
  );
  await assert.rejects(
    () => main.startJob({ sourcePath: "/a.wav", overrides: { bogusKey: 1 } }),
    /Unknown override key/
  );
  await assert.rejects(
    () => main.startJob({ sourcePath: "/a.wav", customDictionary: new Array(129).fill("w") }),
    /128/
  );

  // A valid payload reaches createJob with allowModelDownload defaulting false.
  const result = await main.startJob({ sourcePath: "/a.wav", profile: "memo" });
  assert.equal(result.job.id, "job-x");
  assert.equal(created.length, 1);
  assert.equal(created[0].allowModelDownload, false);
});

test("readTranscriptPage bounds the limit to 500 and returns provenance", () => {
  const repo = makeRepo();
  const jobId = seedJob(repo);
  const segments = Array.from({ length: 600 }, (_, i) => ({ id: `s${i}`, sequence: i }));
  const transcript = {
    schemaVersion: 1,
    segments,
    speakers: [{ id: "SPEAKER_00" }],
    warnings: [{ code: "OOM_FALLBACK_USED", message: "x" }],
    provenance: { model: "large-v3", languageDetected: "en", createdAt: "2026-01-01" },
  };
  repo.replaceArtifacts(jobId, [
    {
      jobId,
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-transcript",
      bytes: 10,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const artifactStore = {
    readArtifact: () => Buffer.from(JSON.stringify(transcript), "utf8"),
  };
  const { main } = makeMain({ repo, artifactStore, runtimeManager: new FakeRuntime() });

  const page = main.readTranscriptPage({ jobId, offset: 0, limit: 9999 });
  assert.equal(page.segments.length, 500);
  assert.equal(page.total, 600);
  assert.deepEqual(page.speakers, [{ id: "SPEAKER_00" }]);
  assert.deepEqual(page.provenance, {
    model: "large-v3",
    languageDetected: "en",
    createdAt: "2026-01-01",
  });

  const small = main.readTranscriptPage({ jobId, offset: 10, limit: 5 });
  assert.equal(small.segments.length, 5);
  assert.equal(small.segments[0].id, "s10");
});

test("getStorageUsage merges DB tallies with on-disk usage", () => {
  const repo = makeRepo();
  const jobId = seedJob(repo);
  repo.replaceArtifacts(jobId, [
    {
      jobId,
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-a",
      bytes: 100,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const artifactStore = { jobDiskUsage: () => 12345 };
  const { main } = makeMain({ repo, artifactStore, runtimeManager: new FakeRuntime() });

  const usage = main.getStorageUsage();
  assert.equal(usage.jobs.length, 1);
  assert.equal(usage.jobs[0].jobId, jobId);
  // On-disk measurement wins over the DB byte tally.
  assert.equal(usage.jobs[0].bytes, 12345);
  assert.equal(usage.total, 12345);
});

test("shutdown cancels the running job and disposes the coordinator", async () => {
  let cancelledId = null;
  let disposed = false;
  const jobManager = {
    queueSnapshot: () => ({ running: "job-running", queued: [] }),
    cancelJob: async (id) => {
      cancelledId = id;
      return { cancelled: true, status: "cancelling" };
    },
  };
  const coordinator = {
    dispose: () => {
      disposed = true;
    },
  };
  const { main } = makeMain({ jobManager, coordinator, runtimeManager: new FakeRuntime() });

  await main.shutdown();
  assert.equal(cancelledId, "job-running");
  assert.equal(disposed, true);
});
