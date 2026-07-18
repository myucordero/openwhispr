const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { isPortAvailable } = require("../utils/serverUtils");
const { redactText } = require("./whisperx/redaction");

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8219;
const HOST = "127.0.0.1";
const BRIDGE_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const NO_CONTENT = Symbol("CliBridge.NoContent");

// Recording sources accepted over the bridge. The renderer path gates
// extensions in the upload UI/dialog (CLAUDE.md §21); the bridge has no dialog
// in front of it, so it applies the same audio + MP4-family list itself. The
// worker's probe/decode stages remain the authoritative audio check.
const RECORDING_SOURCE_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".webm",
  ".ogg",
  ".oga",
  ".flac",
  ".aac",
  ".mp4",
  ".m4v",
]);

// WhisperX main-process error codes → HTTP status + v1 error code. Codes not
// listed fall through to 500/internal_error.
const WHISPERX_HTTP_ERRORS = {
  AUDIO_FILE_NOT_FOUND: { status: 404, code: "not_found" },
  WORKER_PROTOCOL_ERROR: { status: 400, code: "validation_error" },
  OUTPUT_PATH_REJECTED: { status: 400, code: "validation_error" },
  NOTE_MODEL_UNAVAILABLE: { status: 409, code: "conflict" },
  RUNTIME_NOT_INSTALLED: { status: 503, code: "service_unavailable" },
  // Surfaced by readArtifact when a file exceeds the read cap.
  ARTIFACT_WRITE_FAILED: { status: 413, code: "payload_too_large" },
};

function getBridgeFilePath() {
  return path.join(os.homedir(), ".openwhispr", "cli-bridge.json");
}

async function findAvailablePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // Accumulate Buffers and decode once: per-chunk string concatenation
    // corrupts multibyte UTF-8 split across chunk boundaries, and counting
    // UTF-16 code units would under-enforce the byte cap.
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (bytes === 0) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reject(new Error("Invalid JSON payload"));
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(new Error("Request body must be a JSON object"));
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function sendV1Error(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function parseIdParam(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function unwrapMutationResult(result, label) {
  if (!result?.success || !result[label]) {
    throw new Error(result?.error || `Failed to write ${label}`);
  }
  return result[label];
}

class CliBridge {
  constructor(ipcHandlers) {
    this.ipcHandlers = ipcHandlers;
    this.server = null;
    this.port = null;
    this.token = null;
    this.bridgeFilePath = getBridgeFilePath();
    this.routes = this._buildRouteTable();
  }

  async start() {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.port = await findAvailablePort();
    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: err.message }, "cli-bridge");
        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeBridgeFile();
    debugLogger.info("CLI bridge started", { port: this.port }, "cli-bridge");
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.token = null;
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile() {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.token,
    });
    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });
    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: err.message }, "cli-bridge");
    }
  }

  _removeBridgeFile() {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        debugLogger.debug("CLI bridge file removal failed", { error: err.message }, "cli-bridge");
      }
    }
  }

  async _handleRequest(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      sendV1Error(res, 403, "forbidden", "Forbidden");
      return;
    }

    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${this.token}`;
    if (
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);
    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");
      return;
    }

    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", err.message);
        return;
      }
    }

    try {
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT) {
        sendNoContent(res);
        return;
      }
      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      this._sendError(res, err);
    }
  }

  _sendError(res, err) {
    if (err.code === "NOT_FOUND") {
      sendV1Error(res, 404, "not_found", err.message);
      return;
    }
    if (err.code === "VALIDATION") {
      sendV1Error(res, 400, "validation_error", err.message);
      return;
    }
    const whisperx = WHISPERX_HTTP_ERRORS[err.code];
    if (whisperx) {
      sendV1Error(res, whisperx.status, whisperx.code, redactText(err.message || ""));
      return;
    }
    // whisperxMain reports a missing job as UNKNOWN_INTERNAL_ERROR("Job not
    // found") rather than a dedicated code — surface it as a 404 here.
    if (err.code === "UNKNOWN_INTERNAL_ERROR" && /job not found/i.test(err.message || "")) {
      sendV1Error(res, 404, "not_found", err.message);
      return;
    }
    debugLogger.error("CLI bridge route error", { error: redactText(err.message || "") }, "cli-bridge");
    sendV1Error(res, 500, "internal_error", redactText(err.message || "Internal server error"));
  }

  _matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);
      if (params) return { ...route, params };
    }
    return null;
  }

  _buildRouteTable() {
    const exact = (method, path, handler, status) => ({
      method,
      match: (p) => (p === path ? {} : null),
      handler,
      status,
    });
    const param = (method, prefix, suffix, paramName, handler, status) => ({
      method,
      match: (p) => {
        if (!p.startsWith(prefix)) return null;
        const rest = p.slice(prefix.length);
        if (suffix) {
          if (!rest.endsWith(suffix)) return null;
          const value = rest.slice(0, rest.length - suffix.length);
          if (!value || value.includes("/")) return null;
          return { [paramName]: value };
        }
        if (rest.includes("/")) return null;
        return { [paramName]: rest };
      },
      handler,
      status,
    });

    const db = this.ipcHandlers.databaseManager;
    const ipc = this.ipcHandlers;

    const requireId = (params, label) => {
      const id = parseIdParam(params.id);
      if (id == null) {
        const err = new Error(`Invalid ${label} id`);
        err.code = "NOT_FOUND";
        throw err;
      }
      return id;
    };

    const requireSuccess = (result, message) => {
      if (!result?.success) {
        const err = new Error(result?.error || message);
        err.code = "NOT_FOUND";
        throw err;
      }
    };

    return [
      exact("GET", "/v1/health", () => ({ data: { ok: true, version: 1 } })),
      exact("GET", "/v1/notes/list", ({ query }) => {
        const noteType = query.get("note_type") || null;
        const limit = query.get("limit") ? Number(query.get("limit")) : 100;
        const folderId = query.get("folder_id") ? Number(query.get("folder_id")) : null;
        const notes = db.getNotes(noteType, limit, folderId);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/notes/search", ({ query }) => {
        const q = query.get("q") || "";
        if (!q.trim()) {
          const err = new Error("Search query is required");
          err.code = "VALIDATION";
          throw err;
        }
        const limit = query.get("limit") ? Number(query.get("limit")) : 20;
        const notes = db.searchNotes(q, limit);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      param("GET", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const note = db.getNote(id);
        if (!note || note.deleted_at) {
          const err = new Error(`Note ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: note };
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const result = db.saveNote(
            body.title ?? "Untitled Note",
            body.content ?? "",
            body.note_type ?? "personal",
            body.source_file ?? null,
            body.audio_duration_seconds ?? null,
            body.folder_id ?? null
          );
          const note = unwrapMutationResult(result, "note");
          setImmediate(() => ipc.broadcastToWindows("note-added", note));
          ipc._asyncVectorUpsert(note);
          ipc._asyncMirrorWrite(note);
          return { data: note };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", "id", ({ params, body }) => {
        const id = requireId(params, "note");
        const result = db.updateNote(id, body || {});
        const note = unwrapMutationResult(result, "note");
        setImmediate(() => ipc.broadcastToWindows("note-updated", note));
        ipc._asyncVectorUpsert(note);
        ipc._asyncMirrorWrite(note);
        return { data: note };
      }),
      param("DELETE", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const result = ipc.deleteNoteInternal(id);
        requireSuccess(result, `Note ${id} not found`);
        return NO_CONTENT;
      }),
      exact("GET", "/v1/folders/list", () => {
        return { data: db.getFolders(), has_more: false, next_cursor: null };
      }),
      exact(
        "POST",
        "/v1/folders/create",
        ({ body }) => {
          const result = db.createFolder(body?.name);
          const folder = unwrapMutationResult(result, "folder");
          setImmediate(() => ipc.broadcastToWindows("folder-created", folder));
          return { data: folder };
        },
        201
      ),
      exact("GET", "/v1/transcriptions/list", ({ query }) => {
        const limit = query.get("limit") ? Number(query.get("limit")) : 50;
        return {
          data: db.getTranscriptions(limit),
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const transcription = db.getTranscriptionById(id);
        if (!transcription || transcription.deleted_at) {
          const err = new Error(`Transcription ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: transcription };
      }),
      param("DELETE", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.deleteTranscriptionInternal(id);
        requireSuccess(result, `Transcription ${id} not found`);
        return NO_CONTENT;
      }),
      param("DELETE", "/v1/transcriptions/", "/audio", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.audioStorageManager.deleteAudio(id);
        if (!result?.success) {
          throw new Error(`Failed to delete audio for transcription ${id}`);
        }
        db.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
        return NO_CONTENT;
      }),
      ...this._buildRecordingRoutes({ exact, param }),
    ];
  }

  // WhisperX recording jobs (fork feature, CLAUDE.md §18) exposed to the CLI.
  // Everything funnels through whisperxMain, which owns validation, path
  // confinement, GPU coordination, and redaction — the bridge only maps HTTP
  // to that surface and gates the one input the renderer flow gates via a
  // dialog: the source file extension.
  _buildRecordingRoutes({ exact, param }) {
    const whisperx = () => {
      const manager = this.ipcHandlers.whisperxMain;
      if (!manager) {
        const err = new Error("WhisperX is not available in this build");
        err.code = "RUNTIME_NOT_INSTALLED";
        throw err;
      }
      return manager;
    };

    const validation = (message) => {
      const err = new Error(message);
      err.code = "VALIDATION";
      return err;
    };

    const parsePositiveInt = (value, fallback = undefined) => {
      if (value === null || value === undefined || value === "") return fallback;
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 ? n : fallback;
    };

    return [
      exact("GET", "/v1/recordings/readiness", async () => ({
        data: await whisperx().getReadiness(),
      })),
      exact("GET", "/v1/recordings/list", ({ query }) => {
        const opts = {};
        const status = query.get("status");
        if (status) opts.status = status;
        const limit = parsePositiveInt(query.get("limit"));
        if (limit !== undefined) opts.limit = limit;
        const offset = parsePositiveInt(query.get("offset"));
        if (offset !== undefined) opts.offset = offset;
        const { jobs } = whisperx().listJobs(opts);
        return { data: jobs, has_more: false, next_cursor: null };
      }),
      exact(
        "POST",
        "/v1/recordings/create",
        async ({ body }) => {
          const sourcePath = body.source_path;
          if (typeof sourcePath !== "string" || !sourcePath.trim()) {
            throw validation("source_path is required");
          }
          if (!path.isAbsolute(sourcePath)) {
            throw validation("source_path must be an absolute path");
          }
          const ext = path.extname(sourcePath).toLowerCase();
          if (!RECORDING_SOURCE_EXTENSIONS.has(ext)) {
            throw validation(
              `Unsupported source extension "${ext}". Supported: ${[...RECORDING_SOURCE_EXTENSIONS].join(", ")}`
            );
          }
          const payload = { sourcePath };
          if (body.display_name !== undefined) payload.displayName = body.display_name;
          if (body.profile !== undefined) payload.profile = body.profile;
          // Engine override keys (language, model, computeType, batchSize,
          // alignment, diarization, diarizationProvider, exactSpeakers,
          // minSpeakers, maxSpeakers) pass through verbatim — whisperxMain
          // validates against its allowlist.
          if (body.overrides !== undefined) payload.overrides = body.overrides;
          if (body.custom_dictionary !== undefined) payload.customDictionary = body.custom_dictionary;
          if (body.allow_model_download !== undefined)
            payload.allowModelDownload = body.allow_model_download;
          if (body.note_generation !== undefined) payload.noteGeneration = body.note_generation;
          const { job } = await whisperx().startJob(payload);
          return { data: job };
        },
        201
      ),
      param("GET", "/v1/recordings/", "", "id", ({ params }) => ({
        data: whisperx().getJob(params.id),
      })),
      param("POST", "/v1/recordings/", "/cancel", "id", async ({ params }) => ({
        data: await whisperx().cancelJob(params.id),
      })),
      param("POST", "/v1/recordings/", "/retry", "id", ({ params }) => ({
        data: whisperx().retryJob(params.id).job,
      })),
      param("DELETE", "/v1/recordings/", "", "id", ({ params }) => {
        whisperx().deleteJob(params.id);
        return NO_CONTENT;
      }),
      param("GET", "/v1/recordings/", "/transcript", "id", ({ params, query }) => ({
        data: whisperx().readTranscriptPage({
          jobId: params.id,
          offset: parsePositiveInt(query.get("offset"), 0),
          limit: parsePositiveInt(query.get("limit")),
        }),
      })),
      param("GET", "/v1/recordings/", "/artifact", "id", ({ params, query }) => {
        const relativePath = query.get("path");
        if (!relativePath) throw validation("path query parameter is required");
        return {
          data: whisperx().readArtifactText({
            jobId: params.id,
            relativePath,
            maxBytes: parsePositiveInt(query.get("max_bytes")),
          }),
        };
      }),
      param("GET", "/v1/recordings/", "/notes", "id", ({ params }) => ({
        data: whisperx().listNoteRuns(params.id).noteRuns,
        has_more: false,
        next_cursor: null,
      })),
      param("POST", "/v1/recordings/", "/notes", "id", async ({ params, body }) => {
        let llm;
        if (body.provider || body.model) {
          llm = {};
          if (body.provider !== undefined) llm.provider = body.provider;
          if (body.model !== undefined) llm.model = body.model;
          // Real booleans only — Boolean("false") === true would invert intent.
          if (typeof body.disable_thinking === "boolean")
            llm.disableThinking = body.disable_thinking;
        }
        const strict = typeof body.strict === "boolean" ? body.strict : undefined;
        return { data: await whisperx().generateNotes(params.id, { llm, strict }) };
      }),
    ];
  }
}

module.exports = CliBridge;
module.exports.getBridgeFilePath = getBridgeFilePath;
