#!/usr/bin/env node
"use strict";

// WhisperX benchmark CLI (spec 09 §8). Runs every case × configuration pair
// from a private manifest through the real WhisperX worker (never the fake
// sidecar used by unit tests), measures wall-clock/RTF, and scores transcript
// quality against user-supplied references using src/helpers/whisperx/
// benchmarkMetrics.js. Never invents a metric: anything without a reference
// is reported as null with an explicit reason (spec 09 §11).
//
// This harness only benchmarks the ASR/alignment/diarization pipeline (the
// WhisperX worker). Note generation is a separate LLM step (noteCompiler.js)
// that this offline CLI does not invoke, so note-grounding metrics are
// always reported as missing here — see noteGroundingMetrics() in
// benchmarkMetrics.js for the (separately unit-tested) grounding formula.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const { WhisperXRuntimeManager } = require("../src/helpers/whisperx/whisperxRuntimeManager");
const { WhisperXProcessRun } = require("../src/helpers/whisperx/whisperxProcessManager");
const {
  validateJobRequest,
  validateCanonicalTranscript,
} = require("../src/helpers/whisperx/contracts");
const { WHISPERX_PROTOCOL_VERSION, RECORDING_PROFILES } = require("../src/helpers/whisperx/constants");
const { redactText } = require("../src/helpers/whisperx/redaction");
const {
  wer,
  cer,
  domainErrorMetrics,
  speakerAttributionAccuracy,
  timestampBoundaryError,
} = require("../src/helpers/whisperx/benchmarkMetrics");

const REPO_ROOT = path.resolve(__dirname, "..");
const SPEC_PATH =
  "docs/agent-tasks/whisperx-reliable-notes/docs/whisperx-reliable-notes/09_BENCHMARK_AND_QUALITY_EVALUATION.md";

function parseArgs(argv) {
  const args = {
    manifest: null,
    output: null,
    offline: true,
    runtimeDir: null,
    requireCuda: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--offline") args.offline = true;
    else if (arg === "--online" || arg === "--no-offline") args.offline = false;
    else if (arg === "--runtime-dir") args.runtimeDir = argv[++i];
    else if (arg === "--require-cuda") args.requireCuda = true;
  }
  return args;
}

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exitCode = 1;
}

function resolveRelative(baseDir, maybeRelative) {
  if (!maybeRelative) return null;
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(baseDir, maybeRelative);
}

function readGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// Marks a metric as intentionally not computed, with a stated reason —
// spec 09 §11 forbids inventing a value when the reference is absent.
function missing(reason) {
  return { value: null, reason };
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

// Builds a validated WhisperXJobRequest for one case×configuration pairing.
// Mirrors RecordingJobManager._buildRequest (see recordingJobManager.js),
// simplified for benchmarking: no OOM ladder, no note generation.
function buildRequest({
  jobId,
  audioPath,
  displayName,
  sourceSha256,
  jobDirectory,
  configuration,
  offline,
  modelCacheDirectory,
  temporaryDirectory,
}) {
  const diarization = Boolean(configuration.diarization);
  const formats = ["canonical-json", "raw-txt"];
  if (diarization) formats.push("speaker-markdown");
  formats.push("srt", "vtt");

  const profile = RECORDING_PROFILES.includes(configuration.profile)
    ? configuration.profile
    : diarization
      ? "meeting"
      : "memo";

  return {
    protocolVersion: WHISPERX_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    jobId,
    source: {
      path: audioPath,
      displayName,
      expectedSha256: sourceSha256,
    },
    output: {
      jobDirectory,
      preserveNormalizedAudio: false,
      formats,
    },
    profile,
    language: configuration.language || "auto",
    asr: {
      model: configuration.model,
      computeType: configuration.computeType,
      batchSize: configuration.batchSize,
      device: configuration.device || "cuda",
      hotwords: [],
    },
    alignment: { enabled: true },
    diarization: {
      enabled: diarization,
      provider: "pyannote-community-1",
    },
    runtime: {
      offline,
      modelCacheDirectory,
      temporaryDirectory,
    },
  };
}

// Runs one case×configuration pairing. Never throws — every failure mode
// (bad manifest reference, missing audio, protocol violation, worker crash)
// is captured into the returned result so the matrix keeps going (spec
// 09 §8: "Errors per run recorded (code) without aborting the whole matrix").
async function runOne({
  testCase,
  configuration,
  manifestDir,
  artifactsRoot,
  manager,
  offline,
  modelCacheDirectory,
  temporaryDirectory,
}) {
  const jobId = `${testCase.id}__${configuration.id}`;
  const jobDirectory = path.join(artifactsRoot, testCase.id, configuration.id);
  const base = {
    caseId: testCase.id,
    configId: configuration.id,
    jobDirectory,
  };

  if (configuration.provider !== "whisperx") {
    return {
      ...base,
      status: "error",
      errorCode: "UNSUPPORTED_PROVIDER",
      errorMessage: `configuration.provider "${configuration.provider}" is not supported by this harness (only "whisperx")`,
    };
  }

  const audioPath = resolveRelative(manifestDir, testCase.audio);
  if (!audioPath || !fs.existsSync(audioPath)) {
    return {
      ...base,
      status: "error",
      errorCode: "AUDIO_FILE_NOT_FOUND",
      errorMessage: `audio file not found for case "${testCase.id}": ${audioPath || testCase.audio}`,
    };
  }

  fs.mkdirSync(jobDirectory, { recursive: true });

  let sourceSha256;
  try {
    sourceSha256 = sha256File(audioPath);
  } catch (error) {
    return {
      ...base,
      status: "error",
      errorCode: "AUDIO_PROBE_FAILED",
      errorMessage: redactText(error.message),
    };
  }

  const request = buildRequest({
    jobId,
    audioPath,
    displayName: testCase.id,
    sourceSha256,
    jobDirectory,
    configuration,
    offline,
    modelCacheDirectory,
    temporaryDirectory,
  });
  const requestCheck = validateJobRequest(request);
  if (!requestCheck.valid) {
    return {
      ...base,
      status: "error",
      errorCode: "WORKER_PROTOCOL_ERROR",
      errorMessage: `built an invalid job request: ${requestCheck.errors
        .slice(0, 5)
        .map((e) => `${e.path} ${e.message}`)
        .join("; ")}`,
    };
  }

  let invocation;
  try {
    invocation = manager.resolveWorkerInvocation();
  } catch (error) {
    return {
      ...base,
      status: "error",
      errorCode: error.code || "RUNTIME_NOT_INSTALLED",
      errorMessage: redactText(error.message),
    };
  }

  // Same fallback order as environment.js getHuggingFaceToken().
  const hfToken = configuration.diarization
    ? process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || null
    : null;
  const run = new WhisperXProcessRun({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    request,
    hfToken,
    extraEnv: offline ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {},
  });

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await run.run();
  } catch (error) {
    return {
      ...base,
      status: "error",
      errorCode: error.code || "UNKNOWN_INTERNAL_ERROR",
      errorMessage: redactText(error.message),
      wallClockMs: Date.now() - startedAt,
    };
  }
  const wallClockMs = Date.now() - startedAt;
  const { completion, artifacts, warnings } = outcome;

  const transcriptDescriptor = artifacts.find((a) => a.kind === "canonical-transcript");
  if (!transcriptDescriptor) {
    return {
      ...base,
      status: "error",
      errorCode: "TRANSCRIPT_SCHEMA_INVALID",
      errorMessage: "worker completed but produced no canonical-transcript artifact",
      wallClockMs,
    };
  }
  let transcript;
  try {
    transcript = JSON.parse(
      fs.readFileSync(path.join(jobDirectory, transcriptDescriptor.relativePath), "utf8")
    );
  } catch (error) {
    return {
      ...base,
      status: "error",
      errorCode: "TRANSCRIPT_SCHEMA_INVALID",
      errorMessage: `canonical transcript unreadable: ${redactText(error.message)}`,
      wallClockMs,
    };
  }
  const transcriptCheck = validateCanonicalTranscript(transcript);
  if (!transcriptCheck.valid) {
    return {
      ...base,
      status: "error",
      errorCode: "TRANSCRIPT_SCHEMA_INVALID",
      errorMessage: `canonical transcript failed validation: ${transcriptCheck.errors
        .slice(0, 5)
        .map((e) => e.message)
        .join("; ")}`,
      wallClockMs,
    };
  }

  const durationSeconds = completion.durationSeconds || null;
  const rtf = durationSeconds ? wallClockMs / 1000 / durationSeconds : null;
  const hypothesisText = transcript.segments.map((s) => s.text).join(" ");
  const hypothesisTimestampSegments = transcript.segments.map((s) => ({
    start: s.start,
    end: s.end,
  }));
  const hypothesisSpeakerSegments = transcript.segments.map((s) => ({
    start: s.start,
    end: s.end,
    speaker: s.speakerId,
  }));

  const referenceTranscriptPath = resolveRelative(manifestDir, testCase.referenceTranscript);
  const referenceSegmentsPath = resolveRelative(manifestDir, testCase.referenceSegments);
  const referenceText = readTextIfExists(referenceTranscriptPath);
  const referenceSegments = readJsonIfExists(referenceSegmentsPath);
  const referenceTerms = Array.isArray(testCase.referenceTerms) ? testCase.referenceTerms : null;

  const metrics = {
    wer: referenceText !== null ? wer(referenceText, hypothesisText) : missing("no referenceTranscript provided"),
    cer: referenceText !== null ? cer(referenceText, hypothesisText) : missing("no referenceTranscript provided"),
    domain:
      referenceTerms && referenceTerms.length > 0
        ? domainErrorMetrics(referenceTerms, hypothesisText)
        : missing("no referenceTerms provided"),
    timestampBoundary:
      referenceSegments !== null
        ? timestampBoundaryError(referenceSegments, hypothesisTimestampSegments)
        : missing("no referenceSegments provided"),
    speakerAttribution:
      referenceSegments !== null
        ? speakerAttributionAccuracy(referenceSegments, hypothesisSpeakerSegments)
        : missing("no referenceSegments provided"),
    // This harness only runs the ASR/alignment/diarization worker, never the
    // LLM note-compiler — so evidence/grounding metrics are always missing
    // here, never invented. See noteGroundingMetrics() for the formula.
    noteGrounding: missing("note generation not performed by this ASR-only benchmark harness"),
  };

  return {
    ...base,
    status: "ok",
    wallClockMs,
    audioDurationSeconds: durationSeconds,
    rtf,
    detectedLanguage: completion.detectedLanguage || null,
    timingsMs: completion.timingsMs || null,
    actualConfiguration: completion.actualConfiguration || null,
    warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
    metrics,
  };
}

function formatRunLine(result) {
  if (result.status === "ok") {
    const rtf = result.rtf !== null ? result.rtf.toFixed(2) : "n/a";
    return `[OK]    ${result.caseId} x ${result.configId} — ${result.wallClockMs}ms, rtf=${rtf}`;
  }
  return `[ERROR] ${result.caseId} x ${result.configId} — ${result.errorCode}: ${result.errorMessage}`;
}

function buildCsv(results) {
  const header = [
    "caseId",
    "configId",
    "status",
    "errorCode",
    "wallClockMs",
    "audioDurationSeconds",
    "rtf",
    "wer",
    "cer",
    "domainHitRate",
    "attributionAgreement",
    "evidenceMetrics",
  ];
  const rows = [header.join(",")];
  for (const r of results) {
    const m = r.metrics || {};
    rows.push(
      [
        r.caseId,
        r.configId,
        r.status,
        r.errorCode || "",
        r.wallClockMs ?? "",
        r.audioDurationSeconds ?? "",
        r.rtf ?? "",
        m.wer && m.wer.wer !== undefined ? m.wer.wer : "",
        m.cer && m.cer.cer !== undefined ? m.cer.cer : "",
        m.domain && m.domain.hitRate !== undefined ? m.domain.hitRate : "",
        m.speakerAttribution && m.speakerAttribution.agreement !== undefined
          ? m.speakerAttribution.agreement
          : "",
        "null (not generated in this benchmark)",
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return rows.join("\n") + "\n";
}

function metricCell(metric, formatFn) {
  if (!metric) return "n/a";
  if (metric.value === null && metric.reason) return `missing (${metric.reason})`;
  return formatFn(metric);
}

function buildReport({ header, results }) {
  const lines = [];
  lines.push("# WhisperX Benchmark Report");
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(`- date: ${header.date}`);
  lines.push(`- git commit: ${header.gitCommit}`);
  lines.push(`- platform/arch: ${header.platform}/${header.arch}`);
  lines.push(`- node version: ${header.nodeVersion}`);
  lines.push(`- offline: ${header.offline}`);
  lines.push(`- runtime lock hash: ${header.lockHash || "unknown (runtime not provisioned)"}`);
  lines.push(`- manifest: ${header.manifestRelative}`);
  lines.push(`- cases: ${header.caseCount}, configurations: ${header.configurationCount}`);
  lines.push("");
  lines.push(
    "Results from one machine are not a universal model ranking (spec 09 §11) — treat this report as specific to the environment above."
  );
  lines.push("");

  if (results.length === 0) {
    lines.push(
      "No case × configuration pairs were run (manifest declared 0 cases or 0 configurations)."
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Results");
  lines.push("");
  lines.push(
    "| case | config | status | wall-clock (ms) | RTF | WER | CER | domain hit-rate | speaker attribution | note grounding |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.status !== "ok") {
      lines.push(
        `| ${r.caseId} | ${r.configId} | ERROR (${r.errorCode}) | - | - | - | - | - | - | - |`
      );
      continue;
    }
    const m = r.metrics;
    lines.push(
      [
        "",
        r.caseId,
        r.configId,
        "ok",
        r.wallClockMs,
        r.rtf !== null ? r.rtf.toFixed(3) : "n/a",
        metricCell(m.wer, (x) => x.wer.toFixed(4)),
        metricCell(m.cer, (x) => x.cer.toFixed(4)),
        metricCell(m.domain, (x) => `${(x.hitRate * 100).toFixed(1)}% (${x.foundCount}/${x.totalTerms})`),
        metricCell(m.speakerAttribution, (x) => x.agreement.toFixed(3)),
        metricCell(m.noteGrounding, () => "n/a"),
        "",
      ].join(" | ")
    );
  }
  lines.push("");

  const errors = results.filter((r) => r.status === "error");
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const e of errors) {
      lines.push(`- **${e.caseId} x ${e.configId}**: \`${e.errorCode}\` — ${e.errorMessage}`);
    }
    lines.push("");
  }

  lines.push("## Missing metrics");
  lines.push("");
  lines.push(
    "Note-grounding metrics are always missing in this report: this harness benchmarks the ASR/alignment/diarization worker only, not the LLM note-compiler pipeline."
  );
  for (const r of results.filter((res) => res.status === "ok")) {
    for (const [name, metric] of Object.entries(r.metrics)) {
      if (metric && metric.value === null && metric.reason && name !== "noteGrounding") {
        lines.push(`- ${r.caseId} x ${r.configId}: ${name} missing — ${metric.reason}`);
      }
    }
  }
  lines.push("");

  const warningRows = results.filter((r) => r.status === "ok" && r.warnings && r.warnings.length > 0);
  if (warningRows.length > 0) {
    lines.push("## Worker warnings/fallbacks");
    lines.push("");
    for (const r of warningRows) {
      for (const w of r.warnings) {
        lines.push(`- ${r.caseId} x ${r.configId}: \`${w.code}\` — ${w.message}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.manifest) {
    return fail(`--manifest <path> is required. See ${SPEC_PATH} §8 for the manifest shape.`);
  }
  if (!args.output) {
    return fail("--output <dir> is required.");
  }

  const manifestPath = path.resolve(args.manifest);
  let manifestRaw;
  try {
    manifestRaw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return fail(
      `manifest file not found at ${manifestPath}. Provide a valid --manifest <path> (see ${SPEC_PATH} §8 for the expected shape: { "cases": [...], "configurations": [...] }).`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    return fail(`manifest at ${manifestPath} is not valid JSON: ${error.message}`);
  }

  const cases = Array.isArray(manifest.cases) ? manifest.cases : null;
  const configurations = Array.isArray(manifest.configurations) ? manifest.configurations : null;
  if (!cases || !configurations) {
    return fail(
      `manifest must contain "cases" and "configurations" arrays (see ${SPEC_PATH} §8). Got cases=${typeof manifest.cases}, configurations=${typeof manifest.configurations}.`
    );
  }

  const outputDir = path.resolve(args.output);
  const artifactsRoot = path.join(outputDir, "artifacts");
  const temporaryDirectory = path.join(outputDir, "tmp");
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.mkdirSync(temporaryDirectory, { recursive: true });

  const sidecarSourceDir = path.join(REPO_ROOT, "tools", "whisperx-sidecar");
  const runtimeRootDir = args.runtimeDir
    ? path.resolve(args.runtimeDir)
    : path.join(os.homedir(), ".cache", "openwhispr", "whisperx-runtime");
  const modelCacheDirectory = path.join(os.homedir(), ".cache", "openwhispr", "whisperx-models");

  const manager = new WhisperXRuntimeManager({ sidecarSourceDir, runtimeRootDir });
  const status = await manager.getStatus();

  const matrix = [];
  for (const testCase of cases) {
    for (const configuration of configurations) {
      matrix.push({ testCase, configuration });
    }
  }

  if (matrix.length > 0) {
    if (!status.installed) {
      return fail(
        `WhisperX runtime is not installed (checked ${runtimeRootDir}). Run "npm run setup:whisperx" first, then re-run this benchmark. Blockers: ${
          status.blockers.map((b) => b.code).join(", ") || "none reported"
        }`
      );
    }
    if (args.requireCuda) {
      const cuda = await manager.checkCuda();
      if (!cuda.cuda) {
        return fail(
          `--require-cuda was set but CUDA is unavailable (${
            cuda.error || "no CUDA device detected"
          }). Refusing to benchmark on CPU when CUDA was required.`
        );
      }
    }
  }

  const results = [];
  const manifestDir = path.dirname(manifestPath);
  for (const { testCase, configuration } of matrix) {
    const result = await runOne({
      testCase,
      configuration,
      manifestDir,
      artifactsRoot,
      manager,
      offline: args.offline,
      modelCacheDirectory,
      temporaryDirectory,
    });
    results.push(result);
    console.log(formatRunLine(result));
  }

  const header = {
    date: new Date().toISOString(),
    gitCommit: readGitCommit(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    offline: args.offline,
    lockHash: status.lockHash,
    manifestRelative: path.relative(REPO_ROOT, manifestPath),
    caseCount: cases.length,
    configurationCount: configurations.length,
  };

  const fullResults = {
    header,
    results,
  };

  fs.writeFileSync(path.join(outputDir, "results.json"), JSON.stringify(fullResults, null, 2));
  fs.writeFileSync(path.join(outputDir, "results.csv"), buildCsv(results));
  fs.writeFileSync(path.join(outputDir, "report.md"), redactText(buildReport({ header, results })));

  console.log("");
  console.log(
    `Wrote ${results.length} result(s) to ${path.relative(process.cwd(), outputDir) || "."} (results.json, results.csv, report.md)`
  );
}

main().catch((error) => {
  fail(`unexpected error: ${redactText(error.stack || error.message || String(error))}`);
});
