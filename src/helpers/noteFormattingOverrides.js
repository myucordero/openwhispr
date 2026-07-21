// Provider overrides for note-formatting ReasoningService.processText calls.
// Self-hosted must forward remoteUrl as lanUrl — without it, processText
// guesses the provider from the model and can silently hit a cloud API.
export function buildNoteFormattingOverrides(noteFormatting, isCloudMode, customApiKey) {
  if (isCloudMode) {
    return {
      provider: "openwhispr",
      baseUrl: undefined,
      customApiKey: undefined,
      lanUrl: undefined,
    };
  }

  const mode = noteFormatting?.mode;

  if (mode === "self-hosted") {
    return {
      provider: undefined,
      baseUrl: undefined,
      customApiKey: customApiKey || undefined,
      lanUrl: noteFormatting?.remoteUrl || undefined,
    };
  }

  const rawProvider = noteFormatting?.provider;
  const isCliProvider = rawProvider === "claude-cli" || rawProvider === "codex-cli";
  // Forward the CLI provider even in "local" mode so note actions route to the
  // CLI bridge instead of guessing "local" from the (fallback GGUF) model id.
  const provider = isCliProvider
    ? rawProvider
    : mode === "providers"
      ? rawProvider || undefined
      : undefined;
  const isCustom = provider === "custom";
  return {
    provider,
    baseUrl: isCustom ? noteFormatting?.cloudBaseUrl || undefined : undefined,
    customApiKey: isCustom ? customApiKey || undefined : undefined,
    lanUrl: undefined,
  };
}
