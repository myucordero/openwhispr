const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  WhisperXRuntimeManager,
  WhisperXRuntimeError,
} = require("../../src/helpers/whisperx/whisperxRuntimeManager");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function writeLockFile(sidecarDir, content = "test-lock-content\n") {
  fs.writeFileSync(path.join(sidecarDir, "uv.lock"), content);
  fs.writeFileSync(path.join(sidecarDir, "pyproject.toml"), "[project]\nname='x'\n");
  return sha256(Buffer.from(content));
}

// Fake execFileFn: routes calls to behaviors based on command/args, records
// every call for assertion. Mirrors the (command, args, options) => Promise
// shape of util.promisify(execFile) used by the real default.
function makeFakeExec(routes) {
  const calls = [];
  const fn = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const route = routes.find((r) => r.match(command, args));
    if (!route) {
      throw new Error(`Unexpected exec call: ${command} ${args.join(" ")}`);
    }
    if (route.error) throw route.error;
    return route.result || { stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function happyPathRoutes({ pythonPath, sidecarVersion = "0.1.0", pythonVersion = "Python 3.12.3" } = {}) {
  return [
    { match: (cmd, args) => cmd === "uv" && args[0] === "--version", result: { stdout: "uv 0.4.30" } },
    { match: (cmd, args) => cmd === "uv" && args[0] === "venv", result: { stdout: "" } },
    { match: (cmd, args) => cmd === "uv" && args[0] === "sync", result: { stdout: "" } },
    {
      match: (cmd, args) => cmd === pythonPath && args[0] === "-c" && args[1].includes("openwhispr_whisperx"),
      result: { stdout: `${sidecarVersion}\n` },
    },
    {
      match: (cmd, args) => cmd === pythonPath && args[0] === "--version",
      result: { stdout: `${pythonVersion}\n` },
    },
  ];
}

test("getStatus — uv missing yields uvAvailable false and a blocker", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    writeLockFile(sidecarSourceDir);
    const execFileFn = async () => {
      throw new Error("ENOENT: uv not found");
    };
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir, execFileFn });
    const status = await manager.getStatus();
    assert.equal(status.uvAvailable, false);
    assert.equal(status.installed, false);
    assert.ok(status.blockers.some((b) => b.code === "RUNTIME_NOT_INSTALLED"));
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("getStatus — missing uv.lock yields RUNTIME_NOT_INSTALLED blocker", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    // No uv.lock written.
    const execFileFn = async () => ({ stdout: "uv 0.4.30" });
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir, execFileFn });
    const status = await manager.getStatus();
    assert.equal(status.lockHash, null);
    assert.ok(status.blockers.some((b) => b.code === "RUNTIME_NOT_INSTALLED"));
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("getStatus — sentinel lock hash mismatch yields RUNTIME_VERSION_MISMATCH and installed=false", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    writeLockFile(sidecarSourceDir, "current-lock-content\n");
    const execFileFn = async () => ({ stdout: "uv 0.4.30" });
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir, execFileFn });

    // Simulate a previously provisioned venv whose sentinel points at a
    // different (stale) lock hash than the current uv.lock on disk.
    fs.mkdirSync(path.dirname(manager.pythonPath()), { recursive: true });
    fs.writeFileSync(manager.pythonPath(), "#!/bin/sh\n");
    fs.writeFileSync(
      manager.sentinelPath(),
      JSON.stringify({ lockHash: "stale-hash-does-not-match", pythonVersion: "Python 3.12.0" })
    );

    const status = await manager.getStatus();
    assert.equal(status.installed, false);
    assert.ok(status.blockers.some((b) => b.code === "RUNTIME_VERSION_MISMATCH"));
    assert.ok(status.blockers.some((b) => b.message === "runtime is stale, repair needed"));
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("provision — happy path calls the expected argv sequence and writes a matching sentinel", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const expectedLockHash = writeLockFile(sidecarSourceDir);
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    const pythonPath = manager.pythonPath();
    const execFileFn = makeFakeExec(happyPathRoutes({ pythonPath }));
    manager.execFileFn = execFileFn;

    const progressSteps = [];
    const sentinel = await manager.provision({ onProgress: (p) => progressSteps.push(p.step) });

    assert.deepEqual(progressSteps, [
      "verify-uv",
      "verify-lock",
      "create-venv",
      "sync-deps",
      "verify-import",
      "write-sentinel",
      "complete",
    ]);

    const calls = execFileFn.calls;
    assert.equal(calls[0].command, "uv");
    assert.deepEqual(calls[0].args, ["--version"]);

    assert.equal(calls[1].command, "uv");
    assert.deepEqual(calls[1].args, ["venv", manager.venvDir(), "--python", "3.12"]);
    assert.equal(calls[1].options.cwd, sidecarSourceDir);

    assert.equal(calls[2].command, "uv");
    assert.deepEqual(calls[2].args, ["sync", "--frozen", "--python", pythonPath]);
    assert.equal(calls[2].options.cwd, sidecarSourceDir);
    assert.equal(calls[2].options.env.UV_PROJECT_ENVIRONMENT, manager.venvDir());

    assert.equal(calls[3].command, pythonPath);
    assert.equal(calls[3].args[0], "-c");
    assert.ok(calls[3].args[1].includes("openwhispr_whisperx"));

    assert.equal(sentinel.lockHash, expectedLockHash);
    assert.equal(sentinel.sidecarVersion, "0.1.0");
    assert.equal(sentinel.pythonVersion, "Python 3.12.3");

    const onDisk = JSON.parse(fs.readFileSync(manager.sentinelPath(), "utf8"));
    assert.equal(onDisk.lockHash, expectedLockHash);
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("provision — failure redacts a leaked secret from stderr before throwing", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    writeLockFile(sidecarSourceDir);
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    const pythonPath = manager.pythonPath();

    const leakyError = new Error("uv sync failed");
    leakyError.stderr = "authorization failed for hf_SECRET123456789 while fetching model";

    const execFileFn = makeFakeExec([
      { match: (cmd, args) => cmd === "uv" && args[0] === "--version", result: { stdout: "uv 0.4.30" } },
      { match: (cmd, args) => cmd === "uv" && args[0] === "venv", result: { stdout: "" } },
      { match: (cmd, args) => cmd === "uv" && args[0] === "sync", error: leakyError },
    ]);
    manager.execFileFn = execFileFn;
    void pythonPath;

    await assert.rejects(
      () => manager.provision({}),
      (error) => {
        assert.ok(error instanceof WhisperXRuntimeError);
        assert.equal(error.code, "RUNTIME_NOT_INSTALLED");
        assert.ok(!error.message.includes("hf_SECRET123456789"));
        assert.ok(error.message.includes("[REDACTED]"));
        return true;
      }
    );
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("repair — wipes the existing venv/sentinel before re-provisioning", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const expectedLockHash = writeLockFile(sidecarSourceDir);
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    const pythonPath = manager.pythonPath();

    // Pre-existing (stale) install.
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    const staleMarker = path.join(manager.venvDir(), "stale-marker.txt");
    fs.writeFileSync(staleMarker, "stale");
    fs.writeFileSync(manager.sentinelPath(), JSON.stringify({ lockHash: "old-hash" }));

    manager.execFileFn = makeFakeExec(happyPathRoutes({ pythonPath }));

    const progressSteps = [];
    const sentinel = await manager.repair({ onProgress: (p) => progressSteps.push(p.step) });

    assert.equal(progressSteps[0], "remove-existing");
    assert.equal(fs.existsSync(staleMarker), false);
    assert.equal(sentinel.lockHash, expectedLockHash);

    const onDisk = JSON.parse(fs.readFileSync(manager.sentinelPath(), "utf8"));
    assert.equal(onDisk.lockHash, expectedLockHash);
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("remove — refuses to delete when runtimeRootDir does not contain 'whisperx'", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("unrelated-cache-dir-");
  try {
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    await assert.rejects(
      () => manager.remove(),
      (error) => {
        assert.ok(error instanceof WhisperXRuntimeError);
        return true;
      }
    );
    // The directory must still exist — remove() must be a no-op on refusal.
    assert.equal(fs.existsSync(runtimeRootDir), true);
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("remove — deletes venv and sentinel when runtimeRootDir is a whisperx path", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    fs.mkdirSync(manager.venvDir(), { recursive: true });
    fs.writeFileSync(path.join(manager.venvDir(), "marker.txt"), "x");
    fs.writeFileSync(manager.sentinelPath(), "{}");

    await manager.remove();

    assert.equal(fs.existsSync(manager.venvDir()), false);
    assert.equal(fs.existsSync(manager.sentinelPath()), false);
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("resolveWorkerInvocation — throws RUNTIME_NOT_INSTALLED when python missing, returns shape when present", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });

    assert.throws(
      () => manager.resolveWorkerInvocation(),
      (error) => {
        assert.ok(error instanceof WhisperXRuntimeError);
        assert.equal(error.code, "RUNTIME_NOT_INSTALLED");
        return true;
      }
    );

    fs.mkdirSync(path.dirname(manager.pythonPath()), { recursive: true });
    fs.writeFileSync(manager.pythonPath(), "#!/bin/sh\n");

    const invocation = manager.resolveWorkerInvocation();
    assert.deepEqual(invocation, {
      command: manager.pythonPath(),
      args: ["-m", "openwhispr_whisperx.worker"],
      cwd: sidecarSourceDir,
    });
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("checkCuda — degrades gracefully when the runtime is not installed", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    const result = await manager.checkCuda();
    assert.equal(result.torch, null);
    assert.equal(result.cuda, false);
    assert.equal(result.error, "runtime not installed");
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("checkCuda — parses a successful torch/CUDA probe", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    fs.mkdirSync(path.dirname(manager.pythonPath()), { recursive: true });
    fs.writeFileSync(manager.pythonPath(), "#!/bin/sh\n");

    manager.execFileFn = async () => ({
      stdout: JSON.stringify({ torch: "2.4.0", cuda: true, device: "NVIDIA RTX 4090", vramGb: 24 }),
    });

    const result = await manager.checkCuda();
    assert.equal(result.torch, "2.4.0");
    assert.equal(result.cuda, true);
    assert.equal(result.device, "NVIDIA RTX 4090");
    assert.equal(result.vramGb, 24);
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});

test("checkCuda — redacts an error message when the probe fails", async () => {
  const sidecarSourceDir = tmpDir("whisperx-sidecar-");
  const runtimeRootDir = tmpDir("whisperx-runtime-");
  try {
    const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
    fs.mkdirSync(path.dirname(manager.pythonPath()), { recursive: true });
    fs.writeFileSync(manager.pythonPath(), "#!/bin/sh\n");

    const failure = new Error("ModuleNotFoundError: torch");
    failure.stderr = "token hf_SECRET123456789 rejected";
    manager.execFileFn = async () => {
      throw failure;
    };

    const result = await manager.checkCuda();
    assert.equal(result.torch, null);
    assert.equal(result.cuda, false);
    assert.ok(!result.error.includes("hf_SECRET123456789"));
    assert.ok(result.error.includes("[REDACTED]"));
  } finally {
    fs.rmSync(sidecarSourceDir, { recursive: true, force: true });
    fs.rmSync(runtimeRootDir, { recursive: true, force: true });
  }
});
