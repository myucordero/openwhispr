// End-to-end tests for the recording job manager
// (src/helpers/whisperx/recordingJobManager.js).
//
// Each test wires the manager to real collaborators: an in-memory SQLite repo,
// a RecordingArtifactStore on a throwaway jobs root, a real GpuInference
// coordinator, and REAL spawns of the deterministic fake worker
// (tests/fixtures/whisperx-fake-worker.cjs). The worker mode is fed through
// resolveRuntime().extraEnv because the worker process manager spawns with an
// env allowlist (plain process.env would NOT reach the worker).
//
// node:test runs tests serially within a file, so the sequential FIFO queue
// behaviour is observed without cross-test interference. Each test builds its
// own manager/db/store/temp dirs and disposes them in a finally.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  applyRecordingJobsSchema,
  createRecordingJobsRepo,
} = require("../../src/helpers/whisperx/recordingJobsRepo.js");
const {
  RecordingArtifactStore,
} = require("../../src/helpers/whisperx/recordingArtifactStore.js");
const {
  GpuInferenceCoordinator,
} = require("../../src/helpers/whisperx/gpuInferenceCoordinator.js");
const {
  RecordingJobManager,
  RecordingJobError,
} = require("../../src/helpers/whisperx/recordingJobManager.js");
const { resolveJobSettings, ProfileValidationError } = require("../../src/helpers/whisperx/profiles.js");
const { WHISPERX_PROTOCOL_VERSION } = require("../../src/helpers/whisperx/constants.js");

const FAKE_WORKER_PATH = path.resolve(__dirname, "../fixtures/whisperx-fake-worker.cjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// better-sqlite3 is normally rebuilt for Electron's ABI, which plain Node
// cannot load; fall back to the built-in node:sqlite through a thin adapter
// (mirrors tests/whisperx/recordingJobsRepo.test.cjs).
function openMemoryDb() {
  try {
    const Database = require("better-sqlite3");
    return new Database(":memory:");
  } catch (loadError) {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    console.warn(
      `recordingJobManager.test: better-sqlite3 unavailable (${loadError.code || loadError.message}); using node:sqlite adapter`
    );
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

// Assembles a fully-wired manager plus its collaborators and a cleanup hook.
function makeSetup({ mode = "success", getFreeDiskBytes = null } = {}) {
  const jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rjm-jobs-"));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjm-ext-"));
  const modelCacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rjm-cache-"));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rjm-tmp-"));
  const oomDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjm-oom-"));
  const stateFile = path.join(oomDir, "state.json"); // fresh: does not exist yet

  const sourcePath = path.join(externalDir, "source.wav");
  fs.writeFileSync(sourcePath, crypto.randomBytes(1024)); // ~1KB real bytes

  const db = openMemoryDb();
  applyRecordingJobsSchema(db);
  const repo = createRecordingJobsRepo(db);
  const store = new RecordingArtifactStore(jobsRoot);
  const coordinator = new GpuInferenceCoordinator();
  const events = [];
  let currentMode = mode;
  let counter = 0;

  const resolveRuntime = async () => ({
    command: process.execPath,
    args: [FAKE_WORKER_PATH],
    cwd: REPO_ROOT,
    extraEnv: {
      OPENWHISPR_FAKE_WORKER_MODE: currentMode,
      OPENWHISPR_FAKE_WORKER_OOM_STATE_FILE: stateFile,
    },
  });

  const manager = new RecordingJobManager({
    repo,
    artifactStore: store,
    coordinator,
    resolveRuntime,
    modelCacheDirectory,
    temporaryDirectory,
    offline: true,
    emitEvent: (jobId, evt) => events.push(evt),
    now: () => new Date().toISOString(),
    uuid: () => `id-${++counter}`,
    getFreeDiskBytes,
  });

  return {
    manager,
    repo,
    store,
    coordinator,
    events,
    sourcePath,
    externalDir,
    jobsRoot,
    stateFile,
    setMode: (m) => {
      currentMode = m;
    },
    statusesFor: (jobId) => events.filter((e) => e.jobId === jobId).map((e) => e.status),
    cleanup: () => {
      coordinator.dispose();
      for (const d of [jobsRoot, externalDir, modelCacheDirectory, temporaryDirectory, oomDir]) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    },
  };
}

async function pollJob(repo, jobId, statuses, timeoutMs = 15000) {
  const wanted = Array.isArray(statuses) ? statuses : [statuses];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = repo.getJob(jobId);
    if (job && wanted.includes(job.status)) return job;
    await sleep(40);
  }
  const last = repo.getJob(jobId);
  throw new Error(
    `job ${jobId} did not reach [${wanted}] within ${timeoutMs}ms (last status: ${last && last.status})`
  );
}

// Confirms `expected` appears as an order-preserving subsequence of `actual`.
function assertSubsequence(actual, expected) {
  let i = 0;
  for (const value of actual) {
    if (value === expected[i]) i += 1;
    if (i === expected.length) break;
  }
  assert.equal(
    i,
    expected.length,
    `expected subsequence ${JSON.stringify(expected)} within ${JSON.stringify(actual)}`
  );
}

async function waitForWorkerPid(manager, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = manager._running && manager._running.run && manager._running.run.child
      ? manager._running.run.child.pid
      : null;
    if (pid) return pid;
    await sleep(20);
  }
  throw new Error("worker pid never became available");
}

test("success: memo job runs end-to-end to transcript_complete", { timeout: 20000 }, async () => {
  const s = makeSetup({ mode: "success" });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const jobId = created.id;
    await pollJob(s.repo, jobId, "transcript_complete");

    // Progress events, order-preserving.
    assertSubsequence(s.statusesFor(jobId), [
      "queued",
      "validating",
      "preparing",
      "transcribing",
      "transcript_complete",
    ]);

    // Finalized artifacts on disk.
    assert.equal(s.store.hasFinalizedJob(jobId), true);
    const finalDir = s.store.finalDir(jobId);
    assert.equal(fs.existsSync(path.join(finalDir, "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(finalDir, "transcript.raw.json")), true);

    // Artifact rows persisted.
    assert.equal(s.repo.listArtifacts(jobId).length, 5);

    // Source integrity recorded against the real file.
    const job = s.repo.getJob(jobId);
    assert.equal(job.sourceSha256, sha256File(s.sourcePath));

    // actualConfiguration persisted and parseable.
    const actualConfig = JSON.parse(job.actualConfigurationJson);
    assert.equal(actualConfig.model, "large-v3-turbo");
    assert.deepEqual(actualConfig.fallbackAttempts, []);

    // The external source file is never consumed.
    assert.equal(fs.existsSync(s.sourcePath), true);
  } finally {
    s.cleanup();
  }
});

test("sequential queue: the second job stays queued until the first finishes", { timeout: 30000 }, async () => {
  const s = makeSetup({ mode: "success" });
  try {
    const job1 = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const job2 = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });

    await pollJob(s.repo, job1.id, "transcript_complete");
    await pollJob(s.repo, job2.id, "transcript_complete");

    // job2 must not begin validating before job1 has completed.
    const firstComplete = s.events.findIndex(
      (e) => e.jobId === job1.id && e.status === "transcript_complete"
    );
    const job2Validating = s.events.findIndex(
      (e) => e.jobId === job2.id && e.status === "validating"
    );
    assert.ok(firstComplete >= 0 && job2Validating >= 0);
    assert.ok(
      job2Validating > firstComplete,
      "job2 must not start validating until job1 reaches transcript_complete"
    );
  } finally {
    s.cleanup();
  }
});

test("OOM ladder: one CUDA_OUT_OF_MEMORY fallback then success", { timeout: 25000 }, async () => {
  const s = makeSetup({ mode: "oom-once-then-success" });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const jobId = created.id;
    const job = await pollJob(s.repo, jobId, "transcript_complete", 20000);

    const actualConfig = JSON.parse(job.actualConfigurationJson);
    assert.equal(actualConfig.fallbackAttempts.length, 1);
    assert.equal(actualConfig.fallbackAttempts[0].reason, "CUDA_OUT_OF_MEMORY");
    // memo ladder starts at float16/batch4 -> falls back to float16/batch2.
    assert.equal(actualConfig.fallbackAttempts[0].batchSize, 4);
    assert.equal(actualConfig.fallbackAttempts[0].computeType, "float16");

    const warnings = s.events.filter(
      (e) => e.jobId === jobId && e.warning && e.warning.code === "OOM_FALLBACK_USED"
    );
    assert.equal(warnings.length, 1);
  } finally {
    s.cleanup();
  }
});

test("crash: job fails WORKER_CRASHED, staging cleaned, and is retryable", { timeout: 25000 }, async () => {
  const s = makeSetup({ mode: "crash" });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const jobId = created.id;
    const failed = await pollJob(s.repo, jobId, "failed");
    assert.equal(failed.errorCode, "WORKER_CRASHED");
    assert.equal(fs.existsSync(s.store.stagingDir(jobId)), false); // staging cleaned

    s.setMode("success");
    s.manager.retryJob(jobId);
    const done = await pollJob(s.repo, jobId, "transcript_complete");
    assert.equal(done.status, "transcript_complete");
    assert.equal(done.errorCode, null);
  } finally {
    s.cleanup();
  }
});

test("artifact hash mismatch: finalize verification fails the job", { timeout: 20000 }, async () => {
  const s = makeSetup({ mode: "artifact-hash-mismatch" });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const jobId = created.id;
    const failed = await pollJob(s.repo, jobId, "failed");

    // Correct behaviour: the ArtifactStore's ARTIFACT_HASH_MISMATCH code must
    // survive into the persisted job error.
    assert.equal(failed.errorCode, "ARTIFACT_HASH_MISMATCH");
    assert.equal(s.store.hasFinalizedJob(jobId), false); // nothing finalized
  } finally {
    s.cleanup();
  }
});

test("invalid transcript: job fails TRANSCRIPT_SCHEMA_INVALID", { timeout: 20000 }, async () => {
  const s = makeSetup({ mode: "invalid-transcript" });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const failed = await pollJob(s.repo, created.id, "failed");
    assert.equal(failed.errorCode, "TRANSCRIPT_SCHEMA_INVALID");
    assert.equal(s.store.hasFinalizedJob(created.id), false);
  } finally {
    s.cleanup();
  }
});

test("cancel: queued job cancels without starting; running job is cancelled and retryable", { timeout: 30000 }, async () => {
  const s = makeSetup({ mode: "slow-success" });
  try {
    const job1 = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const job2 = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });

    // Wait until job1 is actually running with a live worker.
    const workerPid = await waitForWorkerPid(s.manager);

    // Cancel the still-queued job2: it must go straight to cancelled.
    const r2 = await s.manager.cancelJob(job2.id);
    assert.equal(r2.status, "cancelled");
    assert.equal(s.repo.getJob(job2.id).status, "cancelled");
    assert.ok(
      !s.statusesFor(job2.id).includes("validating"),
      "cancelled queued job must never start validating"
    );

    // Cancel the running job1.
    await s.manager.cancelJob(job1.id);
    const cancelled1 = await pollJob(s.repo, job1.id, "cancelled");
    assert.equal(cancelled1.status, "cancelled");

    // Worker process dies, staging is cleaned, external source intact.
    const deadline = Date.now() + 8000;
    while (pidAlive(workerPid) && Date.now() < deadline) await sleep(100);
    assert.equal(pidAlive(workerPid), false, "worker must be dead after cancel");
    assert.equal(fs.existsSync(s.store.stagingDir(job1.id)), false);
    assert.equal(fs.existsSync(s.sourcePath), true);

    // A cancelled job is retryable.
    s.setMode("success");
    s.manager.retryJob(job1.id);
    const done = await pollJob(s.repo, job1.id, "transcript_complete");
    assert.equal(done.status, "transcript_complete");
  } finally {
    s.cleanup();
  }
});

test("deleteJob: removes final dir + rows (CASCADE); refuses a running job", { timeout: 30000 }, async () => {
  const s = makeSetup({ mode: "success" });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const jobId = created.id;
    await pollJob(s.repo, jobId, "transcript_complete");
    assert.equal(s.repo.listArtifacts(jobId).length, 5);

    const result = s.manager.deleteJob(jobId);
    assert.equal(result.deleted, true);
    assert.equal(s.repo.getJob(jobId), null);
    assert.deepEqual(s.repo.listArtifacts(jobId), []); // CASCADE
    assert.equal(s.store.hasFinalizedJob(jobId), false);
    assert.equal(fs.existsSync(s.sourcePath), true); // external source untouched

    // deleteJob on a running job throws.
    s.setMode("slow-success");
    const running = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    await waitForWorkerPid(s.manager);
    assert.throws(
      () => s.manager.deleteJob(running.id),
      (e) => e instanceof RecordingJobError && /before deleting/.test(e.message)
    );

    // Clean up the running job so no worker leaks past the test.
    await s.manager.cancelJob(running.id);
    await pollJob(s.repo, running.id, "cancelled");
  } finally {
    s.cleanup();
  }
});

test("startup recovery: an active job becomes interrupted, staging is cleared, retry works", { timeout: 25000 }, async () => {
  const s = makeSetup({ mode: "success" });
  try {
    const jobId = "recover-1";
    const settings = resolveJobSettings("memo", {}, []);
    s.repo.createJob({
      id: jobId,
      status: "transcribing", // an active state left over from a crash
      sourceType: "external",
      sourceDisplayName: "source.wav",
      sourcePath: s.sourcePath,
      sourceSha256: null,
      profile: settings.profile,
      settingsJson: JSON.stringify(settings),
      protocolVersion: WHISPERX_PROTOCOL_VERSION,
      artifactDirectory: s.store.finalDir(jobId),
      createdAt: new Date().toISOString(),
    });
    const staging = s.store.createStagingDir(jobId); // stale staging dir
    assert.equal(fs.existsSync(staging), true);

    const summary = s.manager.recoverOnStartup();
    assert.ok(summary.interrupted >= 1);

    const recovered = s.repo.getJob(jobId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.errorCode, "WORKER_CRASHED");
    assert.equal(fs.existsSync(staging), false); // stale staging removed

    // The interrupted job can be retried and completed.
    s.manager.retryJob(jobId);
    const done = await pollJob(s.repo, jobId, "transcript_complete");
    assert.equal(done.status, "transcript_complete");
  } finally {
    s.cleanup();
  }
});

test("disk space: a zero free-bytes reading fails the job before any worker spawn", { timeout: 15000 }, async () => {
  const s = makeSetup({ mode: "success", getFreeDiskBytes: async () => 0 });
  try {
    const created = await s.manager.createJob({ sourcePath: s.sourcePath, profile: "memo" });
    const failed = await pollJob(s.repo, created.id, "failed");
    assert.equal(failed.errorCode, "DISK_SPACE_INSUFFICIENT");
    // Disk check runs during "validating", before "preparing"/spawn.
    assert.ok(!s.statusesFor(created.id).includes("preparing"));
    assert.equal(s.store.hasFinalizedJob(created.id), false);
  } finally {
    s.cleanup();
  }
});

test("createJob input validation: missing source and bad profile throw", { timeout: 10000 }, async () => {
  const s = makeSetup({ mode: "success" });
  try {
    await assert.rejects(
      s.manager.createJob({ sourcePath: path.join(s.externalDir, "does-not-exist.wav"), profile: "memo" }),
      (e) => e instanceof RecordingJobError && e.code === "AUDIO_FILE_NOT_FOUND"
    );
    await assert.rejects(
      s.manager.createJob({ sourcePath: s.sourcePath, profile: "not-a-profile" }),
      (e) => e instanceof ProfileValidationError
    );
  } finally {
    s.cleanup();
  }
});
