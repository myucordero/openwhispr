// Local CLI inference bridge: run the user's `claude` / `codex` CLI (installed
// and authenticated with their subscription) as a reasoning backend. The CLI
// runs on the user's machine but calls Anthropic/OpenAI cloud under the hood —
// an intentional exception to the local-only build, opted into per scope.
//
// Injection safety: argv is a fixed static list; ALL untrusted text (system
// prompt + user content) goes over stdin. That keeps shell:true (needed on
// Windows to launch npm-shim .cmd wrappers as well as native .exe) safe.
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");

// PATH-resolved names (no extension) so Windows shell resolution picks whichever
// of claude.exe / claude.cmd exists; POSIX resolves the bin directly.
const CLI_BIN = { claude: "claude", codex: "codex" };
const IS_WIN = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 180000;

function staticArgs(cli) {
  // claude: -p reads the prompt from stdin, plain text out.
  if (cli === "claude") return ["-p", "--output-format", "text"];
  // codex exec runs headless; "-" reads the prompt from stdin.
  if (cli === "codex") return ["exec", "--skip-git-repo-check", "-"];
  return null;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN && child.pid) {
      // shell:true spawns cmd.exe as the child; kill the whole tree so the
      // real CLI process can't be orphaned on timeout.
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* best effort */
  }
}

// The CLI's model is intentionally NOT selectable: it always uses the account's
// default model. `model` is accepted for API symmetry but never forwarded as an
// arg (forwarding a stray GGUF id from a fallback scope would break the CLI).
function runCliInference({ cli, prompt, systemPrompt } = {}) {
  return new Promise((resolve) => {
    const bin = CLI_BIN[cli];
    const args = staticArgs(cli);
    if (!bin || !args) {
      return resolve({ success: false, error: `Unknown CLI: ${cli}`, code: "UNKNOWN_CLI" });
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      return resolve({ success: false, error: "Empty prompt", code: "EMPTY_PROMPT" });
    }

    const stdinText =
      typeof systemPrompt === "string" && systemPrompt.trim()
        ? `${systemPrompt}\n\n${prompt}`
        : prompt;

    let child;
    try {
      child = spawn(bin, args, { shell: IS_WIN, windowsHide: true, env: process.env });
    } catch (err) {
      return resolve({
        success: false,
        error: `Failed to launch ${cli}: ${err.message}`,
        code: "SPAWN_FAILED",
      });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({ success: false, error: `${cli} timed out`, code: "CLI_TIMEOUT" });
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      const notFound = err && err.code === "ENOENT";
      finish({
        success: false,
        error: notFound ? `${cli} CLI not found on PATH` : `${cli} error: ${err.message}`,
        code: notFound ? "CLI_NOT_FOUND" : "CLI_ERROR",
      });
    });
    child.on("close", (exitCode) => {
      const text = stdout.trim();
      if (exitCode === 0 && text) return finish({ success: true, text });
      debugLogger.debug?.("[cliInference] non-zero/empty", {
        cli,
        exitCode,
        stderrLen: stderr.length,
      });
      finish({
        success: false,
        error: (stderr.trim() || `${cli} exited with code ${exitCode} and no output`).slice(0, 500),
        code: "CLI_FAILED",
      });
    });

    try {
      child.stdin.write(stdinText);
      child.stdin.end();
    } catch (err) {
      finish({
        success: false,
        error: `Failed to send prompt to ${cli}: ${err.message}`,
        code: "STDIN_FAILED",
      });
    }
  });
}

// Cheap availability probe: `<cli> --version`. Used by the renderer to gate the
// note UI so a missing/unauthenticated CLI surfaces clearly instead of failing
// every generation at runtime.
function checkCliAvailable(cli, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const bin = CLI_BIN[cli];
    if (!bin) return resolve({ available: false });
    let child;
    try {
      child = spawn(bin, ["--version"], { shell: IS_WIN, windowsHide: true, env: process.env });
    } catch {
      return resolve({ available: false });
    }
    let out = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(result);
    };
    const t = setTimeout(() => {
      killTree(child);
      done({ available: false });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => done({ available: false }));
    child.on("close", (code) => done({ available: code === 0, version: out.trim() || undefined }));
  });
}

module.exports = { runCliInference, checkCliAvailable };
