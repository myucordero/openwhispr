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
