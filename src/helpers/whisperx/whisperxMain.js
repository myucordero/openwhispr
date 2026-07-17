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

// Trusted ffmpeg for the worker's probe/normalization. ffmpeg-static bundles
// only ffmpeg (no ffprobe); in packaged apps the module resolves inside asar
// and the real binary lives in app.asar.unpacked.
function resolveFfmpegPath() {
  try {
    let ffmpegPath = require("ffmpeg-static");
    if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0) return null;
    if (ffmpegPath.includes("app.asar")) {
      ffmpegPath = ffmpegPath.replace("app.asar", "app.asar.unpacked");
    }
    return fs.existsSync(ffmpegPath) ? ffmpegPath : null;
  } catch {
    return null; // worker falls back to ffmpeg/ffprobe on PATH
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
    runLocalInference,
  } = {}) {
    if (!app || typeof app.getPath !== "function") {
      throw new TypeError("WhisperXMain requires an injected electron `app`");
    }
    this.app = app;
    this.databaseManager = databaseManager;
    this.environmentManager = environmentManager;
    // Test override for the local LLM call; production lazily requires the
    // modelManagerBridge (which needs electron) inside _runLocalInference.
    this._runLocalInferenceOverride = runLocalInference || null;
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
          // GPU sequencing (spec 08 §4): stop/unload the local llama.cpp
          // server before ASR so WhisperX gets the VRAM. Note generation
          // restarts it afterwards through the normal inference path.
          await this._stopLocalLlmServer();
          try {
            const invocation = this.runtimeManager.resolveWorkerInvocation();
            const ffmpegPath = resolveFfmpegPath();
            return {
              ...invocation,
              extraEnv: {
                ...(invocation.extraEnv || {}),
                ...(ffmpegPath ? { OPENWHISPR_FFMPEG_PATH: ffmpegPath } : {}),
              },
            };
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

    // Auto-run reliable notes after transcript completion (spec 02 §13).
    // The hook must never throw: a note failure marks the job
    // transcript_complete_note_failed and leaves the transcript usable.
    // (Guarded: tests may inject a minimal fake job manager.)
    if (typeof this.jobManager.setNoteCompiler === "function") {
      this.jobManager.setNoteCompiler(async (jobId, { transcript, settings }) => {
        await this._autoCompileNotes(jobId, transcript, settings);
      });
    }
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
      noteGeneration,
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
    if (noteGeneration !== undefined && noteGeneration !== null) {
      if (typeof noteGeneration !== "object" || Array.isArray(noteGeneration)) {
        throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", "noteGeneration must be an object");
      }
      for (const [key, value] of Object.entries(noteGeneration)) {
        if (!["provider", "model", "disableThinking"].includes(key)) {
          throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", `Unknown noteGeneration key "${key}"`);
        }
        if (key === "disableThinking" ? typeof value !== "boolean" : typeof value !== "string") {
          throw new WhisperXMainError("WORKER_PROTOCOL_ERROR", `Invalid noteGeneration.${key}`);
        }
      }
    }

    const job = await this.jobManager.createJob({
      sourcePath,
      displayName,
      profile,
      overrides,
      customDictionary,
      allowModelDownload,
      noteGeneration: noteGeneration || undefined,
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
  // supplies a job id, and bytes are served ONLY for jobs whose transcript
  // finalized — the worker's probe/decode stages prove the file is real
  // audio, so a renderer cannot round-trip arbitrary file bytes by starting
  // a job on a non-audio path and reading it back. Bounded to 300 MB,
  // read asynchronously.
  async readSourceAudio(jobId) {
    this._assertJobId(jobId);
    const job = this.repo.getJob(jobId);
    if (!job || !job.sourcePath) {
      throw new WhisperXMainError("AUDIO_FILE_NOT_FOUND", "Job or source path not found");
    }
    const PLAYABLE_STATUSES = ["transcript_complete", "complete", "transcript_complete_note_failed"];
    if (!PLAYABLE_STATUSES.includes(job.status)) {
      throw new WhisperXMainError(
        "AUDIO_UNSUPPORTED",
        "Source audio is only served after the transcript has finalized"
      );
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
      // MP4 video sources: served as audio/mp4 so the review player's <audio>
      // element decodes the AAC audio track (the file was validated by the
      // worker's ffmpeg decode before the job reached a playable status).
      ".mp4": "audio/mp4",
      ".m4v": "audio/mp4",
    };
    const ext = path.extname(job.sourcePath).toLowerCase();
    const buffer = await fs.promises.readFile(job.sourcePath);
    return {
      audio: buffer,
      mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
      bytes: buffer.length,
    };
  }

  // ------------------------------------------------------------ note compiler

  async _stopLocalLlmServer() {
    if (this._runLocalInferenceOverride) return; // tests: nothing to stop
    try {
      const modelManager = require("../modelManagerBridge").default;
      await modelManager.stopServer();
    } catch (error) {
      this._log("warn", "Could not stop local LLM server before ASR", {
        error: error.message,
      });
    }
  }

  // Adapter from the compiler's messages contract to the repo's local
  // llama.cpp bridge (system + single user turn; extra turns are folded into
  // the user text). Returns raw response text.
  _localLlm(llmConfig, lease) {
    return async ({ messages, maxTokens }) => {
      if (lease) lease.touch();
      const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
      const userText = messages
        .filter((m) => m.role !== "system")
        .map((m) => m.content)
        .join("\n\n");
      if (this._runLocalInferenceOverride) {
        return this._runLocalInferenceOverride({
          model: llmConfig.model,
          systemPrompt,
          userText,
          maxTokens,
        });
      }
      const modelManager = require("../modelManagerBridge").default;
      return modelManager.runInference(llmConfig.model, userText, {
        systemPrompt,
        maxTokens,
        temperature: 0.1,
        disableThinking: llmConfig.disableThinking !== false,
      });
    };
  }

  _loadTranscriptForNotes(jobId) {
    const artifacts = this.repo.listArtifacts(jobId);
    const descriptor = artifacts.find((a) => a.kind === "canonical-transcript");
    if (!descriptor) {
      throw new WhisperXMainError("TRANSCRIPT_SCHEMA_INVALID", "Job has no canonical transcript");
    }
    const buffer = this.artifactStore.readArtifact(jobId, descriptor.relativePath);
    const transcript = JSON.parse(buffer.toString("utf8"));
    transcript.__artifactSha256 = descriptor.sha256;
    return transcript;
  }

  _validateNoteLlmConfig(llm) {
    if (!llm || typeof llm !== "object") return null;
    const { provider, model, disableThinking } = llm;
    const isCli = provider === "claude-cli" || provider === "codex-cli";
    // Notes run on a local GGUF or the user's local CLI (claude/codex via
    // subscription). CLI backends use the subscription's default model, so an
    // empty model is valid there; a local GGUF still requires a model id.
    if (provider !== "local" && !isCli) return null;
    if (!isCli && (typeof model !== "string" || model.length === 0)) return null;
    return {
      provider,
      // CLI backends use the account default; never carry a (possibly fallback
      // GGUF) model id that a caller might otherwise forward as --model.
      model: isCli ? "" : model,
      disableThinking: disableThinking !== false,
    };
  }

  // CLI-backed note LLM: run `claude`/`codex` (subscription) once per chunk.
  // The extraction prompt already asks for JSON; parseJsonObject tolerates
  // fences, and we nudge the CLI toward raw JSON for good measure.
  _cliLlm(llmConfig) {
    const cli = llmConfig.provider === "codex-cli" ? "codex" : "claude";
    return async ({ messages }) => {
      const { runCliInference } = require("../cliInference");
      const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
      const userText = messages
        .filter((m) => m.role !== "system")
        .map((m) => m.content)
        .join("\n\n");
      const jsonNudge = "Respond with ONLY the JSON object — no prose, no markdown fences.";
      const res = await runCliInference({
        cli,
        prompt: userText,
        systemPrompt: systemPrompt ? `${systemPrompt}\n\n${jsonNudge}` : jsonNudge,
      });
      if (!res || !res.success || typeof res.text !== "string") {
        throw new WhisperXMainError(
          "NOTE_MODEL_UNAVAILABLE",
          (res && res.error) || `${cli} CLI note inference failed`
        );
      }
      return res.text;
    };
  }

  // Auto-run hook after transcript completion. Never throws.
  async _autoCompileNotes(jobId, transcript, settings) {
    const llmConfig = this._validateNoteLlmConfig(settings.noteGeneration);
    if (!llmConfig) {
      this._log("info", "No local note model configured; job rests at transcript_complete", {
        jobId,
      });
      return;
    }
    try {
      const artifacts = this.repo.listArtifacts(jobId);
      const descriptor = artifacts.find((a) => a.kind === "canonical-transcript");
      if (descriptor) transcript.__artifactSha256 = descriptor.sha256;
      await this._compileNotes(jobId, transcript, settings, llmConfig, {
        strict: Boolean(settings.strictNotes),
      });
    } catch (error) {
      this._markNoteFailure(jobId, error);
    }
  }

  // IPC entry: manual generation/regeneration without retranscription.
  async generateNotes(jobId, { llm, strict } = {}) {
    this._assertJobId(jobId);
    const job = this.repo.getJob(jobId);
    if (!job) throw new WhisperXMainError("UNKNOWN_INTERNAL_ERROR", "Job not found");
    if (!["transcript_complete", "complete", "transcript_complete_note_failed"].includes(job.status)) {
      throw new WhisperXMainError(
        "NOTE_MODEL_UNAVAILABLE",
        `Notes cannot be generated while the job is "${job.status}"`
      );
    }
    const settings = JSON.parse(job.settingsJson);
    const llmConfig = this._validateNoteLlmConfig(llm) || this._validateNoteLlmConfig(settings.noteGeneration);
    if (!llmConfig) {
      throw new WhisperXMainError(
        "NOTE_MODEL_UNAVAILABLE",
        "Select a local note model (noteFormatting scope) before generating notes"
      );
    }
    const transcript = this._loadTranscriptForNotes(jobId);
    try {
      const result = await this._compileNotes(jobId, transcript, settings, llmConfig, {
        strict: strict !== undefined ? Boolean(strict) : Boolean(settings.strictNotes),
      });
      return result;
    } catch (error) {
      this._markNoteFailure(jobId, error);
      throw error;
    }
  }

  listNoteRuns(jobId) {
    this._assertJobId(jobId);
    return { noteRuns: this.repo.listNoteRuns(jobId) };
  }

  _markNoteFailure(jobId, error) {
    try {
      const current = this.repo.getJob(jobId);
      if (current && ["note_extracting", "note_validating", "note_rendering"].includes(current.status)) {
        this.repo.updateJobStatus(jobId, "transcript_complete_note_failed", {
          errorCode: error.code || "NOTE_SCHEMA_INVALID",
        });
      } else if (current && current.status === "transcript_complete") {
        // Failed before entering the note pipeline (e.g. model unavailable).
        this.repo.updateJobStatus(jobId, "note_extracting");
        this.repo.updateJobStatus(jobId, "transcript_complete_note_failed", {
          errorCode: error.code || "NOTE_MODEL_UNAVAILABLE",
        });
      }
      const after = this.repo.getJob(jobId);
      this._broadcast("whisperx-job-event", {
        jobId,
        status: after ? after.status : "transcript_complete_note_failed",
        warning: { code: error.code || "NOTE_SCHEMA_INVALID", message: error.message },
      });
    } catch (markError) {
      this._log("error", "Failed to record note failure", { jobId, error: markError.message });
    }
  }

  async _compileNotes(jobId, transcript, settings, llmConfig, { strict }) {
    const { compileNotes } = require("./noteCompiler");
    const { EXTRACTION_PROMPT_VERSION } = require("./notePrompts");

    const transitionTo = (to) => {
      const current = this.repo.getJob(jobId).status;
      if (current === to) return;
      this.repo.updateJobStatus(jobId, to);
      this._broadcast("whisperx-job-event", { jobId, status: to });
    };

    if (!transcript.__artifactSha256) {
      throw new WhisperXMainError(
        "TRANSCRIPT_SCHEMA_INVALID",
        "Canonical transcript artifact hash missing — cannot record note provenance"
      );
    }
    transitionTo("note_extracting");
    const noteRunId = this._uuid();
    this.repo.createNoteRun({
      id: noteRunId,
      jobId,
      status: "running",
      sourceTranscriptSha256: transcript.__artifactSha256,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      provider: llmConfig.provider,
      model: llmConfig.model,
      createdAt: this._now(),
    });

    const speakerMappings = this.repo.getSpeakerMappings(jobId);
    // CLI note generation uses no local GPU, so it skips the exclusive
    // inference lease entirely (nothing to sequence against WhisperX/llama).
    const isCli = llmConfig.provider === "claude-cli" || llmConfig.provider === "codex-cli";
    const lease = isCli
      ? null
      : await this.coordinator.acquire(jobId, { label: `notes:${llmConfig.model}` });
    let result;
    try {
      result = await compileNotes({
        transcript,
        jobId,
        profile: settings.profile,
        llm: isCli ? this._cliLlm(llmConfig) : this._localLlm(llmConfig, lease),
        generation: {
          provider: llmConfig.provider,
          model: llmConfig.model,
          temperature: 0.1,
          thinkingDisabled: llmConfig.disableThinking !== false,
        },
        glossary: Array.isArray(settings.hotwords) ? settings.hotwords : [],
        speakerMappings,
        strictVerification: strict,
        now: this._now,
        onProgress: ({ stage, completed, total }) => {
          if (stage === "note_validating" || stage === "note_rendering") transitionTo(stage);
          this._broadcast("whisperx-job-event", {
            jobId,
            status: this.repo.getJob(jobId).status,
            completed,
            total,
            unit: "segments",
          });
        },
      });
    } catch (error) {
      this.repo.updateNoteRun(noteRunId, {
        status: "failed",
        error_code: error.code || "NOTE_SCHEMA_INVALID",
        completed_at: this._now(),
      });
      throw error;
    } finally {
      if (lease) lease.release();
    }

    // Persist artifacts into the finalized job directory (single-file atomic
    // writes — the job dir itself was finalized after transcription).
    const finalDir = this.artifactStore.finalDir(jobId);
    const extractionDescriptor = this.artifactStore.writeFileAtomic(
      finalDir,
      "note-extraction.json",
      JSON.stringify(result.extraction, null, 2)
    );
    const notesDescriptor = this.artifactStore.writeFileAtomic(finalDir, "notes.md", result.markdown);

    const createdAt = this._now();
    const existing = this.repo
      .listArtifacts(jobId)
      .filter((a) => !["note-extraction", "notes-markdown"].includes(a.kind));
    this.repo.replaceArtifacts(jobId, [
      ...existing.map((a) => ({
        jobId,
        kind: a.kind,
        relativePath: a.relativePath,
        sha256: a.sha256,
        bytes: a.bytes,
        schemaVersion: a.schemaVersion ?? null,
        createdAt: a.createdAt,
      })),
      {
        jobId,
        kind: "note-extraction",
        relativePath: extractionDescriptor.relativePath,
        sha256: extractionDescriptor.sha256,
        bytes: extractionDescriptor.bytes,
        schemaVersion: result.extraction.schemaVersion,
        createdAt,
      },
      {
        jobId,
        kind: "notes-markdown",
        relativePath: notesDescriptor.relativePath,
        sha256: notesDescriptor.sha256,
        bytes: notesDescriptor.bytes,
        schemaVersion: null,
        createdAt,
      },
    ]);

    // Surface the notes as a regular OpenWhispr note (spec pipeline tail).
    // Regeneration UPDATES the note row from the previous successful run
    // instead of inserting a duplicate (review finding).
    let noteId = null;
    try {
      if (this.databaseManager && typeof this.databaseManager.saveNote === "function") {
        const job = this.repo.getJob(jobId);
        const previousRun = this.repo
          .listNoteRuns(jobId)
          .find((run) => run.status === "complete" && run.noteId);
        if (
          previousRun &&
          typeof this.databaseManager.updateNote === "function"
        ) {
          this.databaseManager.updateNote(previousRun.noteId, { content: result.markdown });
          noteId = previousRun.noteId;
        } else {
          const saved = this.databaseManager.saveNote(
            job.sourceDisplayName,
            result.markdown,
            "whisperx-recording",
            job.sourceDisplayName
          );
          noteId = saved && (saved.id ?? saved.lastInsertRowid ?? null);
        }
      }
    } catch (error) {
      this._log("warn", "Notes rendered but note row creation failed", {
        jobId,
        error: error.message,
      });
    }

    this.repo.updateNoteRun(noteRunId, {
      status: "complete",
      note_id: noteId,
      extraction_relative_path: extractionDescriptor.relativePath,
      notes_relative_path: notesDescriptor.relativePath,
      completed_at: this._now(),
    });

    transitionTo("complete");
    return {
      noteRunId,
      noteId,
      markdown: result.markdown,
      droppedItemIds: result.droppedItemIds,
      issues: result.validation.issues,
      failedChunks: result.failedChunks,
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
