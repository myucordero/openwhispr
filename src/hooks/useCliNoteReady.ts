import { useEffect, useState } from "react";

// Whether the note backend for `provider` is usable. Non-CLI providers are
// always "ready" (their readiness is decided by model presence elsewhere). For
// the claude-cli/codex-cli backends this probes the local CLI once so a missing
// or unauthenticated install surfaces up front instead of failing every note
// generation at runtime. While the probe is in flight it returns true to avoid
// UI flicker; only a confirmed-unavailable CLI gates the UI off.
export function useCliNoteReady(provider: string | undefined): boolean {
  const isCli = provider === "claude-cli" || provider === "codex-cli";
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isCli) {
      setAvailable(true);
      return;
    }
    let alive = true;
    const cli = provider === "codex-cli" ? "codex" : "claude";
    setAvailable(null);
    window.electronAPI
      ?.cliInferenceAvailable?.(cli)
      .then((r) => {
        if (alive) setAvailable(!!r?.available);
      })
      .catch(() => {
        if (alive) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, [isCli, provider]);

  return available !== false;
}
