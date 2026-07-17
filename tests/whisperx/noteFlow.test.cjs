// End-to-end tests for the reliable-notes flow, wiring WhisperXMain to REAL
// collaborators: an in-memory SQLite repo (via the node:sqlite fallback), a
// real RecordingArtifactStore/GpuInferenceCoordinator/RecordingJobManager,
// and a REAL spawn of the deterministic fake WhisperX worker
// (tests/fixtures/whisperx-fake-worker.cjs). Only the runtime manager (which
// resolves the worker's command/args) and the local LLM call
// (runLocalInference) are faked — everything else is the production code
// path from startJob()/generateNotes() through note-extraction, evidence
// validation, deterministic merge/render, and artifact/DB persistence.
//
// node:test runs tests serially within a file (see recordingJobManager.test
// .cjs), which this file relies on: tests 2 and 3 intentionally share one
// harness/job across two test() blocks to exercise "auto-notes skipped, then
// generated manually later" without re-running ASR.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const WhisperXMain = require("../../src/helpers/whisperx/whisperxMain.js");
const {
  applyRecordingJobsSchema,
  createRecordingJobsRepo,
} = require("../../src/helpers/whisperx/recordingJobsRepo.js");
const { resolveJobSettings } = require("../../src/helpers/whisperx/profiles.js");
const { WHISPERX_PROTOCOL_VERSION } = require("../../src/helpers/whisperx/constants.js");

const FAKE_WORKER_PATH = path.resolve(__dirname, "../fixtures/whisperx-fake-worker.cjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// better-sqlite3 is normally rebuilt for Electron's ABI, which plain Node
// cannot load; fall back to the built-in node:sqlite through a thin adapter
// (mirrors recordingJobManager.test.cjs / whisperxMain.test.cjs).
function openMemoryDb() {
  try {
    const Database = require("better-sqlite3");
    return new Database(":memory:");
  } catch (loadError) {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    console.warn(
      `noteFlow.test: better-sqlite3 unavailable (${loadError.code || loadError.message}); using node:sqlite adapter`
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

function makeRepo() {
  const db = openMemoryDb();
  applyRecordingJobsSchema(db);
  return createRecordingJobsRepo(db);
}

// Fake runtime manager: resolves the worker invocation to the real fake
// worker fixture, spawned as a genuine child process. Counts invocations so
// tests can prove a note-only retry never respawns the ASR worker.
class FakeRuntimeManager {
  constructor({ mode = "success" } = {}) {
    this.mode = mode;
    this.invocations = 0;
  }
  resolveWorkerInvocation() {
    this.invocations += 1;
    return {
      command: process.execPath,
      args: [FAKE_WORKER_PATH],
      cwd: REPO_ROOT,
      extraEnv: { OPENWHISPR_FAKE_WORKER_MODE: this.mode },
    };
  }
}

function makeFakeWindow(events) {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => {
        if (channel === "whisperx-job-event") events.push(payload);
      },
    },
  };
}

// Parses transcript segment lines out of the extraction prompt's user turn.
// serializeChunk() (noteChunker.js) emits:
//   [seg-0 start=0.00 end=3.20 speaker=spk-1] Buenos dias a todos...
const SEGMENT_LINE_RE = /^\[(seg-\S+)\s+start=[\d.]+\s+end=[\d.]+(?:\s+speaker=(\S+))?\]\s(.*)$/;

function parseSegmentsFromUserText(userText) {
  const segments = [];
  for (const rawLine of userText.split("\n")) {
    const match = rawLine.match(SEGMENT_LINE_RE);
    if (match) segments.push({ id: match[1], speaker: match[2] || null, text: match[3] });
  }
  return segments;
}

// Builds a schema-valid, evidence-valid extraction fragment: one summary
// claim citing the first seen segment, one decision citing the second, and
// one action item citing the third (owner taken from that segment's real
// speaker, so evidence validation's OWNER_NOT_EXPLICIT check passes).
// Deliberately omits importantQuotes — verbatim-quote matching is the
// riskiest part of evidence validation and isn't what these tests probe.
function buildFakeExtractionFragment(userText) {
  const segments = parseSegmentsFromUserText(userText);
  if (segments.length < 3) {
    throw new Error(
      `fake LLM: expected >=3 transcript segments in the extraction prompt, found ${segments.length}`
    );
  }
  const [first, second, third] = segments;
  const fragment = {
    summaryClaims: [
      { id: "summary-1", text: `Fake summary: ${first.text}`, evidence: { segmentIds: [first.id] } },
    ],
    discussionPoints: [],
    decisions: [
      { id: "decision-1", text: `Fake decision: ${second.text}`, evidence: { segmentIds: [second.id] } },
    ],
    proposals: [],
    actionItems: [
      {
        id: "action-1",
        task: `Fake action: ${third.text}`,
        ownerSpeakerId: third.speaker || null,
        dueDateText: null,
        dueDateIso: null,
        status: "explicit",
        evidence: { segmentIds: [third.id] },
      },
    ],
    followUps: [],
    openQuestions: [],
    risksOrBlockers: [],
    importantQuotes: [],
    unresolvedAmbiguities: [],
  };
  return JSON.stringify(fragment);
}

// The compiler contract: async ({ messages, maxTokens }) => string (noteCompiler
// .js). WhisperXMain._localLlm() adapts that into
// runLocalInference({ model, systemPrompt, userText, maxTokens }) — this is
// the override point injected here (see whisperxMain.js constructor).
// `failModels` lets a single test make a specific noteGeneration.model throw,
// without needing per-job state threaded through the LLM callback.
function makeFakeLlm({ failModels = new Set() } = {}) {
  return async ({ model, systemPrompt, userText }) => {
    if (failModels.has(model)) {
      throw new Error(`fake LLM configured to fail for model "${model}"`);
    }
    if (/verify/i.test(systemPrompt)) {
      // Strict verification is never enabled by these tests (memo profile,
      // strictNotes=false), but keep this branch honest in case that changes.
      return JSON.stringify({ result: "supported", reason: "fake verifier: always supported" });
    }
    if (/extraction engine/i.test(systemPrompt)) {
      return buildFakeExtractionFragment(userText);
    }
    throw new Error(`fake LLM: unrecognized systemPrompt (${systemPrompt.slice(0, 60)})`);
  };
}

// Assembles a fully-wired WhisperXMain: real repo, real artifact store, real
// GPU coordinator, real RecordingJobManager (none of those are faked — only
// runtimeManager and runLocalInference are, per the task brief). `app` points
// at a throwaway userData dir so jobsRoot/model-cache/tmp dirs are isolated
// per test.
function createHarness({ mode = "success", failModels = new Set() } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-noteflow-userdata-"));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-noteflow-ext-"));
  const sourcePath = path.join(externalDir, "source.wav");
  fs.writeFileSync(sourcePath, crypto.randomBytes(2048));

  const repo = makeRepo();
  const events = [];
  const saveNoteCalls = [];
  const databaseManager = {
    recordingJobs: repo,
    saveNote: (title, content, type, sourceFile) => {
      saveNoteCalls.push({ title, content, type, sourceFile });
      return { id: 4242 };
    },
  };
  const runtimeManager = new FakeRuntimeManager({ mode });
  const fakeWindow = makeFakeWindow(events);

  const main = new WhisperXMain({
    app: { getPath: () => userDataDir, isPackaged: false },
    databaseManager,
    environmentManager: { getHuggingFaceToken: () => "" },
    getWindows: () => [fakeWindow],
    runtimeManager,
    runLocalInference: makeFakeLlm({ failModels }),
  });

  return {
    main,
    repo,
    events,
    saveNoteCalls,
    runtimeManager,
    sourcePath,
    statusesFor: (jobId) => events.filter((e) => e.jobId === jobId).map((e) => e.status),
    cleanup: () => {
      try {
        main.coordinator.dispose();
      } catch {
        /* best effort */
      }
      for (const d of [userDataDir, externalDir]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

async function pollUntil(repo, jobId, statuses, timeoutMs = 20000) {
  const wanted = Array.isArray(statuses) ? statuses : [statuses];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = repo.getJob(jobId);
    if (job && wanted.includes(job.status)) return job;
    await sleep(50);
  }
  const last = repo.getJob(jobId);
  throw new Error(
    `job ${jobId} did not reach [${wanted}] within ${timeoutMs}ms (last status: ${last && last.status})`
  );
}

// ---------------------------------------------------------------------------
// 1. Auto-notes happy path
// ---------------------------------------------------------------------------

test(
  "auto-notes happy path: memo job with noteGeneration runs ASR then notes to complete",
  { timeout: 25000 },
  async () => {
    const h = createHarness({ mode: "success" });
    try {
      const { job } = await h.main.startJob({
        sourcePath: h.sourcePath,
        profile: "memo",
        noteGeneration: { provider: "local", model: "fake-qwen" },
      });
      const jobId = job.id;

      const done = await pollUntil(h.repo, jobId, "complete", 20000);
      assert.equal(done.status, "complete");

      // Note artifacts land in the FINALIZED job dir (not staging).
      const finalDir = h.main.artifactStore.finalDir(jobId);
      assert.equal(fs.existsSync(path.join(finalDir, "notes.md")), true);
      assert.equal(fs.existsSync(path.join(finalDir, "note-extraction.json")), true);

      // Artifact rows persisted with real sha256 hashes.
      const artifacts = h.repo.listArtifacts(jobId);
      const extractionArtifact = artifacts.find((a) => a.kind === "note-extraction");
      const notesArtifact = artifacts.find((a) => a.kind === "notes-markdown");
      assert.ok(extractionArtifact, "note-extraction artifact row missing");
      assert.ok(notesArtifact, "notes-markdown artifact row missing");
      assert.match(extractionArtifact.sha256, /^[0-9a-f]{64}$/);
      assert.match(notesArtifact.sha256, /^[0-9a-f]{64}$/);

      // Note run row: complete, linked to the saved note, both relative paths set.
      const noteRuns = h.repo.listNoteRuns(jobId);
      assert.equal(noteRuns.length, 1);
      assert.equal(noteRuns[0].status, "complete");
      assert.equal(noteRuns[0].noteId, 4242);
      assert.equal(noteRuns[0].extractionRelativePath, "note-extraction.json");
      assert.equal(noteRuns[0].notesRelativePath, "notes.md");

      // saveNote called once with rendered markdown.
      assert.equal(h.saveNoteCalls.length, 1);
      const markdown = h.saveNoteCalls[0].content;
      assert.ok(markdown.includes("## "), "markdown missing a section heading");
      assert.ok(
        markdown.includes("openwhispr://recording/"),
        "markdown missing an internal citation link"
      );

      // Broadcast events include the note pipeline's stage transitions.
      const statuses = h.statusesFor(jobId);
      assert.ok(
        statuses.includes("note_extracting"),
        `expected "note_extracting" among broadcast statuses: ${JSON.stringify(statuses)}`
      );
      assert.ok(
        statuses.includes("complete"),
        `expected "complete" among broadcast statuses: ${JSON.stringify(statuses)}`
      );
    } finally {
      h.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// 2 & 3. No noteGeneration -> rests at transcript_complete, then manual
// generateNotes() compiles notes for that same job without re-running ASR.
// These two tests intentionally share one harness/job (see file header).
// ---------------------------------------------------------------------------

let sharedHarness = null;
let sharedJobId = null;

test(
  "no noteGeneration config: job rests at transcript_complete and never auto-completes",
  { timeout: 20000 },
  async () => {
    sharedHarness = createHarness({ mode: "success" });
    const { job } = await sharedHarness.main.startJob({
      sourcePath: sharedHarness.sourcePath,
      profile: "memo",
    });
    sharedJobId = job.id;

    const resting = await pollUntil(sharedHarness.repo, sharedJobId, "transcript_complete", 20000);
    assert.equal(resting.status, "transcript_complete");

    // Give an (absent) note pipeline every chance to fire — it must not.
    await sleep(3000);
    const after = sharedHarness.repo.getJob(sharedJobId);
    assert.equal(
      after.status,
      "transcript_complete",
      "job must not progress past transcript_complete without a noteGeneration config"
    );

    const artifacts = sharedHarness.repo.listArtifacts(sharedJobId);
    assert.ok(!artifacts.some((a) => a.kind === "note-extraction"));
    assert.ok(!artifacts.some((a) => a.kind === "notes-markdown"));
    assert.equal(sharedHarness.repo.listNoteRuns(sharedJobId).length, 0);
  }
);

test(
  "generateNotes manual path: compiles notes for the resting job from the previous test",
  { timeout: 20000 },
  async () => {
    assert.ok(sharedHarness && sharedJobId, "requires the resting job from the previous test");
    try {
      const result = await sharedHarness.main.generateNotes(sharedJobId, {
        llm: { provider: "local", model: "fake-qwen-manual" },
      });
      assert.ok(typeof result.markdown === "string" && result.markdown.length > 0);
      assert.ok(result.markdown.includes("## "));

      const job = sharedHarness.repo.getJob(sharedJobId);
      assert.equal(job.status, "complete");

      const noteRuns = sharedHarness.repo.listNoteRuns(sharedJobId);
      assert.equal(noteRuns.length, 1);
      assert.equal(noteRuns[0].status, "complete");
      assert.equal(noteRuns[0].noteId, 4242);
    } finally {
      sharedHarness.cleanup();
      sharedHarness = null;
      sharedJobId = null;
    }
  }
);

// ---------------------------------------------------------------------------
// 4. Note failure path, then a working retry that does NOT re-run ASR.
// ---------------------------------------------------------------------------

test(
  "note failure path: transcript_complete_note_failed, then generateNotes retry succeeds without re-running ASR",
  { timeout: 25000 },
  async () => {
    const failModel = "fake-qwen-broken";
    const h = createHarness({ mode: "success", failModels: new Set([failModel]) });
    try {
      const { job } = await h.main.startJob({
        sourcePath: h.sourcePath,
        profile: "memo",
        noteGeneration: { provider: "local", model: failModel },
      });
      const jobId = job.id;

      const failed = await pollUntil(h.repo, jobId, "transcript_complete_note_failed", 20000);
      assert.equal(failed.status, "transcript_complete_note_failed");
      assert.ok(failed.errorCode, "expected an error_code recorded on note failure");

      // Transcript artifacts must survive a note failure untouched.
      const finalDir = h.main.artifactStore.finalDir(jobId);
      assert.equal(fs.existsSync(path.join(finalDir, "transcript.raw.json")), true);
      const artifactsAfterFailure = h.repo.listArtifacts(jobId);
      assert.ok(!artifactsAfterFailure.some((a) => a.kind === "note-extraction"));
      assert.ok(!artifactsAfterFailure.some((a) => a.kind === "notes-markdown"));

      assert.equal(h.runtimeManager.invocations, 1, "ASR worker should have spawned exactly once so far");
      const spawnsBeforeRetry = h.runtimeManager.invocations;

      const result = await h.main.generateNotes(jobId, {
        llm: { provider: "local", model: "fake-qwen-fixed" },
      });
      assert.ok(result.markdown.includes("## "));

      const done = h.repo.getJob(jobId);
      assert.equal(done.status, "complete");

      // The critical assertion: retrying notes must NOT respawn the ASR worker.
      assert.equal(
        h.runtimeManager.invocations,
        spawnsBeforeRetry,
        "generateNotes must not respawn the WhisperX ASR worker"
      );
    } finally {
      h.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// 5. generateNotes with no local LLM config anywhere -> NOTE_MODEL_UNAVAILABLE
// ---------------------------------------------------------------------------

test(
  "generateNotes with no local config anywhere rejects with NOTE_MODEL_UNAVAILABLE",
  { timeout: 20000 },
  async () => {
    const h = createHarness({ mode: "success" });
    try {
      const { job } = await h.main.startJob({ sourcePath: h.sourcePath, profile: "memo" });
      const jobId = job.id;
      await pollUntil(h.repo, jobId, "transcript_complete", 20000);

      await assert.rejects(
        () => h.main.generateNotes(jobId),
        (error) => error.code === "NOTE_MODEL_UNAVAILABLE"
      );
    } finally {
      h.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// 6. generateNotes on a "queued" job -> rejected by the job-status guard
// ---------------------------------------------------------------------------

test("generateNotes on a queued job rejects via the status guard", async () => {
  const h = createHarness({ mode: "success" });
  try {
    const jobId = "queued-job-1";
    const settings = resolveJobSettings("memo", {}, []);
    h.repo.createJob({
      id: jobId,
      status: "queued",
      sourceType: "external",
      sourceDisplayName: "queued.wav",
      sourcePath: h.sourcePath,
      sourceSha256: null,
      profile: settings.profile,
      settingsJson: JSON.stringify(settings),
      protocolVersion: WHISPERX_PROTOCOL_VERSION,
      artifactDirectory: h.main.artifactStore.finalDir(jobId),
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      () => h.main.generateNotes(jobId),
      (error) => error.code === "NOTE_MODEL_UNAVAILABLE" && /queued/.test(error.message)
    );
  } finally {
    h.cleanup();
  }
});
