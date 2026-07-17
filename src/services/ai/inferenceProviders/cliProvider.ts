import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";

// Reasoning backed by the user's local `claude` / `codex` CLI (subscription
// auth). The CLI runs on-device but calls the vendor cloud — a deliberate
// opt-in exception to the local-only build. Text-in / text-out (non-streaming);
// used for note formatting and the dictation agent.
function makeCliProvider(id: string, cli: "claude" | "codex"): InferenceProvider {
  return {
    id,
    async call({ text, model, agentName, config, ctx }) {
      if (typeof window === "undefined" || !window.electronAPI?.cliInference) {
        throw new Error(`${cli} CLI bridge is not available in this environment`);
      }
      const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
      // Cleanup passes no systemPrompt (wrap the transcript); agent/notes pass one.
      const prompt = config.systemPrompt ? text : wrapCleanupTranscript(text);

      logger.logReasoning("CLI_START", { cli, agentName, model, textLength: text.length });
      const started = Date.now();
      const result = await window.electronAPI.cliInference({
        cli,
        prompt,
        systemPrompt: systemPrompt || undefined,
        model: model?.trim() || undefined,
      });
      if (!result?.success || typeof result.text !== "string") {
        logger.logReasoning("CLI_ERROR", { cli, error: result?.error, code: result?.code });
        throw new Error(result?.error || `${cli} CLI inference failed`);
      }
      logger.logReasoning("CLI_SUCCESS", {
        cli,
        processingTimeMs: Date.now() - started,
        resultLength: result.text.length,
      });
      return result.text;
    },
  };
}

export const claudeCliProvider = makeCliProvider("claude-cli", "claude");
export const codexCliProvider = makeCliProvider("codex-cli", "codex");
