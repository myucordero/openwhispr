// WhisperX Python runtime provisioning (spec 02 §4, 10 §1/§3/§8).
// Pure Node module: no electron import, every path is injected by the
// caller. Electron main wires <userData>/runtimes/whisperx; the CLI scripts
// (scripts/setup-whisperx.js, scripts/doctor-whisperx.js) wire a --runtime-dir
// override or the ~/.cache default. This keeps the manager unit-testable
// with a fully injected execFileFn (see tests/whisperx/whisperxRuntimeManager.test.cjs).
//
// Provisioning uses a pinned `uv` binary to create an isolated Python 3.12
// venv under runtimeRootDir and `uv sync --frozen` against the sidecar's
// committed uv.lock — never the user's global Python. A sentinel file
// (runtime.json) records the lock hash so drift between the installed venv
// and the current uv.lock is detected as RUNTIME_VERSION_MISMATCH rather
// than silently trusting a stale environment.

const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile: execFileCb } = require("child_process");
const { promisify } = require("util");

const { redactText } = require("./redaction");

const DEFAULT_EXEC_FILE = promisify(execFileCb);

const UV_INSTALL_DOCS_URL = "https://docs.astral.sh/uv/getting-started/installation/";
const SYNC_TIMEOUT_MS = 15 * 60 * 1000; // uv sync can build/download wheels
const SHORT_TIMEOUT_MS = 30 * 1000;

class WhisperXRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WhisperXRuntimeError";
    this.code = code;
    this.details = details;
  }
}

class WhisperXRuntimeManager {
  constructor({
    sidecarSourceDir,
    runtimeRootDir,
    uvBinary = "uv",
    execFileFn = DEFAULT_EXEC_FILE,
    logger = console,
    platform = process.platform,
  } = {}) {
    if (!sidecarSourceDir) throw new TypeError("sidecarSourceDir is required");
    if (!runtimeRootDir) throw new TypeError("runtimeRootDir is required");
    this.sidecarSourceDir = sidecarSourceDir;
    this.runtimeRootDir = runtimeRootDir;
    this.uvBinary = uvBinary;
    this.execFileFn = execFileFn;
    this.logger = logger;
    this.platform = platform;
  }

  venvDir() {
    return path.join(this.runtimeRootDir, "venv");
  }

  pythonPath() {
    return this.platform === "win32"
      ? path.join(this.venvDir(), "Scripts", "python.exe")
      : path.join(this.venvDir(), "bin", "python");
  }

  sentinelPath() {
    return path.join(this.runtimeRootDir, "runtime.json");
  }

  lockPath() {
    return path.join(this.sidecarSourceDir, "uv.lock");
  }

  async _hashLockFile() {
    const buffer = await fsPromises.readFile(this.lockPath());
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  async _readSentinel() {
    try {
      const raw = await fsPromises.readFile(this.sentinelPath(), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async _writeSentinel(sentinel) {
    await fsPromises.mkdir(this.runtimeRootDir, { recursive: true });
    const tmpPath = `${this.sentinelPath()}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(sentinel, null, 2), "utf8");
    await fsPromises.rename(tmpPath, this.sentinelPath());
  }

  async _checkUvAvailable() {
    try {
      await this.execFileFn(this.uvBinary, ["--version"], {});
      return true;
    } catch {
      return false;
    }
  }

  async _readPythonVersion() {
    try {
      const { stdout, stderr } = await this.execFileFn(this.pythonPath(), ["--version"], {
        timeout: SHORT_TIMEOUT_MS,
      });
      return String(stdout || stderr || "").trim() || null;
    } catch {
      return null;
    }
  }

  _wrapExecError(code, message, error) {
    const stderr = redactText(String(error?.stderr || ""));
    const stdout = redactText(String(error?.stdout || ""));
    const baseMessage = redactText(String(error?.message || "unknown error"));
    const detail = [baseMessage, stderr].filter(Boolean).join(" — ").trim();
    return new WhisperXRuntimeError(code, `${message}: ${detail}`, { stdout, stderr });
  }

  async getStatus() {
    const blockers = [];
    const uvAvailable = await this._checkUvAvailable();
    if (!uvAvailable) {
      blockers.push({
        code: "RUNTIME_NOT_INSTALLED",
        message: `uv is not available on PATH. Install it from ${UV_INSTALL_DOCS_URL}, then run "npm run setup:whisperx".`,
      });
    }

    let lockHash = null;
    try {
      lockHash = await this._hashLockFile();
    } catch {
      blockers.push({
        code: "RUNTIME_NOT_INSTALLED",
        message: `Sidecar lock file not found at ${this.lockPath()}. See docs/whisperx-reliable-notes/10_OPERATIONS_AND_TROUBLESHOOTING.md and run "npm run setup:whisperx" once the sidecar source is present.`,
      });
    }

    const sentinel = await this._readSentinel();
    const pythonExists = fs.existsSync(this.pythonPath());

    let installed = Boolean(sentinel && pythonExists && lockHash);
    const pythonVersion = sentinel?.pythonVersion || null;
    const sidecarVersion = sentinel?.sidecarVersion || null;

    if (installed && lockHash && sentinel.lockHash !== lockHash) {
      installed = false;
      blockers.push({
        code: "RUNTIME_VERSION_MISMATCH",
        message: "runtime is stale, repair needed",
      });
    }

    return { installed, pythonVersion, lockHash, sidecarVersion, uvAvailable, blockers };
  }

  async provision({ onProgress = () => {} } = {}) {
    onProgress({ step: "verify-uv", message: "Checking for uv..." });
    if (!(await this._checkUvAvailable())) {
      throw new WhisperXRuntimeError(
        "RUNTIME_NOT_INSTALLED",
        `uv is required to provision the WhisperX runtime. Install it from ${UV_INSTALL_DOCS_URL}.`
      );
    }

    onProgress({ step: "verify-lock", message: "Checking sidecar lock file..." });
    if (!fs.existsSync(this.lockPath())) {
      throw new WhisperXRuntimeError(
        "RUNTIME_NOT_INSTALLED",
        `Sidecar lock file not found at ${this.lockPath()}. The sidecar source (tools/whisperx-sidecar) must be present before provisioning.`
      );
    }

    await fsPromises.mkdir(this.runtimeRootDir, { recursive: true });

    onProgress({ step: "create-venv", message: "Creating Python 3.12 virtual environment..." });
    try {
      await this.execFileFn(this.uvBinary, ["venv", this.venvDir(), "--python", "3.12"], {
        cwd: this.sidecarSourceDir,
      });
    } catch (error) {
      throw this._wrapExecError(
        "RUNTIME_NOT_INSTALLED",
        "Failed to create virtual environment",
        error
      );
    }

    onProgress({
      step: "sync-deps",
      message: "Installing pinned dependencies (uv sync --frozen)...",
    });
    try {
      await this.execFileFn(
        this.uvBinary,
        ["sync", "--frozen", "--python", this.pythonPath()],
        {
          cwd: this.sidecarSourceDir,
          env: { ...process.env, UV_PROJECT_ENVIRONMENT: this.venvDir() },
          timeout: SYNC_TIMEOUT_MS,
        }
      );
    } catch (error) {
      throw this._wrapExecError(
        "RUNTIME_NOT_INSTALLED",
        "Failed to sync sidecar dependencies",
        error
      );
    }

    onProgress({ step: "verify-import", message: "Verifying sidecar package import..." });
    let sidecarVersion = null;
    try {
      const { stdout } = await this.execFileFn(
        this.pythonPath(),
        ["-c", "import openwhispr_whisperx, sys; print(openwhispr_whisperx.__version__)"],
        { cwd: this.sidecarSourceDir, timeout: SHORT_TIMEOUT_MS }
      );
      sidecarVersion = String(stdout).trim();
    } catch (error) {
      throw this._wrapExecError(
        "WORKER_PROTOCOL_ERROR",
        "Failed to import sidecar package after sync",
        error
      );
    }

    onProgress({ step: "write-sentinel", message: "Recording runtime sentinel..." });
    const pythonVersion = await this._readPythonVersion();
    const lockHash = await this._hashLockFile();
    const sentinel = {
      provisionedAt: new Date().toISOString(),
      pythonVersion,
      lockHash,
      sidecarVersion,
    };
    await this._writeSentinel(sentinel);

    onProgress({ step: "complete", message: "WhisperX runtime provisioned." });
    return sentinel;
  }

  _assertRuntimeRootIsSafe() {
    const normalized = this.runtimeRootDir.toLowerCase();
    if (!normalized.includes("whisperx")) {
      throw new WhisperXRuntimeError(
        "UNKNOWN_INTERNAL_ERROR",
        `Refusing to remove a directory that doesn't look like a WhisperX runtime path: ${this.runtimeRootDir}`
      );
    }
  }

  async _removeRuntimeContents() {
    await fsPromises.rm(this.venvDir(), { recursive: true, force: true });
    await fsPromises.rm(this.sentinelPath(), { force: true });
  }

  async repair({ onProgress = () => {} } = {}) {
    onProgress({ step: "remove-existing", message: "Removing existing runtime..." });
    this._assertRuntimeRootIsSafe();
    await this._removeRuntimeContents();
    return this.provision({ onProgress });
  }

  async remove() {
    this._assertRuntimeRootIsSafe();
    await this._removeRuntimeContents();
  }

  async checkCuda() {
    if (!fs.existsSync(this.pythonPath())) {
      return {
        torch: null,
        cuda: false,
        device: null,
        vramGb: null,
        error: "runtime not installed",
      };
    }

    const script =
      "import torch,json;print(json.dumps({'torch':torch.__version__,'cuda':torch.cuda.is_available(),'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,'vramGb':round(torch.cuda.get_device_properties(0).total_memory/1024**3,2) if torch.cuda.is_available() else None}))";

    try {
      const { stdout } = await this.execFileFn(this.pythonPath(), ["-c", script], {
        timeout: SHORT_TIMEOUT_MS,
      });
      const parsed = JSON.parse(String(stdout).trim());
      return {
        torch: parsed.torch ?? null,
        cuda: Boolean(parsed.cuda),
        device: parsed.device ?? null,
        vramGb: parsed.vramGb ?? null,
      };
    } catch (error) {
      return {
        torch: null,
        cuda: false,
        device: null,
        vramGb: null,
        error: redactText(String(error?.stderr || error?.message || "unknown error")),
      };
    }
  }

  resolveWorkerInvocation() {
    const pythonPath = this.pythonPath();
    if (!fs.existsSync(pythonPath)) {
      throw new WhisperXRuntimeError(
        "RUNTIME_NOT_INSTALLED",
        `WhisperX runtime is not installed (missing ${pythonPath}). Run "npm run setup:whisperx".`
      );
    }
    return {
      command: pythonPath,
      args: ["-m", "openwhispr_whisperx.worker"],
      cwd: this.sidecarSourceDir,
    };
  }
}

module.exports = { WhisperXRuntimeManager, WhisperXRuntimeError };
