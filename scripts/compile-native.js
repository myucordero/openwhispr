#!/usr/bin/env node

const { spawnSync } = require("child_process");

const PLATFORM_SCRIPTS = {
  darwin: [
    "compile:globe",
    "compile:fast-paste",
    "compile:text-monitor",
    "compile:media-remote",
    "compile:mic-listener",
    "compile:audio-tap",
  ],
  win32: ["compile:winkeys", "compile:winpaste", "compile:text-monitor"],
  linux: ["compile:linux-paste", "compile:text-monitor"],
};

const scripts = PLATFORM_SCRIPTS[process.platform] || [];

if (scripts.length === 0) {
  console.log(`[compile:native] No native build steps for platform ${process.platform}`);
  process.exit(0);
}

console.log(`[compile:native] Running ${scripts.join(", ")}`);

for (const script of scripts) {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
