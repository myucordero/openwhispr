// Local CLI inference bridge: run the user's `claude` / `codex` CLI (installed
// and authenticated with their subscription) as a reasoning backend. The CLI
// runs on the user's machine but calls Anthropic/OpenAI cloud under the hood —
// an intentional exception to the local-only build, opted into per scope.
//
// User content is piped over stdin (no argv length limit for long transcripts);
// the system prompt (shorter) goes on the CLI flag.
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");

const CLI_BIN = {
  claude: process.platform === "win32" ? "claude.exe" : "claude",
  codex: process.platform === "win32" ? "codex.exe" : "codex",
};

const DEFAULT_TIMEOUT_MS = 180000;

function buildArgs(cli, { systemPrompt, model }) {
  if (cli === "claude") {
    // -p reads the prompt from stdin; text output only; never touch the
    // filesystem or run tools for a plain text-in/text-out reasoning call.
    const args = ["-p", "--output-format", "text", "--permission-mode", "default"];
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (model) args.push("--model", model);
    return args;
  }
  if (cli === "codex") {
    // codex exec runs headless and prints the final message; prompt via stdin.
    const args = ["exec", "--skip-git-repo-check", "-"];
    if (model) args.splice(1, 0, "--model", model);
    return args;
  }
  return null;
}

function runCliInference({ cli, prompt, systemPrompt, model, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const bin = CLI_BIN[cli];
    if (!bin) return resolve({ success: false, error: `Unknown CLI: ${cli}`, code: "UNKNOWN_CLI" });
    if (typeof prompt !== "string" || !prompt.trim()) {
      return resolve({ success: false, error: "Empty prompt", code: "EMPTY_PROMPT" });
    }
    const args = buildArgs(cli, { systemPrompt, model });
    if (!args) return resolve({ success: false, error: `Unknown CLI: ${cli}`, code: "UNKNOWN_CLI" });

    // For codex the system prompt is prepended to the piped prompt (no flag).
    const stdinText =
      cli === "codex" && systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    let child;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, env: process.env });
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
      try {
        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {}
      finish({ success: false, error: `${cli} timed out`, code: "CLI_TIMEOUT" });
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

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
      debugLogger.debug?.("[cliInference] non-zero/empty", { cli, exitCode, stderrLen: stderr.length });
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
      finish({ success: false, error: `Failed to send prompt to ${cli}: ${err.message}`, code: "STDIN_FAILED" });
    }
  });
}

// Cheap availability probe: spawn `<cli> --version` and resolve on exit.
function checkCliAvailable(cli, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const bin = CLI_BIN[cli];
    if (!bin) return resolve({ available: false });
    let child;
    try {
      child = spawn(bin, ["--version"], { shell: false, windowsHide: true, env: process.env });
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
      try {
        child.kill();
      } catch {}
      done({ available: false });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => done({ available: false }));
    child.on("close", (code) => done({ available: code === 0, version: out.trim() || undefined }));
  });
}

module.exports = { runCliInference, checkCliAvailable };
