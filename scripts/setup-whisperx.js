#!/usr/bin/env node
"use strict";

// First-time / repair setup for the WhisperX runtime (spec 10 §1).
// Provisions an app-specific Python 3.12 venv via `uv` from the committed
// tools/whisperx-sidecar/uv.lock. Does not touch the user's global Python.
// The packaged Electron app provisions into <userData>/runtimes/whisperx
// instead of the ~/.cache default used here — override with --runtime-dir
// when testing against a different location.

const os = require("os");
const path = require("path");

const { WhisperXRuntimeManager, WhisperXRuntimeError } = require("../src/helpers/whisperx/whisperxRuntimeManager");

const REPO_ROOT = path.resolve(__dirname, "..");
const UV_INSTALL_DOCS_URL = "https://docs.astral.sh/uv/getting-started/installation/";

function parseArgs(argv) {
  const args = { repair: false, remove: false, runtimeDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repair") args.repair = true;
    else if (arg === "--remove") args.remove = true;
    else if (arg === "--runtime-dir") args.runtimeDir = argv[++i];
  }
  return args;
}

function printStatus(status) {
  console.log(`uv available:      ${status.uvAvailable ? "yes" : "no"}`);
  console.log(`runtime installed: ${status.installed ? "yes" : "no"}`);
  if (status.pythonVersion) console.log(`python version:    ${status.pythonVersion}`);
  if (status.sidecarVersion) console.log(`sidecar version:   ${status.sidecarVersion}`);
  if (status.lockHash) console.log(`lock hash:         ${status.lockHash.slice(0, 12)}...`);
  for (const blocker of status.blockers) {
    console.log(`  [BLOCKER] ${blocker.code}: ${blocker.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sidecarSourceDir = path.join(REPO_ROOT, "tools", "whisperx-sidecar");
  const runtimeRootDir = args.runtimeDir
    ? path.resolve(args.runtimeDir)
    : path.join(os.homedir(), ".cache", "openwhispr", "whisperx-runtime");

  console.log("OpenWhispr WhisperX Setup");
  console.log(`Sidecar source: ${sidecarSourceDir}`);
  console.log(`Runtime dir:    ${runtimeRootDir}`);
  console.log("(The packaged app provisions into its own userData directory instead.)");
  console.log("");

  const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });

  if (args.remove) {
    await manager.remove();
    console.log("WhisperX runtime removed.");
    return;
  }

  console.log("Current status:");
  printStatus(await manager.getStatus());
  console.log("");

  const onProgress = ({ step, message }) => console.log(`[${step}] ${message}`);

  try {
    if (args.repair) {
      await manager.repair({ onProgress });
    } else {
      await manager.provision({ onProgress });
    }
    console.log("");
    console.log("WhisperX runtime ready. Run \"npm run doctor:whisperx\" to verify.");
  } catch (error) {
    console.error("");
    if (error instanceof WhisperXRuntimeError) {
      console.error(`Setup failed [${error.code}]: ${error.message}`);
      if (error.code === "RUNTIME_NOT_INSTALLED") {
        console.error(`Install uv: ${UV_INSTALL_DOCS_URL}`);
      }
    } else {
      console.error(`Setup failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
