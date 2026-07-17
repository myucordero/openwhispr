#!/usr/bin/env node
"use strict";

// WhisperX diagnostics (spec 10 §3). Mirrors scripts/local-doctor.js output
// style ([PASS]/[WARN]/[FAIL] lines) plus a --json machine-readable mode.
// Content-safe: every message is redacted before being printed or emitted
// (spec 07 §11) — no secrets, and home directories are collapsed to <home>.
// Runs standalone (no electron); the Electron app additionally provisions
// into <userData>/runtimes/whisperx rather than the ~/.cache default used here.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { WhisperXRuntimeManager } = require("../src/helpers/whisperx/whisperxRuntimeManager");
const { redactText } = require("../src/helpers/whisperx/redaction");

const REPO_ROOT = path.resolve(__dirname, "..");
const UV_INSTALL_DOCS_URL = "https://docs.astral.sh/uv/getting-started/installation/";

function parseArgs(argv) {
  const args = { json: false, requireRuntime: false, modelDir: null, runtimeDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--require-runtime") args.requireRuntime = true;
    else if (arg === "--model-dir") args.modelDir = argv[++i];
    else if (arg === "--runtime-dir") args.runtimeDir = argv[++i];
  }
  return args;
}

function checkWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.doctor-write-check-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];
  const push = (id, status, message) => checks.push({ id, status, message: redactText(message) });

  const sidecarSourceDir = path.join(REPO_ROOT, "tools", "whisperx-sidecar");
  const runtimeRootDir = args.runtimeDir
    ? path.resolve(args.runtimeDir)
    : path.join(os.homedir(), ".cache", "openwhispr", "whisperx-runtime");
  const modelDir = args.modelDir
    ? path.resolve(args.modelDir)
    : path.join(os.homedir(), ".cache", "openwhispr", "whisperx-models");

  const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
  const status = await manager.getStatus();

  push(
    "uv",
    status.uvAvailable ? "PASS" : "FAIL",
    status.uvAvailable
      ? "uv available on PATH"
      : `uv not found on PATH. Install from ${UV_INSTALL_DOCS_URL}`
  );

  const pyprojectExists = fs.existsSync(path.join(sidecarSourceDir, "pyproject.toml"));
  const lockExists = fs.existsSync(path.join(sidecarSourceDir, "uv.lock"));
  const sidecarSourceOk = pyprojectExists && lockExists;
  push(
    "sidecar-source",
    sidecarSourceOk ? "PASS" : "FAIL",
    sidecarSourceOk
      ? `sidecar source present at ${sidecarSourceDir}`
      : `missing pyproject.toml/uv.lock under ${sidecarSourceDir}`
  );

  push(
    "runtime-installed",
    status.installed ? "PASS" : "WARN",
    status.installed
      ? `runtime installed (lock ${status.lockHash ? status.lockHash.slice(0, 12) : "?"}...)`
      : `runtime not provisioned — run "npm run setup:whisperx"${
          status.blockers.length ? ` (${status.blockers.map((b) => b.code).join(", ")})` : ""
        }`
  );

  push(
    "python-version",
    status.pythonVersion ? "PASS" : "WARN",
    status.pythonVersion || "unknown (runtime not installed)"
  );

  const cuda = await manager.checkCuda();
  if (cuda.cuda) {
    push(
      "cuda",
      "PASS",
      `CUDA available — ${cuda.device || "unknown GPU"} (${cuda.vramGb ?? "?"} GB VRAM), torch ${cuda.torch}`
    );
  } else if (cuda.torch) {
    push("cuda", "WARN", `torch ${cuda.torch} installed but CUDA unavailable — CPU fallback (slow)`);
  } else {
    push(
      "cuda",
      "WARN",
      cuda.error ? `torch/CUDA check failed: ${cuda.error}` : "runtime not installed; torch/CUDA unknown"
    );
  }

  let ffmpegOk = false;
  let ffmpegPath = null;
  try {
    ffmpegPath = require("ffmpeg-static");
    ffmpegOk = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
  } catch {
    ffmpegOk = false;
  }
  push(
    "ffmpeg",
    ffmpegOk ? "PASS" : "WARN",
    ffmpegOk
      ? `ffmpeg-static resolved at ${ffmpegPath}`
      : "ffmpeg-static binary not resolvable (run npm install)"
  );

  const modelDirWritable = checkWritable(modelDir);
  push(
    "model-cache-writable",
    modelDirWritable ? "PASS" : "FAIL",
    `${modelDir} ${modelDirWritable ? "is writable" : "is not writable"}`
  );

  const hfTokenPresent = Boolean(process.env.HUGGINGFACE_TOKEN);
  push(
    "huggingface-token",
    hfTokenPresent ? "PASS" : "WARN",
    hfTokenPresent
      ? "HUGGINGFACE_TOKEN present (from env) — diarization can use it"
      : "not configured — not visible outside the running app; configure in Settings (blocks diarization only, ASR still works)"
  );

  const offlineReady = status.installed && Boolean(cuda.torch);
  push(
    "offline-readiness",
    offlineReady ? "PASS" : "WARN",
    offlineReady
      ? "runtime provisioned; expected to run without network after models are cached"
      : "runtime/models not fully provisioned yet — offline use not guaranteed"
  );

  push(
    "mode",
    "PASS",
    process.resourcesPath ? "packaged mode" : "development mode (repo working directory)"
  );

  const blocking =
    !status.uvAvailable || !sidecarSourceOk || (args.requireRuntime && !status.installed);
  const ok = !blocking;

  if (args.json) {
    console.log(JSON.stringify({ checks, ok }, null, 2));
  } else {
    console.log("OpenWhispr WhisperX Doctor");
    console.log("");
    for (const check of checks) {
      console.log(`[${check.status}] ${check.id} - ${check.message}`);
    }
    console.log("");
    console.log(ok ? "Overall: OK" : "Overall: BLOCKED");
  }

  process.exitCode = ok ? 0 : 1;
}

main();
