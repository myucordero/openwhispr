#!/usr/bin/env node
// OpenWhispr WhisperX CLI — drives the desktop app's WhisperX recording-job
// pipeline (CLAUDE.md §18) over the loopback CLI bridge, for terminal and
// agentic use from any project. Zero dependencies; Node 20+.
//
// Conventions match @openwhispr/cli: noun-verb commands, bare JSON on pipes,
// human output on TTYs, exit codes 0 ok / 1 user error / 2 backend
// unreachable / 3 auth / 4 not found.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXIT = { OK: 0, USER: 1, UNREACHABLE: 2, AUTH: 3, NOT_FOUND: 4 };

const ACTIVE_STATES = new Set([
  "created",
  "queued",
  "validating",
  "preparing",
  "transcribing",
  "aligning",
  "diarizing",
  "canonicalizing",
  "persisting",
  "note_extracting",
  "note_validating",
  "note_rendering",
]);
const FAILURE_STATES = new Set(["cancelled", "failed", "interrupted"]);

const TRANSCRIPT_ARTIFACTS = {
  text: "transcript.raw.txt",
  srt: "transcript.srt",
  vtt: "transcript.vtt",
  md: "transcript.speakers.md",
};

class CliError extends Error {
  constructor(message, exitCode = EXIT.USER) {
    super(message);
    this.exitCode = exitCode;
  }
}

// --------------------------------------------------------------- bridge I/O

function readBridgeFile() {
  const bridgePath =
    process.env.OPENWHISPR_BRIDGE_FILE || path.join(os.homedir(), ".openwhispr", "cli-bridge.json");
  let raw;
  try {
    raw = fs.readFileSync(bridgePath, "utf8");
  } catch {
    throw new CliError(
      "Local desktop bridge unavailable (no ~/.openwhispr/cli-bridge.json). Start the OpenWhispr desktop app and retry.",
      EXIT.UNREACHABLE
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.port || !parsed.token) throw new Error("missing fields");
    return parsed;
  } catch {
    throw new CliError("Bridge file is malformed; restart the OpenWhispr desktop app.", EXIT.UNREACHABLE);
  }
}

async function request(method, pathname, { query, body } = {}) {
  const bridge = readBridgeFile();
  const url = new URL(`http://127.0.0.1:${bridge.port}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new CliError(
      "Local desktop bridge unreachable. Start the OpenWhispr desktop app and retry.",
      EXIT.UNREACHABLE
    );
  }
  if (res.status === 204) return null;
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (res.ok) return payload;
  const message = payload?.error?.message || `Bridge error (HTTP ${res.status})`;
  if (res.status === 401 || res.status === 403) throw new CliError(message, EXIT.AUTH);
  if (res.status === 404) throw new CliError(message, EXIT.NOT_FOUND);
  throw new CliError(message, EXIT.USER);
}

// ------------------------------------------------------------------- output

function wantsJson(flags) {
  if (flags.format === "json") return true;
  if (flags.format && flags.format !== "json") return false;
  return !process.stdout.isTTY;
}

function printData(data, flags, humanize) {
  if (wantsJson(flags) || !humanize) {
    process.stdout.write(`${JSON.stringify(data, null, wantsJson(flags) && process.stdout.isTTY ? 2 : 0)}\n`);
  } else {
    process.stdout.write(`${humanize(data)}\n`);
  }
}

function jobLine(job) {
  const bits = [job.id, job.status, job.profile];
  if (job.sourceDisplayName) bits.push(job.sourceDisplayName);
  if (job.errorCode) bits.push(`error=${job.errorCode}`);
  return bits.join("  ");
}

// ------------------------------------------------------------------ argv

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function intFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 0) throw new CliError(`--${name} must be a non-negative integer`);
  return n;
}

// ------------------------------------------------------ local (headless) mode
//
// Spawns the WhisperX sidecar worker directly (no desktop app) via
// `uv run python -m openwhispr_whisperx.worker`, one-shot per invocation.
// See CLAUDE.md §22 and docs/whisperx-reliable-notes.md.

// Profile defaults for local mode. MUST stay in sync with
// src/helpers/whisperx/profiles.js `PROFILES`.
const LOCAL_PROFILE_DEFAULTS = {
  memo: { model: "large-v3-turbo", computeType: "float16", batchSize: 4, alignment: true, diarization: false },
  meeting: { model: "large-v3-turbo", computeType: "float16", batchSize: 4, alignment: true, diarization: true },
  "critical-interview": { model: "large-v3", computeType: "float16", batchSize: 2, alignment: true, diarization: true },
};
const LOCAL_PROFILES = Object.keys(LOCAL_PROFILE_DEFAULTS);
// Mirrors src/helpers/whisperx/constants.js — kept inline so the CLI stays
// dependency-free and importable without the desktop app's helper tree.
const LOCAL_LANGUAGES = ["auto", "en", "es"];
const LOCAL_MODELS = ["large-v3-turbo", "large-v3"];
const LOCAL_COMPUTE_TYPES = ["float16", "int8"];
const LOCAL_BATCH_SIZES = [1, 2, 4, 8];
const LOCAL_DEVICES = ["cuda", "cpu"];
const LOCAL_DIARIZATION_PROVIDER = "pyannote-community-1";
// Limits mirror tools/whisperx-sidecar/src/openwhispr_whisperx/schemas.py:92-110
// (MAX_HOTWORDS, MAX_HOTWORD_LENGTH, MAX_INITIAL_PROMPT_LENGTH, MAX_SPEAKERS,
// CONTROL_CHAR_RE) so local mode rejects invalid requests before spawning the
// worker instead of surfacing a schema-validation error after the fact.
const LOCAL_MAX_HOTWORDS = 64;
const LOCAL_MAX_HOTWORD_LENGTH = 64;
const LOCAL_MAX_INITIAL_PROMPT_LENGTH = 2048;
const LOCAL_MAX_SPEAKERS = 32;
const LOCAL_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// Mirrors src/helpers/whisperx/redaction.js HF_TOKEN_RE — never let a leaked
// Hugging Face token reach stdout/stderr/error output.
const LOCAL_HF_TOKEN_RE = /\bhf_[A-Za-z0-9]{10,}\b/g;
const LOCAL_STDERR_CAPTURE_BYTES = 8192;
const LOCAL_DEFAULT_WORKER_TIMEOUT_SECONDS = 600;

function redactLocalStderr(text) {
  return text.replace(LOCAL_HF_TOKEN_RE, "[redacted]");
}

function buildLocalOverrides(flags) {
  const overrides = buildOverrides(flags);
  if (flags.device !== undefined) overrides.device = String(flags.device);
  return overrides;
}

// Pure request builder (no fs side effects) — the caller resolves/creates
// jobDirectory, modelCacheDirectory, temporaryDirectory before calling this.
// Field shapes mirror tools/whisperx-sidecar/src/openwhispr_whisperx/schemas.py
// WhisperXJobRequest and src/helpers/whisperx/recordingJobManager.js
// `_buildRequest`. NEVER add a credential-shaped key here — the worker
// schema rejects the request; secrets travel via env only.
export function buildLocalRequest(options) {
  const {
    sourcePath,
    displayName,
    profile = "memo",
    language = "auto",
    overrides = {},
    hotwords = [],
    allowModelDownload = false,
    requestId,
    jobId,
    jobDirectory,
    modelCacheDirectory,
    temporaryDirectory,
  } = options;

  const base = LOCAL_PROFILE_DEFAULTS[profile];
  if (!base) {
    throw new CliError(`Unknown profile "${profile}" (expected one of ${LOCAL_PROFILES.join(", ")})`);
  }
  if (!LOCAL_LANGUAGES.includes(language)) {
    throw new CliError(`Unknown language "${language}" (expected one of ${LOCAL_LANGUAGES.join(", ")})`);
  }

  const model = overrides.model !== undefined ? overrides.model : base.model;
  if (!LOCAL_MODELS.includes(model)) {
    throw new CliError(`Unknown model "${model}" (expected one of ${LOCAL_MODELS.join(", ")})`);
  }
  const computeType = overrides.computeType !== undefined ? overrides.computeType : base.computeType;
  if (!LOCAL_COMPUTE_TYPES.includes(computeType)) {
    throw new CliError(`Unknown compute-type "${computeType}" (expected one of ${LOCAL_COMPUTE_TYPES.join(", ")})`);
  }
  const batchSize = overrides.batchSize !== undefined ? overrides.batchSize : base.batchSize;
  if (!LOCAL_BATCH_SIZES.includes(batchSize)) {
    throw new CliError(`batch-size must be one of ${LOCAL_BATCH_SIZES.join(", ")}`);
  }
  const device = overrides.device !== undefined ? overrides.device : "cuda";
  if (!LOCAL_DEVICES.includes(device)) {
    throw new CliError('--device must be "cuda" or "cpu"');
  }
  const alignment = overrides.alignment !== undefined ? overrides.alignment : base.alignment;
  const diarization = overrides.diarization !== undefined ? overrides.diarization : base.diarization;

  const exactSpeakers = overrides.exactSpeakers;
  const minSpeakers = overrides.minSpeakers;
  const maxSpeakers = overrides.maxSpeakers;
  for (const [name, v] of [
    ["speakers", exactSpeakers],
    ["min-speakers", minSpeakers],
    ["max-speakers", maxSpeakers],
  ]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > LOCAL_MAX_SPEAKERS)) {
      throw new CliError(`--${name} must be an integer between 1 and ${LOCAL_MAX_SPEAKERS}`);
    }
  }
  if (exactSpeakers !== undefined && (minSpeakers !== undefined || maxSpeakers !== undefined)) {
    throw new CliError("--speakers cannot be combined with --min-speakers/--max-speakers");
  }
  if (minSpeakers !== undefined && maxSpeakers !== undefined && minSpeakers > maxSpeakers) {
    throw new CliError("--min-speakers must be <= --max-speakers");
  }

  const formats = ["canonical-json", "raw-txt"];
  if (diarization) formats.push("speaker-markdown");
  // Segment-level timestamps always exist, so subtitles are always produced.
  formats.push("srt", "vtt");

  const rawHotwords = Array.isArray(hotwords) ? hotwords.filter(Boolean).map(String) : [];
  if (rawHotwords.length > LOCAL_MAX_HOTWORDS) {
    throw new CliError(`--dictionary accepts at most ${LOCAL_MAX_HOTWORDS} words (got ${rawHotwords.length})`);
  }
  for (const word of rawHotwords) {
    if (word.length > LOCAL_MAX_HOTWORD_LENGTH) {
      throw new CliError(
        `--dictionary word "${word.slice(0, 20)}…" exceeds ${LOCAL_MAX_HOTWORD_LENGTH} characters`
      );
    }
    if (LOCAL_CONTROL_CHAR_RE.test(word) || word.includes("\n") || word.includes("\r")) {
      throw new CliError(`--dictionary words must not contain control characters ("${word}")`);
    }
  }
  const cleanHotwords = rawHotwords;
  // initialPrompt is derived, not user-authored directly: truncate rather
  // than error if the joined hotwords exceed the schema limit.
  const initialPrompt =
    cleanHotwords.length > 0 ? cleanHotwords.join(", ").slice(0, LOCAL_MAX_INITIAL_PROMPT_LENGTH) : undefined;

  const request = {
    protocolVersion: 1,
    requestId,
    jobId,
    source: { path: sourcePath, displayName },
    output: { jobDirectory, preserveNormalizedAudio: false, formats },
    profile,
    language,
    asr: {
      model,
      computeType,
      batchSize,
      device,
      hotwords: cleanHotwords,
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    },
    alignment: { enabled: alignment },
    diarization: {
      enabled: diarization,
      provider: LOCAL_DIARIZATION_PROVIDER,
      ...(exactSpeakers !== undefined ? { exactSpeakers } : {}),
      ...(minSpeakers !== undefined ? { minSpeakers } : {}),
      ...(maxSpeakers !== undefined ? { maxSpeakers } : {}),
    },
    runtime: {
      offline: !allowModelDownload,
      modelCacheDirectory,
      temporaryDirectory,
    },
  };

  return { request };
}

// The OOM retry ladder for local mode (spec 08 §6 / profiles.js OOM_LADDERS,
// simplified): same model, computeType -> int8, then device -> cpu. Max 2
// retries (3 attempts total).
function oomRetryLadder(asr) {
  return [
    { ...asr, computeType: "int8" },
    { ...asr, computeType: "int8", device: "cpu" },
  ];
}

function resolveSidecarDir() {
  if (process.env.OPENWHISPR_SIDECAR_DIR) return process.env.OPENWHISPR_SIDECAR_DIR;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, "..", "tools", "whisperx-sidecar");
}

function isOnPath(binary) {
  const pathEnv = process.env.PATH || "";
  return pathEnv.split(path.delimiter).some((dir) => {
    try {
      return fs.existsSync(path.join(dir, binary));
    } catch {
      return false;
    }
  });
}

function resolveFfmpegPathForLocal(cliDir) {
  if (isOnPath(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")) return null;
  const bundled = path.resolve(cliDir, "..", "node_modules", "ffmpeg-static", "ffmpeg");
  return fs.existsSync(bundled) ? bundled : null;
}

// Belt-and-braces cuDNN discovery fix (CTranslate2 dlopens cuDNN by soname;
// pip layouts put it off the default loader path — see CLAUDE.md §22).
function findCudnnLibDirs(sidecarDir) {
  const base = path.join(sidecarDir, ".venv", "lib", "python3.12", "site-packages", "nvidia");
  const dirs = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lib = path.join(base, entry.name, "lib");
    if (fs.existsSync(lib)) dirs.push(lib);
  }
  return dirs;
}

export function buildLocalWorkerEnv(sidecarDir, cliDir) {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "CUDA_VISIBLE_DEVICES"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONIOENCODING = "utf-8";
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (hfToken) env.HF_TOKEN = hfToken;
  const ffmpegPath = resolveFfmpegPathForLocal(cliDir);
  if (ffmpegPath) env.OPENWHISPR_FFMPEG_PATH = ffmpegPath;
  const cudnnDirs = findCudnnLibDirs(sidecarDir);
  const existingLdPath = process.env.LD_LIBRARY_PATH;
  const ldPath = [...cudnnDirs, existingLdPath].filter(Boolean).join(":");
  if (ldPath) env.LD_LIBRARY_PATH = ldPath;
  return env;
}

// Resolves the worker command/args/env. `OPENWHISPR_WORKER_CMD` is a
// TEST-ONLY escape hatch (see tests/whisperx/cliHeadless.test.cjs): when set,
// it overrides the sidecar worker entirely (space-split, spawned with no
// extra args) and the caller's full process.env is forwarded to the child —
// used to run the deterministic Node fake worker fixture instead of
// `uv run python -m openwhispr_whisperx.worker`. Never set in real usage.
function resolveWorkerCommand(sidecarDir, cliDir) {
  const override = process.env.OPENWHISPR_WORKER_CMD;
  if (override) {
    const parts = override.split(" ").filter(Boolean);
    return { command: parts[0], args: parts.slice(1), env: { ...process.env } };
  }
  return { command: "uv", args: ["run", "python", "-m", "openwhispr_whisperx.worker"], env: buildLocalWorkerEnv(sidecarDir, cliDir) };
}

// Spawns one worker attempt and resolves once it exits. Enforces an
// inactivity watchdog (no stdout line for `workerTimeoutSeconds` -> SIGTERM,
// then SIGKILL after 5s if it doesn't exit) and terminal-event integrity (a
// clean exit with no `complete` event is treated as a failure, never a silent
// success).
function runWorkerAttempt(request, sidecarDir, cliDir, workerTimeoutSeconds = LOCAL_DEFAULT_WORKER_TIMEOUT_SECONDS) {
  return new Promise((resolve, reject) => {
    const { command, args, env } = resolveWorkerCommand(sidecarDir, cliDir);
    let child;
    try {
      child = spawn(command, args, { cwd: sidecarDir, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      reject(
        new CliError(
          `Failed to spawn the WhisperX sidecar worker ("${command}"). Install uv (https://docs.astral.sh/uv/) or run the OpenWhispr desktop app instead. (${err.message})`
        )
      );
      return;
    }
    child.on("error", (err) => {
      reject(
        new CliError(
          `Failed to spawn the WhisperX sidecar worker ("${command}"). Install uv (https://docs.astral.sh/uv/) or run the OpenWhispr desktop app instead. (${err.message})`
        )
      );
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();

    let stderrBuf = Buffer.alloc(0);
    child.stderr.on("data", (chunk) => {
      stderrBuf = Buffer.concat([stderrBuf, chunk]);
      if (stderrBuf.length > LOCAL_STDERR_CAPTURE_BYTES) {
        stderrBuf = stderrBuf.subarray(stderrBuf.length - LOCAL_STDERR_CAPTURE_BYTES);
      }
    });

    let result = null;
    let workerError = null;
    let receivedComplete = false;
    let unparseableCount = 0;

    // Inactivity watchdog: reset on ANY stdout line (heartbeats included).
    let lastLineAt = Date.now();
    let killedByWatchdog = false;
    let watchdogInterval = null;
    let forceKillTimer = null;
    if (workerTimeoutSeconds > 0) {
      watchdogInterval = setInterval(() => {
        if (Date.now() - lastLineAt >= workerTimeoutSeconds * 1000) {
          killedByWatchdog = true;
          clearInterval(watchdogInterval);
          try {
            child.kill("SIGTERM");
          } catch {
            /* already dead */
          }
          forceKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already dead */
            }
          }, 5000);
        }
      }, 1000);
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      lastLineAt = Date.now();
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        unparseableCount++; // ignored as protocol, but counted for diagnostics
        return;
      }
      if (process.stderr.isTTY && (event.type === "stage" || event.type === "progress" || event.type === "warning")) {
        if (event.type === "stage") process.stderr.write(`stage: ${event.stage}\n`);
        else if (event.type === "progress") {
          process.stderr.write(`progress: ${event.stage} ${event.completed}${event.total ? `/${event.total}` : ""}\n`);
        } else {
          process.stderr.write(`warning: ${event.code} — ${event.message}\n`);
        }
      } else if (event.type === "complete") {
        result = event.result;
        receivedComplete = true;
      } else if (event.type === "error") {
        workerError = event.error;
      }
    });

    child.on("close", (code, signal) => {
      if (watchdogInterval) clearInterval(watchdogInterval);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const stderrText = redactLocalStderr(stderrBuf.toString("utf8")).trim();

      if (killedByWatchdog) {
        resolve({
          exitCode: 124,
          result: null,
          error: {
            code: "WORKER_INACTIVITY_TIMEOUT",
            message: `No worker output for ${workerTimeoutSeconds}s; killed the process`,
          },
          stderrText,
          unparseableCount,
          missingComplete: false,
        });
        return;
      }

      const exitCode = code !== null ? code : signal === "SIGTERM" ? 130 : 1;
      resolve({
        exitCode,
        result,
        error: workerError,
        stderrText,
        unparseableCount,
        missingComplete: exitCode === 0 && !receivedComplete,
      });
    });
  });
}

async function cmdTranscribeLocal(positional, flags) {
  const file = positional[0];
  if (!file) throw new CliError("Usage: openwhispr-whisperx transcribe <file> --local [options]");
  const sourcePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(sourcePath)) throw new CliError(`File not found: ${sourcePath}`);

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const sidecarDir = resolveSidecarDir();
  if (!fs.existsSync(sidecarDir)) {
    throw new CliError(
      `WhisperX sidecar not found at ${sidecarDir}. Run scripts/setup-whisperx.js, or set OPENWHISPR_SIDECAR_DIR, or run the OpenWhispr desktop app instead.`
    );
  }

  const profile = flags.profile !== undefined ? String(flags.profile) : "memo";
  const language = flags.language !== undefined ? String(flags.language) : "auto";
  const overrides = buildLocalOverrides(flags);
  const hotwords =
    flags.dictionary !== undefined
      ? String(flags.dictionary)
          .split(",")
          .map((word) => word.trim())
          .filter(Boolean)
      : [];
  const allowModelDownload = Boolean(flags["allow-model-download"]);
  const displayName = flags["display-name"] !== undefined ? String(flags["display-name"]) : path.basename(sourcePath);
  const workerTimeoutSeconds =
    flags["worker-timeout"] !== undefined ? intFlag(flags, "worker-timeout") : LOCAL_DEFAULT_WORKER_TIMEOUT_SECONDS;

  const jobId = crypto.randomUUID();
  const jobDirectory = path.join(os.homedir(), ".cache", "openwhispr", "headless-jobs", jobId);
  const temporaryDirectory = path.join(jobDirectory, "tmp");
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const modelCacheDirectory =
    process.env.OPENWHISPR_MODEL_CACHE || path.join(os.homedir(), ".cache", "openwhispr", "whisperx-models");
  fs.mkdirSync(modelCacheDirectory, { recursive: true });

  const { request: baseRequest } = buildLocalRequest({
    sourcePath,
    displayName,
    profile,
    language,
    overrides,
    hotwords,
    allowModelDownload,
    requestId: crypto.randomUUID(),
    jobId,
    jobDirectory,
    modelCacheDirectory,
    temporaryDirectory,
  });

  const MAX_RETRIES = 2;
  const attempts = [];
  let request = baseRequest;
  let outcome = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    outcome = await runWorkerAttempt(request, sidecarDir, cliDir, workerTimeoutSeconds);
    attempts.push({
      requestId: request.requestId,
      profile: request.profile,
      language: request.language,
      asr: { ...request.asr },
      alignment: request.alignment.enabled,
      diarization: request.diarization.enabled,
      exitCode: outcome.exitCode,
    });
    if (outcome.exitCode === 3 && attempt < MAX_RETRIES) {
      const next = oomRetryLadder(baseRequest.asr)[attempt];
      process.stderr.write(
        `CUDA out of memory — retrying with computeType=${next.computeType}${next.device !== request.asr.device ? `, device=${next.device}` : ""}\n`
      );
      request = { ...request, requestId: crypto.randomUUID(), asr: next };
      continue;
    }
    break;
  }

  if (outcome.exitCode === 130) {
    process.exitCode = 130;
    return;
  }

  const failed = outcome.exitCode !== 0 || outcome.missingComplete;
  if (failed) {
    let message;
    if (outcome.missingComplete) {
      message = "worker exited without a complete event";
    } else if (outcome.error) {
      message = `Worker error ${outcome.error.code}: ${outcome.error.message}`;
    } else {
      message = outcome.stderrText
        ? `Worker exited with code ${outcome.exitCode}:\n${outcome.stderrText}`
        : `Worker exited with code ${outcome.exitCode}`;
    }
    if (outcome.unparseableCount > 0) {
      message += ` (${outcome.unparseableCount} unparseable stdout line${outcome.unparseableCount === 1 ? "" : "s"})`;
    }

    // Best-effort manifest write on total failure so the job dir still
    // records what was attempted and why it failed.
    try {
      fs.mkdirSync(jobDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(jobDirectory, "manifest.json"),
        JSON.stringify(
          {
            jobId,
            createdAt: new Date().toISOString(),
            source: baseRequest.source,
            settings: attempts,
            error: outcome.missingComplete
              ? { code: "WORKER_NO_COMPLETE_EVENT", message: "worker exited without a complete event" }
              : outcome.error || { code: "WORKER_EXIT", message: `Worker exited with code ${outcome.exitCode}` },
          },
          null,
          2
        )
      );
    } catch {
      /* never mask the real failure with a manifest-write error */
    }

    throw new CliError(message, EXIT.USER);
  }

  const manifest = {
    jobId,
    createdAt: new Date().toISOString(),
    source: baseRequest.source,
    settings: attempts,
    result: outcome.result,
  };
  fs.writeFileSync(path.join(jobDirectory, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (flags.text) {
    const text = fs.readFileSync(path.join(jobDirectory, TRANSCRIPT_ARTIFACTS.text), "utf8");
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  printData({ jobDirectory, result: outcome.result }, flags, (d) => `job directory: ${d.jobDirectory}`);
}

// ---------------------------------------------------------------- commands

async function cmdDoctor(flags) {
  let readiness = null;
  let reachable = false;
  try {
    readiness = (await request("GET", "/v1/recordings/readiness"))?.data;
    reachable = true;
  } catch (err) {
    if (err instanceof CliError && err.exitCode !== EXIT.USER) {
      printData({ reachable: false, error: err.message }, flags, (d) => `bridge: unreachable — ${d.error}`);
      process.exitCode = err.exitCode;
      return;
    }
    throw err;
  }
  printData({ reachable, readiness }, flags, (d) => {
    const lines = [`bridge: ok`, `runtime installed: ${d.readiness?.runtimeInstalled}`];
    for (const blocker of d.readiness?.blockers || []) lines.push(`blocker: ${blocker.code} — ${blocker.message}`);
    return lines.join("\n");
  });
}

async function cmdReadiness(flags) {
  const { data } = await request("GET", "/v1/recordings/readiness");
  printData(data, flags);
}

function buildOverrides(flags) {
  const overrides = {};
  if (flags.language !== undefined) overrides.language = String(flags.language);
  if (flags.model !== undefined) overrides.model = String(flags.model);
  if (flags["compute-type"] !== undefined) overrides.computeType = String(flags["compute-type"]);
  const batchSize = intFlag(flags, "batch-size");
  if (batchSize !== undefined) overrides.batchSize = batchSize;
  if (flags["no-align"]) overrides.alignment = false;
  if (flags.diarize) overrides.diarization = true;
  if (flags["no-diarize"]) overrides.diarization = false;
  const speakers = intFlag(flags, "speakers");
  if (speakers !== undefined) overrides.exactSpeakers = speakers;
  const minSpeakers = intFlag(flags, "min-speakers");
  if (minSpeakers !== undefined) overrides.minSpeakers = minSpeakers;
  const maxSpeakers = intFlag(flags, "max-speakers");
  if (maxSpeakers !== undefined) overrides.maxSpeakers = maxSpeakers;
  return overrides;
}

async function pollUntilSettled(jobId, flags) {
  const pollSeconds = intFlag(flags, "poll") ?? 5;
  const timeoutSeconds = intFlag(flags, "timeout") ?? 0;
  const startedAt = Date.now();
  let lastStatus = null;
  for (;;) {
    const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(jobId)}`);
    const job = data.job;
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      if (process.stderr.isTTY) process.stderr.write(`${new Date().toISOString()} ${job.status}\n`);
    }
    if (!ACTIVE_STATES.has(job.status)) return data;
    if (timeoutSeconds > 0 && Date.now() - startedAt > timeoutSeconds * 1000) {
      throw new CliError(`Timed out after ${timeoutSeconds}s waiting for job ${jobId} (status: ${job.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

async function cmdTranscribe(positional, flags) {
  if (flags.local) return cmdTranscribeLocal(positional, flags);
  try {
    return await cmdTranscribeBridge(positional, flags);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT.UNREACHABLE && fs.existsSync(resolveSidecarDir())) {
      process.stderr.write("desktop bridge unavailable — running locally via the WhisperX sidecar\n");
      return cmdTranscribeLocal(positional, flags);
    }
    throw err;
  }
}

async function cmdTranscribeBridge(positional, flags) {
  const file = positional[0];
  if (!file) throw new CliError("Usage: openwhispr-whisperx transcribe <file> [options]");
  const sourcePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(sourcePath)) throw new CliError(`File not found: ${sourcePath}`);

  const body = { source_path: sourcePath };
  if (flags.profile !== undefined) body.profile = String(flags.profile);
  if (flags["display-name"] !== undefined) body.display_name = String(flags["display-name"]);
  if (flags.dictionary !== undefined) {
    body.custom_dictionary = String(flags.dictionary)
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean);
  }
  if (flags["allow-model-download"]) body.allow_model_download = true;
  const overrides = buildOverrides(flags);
  if (Object.keys(overrides).length > 0) body.overrides = overrides;
  if (flags["notes-provider"] || flags["notes-model"]) {
    body.note_generation = {};
    if (flags["notes-provider"]) body.note_generation.provider = String(flags["notes-provider"]);
    if (flags["notes-model"]) body.note_generation.model = String(flags["notes-model"]);
  }

  const { data: job } = await request("POST", "/v1/recordings/create", { body });

  if (!flags.wait && !flags.text) {
    printData(job, flags, jobLine);
    return;
  }

  const settled = await pollUntilSettled(job.id, flags);
  if (FAILURE_STATES.has(settled.job.status)) {
    throw new CliError(
      `Job ${settled.job.id} ${settled.job.status}${settled.job.errorCode ? `: ${settled.job.errorCode}` : ""}`
    );
  }
  if (flags.text) {
    const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(job.id)}/artifact`, {
      query: { path: TRANSCRIPT_ARTIFACTS.text },
    });
    process.stdout.write(data.text.endsWith("\n") ? data.text : `${data.text}\n`);
    return;
  }
  printData(settled, flags, (d) => [jobLine(d.job), ...d.artifacts.map((a) => `artifact: ${a.relativePath ?? a.path ?? a}`)].join("\n"));
}

async function cmdJobs(positional, flags) {
  const verb = positional[0];
  const id = positional[1];
  switch (verb) {
    case "list": {
      const { data } = await request("GET", "/v1/recordings/list", {
        query: { status: flags.status, limit: flags.limit, offset: flags.offset },
      });
      printData(data, flags, (jobs) => jobs.map(jobLine).join("\n") || "(no jobs)");
      return;
    }
    case "get": {
      if (!id) throw new CliError("Usage: openwhispr-whisperx jobs get <id>");
      const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(id)}`);
      printData(data, flags, (d) => [jobLine(d.job), ...d.artifacts.map((a) => `artifact: ${a.relativePath ?? a.path ?? a}`)].join("\n"));
      return;
    }
    case "cancel":
    case "retry": {
      if (!id) throw new CliError(`Usage: openwhispr-whisperx jobs ${verb} <id>`);
      const { data } = await request("POST", `/v1/recordings/${encodeURIComponent(id)}/${verb}`, { body: {} });
      printData(data, flags, (d) => (d?.id ? jobLine(d) : JSON.stringify(d)));
      return;
    }
    case "delete": {
      if (!id) throw new CliError("Usage: openwhispr-whisperx jobs delete <id>");
      await request("DELETE", `/v1/recordings/${encodeURIComponent(id)}`);
      if (process.stdout.isTTY) process.stdout.write(`deleted ${id}\n`);
      return;
    }
    default:
      throw new CliError("Usage: openwhispr-whisperx jobs <list|get|cancel|retry|delete> [id]");
  }
}

async function cmdTranscript(positional, flags) {
  const id = positional[0];
  if (!id) throw new CliError("Usage: openwhispr-whisperx transcript <id> [--format json|text|srt|vtt|md]");
  const format = flags.format && flags.format !== "json" ? String(flags.format) : wantsJson(flags) ? "json" : "text";
  if (format === "json") {
    const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(id)}/transcript`, {
      query: { offset: flags.offset, limit: flags.limit },
    });
    process.stdout.write(`${JSON.stringify(data, null, process.stdout.isTTY ? 2 : 0)}\n`);
    return;
  }
  const artifact = TRANSCRIPT_ARTIFACTS[format];
  if (!artifact) throw new CliError(`Unknown transcript format "${format}" (json|text|srt|vtt|md)`);
  const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(id)}/artifact`, {
    query: { path: artifact, max_bytes: flags["max-bytes"] },
  });
  process.stdout.write(data.text.endsWith("\n") ? data.text : `${data.text}\n`);
}

async function cmdNotes(positional, flags) {
  const verb = positional[0];
  const id = positional[1];
  if (!id) throw new CliError("Usage: openwhispr-whisperx notes <generate|list|get> <id>");
  switch (verb) {
    case "generate": {
      const body = {};
      if (flags.provider) body.provider = String(flags.provider);
      if (flags.model) body.model = String(flags.model);
      if (flags.strict) body.strict = true;
      const { data } = await request("POST", `/v1/recordings/${encodeURIComponent(id)}/notes`, { body });
      printData(data, flags);
      return;
    }
    case "list": {
      const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(id)}/notes`);
      printData(data, flags);
      return;
    }
    case "get": {
      const { data } = await request("GET", `/v1/recordings/${encodeURIComponent(id)}/artifact`, {
        query: { path: "notes.md" },
      });
      process.stdout.write(data.text.endsWith("\n") ? data.text : `${data.text}\n`);
      return;
    }
    default:
      throw new CliError("Usage: openwhispr-whisperx notes <generate|list|get> <id>");
  }
}

const USAGE = `openwhispr-whisperx — local WhisperX transcription via the OpenWhispr desktop app

Usage:
  openwhispr-whisperx doctor
  openwhispr-whisperx readiness
  openwhispr-whisperx transcribe <file> [--profile memo|meeting|critical-interview]
      [--language <code>] [--diarize|--no-diarize] [--speakers N]
      [--min-speakers N] [--max-speakers N] [--model <id>] [--compute-type <t>]
      [--batch-size N] [--no-align] [--dictionary w1,w2] [--display-name <s>]
      [--allow-model-download] [--notes-provider <p>] [--notes-model <m>]
      [--wait] [--poll SECONDS] [--timeout SECONDS] [--text]
      [--local] [--device cuda|cpu] [--worker-timeout SECONDS]
      (--local spawns the WhisperX sidecar worker directly, no desktop app
       needed — auto-fallback also kicks in when the desktop bridge is
       unreachable and the sidecar is installed; --wait/--poll/--timeout are
       bridge-only and ignored in local mode; --worker-timeout is the local-mode
       inactivity watchdog, default 600s, 0 disables)
  openwhispr-whisperx jobs <list|get|cancel|retry|delete> [id] [--status s] [--limit N]
  openwhispr-whisperx transcript <id> [--format json|text|srt|vtt|md]
  openwhispr-whisperx notes <generate|list|get> <id> [--provider p] [--model m] [--strict]

All commands accept --format json. Exit codes: 0 ok, 1 user error,
2 desktop bridge unreachable, 3 auth failure, 4 not found.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "doctor":
      return cmdDoctor(flags);
    case "readiness":
    case "status":
      return cmdReadiness(flags);
    case "transcribe":
      return cmdTranscribe(positional, flags);
    case "jobs":
      return cmdJobs(positional, flags);
    case "transcript":
      return cmdTranscript(positional, flags);
    case "notes":
      return cmdNotes(positional, flags);
    case "version":
    case "--version":
      process.stdout.write("openwhispr-whisperx 0.1.0\n");
      return;
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(`${USAGE}\n`);
      if (command === undefined) process.exitCode = EXIT.USER;
      return;
    default:
      throw new CliError(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

// Execution gate: run main() only when invoked directly, not when imported by
// tests. import.meta.url is the module's REAL path (Node resolves the main
// entry through symlinks), so argv[1] must be realpath'd too — otherwise
// invocation via a ~/.local/bin or npm-bin symlink silently does nothing.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  let entry = process.argv[1];
  try {
    entry = fs.realpathSync(entry);
  } catch {
    /* keep the raw path */
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
  main().catch((err) => {
    const exitCode = err instanceof CliError ? err.exitCode : EXIT.USER;
    process.stderr.write(`${err.message}\n`);
    process.exitCode = exitCode;
  });
}
