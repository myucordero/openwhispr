// Recording-jobs persistence layer (WhisperX reliable-notes pipeline).
// Pure module: takes a better-sqlite3 db handle, no electron imports and no
// require of database.js, so it stays unit-testable outside Electron.
// Timestamps are never generated here (no Date.now()/new Date()) — callers
// pass every timestamp in, keeping tests deterministic.

function toCamelKey(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function mapRow(row) {
  if (!row) return null;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[toCamelKey(key)] = value;
  }
  return result;
}

function mapRows(rows) {
  return rows.map(mapRow);
}

function applyRecordingJobsSchema(db) {
  // NOTE: foreign_keys is deliberately NOT enabled here — the pragma is
  // connection-global and database.js shares one connection across every
  // pre-existing table, so flipping it from a feature module would silently
  // change enforcement semantics app-wide (security review finding).
  // deleteJob() cascades explicitly inside a transaction instead; the FK
  // clauses below remain as documentation and for any future DB-wide
  // decision to enable enforcement.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_display_name TEXT NOT NULL,
      source_path TEXT,
      source_sha256 TEXT,
      profile TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      transcript_schema_version INTEGER,
      artifact_directory TEXT NOT NULL,
      error_code TEXT,
      warning_json TEXT,
      actual_configuration_json TEXT,
      duration_seconds REAL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      schema_version INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES recording_jobs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS note_generation_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      note_id INTEGER,
      status TEXT NOT NULL,
      source_transcript_sha256 TEXT NOT NULL,
      transcript_revision_id TEXT,
      prompt_version TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      extraction_relative_path TEXT,
      notes_relative_path TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(job_id) REFERENCES recording_jobs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_speaker_mappings (
      job_id TEXT NOT NULL,
      speaker_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, speaker_id),
      FOREIGN KEY(job_id) REFERENCES recording_jobs(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_revisions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      parent_transcript_sha256 TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      old_text TEXT NOT NULL,
      new_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES recording_jobs(id) ON DELETE CASCADE
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_jobs_status ON recording_jobs(status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_recording_jobs_source_sha256 ON recording_jobs(source_sha256)"
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_artifacts_unique ON recording_artifacts(job_id, kind, relative_path)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_recording_artifacts_job_id ON recording_artifacts(job_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_note_generation_runs_job_id ON note_generation_runs(job_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_transcript_revisions_job_id ON transcript_revisions(job_id)"
  );
}

function createRecordingJobsRepo(db) {
  function applyAllowlistedUpdate(table, id, fields, allowedFields, getFn) {
    const setClauses = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowedFields.includes(key)) {
        throw new Error(`Unknown field "${key}" for ${table} update`);
      }
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
    if (setClauses.length === 0) return getFn(id);
    values.push(id);
    db.prepare(`UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    return getFn(id);
  }

  function createJob(job) {
    const {
      id,
      status,
      sourceType,
      sourceDisplayName,
      sourcePath = null,
      sourceSha256 = null,
      profile,
      settingsJson,
      protocolVersion,
      artifactDirectory,
      createdAt,
    } = job;
    db.prepare(
      `INSERT INTO recording_jobs (
        id, status, source_type, source_display_name, source_path, source_sha256,
        profile, settings_json, protocol_version, artifact_directory, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      status,
      sourceType,
      sourceDisplayName,
      sourcePath,
      sourceSha256,
      profile,
      settingsJson,
      protocolVersion,
      artifactDirectory,
      createdAt
    );
    return getJob(id);
  }

  function getJob(id) {
    return mapRow(db.prepare("SELECT * FROM recording_jobs WHERE id = ?").get(id));
  }

  function listJobs({ status, limit = 100, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT * FROM recording_jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    return mapRows(rows);
  }

  function updateJobStatus(id, status, opts = {}) {
    const { errorCode = null, startedAt, completedAt } = opts;
    const setClauses = ["status = ?", "error_code = ?"];
    const values = [status, errorCode];
    if (startedAt !== undefined) {
      setClauses.push("started_at = ?");
      values.push(startedAt);
    }
    if (completedAt !== undefined) {
      setClauses.push("completed_at = ?");
      values.push(completedAt);
    }
    values.push(id);
    db.prepare(`UPDATE recording_jobs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    return getJob(id);
  }

  function updateJobFields(id, fields) {
    const allowedFields = [
      "status",
      "error_code",
      "warning_json",
      "actual_configuration_json",
      "transcript_schema_version",
      "duration_seconds",
      "source_sha256",
      "started_at",
      "completed_at",
    ];
    return applyAllowlistedUpdate("recording_jobs", id, fields, allowedFields, getJob);
  }

  function findJobsByStatuses(statuses) {
    if (!statuses || statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT * FROM recording_jobs WHERE status IN (${placeholders}) ORDER BY created_at DESC`
      )
      .all(...statuses);
    return mapRows(rows);
  }

  function findJobsBySourceSha256(sha256) {
    const rows = db
      .prepare("SELECT * FROM recording_jobs WHERE source_sha256 = ? ORDER BY created_at DESC")
      .all(sha256);
    return mapRows(rows);
  }

  function deleteJob(id) {
    // Explicit cascade in one transaction (FK enforcement is intentionally
    // not enabled on the shared connection — see applyRecordingJobsSchema).
    const runDelete = db.transaction((jobId) => {
      db.prepare("DELETE FROM recording_artifacts WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM note_generation_runs WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM recording_speaker_mappings WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM transcript_revisions WHERE job_id = ?").run(jobId);
      return db.prepare("DELETE FROM recording_jobs WHERE id = ?").run(jobId);
    });
    const result = runDelete(id);
    return { success: result.changes > 0 };
  }

  function replaceArtifacts(jobId, artifacts) {
    const deleteStmt = db.prepare("DELETE FROM recording_artifacts WHERE job_id = ?");
    const insertStmt = db.prepare(
      `INSERT INTO recording_artifacts (
        job_id, kind, relative_path, sha256, bytes, schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = db.transaction((id, artifactList) => {
      deleteStmt.run(id);
      for (const artifact of artifactList) {
        insertStmt.run(
          id,
          artifact.kind,
          artifact.relativePath,
          artifact.sha256,
          artifact.bytes,
          artifact.schemaVersion ?? null,
          artifact.createdAt
        );
      }
    });
    transaction(jobId, artifacts);
    return listArtifacts(jobId);
  }

  function listArtifacts(jobId) {
    const rows = db
      .prepare("SELECT * FROM recording_artifacts WHERE job_id = ? ORDER BY id ASC")
      .all(jobId);
    return mapRows(rows);
  }

  function createNoteRun(run) {
    const {
      id,
      jobId,
      noteId = null,
      status,
      sourceTranscriptSha256,
      transcriptRevisionId = null,
      promptVersion,
      provider,
      model,
      extractionRelativePath = null,
      notesRelativePath = null,
      errorCode = null,
      createdAt,
      completedAt = null,
    } = run;
    db.prepare(
      `INSERT INTO note_generation_runs (
        id, job_id, note_id, status, source_transcript_sha256, transcript_revision_id,
        prompt_version, provider, model, extraction_relative_path, notes_relative_path,
        error_code, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      jobId,
      noteId,
      status,
      sourceTranscriptSha256,
      transcriptRevisionId,
      promptVersion,
      provider,
      model,
      extractionRelativePath,
      notesRelativePath,
      errorCode,
      createdAt,
      completedAt
    );
    return getNoteRun(id);
  }

  function getNoteRun(id) {
    return mapRow(db.prepare("SELECT * FROM note_generation_runs WHERE id = ?").get(id));
  }

  function listNoteRuns(jobId) {
    const rows = db
      .prepare("SELECT * FROM note_generation_runs WHERE job_id = ? ORDER BY created_at DESC")
      .all(jobId);
    return mapRows(rows);
  }

  function updateNoteRun(id, fields) {
    const allowedFields = [
      "status",
      "note_id",
      "extraction_relative_path",
      "notes_relative_path",
      "error_code",
      "completed_at",
    ];
    return applyAllowlistedUpdate("note_generation_runs", id, fields, allowedFields, getNoteRun);
  }

  function saveSpeakerMapping(jobId, speakerId, displayName, updatedAt) {
    db.prepare(
      `INSERT INTO recording_speaker_mappings (job_id, speaker_id, display_name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id, speaker_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`
    ).run(jobId, speakerId, displayName, updatedAt);
    return getSpeakerMappings(jobId);
  }

  function getSpeakerMappings(jobId) {
    const rows = db
      .prepare(
        "SELECT speaker_id, display_name FROM recording_speaker_mappings WHERE job_id = ?"
      )
      .all(jobId);
    const result = {};
    for (const row of rows) {
      result[row.speaker_id] = row.display_name;
    }
    return result;
  }

  function addTranscriptRevision(revision) {
    const { id, jobId, parentTranscriptSha256, segmentId, oldText, newText, createdAt } =
      revision;
    db.prepare(
      `INSERT INTO transcript_revisions (
        id, job_id, parent_transcript_sha256, segment_id, old_text, new_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, jobId, parentTranscriptSha256, segmentId, oldText, newText, createdAt);
    return mapRow(db.prepare("SELECT * FROM transcript_revisions WHERE id = ?").get(id));
  }

  function listTranscriptRevisions(jobId) {
    const rows = db
      .prepare("SELECT * FROM transcript_revisions WHERE job_id = ? ORDER BY created_at ASC")
      .all(jobId);
    return mapRows(rows);
  }

  function getStorageUsage() {
    const rows = db
      .prepare("SELECT job_id, SUM(bytes) as bytes FROM recording_artifacts GROUP BY job_id")
      .all();
    return rows.map((row) => ({ jobId: row.job_id, bytes: row.bytes }));
  }

  return {
    createJob,
    getJob,
    listJobs,
    updateJobStatus,
    updateJobFields,
    findJobsByStatuses,
    findJobsBySourceSha256,
    deleteJob,
    replaceArtifacts,
    listArtifacts,
    createNoteRun,
    getNoteRun,
    listNoteRuns,
    updateNoteRun,
    saveSpeakerMapping,
    getSpeakerMappings,
    addTranscriptRevision,
    listTranscriptRevisions,
    getStorageUsage,
  };
}

module.exports = {
  applyRecordingJobsSchema,
  createRecordingJobsRepo,
};
