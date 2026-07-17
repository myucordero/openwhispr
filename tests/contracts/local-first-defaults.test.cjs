const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("settings default to local transcription", () => {
  const content = read("src/stores/settingsStore.ts");
  // Default stays local (readBoolean(..., true)); local-only builds force it on.
  assert.match(content, /useLocalWhisper:[^\n]*readBoolean\("useLocalWhisper",\s*true\)/);
});

test("signed-in onboarding is not explicitly cloud-first", () => {
  const content = read("src/components/OnboardingFlow.tsx");
  assert.doesNotMatch(content, /cloud-first/i);
});

test("local-only build flag is wired to hide cloud surfaces", () => {
  // The build-time gate that hides sign-in/account, cloud transcription, and
  // cloud reasoning/agent providers. Losing any of these re-exposes the cloud.
  assert.match(read("src/lib/features.ts"), /export const LOCAL_ONLY_MODE\s*=/);
  assert.match(read("src/lib/auth.ts"), /LOCAL_ONLY_MODE\s*\?\s*""/);
  assert.match(read("src/stores/settingsStore.ts"), /coerceLocalOnlyMode/);
  assert.match(read("src/components/TranscriptionModelPicker.tsx"), /LOCAL_ONLY_MODE/);
  assert.match(read("src/components/settings/InferenceConfigEditor.tsx"), /LOCAL_ONLY_ALLOWED_MODES/);
});

test("local-only build has a fail-closed backstop against cloud inference", () => {
  // Even with stale cloud mode/provider/model, no inference may reach a cloud
  // provider. The guard lives at ReasoningService's dispatch (all inference).
  const rs = read("src/services/ReasoningService.ts");
  assert.match(rs, /assertLocalOnlyProviderAllowed/);
  assert.match(rs, /Cloud inference is disabled in this local-only build/);
});

test("notes onboarding LLM picker is pinned to local in local-only builds", () => {
  // This picker previously rendered the full cloud provider tab bar ungated.
  const notes = read("src/components/notes/NotesOnboarding.tsx");
  assert.match(notes, /LOCAL_ONLY_MODE\s*\?\s*\{\s*mode:\s*"local"/);
});

test("local-only skips auth client construction (empty baseURL would crash the renderer)", () => {
  // createAuthClient({baseURL:""}) throws BetterAuthError("Invalid base URL: file://"),
  // which white-screens the app. Local-only must not construct the client.
  const auth = read("src/lib/auth.ts");
  assert.match(auth, /authClient\s*=\s*LOCAL_ONLY_MODE\s*\?\s*null/);
});

test("claude/codex CLI inference providers are registered and guard-exempt", () => {
  const registry = read("src/services/ai/inferenceProviders/index.ts");
  assert.match(registry, /"claude-cli":\s*claudeCliProvider/);
  assert.match(registry, /"codex-cli":\s*codexCliProvider/);
  // The local-only guard must allow the CLI backends (user's subscription).
  const rs = read("src/services/ReasoningService.ts");
  assert.match(rs, /"local",\s*"lan",\s*"claude-cli",\s*"codex-cli"/);
});

test("WhisperX note generation accepts the CLI note providers", () => {
  const main = read("src/helpers/whisperx/whisperxMain.js");
  assert.match(main, /provider === "claude-cli" \|\| provider === "codex-cli"/);
  assert.match(main, /_cliLlm/);
});

test("local-only build seeds a ready-to-use local model configuration", () => {
  const store = read("src/stores/settingsStore.ts");
  assert.match(store, /function seedLocalOnlyDefaults/);
  // Hybrid: local Whisper live, WhisperX uploads, local cleanup, Claude-CLI notes.
  assert.match(store, /whisperModel:\s*"large-v3-turbo"/);
  assert.match(store, /uploadLocalTranscriptionProvider:\s*"whisperx"/);
  assert.match(store, /cleanupProvider:\s*"qwen"/);
  assert.match(store, /noteFormattingProvider:\s*"claude-cli"/);
  assert.match(store, /onboardingCompleted:\s*"true"/);
  // Must run after all migrations so nothing overwrites the seeded keys.
  const seedCall = store.lastIndexOf("seedLocalOnlyDefaults();");
  const lastMigration = store.lastIndexOf("migrateLLMScopeKeys();");
  assert.ok(seedCall > lastMigration, "seedLocalOnlyDefaults() must run after migrateLLMScopeKeys()");
});
