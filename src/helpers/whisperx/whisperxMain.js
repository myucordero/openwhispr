// WhisperX subsystem assembly for the Electron main process (spec 02/03).
// Pure Node module: electron `app` and the window accessor are injected via
// the constructor, never required at module top level, so this file loads
// under plain Node for unit tests (tests/whisperx/whisperxMain.test.cjs).
//
// WhisperXMain owns the runtime manager, artifact store, GPU coordinator and
// job manager, wires them together with real userData paths, and exposes the
// small surface the IPC layer calls. Every method throws typed errors
// (code + message); the IPC layer serializes them into { success:false,
// error, code }. Redaction happens at that IPC boundary, not here.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { WhisperXRuntimeManager } = require("./whisperxRuntimeManager");
const { RecordingArtifactStore } = require("./recordingArtifactStore");
const { GpuInferenceCoordinator } = require("./gpuInferenceCoordinator");
const { RecordingJobManager, RecordingJobError } = require("./recordingJobManager");

const READINESS_CACHE_MS = 5000;
const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_DICTIONARY_ENTRIES = 128;
const MAX_TRANSCRIPT_PAGE_LIMIT = 500;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 200;
const MAX_ARTIFACT_TEXT_BYTES = 4 * 1024 * 1024; // 4 MiB

// Only these override keys reach resolveJobSettings; anything else is a
// renderer contract violation and is rejected before a job is created.
const ALLOWED_OVERRIDE_KEYS = new Set([
  "language",
  "model",
  "computeType",
  "batchSize",
  "alignment",
  "diarization",
  "diarizationProvider",
  "exactSpeakers",
  "minSpeakers",
  "maxSpeakers",
]);

// HF cache directory heuristics (spec 10 §3). The Hugging Face hub stores
// snapshots as "models--<org>--<name>" directories under the cache root, so a
// non-empty directory whose name matches the model family is treated as ready.
const ASR_MODEL_RE = /faster-whisper|whisper/i;
const ALIGNMENT_MODEL_RE = /wav2vec|alignment/i;
const DIARIZATION_MODEL_RE = /pyannote|speaker-diarization/i;

class WhisperXMainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WhisperXMainError";
    this.code = code;
  }
}

function freeDiskBytesFor(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

class WhisperXMain {
  constructor({
    app,
    databaseManager,
    environmentManager,
    logger = null,
    getWindows = () => [],
    now,
    uuid,
    // Test-only dependency overrides — production wiring builds these itself.
    runtimeManager,
    artifactStore,
    coordinator,
    jobManager,
  } = {}) {
    if (!app || typeof app.getPath !== "function") {
      throw new TypeError("WhisperXMain requires an injected electron `app`");
    }
    this.app = app;
    this.environmentManager = environmentManager;
    this.logger = logger;
    this._getWindows = typeof getWindows === "function" ? getWindows : () => [];
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._uuid = typeof uuid === "function" ? uuid : () => crypto.randomUUID();

    const userData = app.getPath("userData");
    this.jobsRoot = path.join(userData, "recording-jobs");
    this.runtimeRootDir = path.join(userData, "whisperx-runtime");
    this.modelCacheDirectory = path.join(userData, "whisperx-models");
    this.temporaryDirectory = path.join(userData, "whisperx-tmp");

    const appRoot = path.resolve(__dirname, "..", "..", "..");
    this.sidecarSourceDir = app.isPackaged
      ? path.join(process.resourcesPath, "whisperx-sidecar")
      : path.join(appRoot, "tools", "whisperx-sidecar");

    this.repo = databaseManager ? databaseManager.recordingJobs : null;

    this.runtimeManager =
      runtimeManager ||
      new WhisperXRuntimeManager({
        sidecarSourceDir: this.sidecarSourceDir,
        runtimeRootDir: this.runtimeRootDir,
        logger: logger || console,
      });

    this.artifactStore = artifactStore || new RecordingArtifactStore(this.jobsRoot);

    this.coordinator = coordinator || new GpuInferenceCoordinator({ logger });

    this.jobManager =
      jobManager ||
      new RecordingJobManager({
        repo: this.repo,
        artifactStore: this.artifactStore,
        coordinator: this.coordinator,
        resolveRuntime: async () => {
          try {
            return this.runtimeManager.resolveWorkerInvocation();
          } catch (error) {
            // Map the runtime manager's typed throw into a RecordingJobError so
            // the job manager's failure handler preserves RUNTIME_NOT_INSTALLED.
            throw new RecordingJobError(
              error.code || "RUNTIME_NOT_INSTALLED",
              error.message || "WhisperX runtime is not installed"
            );
          }
        },
        getHfToken: async () =>
          (this.environmentManager && this.environmentManager.getHuggingFaceToken()) || null,
        modelCacheDirectory: this.modelCacheDirectory,
        temporaryDirectory: this.temporaryDirectory,
        offline: true,
        emitEvent: (_jobId, payload) => this._broadcast("whisperx-job-event", payload),
        logger,
        minFreeDiskBytes: MIN_FREE_DISK_BYTES,
        getFreeDiskBytes: async (dir) => freeDiskBytesFor(dir),
      });

    this._readinessCache = null;
  }

  // --------------------------------------------------------------- lifecycle
  startup() {
    this._ensureDirs();
    return this.jobManager.recoverOnStartup();
  }

  async shutdown() {
    try {
      const snapshot =
        typeof this.jobManager.queueSnapshot === "function"
          ? this.jobManager.queueSnapshot()
          : null;
      if (snapshot && snapshot.running) {
        await this.jobManager.cancelJob(snapshot.running);
      }
    } catch (error) {
      this._log("warn", "WhisperX shutdown cancel failed", { error: error.message });
    }
    try {
      this.coordinator.dispose();
    } catch (error) {
      this._log("warn", "WhisperX coordinator dispose failed", { error: error.message });
    }
  }

  // --------------------------------------------------------------- readiness
  async getReadiness() {
    const nowMs = Date.now();
    if (this._readinessCache && nowMs - this._readinessCache.at < READINESS_CACHE_MS) {
      return this._readinessCache.value;
    }
    const value = await this._computeReadiness();
    this._readinessCache = { at: nowMs, value };
    return value;
  }

  async _computeReadiness() {
    const blockers = [];

    const status = await this.runtimeManager.getStatus();
    const runtimeInstalled = Boolean(status.installed);
    for (const blocker of status.blockers || []) blockers.push(blocker);

    // CUDA probing costs a Python spawn — only attempt it once the runtime is
    // actually installed, otherwise report nulls.
    let cuda = { cuda: false, device: null, vramGb: null };
    if (runtimeInstalled) {
      cuda = await this.runtimeManager.checkCuda();
    }
    const cudaAvailable = runtimeInstalled ? Boolean(cuda.cuda) : false;
    const gpuName = runtimeInstalled ? cuda.device ?? null : null;
    const vramTotalMb =
      runtimeInstalled && cuda.vramGb != null ? Math.round(cuda.vramGb * 1024) : null;

    const asrModelReady = this._scanModelCache(ASR_MODEL_RE);
    const alignmentModelReady = this._scanModelCache(ALIGNMENT_MODEL_RE);
    const diarizationModelReady = this._scanModelCache(DIARIZATION_MODEL_RE);

    const hfToken =
      this.environmentManager && this.environmentManager.getHuggingFaceToken
        ? this.environmentManager.getHuggingFaceToken()
        : "";
    const diarizationTokenConfigured = Boolean(hfToken);

    const ffmpegAvailable = this._checkFfmpeg();
    const storageWritable = this._checkStorageWritable();
    const freeDiskBytes = freeDiskBytesFor(this.jobsRoot);

    const offlineReady = runtimeInstalled && asrModelReady;

    if (!asrModelReady) {
      blockers.push({
        code: "MODEL_NOT_AVAILABLE_OFFLINE",
        message: "The WhisperX ASR model is not present in the local model cache.",
      });
    }
    if (!ffmpegAvailable) {
      blockers.push({
        code: "FFMPEG_UNAVAILABLE",
        message: "Bundled ffmpeg (ffmpeg-static) could not be resolved.",
      });
    }
    if (!storageWritable) {
      blockers.push({
        code: "STORAGE_NOT_WRITABLE",
        message: `Recording jobs directory is not writable: ${this.jobsRoot}`,
      });
    }
    if (freeDiskBytes !== null && freeDiskBytes < MIN_FREE_DISK_BYTES) {
      blockers.push({
        code: "DISK_SPACE_INSUFFICIENT",
        message: "Less than 2 GiB of free disk space is available for recordings.",
      });
    }

    return {
      runtimeInstalled,
      runtimeVersion: status.sidecarVersion ?? null,
      pythonVersion: status.pythonVersion ?? null,
      cudaAvailable,
      gpuName,
      vramTotalMb,
      vramFreeMb: null,
      asrModelReady,
      alignmentModelReady,
      diarizationTokenConfigured,
      diarizationModelReady,
      offlineReady,
      ffmpegAvailable,
      storageWritable,
      freeDiskBytes,
      blockers,
    };
  }

  _scanModelCache(regexp) {
    let entries;
    try {
      entries = fs.readdirSync(this.modelCacheDirectory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !regexp.test(entry.name)) continue;
      try {
        const inner = fs.readdirSync(path.join(this.modelCacheDirectory, entry.name));
        if (inner.length > 0) return true;
      } catch {
        /* unreadable subdir — treat as not ready */
      }
    }
    return false;
  }

  _checkFfmpeg() {
    try {
      const ffmpegPath = require("ffmpeg-static");
      return typeof ffmpegPath === "string" && fs.existsSync(ffmpegPath);
    } catch {
      return false;
    }
  }

  _checkStorageWritable() {
    try {
      fs.mkdirSync(this.jobsRoot, { recursive: true });
      const probe = path.join(this.jobsRoot, `.probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ provisioning
  async provisionRuntime({ onProgress } = {}) {
    this._ensureDirs();
    const sentinel = await this.runtimeManager.provision({
      onProgress: typeof onProgress === "function" ? onProgress : () => {},
    });
    this._readinessCache = null;
    return { sentinel };
  }

  // --------------------------------------------------------------- job flow
  async startJob(payload = {}) {
    const {
      sourcePath,
      displayName,
      profile,
      overrides = {},
      customDictionary = [],
      allowModelDownload = false,
    } = payload || {};

    if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
      throw new WhisperXMainError("AUDIO_FILE_NOT_FOUND", "sourcePath must be a non-empty string");
    }
    if (displayName !== undefined && typeof displayName !== "string") {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "displayName must be a string");
    }
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "overrides must be an object");
    }
    for (const key of Object.keys(overrides)) {
      if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
        throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", `Unknown override key "${key}"`);
      }
    }
    if (!Array.isArray(customDictionary)) {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "customDictionary must be an array");
    }
    if (customDictionary.some((word) => typeof word !== "string")) {
      throw new WhisperXMainError(
        "WORKER_PROTOCOL_ERROR",
        "customDictionary must contain only strings"
      );
    }
    if (customDictionary.length > MAX_DICTIONARY_ENTRIES) {
      throw new WhisperXMainError(
        "WORKER_PROTOCOL_ERROR",
        `customDictionary exceeds the ${MAX_DICTIONARY_ENTRIES}-entry limit`
      );
    }
    if (typeof allowModelDownload !== "boolean") {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "allowModelDownload must be a boolean");
    }

    const job = await this.jobManager.createJob({
      sourcePath,
      displayName,
      profile,
      overrides,
      customDictionary,
      allowModelDownload,
    });
    return { job };
  }

  async cancelJob(jobId) {
    this._assertJobId(jobId);
    const result = await this.jobManager.cancelJob(jobId);
    return result;
  }

  retryJob(jobId) {
    this._assertJobId(jobId);
    const job = this.jobManager.retryJob(jobId);
    return { job };
  }

  deleteJob(jobId) {
    this._assertJobId(jobId);
    const result = this.jobManager.deleteJob(jobId);
    return result;
  }

  getJob(jobId) {
    this._assertJobId(jobId);
    const job = this.repo.getJob(jobId);
    if (!job) {
      throw new WhisperXMainError("UNKNOWN_INTERNAL_ERROR", "Job not found");
    }
    return {
      job,
      artifacts: this.repo.listArtifacts(jobId),
      speakerMappings: this.repo.getSpeakerMappings(jobId),
    };
  }

  listJobs(query = {}) {
    const { status, limit, offset } = query || {};
    if (status !== undefined && typeof status !== "string") {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "status must be a string");
    }
    const opts = {};
    if (status) opts.status = status;
    if (Number.isInteger(limit) && limit > 0) opts.limit = limit;
    if (Number.isInteger(offset) && offset >= 0) opts.offset = offset;
    return { jobs: this.repo.listJobs(opts) };
  }

  // ----------------------------------------------------------- transcript IO
  readTranscriptPage({ jobId, offset = 0, limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT } = {}) {
    this._assertJobId(jobId);
    const boundedLimit = Math.min(
      Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_TRANSCRIPT_PAGE_LIMIT),
      MAX_TRANSCRIPT_PAGE_LIMIT
    );
    const boundedOffset = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);

    const descriptor = this._canonicalTranscriptDescriptor(jobId);
    const buffer = this.artifactStore.readArtifact(jobId, descriptor.relativePath);
    let transcript;
    try {
      transcript = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      throw new WhisperXMainError(
        "TRANSCRIPT_SCHEMA_INVALID",
        `Canonical transcript is not valid JSON: ${error.message}`
      );
    }
    const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
    const provenance = transcript.provenance || {};
    return {
      segments: segments.slice(boundedOffset, boundedOffset + boundedLimit),
      total: segments.length,
      speakers: Array.isArray(transcript.speakers) ? transcript.speakers : [],
      warnings: Array.isArray(transcript.warnings) ? transcript.warnings : [],
      provenance: {
        model: provenance.model ?? null,
        languageDetected: provenance.languageDetected ?? null,
        createdAt: provenance.createdAt ?? null,
      },
    };
  }

  readArtifactText({ jobId, relativePath, maxBytes = MAX_ARTIFACT_TEXT_BYTES } = {}) {
    this._assertJobId(jobId);
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new WhisperXMainError("OUTPUT_PATH_REJECTED", "relativePath must be a non-empty string");
    }
    const cap = Math.min(
      Math.max(1, Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : MAX_ARTIFACT_TEXT_BYTES),
      MAX_ARTIFACT_TEXT_BYTES
    );
    const buffer = this.artifactStore.readArtifact(jobId, relativePath, { maxBytes: cap });
    return { text: buffer.toString("utf8"), bytes: buffer.length };
  }

  // Source audio for transcript review playback (FR-036). The renderer only
  // ever supplies a job id — the path comes from the job row, so no arbitrary
  // filesystem read is reachable from the renderer. Bounded to 300 MB.
  readSourceAudio(jobId) {
    this._assertJobId(jobId);
    const job = this.repo.getJob(jobId);
    if (!job || !job.sourcePath) {
      throw new WhisperXMainError("AUDIO_FILE_NOT_FOUND", "Job or source path not found");
    }
    let stat;
    try {
      stat = fs.statSync(job.sourcePath);
    } catch {
      throw new WhisperXMainError("AUDIO_FILE_NOT_FOUND", "Source file no longer exists");
    }
    const MAX_SOURCE_AUDIO_BYTES = 300 * 1024 * 1024;
    if (!stat.isFile() || stat.size > MAX_SOURCE_AUDIO_BYTES) {
      throw new WhisperXMainError(
        "AUDIO_UNSUPPORTED",
        "Source audio exceeds the playback size cap"
      );
    }
    const MIME_BY_EXT = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".webm": "audio/webm",
      ".ogg": "audio/ogg",
      ".oga": "audio/ogg",
      ".flac": "audio/flac",
      ".aac": "audio/aac",
    };
    const ext = path.extname(job.sourcePath).toLowerCase();
    const buffer = fs.readFileSync(job.sourcePath);
    return {
      audio: buffer,
      mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
      bytes: buffer.length,
    };
  }

  // ------------------------------------------------------------ speaker maps
  saveSpeakerMapping({ jobId, speakerId, displayName } = {}) {
    this._assertJobId(jobId);
    if (typeof speakerId !== "string" || speakerId.length === 0) {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "speakerId must be a non-empty string");
    }
    if (typeof displayName !== "string") {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "displayName must be a string");
    }
    const speakerMappings = this.repo.saveSpeakerMapping(
      jobId,
      speakerId,
      displayName,
      this._now()
    );
    return { speakerMappings };
  }

  getSpeakerMappings(jobId) {
    this._assertJobId(jobId);
    return { speakerMappings: this.repo.getSpeakerMappings(jobId) };
  }

  // ------------------------------------------------------- transcript edits
  saveTranscriptRevision({ jobId, segmentId, oldText, newText } = {}) {
    this._assertJobId(jobId);
    if (typeof segmentId !== "string" || segmentId.length === 0) {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "segmentId must be a non-empty string");
    }
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "oldText and newText must be strings");
    }
    const descriptor = this._canonicalTranscriptDescriptor(jobId);
    const revision = this.repo.addTranscriptRevision({
      id: this._uuid(),
      jobId,
      parentTranscriptSha256: descriptor.sha256,
      segmentId,
      oldText,
      newText,
      createdAt: this._now(),
    });
    return { revision };
  }

  listTranscriptRevisions(jobId) {
    this._assertJobId(jobId);
    return { revisions: this.repo.listTranscriptRevisions(jobId) };
  }

  // ----------------------------------------------------------------- storage
  getStorageUsage() {
    const dbUsage = this.repo.getStorageUsage(); // [{ jobId, bytes }] from the DB
    const jobs = dbUsage.map((entry) => {
      let bytes = 0;
      try {
        bytes = this.artifactStore.jobDiskUsage(entry.jobId);
      } catch {
        bytes = 0;
      }
      // Prefer measured on-disk usage; fall back to the DB tally.
      return { jobId: entry.jobId, bytes: bytes || entry.bytes || 0 };
    });
    const total = jobs.reduce((sum, job) => sum + (job.bytes || 0), 0);
    return { jobs, total };
  }

  // ----------------------------------------------------------------- helpers
  _canonicalTranscriptDescriptor(jobId) {
    const artifacts = this.repo.listArtifacts(jobId);
    const descriptor = artifacts.find((artifact) => artifact.kind === "canonical-transcript");
    if (!descriptor) {
      throw new WhisperXMainError(
        "TRANSCRIPT_SCHEMA_INVALID",
        "No canonical transcript artifact exists for this job"
      );
    }
    return descriptor;
  }

  _assertJobId(jobId) {
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "jobId must be a non-empty string");
    }
  }

  _ensureDirs() {
    for (const dir of [
      this.jobsRoot,
      this.modelCacheDirectory,
      this.temporaryDirectory,
      this.runtimeRootDir,
    ]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        this._log("warn", "Failed to create WhisperX directory", { dir, error: error.message });
      }
    }
  }

  _broadcast(channel, payload) {
    let windows = [];
    try {
      windows = this._getWindows() || [];
    } catch {
      return;
    }
    for (const win of windows) {
      try {
        if (
          win &&
          typeof win.isDestroyed === "function" &&
          !win.isDestroyed() &&
          win.webContents &&
          !win.webContents.isDestroyed()
        ) {
          win.webContents.send(channel, payload);
        }
      } catch {
        /* renderer gone — ignore */
      }
    }
  }

  _log(level, message, meta) {
    if (this.logger && typeof this.logger[level] === "function") {
      this.logger[level](message, meta);
    }
  }
}

module.exports = WhisperXMain;
module.exports.WhisperXMain = WhisperXMain;
module.exports.WhisperXMainError = WhisperXMainError;
