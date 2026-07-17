// Recording job manager (spec 02 §5/§7/§9/§10, 05 phase 4).
// Owns the sequential FIFO job queue, job state persistence, GPU lease use,
// deterministic OOM ladder retries, staging/finalize, cancellation, retry,
// deletion semantics and startup recovery. Pure Node module: everything
// environment-specific (paths, runtime command, event sink, secrets) is
// injected, so the whole orchestration is testable with the fake worker.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { WHISPERX_PROTOCOL_VERSION } = require("./constants");
const { validateJobRequest, validateCanonicalTranscript } = require("./contracts");
const {
  assertTransition,
  isRetryableState,
  isActiveState,
  recoveryStateFor,
  canCancel,
  ACTIVE_STATES,
} = require("./jobStateMachine");
const { resolveJobSettings, oomLadderFor } = require("./profiles");
const { WhisperXProcessRun, WhisperXProcessError } = require("./whisperxProcessManager");
const { ArtifactStoreError } = require("./recordingArtifactStore");

const STAGE_TO_JOB_STATE = {
  "probing-audio": "preparing",
  "normalizing-audio": "preparing",
  "loading-asr": "transcribing",
  transcribing: "transcribing",
  "unloading-asr": "transcribing",
  "loading-alignment": "aligning",
  aligning: "aligning",
  "unloading-alignment": "aligning",
  "loading-diarization": "diarizing",
  diarizing: "diarizing",
  "unloading-diarization": "diarizing",
  canonicalizing: "canonicalizing",
  "writing-artifacts": "persisting",
};

class RecordingJobError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecordingJobError";
    this.code = code;
    this.details = details;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

class RecordingJobManager {
  constructor({
    repo, // recordingJobsRepo instance (database)
    artifactStore, // RecordingArtifactStore
    coordinator, // GpuInferenceCoordinator
    resolveRuntime, // async () => ({ command, args, cwd, extraEnv }) throws RecordingJobError(RUNTIME_NOT_INSTALLED)
    getHfToken = async () => null, // secret provider; env-only usage
    modelCacheDirectory,
    temporaryDirectory,
    offline = true,
    emitEvent = () => {}, // (jobId, RecordingJobProgressEvent)
    logger = null,
    now = () => new Date().toISOString(),
    uuid = () => crypto.randomUUID(),
    minFreeDiskBytes = 2 * 1024 * 1024 * 1024,
    getFreeDiskBytes = null, // async (dir) => bytes | null
    heartbeatTimeoutMs,
    absoluteTimeoutMs,
    spawnFn, // test injection, passed through to WhisperXProcessRun
  }) {
    this.repo = repo;
    this.artifactStore = artifactStore;
    this.coordinator = coordinator;
    this.resolveRuntime = resolveRuntime;
    this.getHfToken = getHfToken;
    this.modelCacheDirectory = modelCacheDirectory;
    this.temporaryDirectory = temporaryDirectory;
    this.offline = offline;
    this.emitEvent = emitEvent;
    this.logger = logger;
    this.now = now;
    this.uuid = uuid;
    this.minFreeDiskBytes = minFreeDiskBytes;
    this.getFreeDiskBytes = getFreeDiskBytes;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.absoluteTimeoutMs = absoluteTimeoutMs;
    this.spawnFn = spawnFn;

    this._queue = [];
    this._running = null; // { jobId, run, cancelRequested }
    this._noteCompiler = null; // set in phase 4 wiring
  }

  setNoteCompiler(fn) {
    this._noteCompiler = fn;
  }

  // ------------------------------------------------------------------ create
  async createJob({
    sourcePath,
    displayName,
    profile,
    overrides = {},
    customDictionary = [],
    allowModelDownload = false,
    noteGeneration = null,
  }) {
    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      throw new RecordingJobError("AUDIO_FILE_NOT_FOUND", `Source file not found`, {
        sourcePath,
      });
    }
    if (!stat.isFile()) {
      throw new RecordingJobError("AUDIO_FILE_NOT_FOUND", "Source is not a regular file");
    }

    const settings = resolveJobSettings(profile, overrides, customDictionary);
    // Per-job offline override: when the caller allows a model download, the
    // worker's offline env is relaxed for this job only (see _buildRequest).
    settings.allowModelDownload = Boolean(allowModelDownload);
    // Resolved note-LLM config (renderer resolves the noteFormatting scope at
    // submit time); consumed by the note-compiler hook after finalize.
    if (noteGeneration) settings.noteGeneration = noteGeneration;
    const jobId = this.uuid();
    const createdAt = this.now();

    this.repo.createJob({
      id: jobId,
      status: "created",
      sourceType: "external",
      sourceDisplayName: displayName || path.basename(sourcePath),
      sourcePath,
      sourceSha256: null,
      profile: settings.profile,
      settingsJson: JSON.stringify(settings),
      protocolVersion: WHISPERX_PROTOCOL_VERSION,
      artifactDirectory: this.artifactStore.finalDir(jobId),
      createdAt,
    });
    this._transition(jobId, "created", "queued");
    this._queue.push(jobId);
    this._pump();
    return this.repo.getJob(jobId);
  }

  // ------------------------------------------------------------------- queue
  _pump() {
    if (this._running || this._queue.length === 0) return;
    const jobId = this._queue.shift();
    const job = this.repo.getJob(jobId);
    if (!job || job.status !== "queued") {
      this._pump();
      return;
    }
    this._running = { jobId, run: null, cancelRequested: false };
    this._runJob(jobId)
      .catch((error) => {
        this._log("error", "Job run crashed outside error handling", {
          jobId,
          error: error.message,
        });
      })
      .finally(() => {
        this._running = null;
        this._pump();
      });
  }

  queueSnapshot() {
    return {
      running: this._running ? this._running.jobId : null,
      queued: [...this._queue],
    };
  }

  // -------------------------------------------------------------------- run
  async _runJob(jobId) {
    let job = this.repo.getJob(jobId);
    const settings = JSON.parse(job.settingsJson);
    const startedAt = this.now();
    this.repo.updateJobFields(jobId, { started_at: startedAt });

    try {
      this._transition(jobId, "queued", "validating");

      // Source integrity + disk preflight.
      const sourceSha256 = await sha256File(job.sourcePath);
      this.repo.updateJobFields(jobId, { source_sha256: sourceSha256 });
      await this._checkDiskSpace(job);
      this._throwIfCancelRequested(jobId);

      const runtime = await this.resolveRuntime();
      const staging = this.artifactStore.createStagingDir(jobId);
      this._transition(jobId, "validating", "preparing");

      const ladder = oomLadderFor(settings);
      const fallbackAttempts = [];
      let outcome = null;

      for (let attempt = 0; attempt < ladder.length; attempt++) {
        const step = ladder[attempt];
        this._throwIfCancelRequested(jobId);

        const request = this._buildRequest(job, settings, step, staging, sourceSha256);
        const requestCheck = validateJobRequest(request);
        if (!requestCheck.valid) {
          throw new RecordingJobError("WORKER_PROTOCOL_ERROR", "Built an invalid job request", {
            errors: requestCheck.errors,
          });
        }

        const hfToken = settings.diarization ? await this.getHfToken() : null;
        const lease = await this.coordinator.acquire(jobId, {
          label: `whisperx:${step.model}/${step.computeType}/b${step.batchSize}`,
        });
        try {
          const run = new WhisperXProcessRun({
            command: runtime.command,
            args: runtime.args,
            cwd: runtime.cwd,
            request,
            hfToken,
            extraEnv: {
              ...(runtime.extraEnv || {}),
              // Per-job effective offline: allowModelDownload (explicit user
              // consent) relaxes the offline env for this job only, matching
              // the request's runtime.offline flag built in _buildRequest.
              ...(this.offline && !settings.allowModelDownload
                ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }
                : { HF_HUB_OFFLINE: "0", TRANSFORMERS_OFFLINE: "0" }),
            },
            heartbeatTimeoutMs: this.heartbeatTimeoutMs,
            absoluteTimeoutMs: this.absoluteTimeoutMs,
            spawnFn: this.spawnFn,
            onEvent: (event) => this._onWorkerEvent(jobId, event, lease),
          });
          if (this._running && this._running.jobId === jobId) this._running.run = run;
          if (this._running && this._running.cancelRequested) {
            await run.cancel();
          }
          outcome = await run.run();
          if (fallbackAttempts.length > 0 && outcome.completion) {
            outcome.completion.actualConfiguration = {
              ...outcome.completion.actualConfiguration,
              fallbackAttempts,
            };
          }
          break; // success
        } catch (error) {
          if (error.code === "JOB_CANCELLED" || (this._running && this._running.cancelRequested)) {
            throw new RecordingJobError("JOB_CANCELLED", "Job cancelled", {});
          }
          if (error.code === "CUDA_OUT_OF_MEMORY" && attempt < ladder.length - 1) {
            const nextStep = ladder[attempt + 1];
            fallbackAttempts.push({
              model: step.model,
              computeType: step.computeType,
              batchSize: step.batchSize,
              reason: "CUDA_OUT_OF_MEMORY",
            });
            this._emit(jobId, {
              status: this.repo.getJob(jobId).status,
              warning: {
                code: "OOM_FALLBACK_USED",
                message: `Retrying with ${nextStep.model} ${nextStep.computeType} batch ${nextStep.batchSize}`,
              },
            });
            continue;
          }
          throw error;
        } finally {
          if (this._running && this._running.jobId === jobId) this._running.run = null;
          lease.release();
        }
      }

      if (!outcome || !outcome.completion) {
        throw new RecordingJobError("CUDA_OUT_OF_MEMORY", "All OOM fallback attempts exhausted", {
          fallbackAttempts,
        });
      }

      await this._finalize(jobId, job, settings, outcome, sourceSha256, fallbackAttempts);
    } catch (error) {
      this._handleRunFailure(jobId, error);
    }
  }

  _buildRequest(job, settings, step, stagingDir, sourceSha256) {
    const formats = ["canonical-json", "raw-txt"];
    if (settings.diarization) formats.push("speaker-markdown");
    // Segment-level timestamps always exist, so subtitles are always produced.
    formats.push("srt", "vtt");
    return {
      protocolVersion: WHISPERX_PROTOCOL_VERSION,
      requestId: this.uuid(),
      jobId: job.id,
      source: {
        path: job.sourcePath,
        displayName: job.sourceDisplayName,
        expectedSha256: sourceSha256,
      },
      output: {
        jobDirectory: stagingDir,
        preserveNormalizedAudio: false,
        formats,
      },
      profile: settings.profile,
      language: settings.language,
      asr: {
        model: step.model,
        computeType: step.computeType,
        batchSize: step.batchSize,
        device: settings.device,
        hotwords: settings.hotwords,
        ...(settings.hotwords.length > 0
          ? { initialPrompt: settings.hotwords.join(", ") }
          : {}),
      },
      alignment: { enabled: settings.alignment },
      diarization: {
        enabled: settings.diarization,
        provider: settings.diarizationProvider,
        ...(settings.exactSpeakers !== undefined ? { exactSpeakers: settings.exactSpeakers } : {}),
        ...(settings.minSpeakers !== undefined ? { minSpeakers: settings.minSpeakers } : {}),
        ...(settings.maxSpeakers !== undefined ? { maxSpeakers: settings.maxSpeakers } : {}),
      },
      runtime: {
        offline: this.offline && !settings.allowModelDownload,
        modelCacheDirectory: this.modelCacheDirectory,
        temporaryDirectory: this.temporaryDirectory,
      },
    };
  }

  _onWorkerEvent(jobId, event, lease) {
    lease.touch();
    if (event.type === "stage") {
      const mapped = STAGE_TO_JOB_STATE[event.stage];
      const current = this.repo.getJob(jobId);
      if (mapped && current && mapped !== current.status && isActiveState(current.status)) {
        try {
          assertTransition(current.status, mapped);
          this.repo.updateJobStatus(jobId, mapped);
          this._emit(jobId, { status: mapped, stage: event.stage });
        } catch {
          // Stage jitter (e.g. unload events) — keep current state.
          this._emit(jobId, { status: current.status, stage: event.stage });
        }
      } else if (current) {
        this._emit(jobId, { status: current.status, stage: event.stage });
      }
      return;
    }
    if (event.type === "progress") {
      const current = this.repo.getJob(jobId);
      this._emit(jobId, {
        status: current ? current.status : "transcribing",
        stage: event.stage,
        completed: event.completed,
        total: event.total,
        unit: event.unit,
      });
      return;
    }
    if (event.type === "warning") {
      const current = this.repo.getJob(jobId);
      this._emit(jobId, {
        status: current ? current.status : "transcribing",
        warning: { code: event.code, message: event.message },
      });
    }
  }

  async _finalize(jobId, job, settings, outcome, sourceSha256, fallbackAttempts) {
    const { completion, artifacts, warnings } = outcome;

    // The canonical transcript must exist, be confined, and validate.
    const staging = this.artifactStore.stagingDir(jobId);
    const transcriptDescriptor = artifacts.find((a) => a.kind === "canonical-transcript");
    if (!transcriptDescriptor) {
      throw new RecordingJobError("TRANSCRIPT_SCHEMA_INVALID", "Worker produced no canonical transcript");
    }
    const transcriptPath = path.join(staging, transcriptDescriptor.relativePath);
    let transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
    } catch (error) {
      throw new RecordingJobError("TRANSCRIPT_SCHEMA_INVALID", "Canonical transcript unreadable", {
        message: error.message,
      });
    }
    const transcriptCheck = validateCanonicalTranscript(transcript);
    if (!transcriptCheck.valid) {
      throw new RecordingJobError("TRANSCRIPT_SCHEMA_INVALID", "Canonical transcript failed validation", {
        errors: transcriptCheck.errors.slice(0, 20),
      });
    }
    if (completion.sourceSha256 !== sourceSha256) {
      throw new RecordingJobError("SOURCE_HASH_MISMATCH", "Worker reported a different source hash", {
        expected: sourceSha256,
        reported: completion.sourceSha256,
      });
    }

    const createdAt = this.now();
    const descriptors = artifacts.map((a) => ({
      kind: a.kind,
      relativePath: a.relativePath,
      sha256: a.sha256,
      bytes: a.bytes,
      schemaVersion: a.kind === "canonical-transcript" ? transcript.schemaVersion : undefined,
      createdAt,
    }));

    await this.artifactStore.finalizeJob(jobId, {
      manifest: {
        jobId,
        sourceSha256,
        profile: settings.profile,
        settings,
        actualConfiguration: completion.actualConfiguration,
        warnings: [...warnings.map((w) => ({ code: w.code, message: w.message }))],
        durationSeconds: completion.durationSeconds,
        detectedLanguage: completion.detectedLanguage,
        timingsMs: completion.timingsMs,
        createdAt,
      },
      descriptors,
    });

    this.repo.replaceArtifacts(
      jobId,
      descriptors.map((d) => ({
        jobId,
        kind: d.kind,
        relativePath: d.relativePath,
        sha256: d.sha256,
        bytes: d.bytes,
        schemaVersion: d.schemaVersion ?? null,
        createdAt,
      }))
    );
    this.repo.updateJobFields(jobId, {
      transcript_schema_version: transcript.schemaVersion,
      duration_seconds: completion.durationSeconds,
      actual_configuration_json: JSON.stringify({
        ...completion.actualConfiguration,
        fallbackAttempts,
      }),
      warning_json: JSON.stringify(warnings.map((w) => ({ code: w.code, message: w.message }))),
      completed_at: this.now(),
    });

    const current = this.repo.getJob(jobId).status;
    // Walk remaining pipeline states to transcript_complete legally.
    if (current !== "persisting") {
      // e.g. skipped stages when the worker was fast; force through canonicalizing→persisting
      const hops = {
        transcribing: ["canonicalizing", "persisting"],
        aligning: ["canonicalizing", "persisting"],
        diarizing: ["canonicalizing", "persisting"],
        canonicalizing: ["persisting"],
        preparing: ["transcribing", "canonicalizing", "persisting"],
      }[current] || [];
      let from = current;
      for (const to of hops) {
        this._transition(jobId, from, to);
        from = to;
      }
    }
    this._transition(jobId, "persisting", "transcript_complete");
    this._emit(jobId, { status: "transcript_complete" });
    this._log("info", "Recording job transcript complete", { jobId });

    if (this._noteCompiler && settings.noteSections && settings.noteSections.length > 0) {
      await this._noteCompiler(jobId, { transcript, settings });
    }
  }

  _handleRunFailure(jobId, error) {
    const job = this.repo.getJob(jobId);
    if (!job) return;
    const code =
      error instanceof RecordingJobError ||
      error instanceof WhisperXProcessError ||
      error instanceof ArtifactStoreError
        ? error.code
        : "UNKNOWN_INTERNAL_ERROR";

    // Clean staging on any failure — finalized artifacts (if a previous run
    // completed) stay untouched.
    try {
      this.artifactStore.deleteJobArtifacts(jobId, { keepFinal: true });
    } catch {
      /* best effort */
    }

    const target = code === "JOB_CANCELLED" ? "cancelled" : "failed";
    if (isActiveState(job.status)) {
      this.repo.updateJobStatus(jobId, target, { errorCode: code === "JOB_CANCELLED" ? null : code });
      this._emit(jobId, {
        status: target,
        ...(code !== "JOB_CANCELLED" ? { warning: { code, message: error.message } } : {}),
      });
    }
    this._log("warn", "Recording job did not complete", { jobId, code, message: error.message });
  }

  _throwIfCancelRequested(jobId) {
    if (this._running && this._running.jobId === jobId && this._running.cancelRequested) {
      throw new RecordingJobError("JOB_CANCELLED", "Job cancelled", {});
    }
  }

  // ------------------------------------------------------------ cancel/retry
  async cancelJob(jobId) {
    const job = this.repo.getJob(jobId);
    if (!job) throw new RecordingJobError("UNKNOWN_INTERNAL_ERROR", "Job not found");
    if (!canCancel(job.status)) {
      return { cancelled: false, status: job.status };
    }
    const queueIndex = this._queue.indexOf(jobId);
    if (queueIndex >= 0) {
      this._queue.splice(queueIndex, 1);
      this.repo.updateJobStatus(jobId, "cancelled");
      this._emit(jobId, { status: "cancelled" });
      return { cancelled: true, status: "cancelled" };
    }
    if (this._running && this._running.jobId === jobId) {
      this._running.cancelRequested = true;
      this.coordinator.cancelPending(jobId);
      if (this._running.run) {
        await this._running.run.cancel();
      }
      return { cancelled: true, status: "cancelling" };
    }
    // Active in DB but not actually running (shouldn't happen) — recover.
    this.repo.updateJobStatus(jobId, "cancelled");
    this._emit(jobId, { status: "cancelled" });
    return { cancelled: true, status: "cancelled" };
  }

  retryJob(jobId) {
    const job = this.repo.getJob(jobId);
    if (!job) throw new RecordingJobError("UNKNOWN_INTERNAL_ERROR", "Job not found");
    if (!isRetryableState(job.status)) {
      throw new RecordingJobError(
        "UNKNOWN_INTERNAL_ERROR",
        `Job in state "${job.status}" is not retryable`
      );
    }
    this._transition(jobId, job.status, "queued");
    this.repo.updateJobFields(jobId, { error_code: null });
    this._queue.push(jobId);
    this._pump();
    return this.repo.getJob(jobId);
  }

  // ---------------------------------------------------------------- deletion
  deleteJob(jobId) {
    const job = this.repo.getJob(jobId);
    if (!job) return { deleted: false };
    if (this._running && this._running.jobId === jobId) {
      throw new RecordingJobError("UNKNOWN_INTERNAL_ERROR", "Cancel the job before deleting it");
    }
    const queueIndex = this._queue.indexOf(jobId);
    if (queueIndex >= 0) this._queue.splice(queueIndex, 1);
    // Managed artifacts only — the external source file is never touched.
    this.artifactStore.deleteJobArtifacts(jobId);
    this.repo.deleteJob(jobId);
    return { deleted: true };
  }

  // ---------------------------------------------------------------- recovery
  recoverOnStartup() {
    const stale = this.repo.findJobsByStatuses(ACTIVE_STATES);
    for (const job of stale) {
      const target = recoveryStateFor(job.status);
      if (target) {
        this.repo.updateJobStatus(job.id, target, { errorCode: "WORKER_CRASHED" });
        this._log("warn", "Stale active job marked interrupted at startup", {
          jobId: job.id,
          previousStatus: job.status,
        });
      }
    }
    const removedStaging = this.artifactStore.cleanupStaleStaging({ maxAgeMs: 0 });
    return { interrupted: stale.length, stagingRemoved: removedStaging.length };
  }

  // ----------------------------------------------------------------- helpers
  async _checkDiskSpace(job) {
    if (typeof this.getFreeDiskBytes !== "function") return;
    let free = null;
    try {
      free = await this.getFreeDiskBytes(this.artifactStore.jobsRoot);
    } catch {
      return; // metric unavailable — do not block
    }
    if (free !== null && free < this.minFreeDiskBytes) {
      throw new RecordingJobError("DISK_SPACE_INSUFFICIENT", "Not enough free disk space", {
        freeBytes: free,
        requiredBytes: this.minFreeDiskBytes,
      });
    }
  }

  _transition(jobId, from, to) {
    assertTransition(from, to);
    this.repo.updateJobStatus(jobId, to);
    this._emit(jobId, { status: to });
  }

  _emit(jobId, payload) {
    try {
      this.emitEvent(jobId, { jobId, ...payload });
    } catch {
      /* renderer gone — ignore */
    }
  }

  _log(level, message, meta) {
    if (this.logger && typeof this.logger[level] === "function") {
      this.logger[level](message, meta);
    }
  }
}

module.exports = { RecordingJobManager, RecordingJobError, STAGE_TO_JOB_STATE };
