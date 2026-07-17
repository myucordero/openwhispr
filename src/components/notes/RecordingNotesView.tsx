import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { useRecordingJobsStore } from "../../stores/recordingJobsStore";
import { useCliNoteReady } from "../../hooks/useCliNoteReady";
import {
  useSettingsStore,
  selectResolvedNoteFormatting,
  selectResolvedLLMConfig,
} from "../../stores/settingsStore";
import type { RecordingJobStatus, RecordingJobSummary } from "../../types/whisperx";

// Statuses reached while the note pipeline is running. When the live job sits at
// one of these, the generate button reflects in-flight progress.
const NOTE_ACTIVE_STATUSES: ReadonlySet<RecordingJobStatus> = new Set<RecordingJobStatus>([
  "note_extracting",
  "note_validating",
  "note_rendering",
]);

// The renderer marks review-required items with "⚠️ *Needs review*"; presence of
// this substring drives the legend (kept in sync with noteRenderer.js).
const REVIEW_MARKER_TEXT = "Needs review";

interface RecordingNotesViewProps {
  job: RecordingJobSummary;
}

export default function RecordingNotesView({ job }: RecordingNotesViewProps) {
  const { t } = useTranslation();
  const jobId = job.id;

  // Live status/progress flow through the store from whisperx-job-event.
  const liveJob = useRecordingJobsStore((s) => s.jobs[jobId]);
  const progressEvt = useRecordingJobsStore((s) => s.progress[jobId]);
  const generateNotes = useRecordingJobsStore((s) => s.generateNotes);

  const status: RecordingJobStatus = liveJob?.status ?? job.status;
  const errorCode = liveJob?.errorCode ?? job.errorCode;

  // Current resolved note-formatting config (reactive to settings changes).
  const noteProvider = useSettingsStore((s) => selectResolvedNoteFormatting(s).provider);
  const noteModel = useSettingsStore((s) => selectResolvedNoteFormatting(s).model);
  const isCliNoteProvider = noteProvider === "claude-cli" || noteProvider === "codex-cli";
  const cliNoteReady = useCliNoteReady(noteProvider);
  // Note generation is available with a local GGUF (needs a model) or an
  // installed local CLI backend (claude/codex, no model id needed).
  const isLocalNoteModel =
    ((noteProvider === "local" && noteModel.length > 0) || isCliNoteProvider) && cliNoteReady;

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [strict, setStrict] = useState(job.profile === "critical-interview");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ dropped: number; issues: number } | null>(null);

  const isNoteActive = running || NOTE_ACTIVE_STATUSES.has(status);
  const noteFailed = status === "transcript_complete_note_failed";

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const jobRes = await window.electronAPI.whisperxGetJob?.(jobId);
      if (!jobRes?.success) throw new Error("load failed");
      const artifact = (jobRes.artifacts ?? []).find((a) => a.kind === "notes-markdown");
      if (!artifact) {
        setMarkdown(null);
        return;
      }
      const res = await window.electronAPI.whisperxReadArtifact?.({
        jobId,
        relativePath: artifact.relativePath,
      });
      setMarkdown(res?.success && typeof res.text === "string" ? res.text : null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  // A completed run leaves the job at "complete"; reload the persisted artifact.
  useEffect(() => {
    if (status === "complete") void loadNotes();
  }, [status, loadNotes]);

  const handleGenerate = async () => {
    if (!isLocalNoteModel || running) return;
    setRunning(true);
    setRunError(null);
    setLastRun(null);
    try {
      const state = useSettingsStore.getState();
      const noteCfg = selectResolvedNoteFormatting(state);
      const llmCfg = selectResolvedLLMConfig(state, "noteFormatting");
      const res = await generateNotes(jobId, {
        llm: {
          provider: noteCfg.provider,
          // CLI backends use the subscription default; don't forward the
          // fallback GGUF model id (noteFormatting falls back to cleanup).
          model: isCliNoteProvider ? "" : noteCfg.model,
          disableThinking: llmCfg.disableThinking !== false,
        },
        strict,
      });
      if (res.success) {
        setLastRun({
          dropped: res.droppedItemIds?.length ?? 0,
          issues: res.issues?.length ?? 0,
        });
        if (typeof res.markdown === "string") setMarkdown(res.markdown);
        else await loadNotes();
      } else {
        setRunError(res.code || res.error || "generate failed");
      }
    } finally {
      setRunning(false);
    }
  };

  const hasNotes = markdown != null && markdown.trim().length > 0;
  const showReviewLegend = hasNotes && markdown!.includes(REVIEW_MARKER_TEXT);
  const generateLabel = hasNotes
    ? t("whisperx.notes.regenerate")
    : t("whisperx.notes.generate");

  return (
    <div className="space-y-4">
      {/* Header row: model info + strict toggle + generate/regenerate */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleGenerate()}
            disabled={!isLocalNoteModel || isNoteActive}
            title={!isLocalNoteModel ? t("whisperx.notes.noLocalModel") : undefined}
            className="h-7 px-2.5 text-xs"
          >
            {isNoteActive ? (
              <Loader2 size={11} className="mr-1 animate-spin" />
            ) : (
              <Sparkles size={11} className="mr-1" />
            )}
            {isNoteActive ? t("whisperx.notes.generating") : generateLabel}
          </Button>

          <label className="flex items-center gap-1.5 text-xs text-foreground/50 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={strict}
              disabled={isNoteActive}
              onChange={(e) => setStrict(e.target.checked)}
              className="h-3 w-3 rounded border-foreground/20 accent-primary"
            />
            <span title={t("whisperx.notes.strictHint")}>{t("whisperx.notes.strict")}</span>
          </label>
        </div>

        <p className="text-xs text-foreground/30">
          {isLocalNoteModel
            ? t("whisperx.notes.notesModelInfo", {
                model: isCliNoteProvider
                  ? noteProvider === "claude-cli"
                    ? "Claude"
                    : "Codex"
                  : noteModel,
              })
            : t("whisperx.notes.notesModelNone")}
        </p>

        {isNoteActive && (
          <p className="flex items-center gap-1.5 text-xs text-foreground/45">
            <Loader2 size={11} className="animate-spin" />
            {t(`whisperx.status.${status}`, { defaultValue: t("whisperx.notes.generating") })}
            {progressEvt?.total ? (
              <span className="tabular-nums text-foreground/30">
                {" · "}
                {progressEvt.completed ?? 0}/{progressEvt.total}
              </span>
            ) : null}
          </p>
        )}

        {lastRun && (lastRun.dropped > 0 || lastRun.issues > 0) && (
          <p className="text-xs text-foreground/40">
            {t("whisperx.notes.droppedSummary", {
              dropped: lastRun.dropped,
              issues: lastRun.issues,
            })}
          </p>
        )}
      </div>

      {/* Note-generation failure banner */}
      {noteFailed && (
        <div className="rounded-lg border border-destructive/15 bg-destructive/[0.03] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertCircle size={13} className="text-destructive/50 shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1.5">
              <p className="text-xs text-destructive/70 leading-relaxed">
                {t("whisperx.notes.failed")}
                {errorCode ? ` (${errorCode})` : ""}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleGenerate()}
                disabled={!isLocalNoteModel || isNoteActive}
                className="h-6 px-2 text-xs text-foreground/50 hover:text-foreground"
              >
                <RotateCcw size={11} className="mr-1" />
                {t("whisperx.notes.retry")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Inline run error (from a manual attempt) */}
      {runError && !noteFailed && (
        <p className="text-xs text-destructive/70">
          {t("whisperx.notes.failed")} ({runError})
        </p>
      )}

      {/* Review-marker legend */}
      {showReviewLegend && (
        <p className="flex items-center gap-1.5 text-xs text-foreground/40">
          <AlertTriangle size={11} className="text-warning" />
          {t("whisperx.notes.reviewLegend")}
        </p>
      )}

      {/* Notes body */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-foreground/40">
          <Loader2 size={13} className="animate-spin" />
          {t("whisperx.notes.generating")}
        </div>
      ) : loadError ? (
        <p className="text-xs text-destructive/70 py-4 text-center">{loadError}</p>
      ) : hasNotes ? (
        <MarkdownRenderer content={markdown!} className="text-xs text-foreground/70" />
      ) : (
        !noteFailed && (
          <p className="text-xs text-foreground/40 py-6 text-center">
            {t("whisperx.notes.noneYet")}
          </p>
        )
      )}
    </div>
  );
}
