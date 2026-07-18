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

main().catch((err) => {
  const exitCode = err instanceof CliError ? err.exitCode : EXIT.USER;
  process.stderr.write(`${err.message}\n`);
  process.exitCode = exitCode;
});
