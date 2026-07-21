const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyRecordingJobsSchema,
  createRecordingJobsRepo,
} = require("../../src/helpers/whisperx/recordingJobsRepo.js");

// better-sqlite3 is the production driver, but node_modules is typically
// rebuilt for Electron's ABI (postinstall runs electron-builder
// install-app-deps), which plain Node cannot load. Fall back to the built-in
// node:sqlite (real SQLite, same SQL semantics) through a thin adapter that
// emulates the small better-sqlite3 surface the repo module uses
// (exec/pragma/prepare/transaction).
function openMemoryDb() {
  try {
    const Database = require("better-sqlite3");
    return new Database(":memory:");
  } catch (loadError) {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    console.warn(
      `recordingJobsRepo.test: better-sqlite3 unavailable under this Node ABI (${loadError.code || loadError.message}); using node:sqlite adapter`
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

function makeDb() {
  const db = openMemoryDb();
  applyRecordingJobsSchema(db);
  const repo = createRecordingJobsRepo(db);
  return { db, repo };
}

function baseJob(overrides = {}) {
  return {
    id: "job-1",
    status: "created",
    sourceType: "external",
    sourceDisplayName: "meeting.wav",
    sourcePath: "/tmp/meeting.wav",
    sourceSha256: "sha-abc",
    profile: "meeting",
    settingsJson: "{}",
    protocolVersion: 1,
    artifactDirectory: "/data/jobs/job-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("applyRecordingJobsSchema is idempotent", () => {
  const { db } = makeDb();
  assert.doesNotThrow(() => applyRecordingJobsSchema(db));
});

test("createJob + getJob roundtrip with camelCase mapping", () => {
  const { repo } = makeDb();
  const created = repo.createJob(baseJob());
  assert.equal(created.id, "job-1");
  assert.equal(created.sourceType, "external");
  assert.equal(created.sourceDisplayName, "meeting.wav");
  assert.equal(created.sourceSha256, "sha-abc");
  assert.equal(created.protocolVersion, 1);
  assert.equal(created.artifactDirectory, "/data/jobs/job-1");
  assert.equal(created.errorCode, null);

  const fetched = repo.getJob("job-1");
  assert.deepEqual(fetched, created);

  assert.equal(repo.getJob("missing"), null);
});

test("listJobs filters by status and orders by created_at DESC", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob({ id: "job-a", status: "queued", createdAt: "2026-01-01T00:00:00.000Z" }));
  repo.createJob(baseJob({ id: "job-b", status: "complete", createdAt: "2026-01-02T00:00:00.000Z" }));
  repo.createJob(baseJob({ id: "job-c", status: "queued", createdAt: "2026-01-03T00:00:00.000Z" }));

  const queued = repo.listJobs({ status: "queued" });
  assert.deepEqual(
    queued.map((j) => j.id),
    ["job-c", "job-a"]
  );

  const all = repo.listJobs();
  assert.deepEqual(
    all.map((j) => j.id),
    ["job-c", "job-b", "job-a"]
  );
});

test("updateJobStatus sets and clears error_code, sets timestamps", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());

  const failed = repo.updateJobStatus("job-1", "failed", { errorCode: "WORKER_CRASHED" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "WORKER_CRASHED");

  const requeued = repo.updateJobStatus("job-1", "queued");
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.errorCode, null);

  const started = repo.updateJobStatus("job-1", "transcribing", {
    startedAt: "2026-01-01T01:00:00.000Z",
  });
  assert.equal(started.startedAt, "2026-01-01T01:00:00.000Z");

  const completed = repo.updateJobStatus("job-1", "complete", {
    completedAt: "2026-01-01T02:00:00.000Z",
  });
  assert.equal(completed.completedAt, "2026-01-01T02:00:00.000Z");
  // startedAt should be untouched by a call that didn't pass it
  assert.equal(completed.startedAt, "2026-01-01T01:00:00.000Z");
});

test("updateJobFields rejects unknown keys", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());
  assert.throws(() => repo.updateJobFields("job-1", { not_a_real_column: 1 }), /Unknown field/);

  const updated = repo.updateJobFields("job-1", {
    warning_json: "[]",
    duration_seconds: 12.5,
  });
  assert.equal(updated.warningJson, "[]");
  assert.equal(updated.durationSeconds, 12.5);
});

test("findJobsByStatuses supports startup recovery queries", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob({ id: "job-transcribing", status: "transcribing" }));
  repo.createJob(baseJob({ id: "job-persisting", status: "persisting" }));
  repo.createJob(baseJob({ id: "job-complete", status: "complete" }));

  const active = repo.findJobsByStatuses(["transcribing", "persisting"]);
  assert.deepEqual(
    active.map((j) => j.id).sort(),
    ["job-persisting", "job-transcribing"]
  );

  assert.deepEqual(repo.findJobsByStatuses([]), []);
});

test("findJobsBySourceSha256 detects duplicate source recordings", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob({ id: "job-1", sourceSha256: "dup-sha" }));
  repo.createJob(baseJob({ id: "job-2", sourceSha256: "dup-sha", createdAt: "2026-01-02T00:00:00.000Z" }));
  repo.createJob(baseJob({ id: "job-3", sourceSha256: "other-sha" }));

  const dupes = repo.findJobsBySourceSha256("dup-sha");
  assert.deepEqual(
    dupes.map((j) => j.id),
    ["job-2", "job-1"]
  );
});

test("replaceArtifacts is transactional and respects the unique index", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());

  const first = repo.replaceArtifacts("job-1", [
    {
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-1",
      bytes: 100,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(first.length, 1);

  const second = repo.replaceArtifacts("job-1", [
    {
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-2",
      bytes: 200,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:01:00.000Z",
    },
    {
      kind: "notes-markdown",
      relativePath: "notes.md",
      sha256: "sha-3",
      bytes: 50,
      schemaVersion: null,
      createdAt: "2026-01-01T00:01:00.000Z",
    },
  ]);
  assert.equal(second.length, 2);
  const transcriptArtifact = second.find((a) => a.kind === "canonical-transcript");
  assert.equal(transcriptArtifact.sha256, "sha-2");

  assert.deepEqual(repo.listArtifacts("job-1"), second);
});

test("deleteJob cascades artifacts, note runs, mappings, and revisions", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());
  repo.replaceArtifacts("job-1", [
    {
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-1",
      bytes: 100,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  repo.createNoteRun({
    id: "run-1",
    jobId: "job-1",
    status: "complete",
    sourceTranscriptSha256: "sha-1",
    promptVersion: "v1",
    provider: "openai",
    model: "gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  repo.saveSpeakerMapping("job-1", "SPEAKER_00", "Alice", "2026-01-01T00:00:00.000Z");
  repo.addTranscriptRevision({
    id: "rev-1",
    jobId: "job-1",
    parentTranscriptSha256: "sha-1",
    segmentId: "seg-1",
    oldText: "old",
    newText: "new",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const result = repo.deleteJob("job-1");
  assert.equal(result.success, true);

  assert.equal(repo.getJob("job-1"), null);
  assert.deepEqual(repo.listArtifacts("job-1"), []);
  assert.deepEqual(repo.listNoteRuns("job-1"), []);
  assert.deepEqual(repo.getSpeakerMappings("job-1"), {});
  assert.deepEqual(repo.listTranscriptRevisions("job-1"), []);

  const missingResult = repo.deleteJob("job-1");
  assert.equal(missingResult.success, false);
});

test("note run create/update/get with allowlist rejection", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());
  const run = repo.createNoteRun({
    id: "run-1",
    jobId: "job-1",
    status: "note_extracting",
    sourceTranscriptSha256: "sha-1",
    promptVersion: "v1",
    provider: "openai",
    model: "gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(run.status, "note_extracting");
  assert.equal(run.noteId, null);

  assert.throws(() => repo.updateNoteRun("run-1", { bogus: 1 }), /Unknown field/);

  const updated = repo.updateNoteRun("run-1", {
    status: "complete",
    note_id: 42,
    completed_at: "2026-01-01T00:05:00.000Z",
  });
  assert.equal(updated.status, "complete");
  assert.equal(updated.noteId, 42);
  assert.equal(updated.completedAt, "2026-01-01T00:05:00.000Z");

  assert.deepEqual(repo.getNoteRun("run-1"), updated);
  assert.equal(repo.getNoteRun("missing"), null);
});

test("speaker mapping upsert renames the same speaker", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());

  repo.saveSpeakerMapping("job-1", "SPEAKER_00", "Speaker 1", "2026-01-01T00:00:00.000Z");
  repo.saveSpeakerMapping("job-1", "SPEAKER_01", "Speaker 2", "2026-01-01T00:00:00.000Z");
  let mappings = repo.getSpeakerMappings("job-1");
  assert.deepEqual(mappings, { SPEAKER_00: "Speaker 1", SPEAKER_01: "Speaker 2" });

  repo.saveSpeakerMapping("job-1", "SPEAKER_00", "Alice", "2026-01-01T00:10:00.000Z");
  mappings = repo.getSpeakerMappings("job-1");
  assert.deepEqual(mappings, { SPEAKER_00: "Alice", SPEAKER_01: "Speaker 2" });
});

test("transcript revisions append and list in creation order", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob());

  repo.addTranscriptRevision({
    id: "rev-1",
    jobId: "job-1",
    parentTranscriptSha256: "sha-1",
    segmentId: "seg-1",
    oldText: "a",
    newText: "b",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  repo.addTranscriptRevision({
    id: "rev-2",
    jobId: "job-1",
    parentTranscriptSha256: "sha-1",
    segmentId: "seg-2",
    oldText: "c",
    newText: "d",
    createdAt: "2026-01-01T00:01:00.000Z",
  });

  const revisions = repo.listTranscriptRevisions("job-1");
  assert.deepEqual(
    revisions.map((r) => r.id),
    ["rev-1", "rev-2"]
  );
  assert.equal(revisions[0].oldText, "a");
  assert.equal(revisions[1].newText, "d");
});

test("getStorageUsage sums bytes per job", () => {
  const { repo } = makeDb();
  repo.createJob(baseJob({ id: "job-1" }));
  repo.createJob(baseJob({ id: "job-2" }));

  repo.replaceArtifacts("job-1", [
    {
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-1",
      bytes: 100,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      kind: "notes-markdown",
      relativePath: "notes.md",
      sha256: "sha-2",
      bytes: 50,
      schemaVersion: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  repo.replaceArtifacts("job-2", [
    {
      kind: "canonical-transcript",
      relativePath: "transcript.json",
      sha256: "sha-3",
      bytes: 30,
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  const usage = repo.getStorageUsage().sort((a, b) => a.jobId.localeCompare(b.jobId));
  assert.deepEqual(usage, [
    { jobId: "job-1", bytes: 150 },
    { jobId: "job-2", bytes: 30 },
  ]);
});

test("schema does not flip the connection-global foreign_keys pragma (security review)", () => {
  // The shared app connection must keep whatever FK semantics it already had
  // (better-sqlite3 defaults OFF; node:sqlite defaults ON) — the repo module
  // must not change it. deleteJob cascades explicitly instead.
  const db = openMemoryDb();
  const readPragma = () => {
    const row = db.prepare("PRAGMA foreign_keys").get();
    return Number(row.foreign_keys ?? Object.values(row)[0]);
  };
  const before = readPragma();
  applyRecordingJobsSchema(db);
  const after = readPragma();
  assert.equal(after, before, "applyRecordingJobsSchema must not change the foreign_keys pragma");
});
