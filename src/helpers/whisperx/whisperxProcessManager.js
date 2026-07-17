// WhisperX worker process manager (spec 02 §5, 07 §5).
// Runs ONE worker process per job attempt: spawn (shell:false, allowlisted
// env, detached process group on POSIX), write a single JSONL request line,
// consume protocol events through JsonlLineReader/ProtocolSession, enforce a
// heartbeat watchdog and an absolute deadline, capture bounded redacted
// stderr, and guarantee process-tree termination on cancel/timeout/dispose.
//
// The executable/args come from the trusted runtime manager — never from the
// renderer. The HF token is injected as an env var only when diarization
// needs it and never appears in args or logs.

const { spawn, execFile, execFileSync } = require("child_process");

const { JsonlLineReader, ProtocolSession, ProtocolError } = require("./jsonlProtocol");
const { BoundedRedactedCapture, redactText, isSensitiveEnvKey } = require("./redaction");
const { LIMITS } = require("./constants");

class WhisperXProcessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WhisperXProcessError";
    this.code = code;
    this.details = details;
  }
}

// Environment allowlist: the worker gets a minimal env, not process.env.
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "LANG",
  "LC_ALL",
  "CUDA_VISIBLE_DEVICES",
  "PYTHONIOENCODING",
];

function buildWorkerEnv({ baseEnv = process.env, extraEnv = {}, hfToken = null } = {}) {
  const env = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || "utf-8";
  env.PYTHONUNBUFFERED = "1";
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  if (hfToken) env.HF_TOKEN = hfToken;
  return env;
}

// Enumerates every live descendant of rootPid by walking the ps ppid table.
// A descendant that called setsid() leaves the process group but keeps its
// parent, so a ppid walk still finds it while the parent chain is alive.
function listDescendantsPosix(rootPid) {
  try {
    const out = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
    const childrenByParent = new Map();
    for (const line of out.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
      childrenByParent.get(ppid).push(pid);
    }
    const descendants = [];
    const stack = [rootPid];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const childPid of childrenByParent.get(current) || []) {
        descendants.push(childPid);
        stack.push(childPid);
      }
    }
    return descendants;
  } catch {
    return [];
  }
}

function signalPosixTree(child, descendants, signal) {
  // Group signal covers the worker and same-group children…
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
  // …and explicit per-pid signals cover descendants that made their own
  // session/group via setsid/detached spawn.
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

function killProcessTree(child, { forceAfterMs = 5000, setTimeoutFn = setTimeout } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve("already-exited");
      return;
    }
    let settled = false;
    const finish = (how) => {
      if (!settled) {
        settled = true;
        resolve(how);
      }
    };
    child.once("exit", () => finish("exited"));

    if (process.platform === "win32") {
      // taskkill /T kills the whole tree; args are a fixed array (no shell).
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {
        // taskkill failure (already dead / access) — fall through to kill().
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      });
    } else {
      // Collect descendants BEFORE signaling — once the worker dies its
      // orphans reparent to init and the ppid walk can no longer find them.
      const descendants = listDescendantsPosix(child.pid);
      signalPosixTree(child, descendants, "SIGTERM");
      const timer = setTimeoutFn(() => {
        const survivors = new Set([...descendants, ...listDescendantsPosix(child.pid)]);
        signalPosixTree(child, [...survivors], "SIGKILL");
      }, forceAfterMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
  });
}

class WhisperXProcessRun {
  // options:
  //   command, args        — trusted executable + args (runtime manager)
  //   cwd                  — trusted working directory
  //   request              — validated WhisperXJobRequest (already validated!)
  //   hfToken              — optional secret, env-only
  //   extraEnv             — allowlisted additions (e.g. HF_HUB_OFFLINE)
  //   heartbeatTimeoutMs   — max silence between protocol events (default 90s)
  //   absoluteTimeoutMs    — hard cap for the whole run (default 3h)
  //   onEvent(event)       — every valid protocol event (progress UI)
  //   logger               — debugLogger-compatible (optional)
  constructor(options) {
    this.options = options;
    this.child = null;
    this.stderrCapture = new BoundedRedactedCapture(LIMITS.MAX_STDERR_CAPTURE_BYTES);
    this.session = new ProtocolSession();
    this.reader = new JsonlLineReader();
    this.events = [];
    this.artifacts = [];
    this.warnings = [];
    this.completion = null;
    this.workerError = null;
    this.cancelled = false;
    this.timedOut = false;
    this._timers = { heartbeat: null, absolute: null };
    this._setTimeout = options.setTimeoutFn || setTimeout;
    this._clearTimeout = options.clearTimeoutFn || clearTimeout;
  }

  // Runs the worker to completion. Resolves with
  //   { completion, artifacts, warnings, events, stderr }
  // Throws WhisperXProcessError with a stable code otherwise.
  run() {
    if (this._promise) return this._promise;
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._start();
    });
    return this._promise;
  }

  async cancel() {
    this.cancelled = true;
    if (this.child) {
      await killProcessTree(this.child, { setTimeoutFn: this._setTimeout });
    }
  }

  _start() {
    const {
      command,
      args = [],
      cwd,
      request,
      hfToken = null,
      extraEnv = {},
      spawnFn = spawn,
    } = this.options;

    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        env: buildWorkerEnv({ extraEnv, hfToken }),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this._fail(
        new WhisperXProcessError("PYTHON_START_FAILED", "Failed to spawn worker", {
          message: redactText(error.message),
        })
      );
      return;
    }
    this.child = child;

    child.once("error", (error) => {
      this._fail(
        new WhisperXProcessError("PYTHON_START_FAILED", "Worker process error", {
          message: redactText(error.message),
        })
      );
    });

    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.on("data", (chunk) => this.stderrCapture.append(chunk));
    child.once("close", (code, signal) => this._onClose(code, signal));

    // Single request line, then close stdin (worker reads exactly one line).
    try {
      child.stdin.on("error", () => {
        /* EPIPE when worker exits early — close handler decides the outcome */
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      child.stdin.end();
    } catch {
      /* close handler decides the outcome */
    }

    this._armHeartbeat();
    const absoluteMs = this.options.absoluteTimeoutMs ?? 3 * 60 * 60 * 1000;
    this._timers.absolute = this._setTimeout(() => this._onTimeout("absolute"), absoluteMs);
    if (this._timers.absolute && typeof this._timers.absolute.unref === "function") {
      this._timers.absolute.unref();
    }
  }

  _armHeartbeat() {
    const heartbeatMs = this.options.heartbeatTimeoutMs ?? 90 * 1000;
    if (this._timers.heartbeat) this._clearTimeout(this._timers.heartbeat);
    this._timers.heartbeat = this._setTimeout(() => this._onTimeout("heartbeat"), heartbeatMs);
    if (this._timers.heartbeat && typeof this._timers.heartbeat.unref === "function") {
      this._timers.heartbeat.unref();
    }
  }

  _onStdout(chunk) {
    let lines;
    try {
      lines = this.reader.feed(chunk);
    } catch (error) {
      this._protocolFailure(error);
      return;
    }
    for (const line of lines) {
      let event;
      try {
        event = this.session.acceptLine(line);
      } catch (error) {
        this._protocolFailure(error);
        return;
      }
      this._armHeartbeat();
      this.events.push(event);
      if (event.type === "artifact") this.artifacts.push(event);
      if (event.type === "warning") this.warnings.push(event);
      if (event.type === "complete") this.completion = event.result;
      if (event.type === "error") this.workerError = event.error;
      if (typeof this.options.onEvent === "function") {
        try {
          this.options.onEvent(event);
        } catch {
          /* observer errors must not kill the run */
        }
      }
    }
  }

  _protocolFailure(error) {
    const details =
      error instanceof ProtocolError
        ? { ...error.details, message: error.message }
        : { message: redactText(error.message) };
    const code = error instanceof ProtocolError ? error.code : "WORKER_PROTOCOL_ERROR";
    killProcessTree(this.child, { setTimeoutFn: this._setTimeout });
    this._fail(new WhisperXProcessError(code, "Worker protocol violation", details));
  }

  _onTimeout(kind) {
    if (this._settled) return;
    this.timedOut = true;
    killProcessTree(this.child, { setTimeoutFn: this._setTimeout });
    this._fail(
      new WhisperXProcessError("WORKER_TIMEOUT", `Worker ${kind} timeout`, {
        kind,
        lastEventType: this.events.length ? this.events[this.events.length - 1].type : null,
      })
    );
  }

  _onClose(code, signal) {
    if (this._settled) return;
    const stderr = this.stderrCapture.toRedactedString();

    if (this.cancelled) {
      this._fail(
        new WhisperXProcessError("JOB_CANCELLED", "Job cancelled", { exitCode: code, signal })
      );
      return;
    }
    if (this.workerError) {
      this._fail(
        new WhisperXProcessError(
          this.workerError.code || "UNKNOWN_INTERNAL_ERROR",
          this.workerError.message || "Worker reported an error",
          { exitCode: code, signal, workerDetails: this.workerError.details, stderr }
        )
      );
      return;
    }
    if (this.completion && code === 0) {
      this._succeed(stderr);
      return;
    }
    if (this.completion && code !== 0) {
      this._fail(
        new WhisperXProcessError(
          "WORKER_CRASHED",
          `Worker emitted complete but exited with code ${code}`,
          { exitCode: code, signal, stderr }
        )
      );
      return;
    }
    this._fail(
      new WhisperXProcessError("WORKER_CRASHED", "Worker exited without a terminal event", {
        exitCode: code,
        signal,
        stderr,
        pendingBytes: this.reader.pendingBytes(),
      })
    );
  }

  _clearTimers() {
    for (const key of Object.keys(this._timers)) {
      if (this._timers[key]) {
        this._clearTimeout(this._timers[key]);
        this._timers[key] = null;
      }
    }
  }

  _succeed(stderr) {
    if (this._settled) return;
    this._settled = true;
    this._clearTimers();
    this._resolve({
      completion: this.completion,
      artifacts: this.artifacts,
      warnings: this.warnings,
      events: this.events,
      stderr,
    });
  }

  _fail(error) {
    if (this._settled) return;
    this._settled = true;
    this._clearTimers();
    error.details = {
      ...error.details,
      cancelled: this.cancelled,
      timedOut: this.timedOut,
    };
    if (error.details.stderr === undefined) {
      error.details.stderr = this.stderrCapture.toRedactedString();
    }
    this._reject(error);
  }
}

module.exports = {
  WhisperXProcessRun,
  WhisperXProcessError,
  buildWorkerEnv,
  killProcessTree,
  BASE_ENV_ALLOWLIST,
};
