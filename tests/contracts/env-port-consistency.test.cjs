const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("vite and main-process dev server defaults use port 5191", () => {
  const viteConfig = read("src/vite.config.mjs");
  const devServerManager = read("src/helpers/devServerManager.js");

  assert.match(viteConfig, /DEFAULT_DEV_SERVER_PORT\s*=\s*5191/);
  assert.match(devServerManager, /DEFAULT_DEV_SERVER_PORT\s*=\s*5191/);
});

test("desktop auth callback supports an environment override", () => {
  const auth = read("src/lib/auth.ts");

  assert.match(auth, /VITE_OPENWHISPR_OAUTH_CALLBACK_URL/);
  assert.match(auth, /DEFAULT_DESKTOP_OAUTH_CALLBACK_URL/);
});
