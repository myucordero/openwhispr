import { useTranslation } from "react-i18next";
import { X, RotateCcw, Loader2, AlertCircle } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { useRecordingJobsStore } from "../../stores/recordingJobsStore";
import type { RecordingJobStatus } from "../../types/whisperx";

const ACTIVE_STATUSES: ReadonlySet<RecordingJobStatus> = new Set<RecordingJobStatus>([
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

const RETRYABLE_STATUSES: ReadonlySet<RecordingJobStatus> = new Set<RecordingJobStatus>([
  "failed",
  "cancelled",
  "interrupted",
  "transcript_complete_note_failed",
]);

// Warning codes we render with a friendly label; anything else falls back to the
// raw code so nothing is silently dropped.
const KNOWN_WARNING_CODES = new Set([
  "OOM_FALLBACK_USED",
  "DIARIZATION_UNAVAILABLE",
  "ALIGNMENT_PARTIAL",
  "CPU_FALLBACK_USED",
]);

function statusVariant(
  status: RecordingJobStatus
): "default" | "success" | "destructive" | "warning" | "outline" | "info" {
  switch (status) {
    case "complete":
      return "success";
    case "transcript_complete":
      return "info";
    case "failed":
      return "destructive";
    case "transcript_complete_note_failed":
      return "warning";
    case "cancelled":
    case "interrupted":
      return "outline";
    default:
      return "default";
  }
}

interface RecordingJobProgressProps {
  jobIds: string[];
}

export default function RecordingJobProgress({ jobIds }: RecordingJobProgressProps) {
  const { t } = useTranslation();
  const jobs = useRecordingJobsStore((s) => s.jobs);
  const progress = useRecordingJobsStore((s) => s.progress);
  const cancelJob = useRecordingJobsStore((s) => s.cancelJob);
  const retryJob = useRecordingJobsStore((s) => s.retryJob);

  const visibleIds = jobIds.filter((id) => jobs[id] || progress[id]);
  if (visibleIds.length === 0) return null;

  return (
    <div className="space-y-2">
      {visibleIds.map((jobId) => {
        const job = jobs[jobId];
        const evt = progress[jobId];
        const status = job?.status ?? evt?.status ?? "created";
        const isActive = ACTIVE_STATUSES.has(status);
        const isRetryable = RETRYABLE_STATUSES.has(status);

        const total = evt?.total;
        const completed = evt?.completed;
        const hasMeasuredTotal = typeof total === "number" && total > 0;
        const percent = hasMeasuredTotal
          ? Math.min(100, Math.round(((completed ?? 0) / total) * 100))
          : null;
        const unitLabel = evt?.unit ? t(`whisperx.progress.unit.${evt.unit}`) : null;

        const warnings: Array<{ code: string; message: string }> = [];
        if (evt?.warning) warnings.push(evt.warning);
        if (job?.warningJson) {
          try {
            const parsed = JSON.parse(job.warningJson);
            if (Array.isArray(parsed)) {
              for (const w of parsed) {
                if (w && typeof w.code === "string") warnings.push(w);
              }
            }
          } catch {
            /* ignore malformed warning payloads */
          }
        }

        const displayName = job?.sourceDisplayName ?? jobId;

        return (
          <div
            key={jobId}
            className="rounded-lg border border-foreground/8 dark:border-white/6 bg-surface-1/40 dark:bg-white/[0.03] p-3"
          >
            <div className="flex items-center gap-2 mb-2">
              <p className="flex-1 min-w-0 text-xs font-medium text-foreground/70 truncate">
                {displayName}
              </p>
              <Badge variant={statusVariant(status)} className="shrink-0">
                {t(`whisperx.status.${status}`)}
              </Badge>
            </div>

            {isActive && (
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="flex items-center gap-1.5 text-xs text-foreground/50">
                    <Loader2 size={11} className="animate-spin" />
                    {evt?.stage
                      ? t(`whisperx.stages.${evt.stage}`)
                      : t(`whisperx.status.${status}`)}
                  </span>
                  {percent !== null && (
                    <span className="text-xs tabular-nums text-foreground/40">
                      {percent}%
                      {evt?.estimated ? ` · ${t("whisperx.progress.estimated")}` : ""}
                    </span>
                  )}
                </div>
                <div className="w-full h-[3px] rounded-full bg-foreground/5 dark:bg-white/5 overflow-hidden">
                  {percent !== null ? (
                    <div
                      className="h-full rounded-full bg-primary/50 transition-[width] duration-500 ease-out"
                      style={{ width: `${percent}%` }}
                    />
                  ) : (
                    <div
                      className="h-full w-1/3 rounded-full bg-primary/50"
                      style={{ animation: "shimmer-slide 1.5s ease-in-out infinite" }}
                    />
                  )}
                </div>
                {percent !== null && unitLabel && (
                  <p className="text-xs text-foreground/30 mt-1">
                    {t("whisperx.progress.countOfTotal", {
                      completed: completed ?? 0,
                      total,
                      unit: unitLabel,
                    })}
                  </p>
                )}
              </div>
            )}

            {warnings.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {warnings.map((w, i) => (
                  <Badge key={`${w.code}-${i}`} variant="warning" className="gap-1">
                    <AlertCircle size={10} />
                    {KNOWN_WARNING_CODES.has(w.code)
                      ? t(`whisperx.warnings.${w.code}`)
                      : w.code}
                  </Badge>
                ))}
              </div>
            )}

            {status === "failed" && (
              <p className="text-xs text-destructive/70 leading-relaxed mb-2">
                {job?.errorCode
                  ? t(`whisperx.errors.${job.errorCode}`, {
                      defaultValue: t("whisperx.errors.generic", { code: job.errorCode }),
                    })
                  : t("whisperx.errors.unknown")}
              </p>
            )}

            <div className="flex items-center gap-1.5">
              {isActive && (
                <Button
                  onClick={() => void cancelJob(jobId)}
                  size="sm"
                  variant="ghost"
                  aria-label={t("whisperx.progress.cancel")}
                  className="h-7 px-2.5 text-xs text-foreground/40 hover:text-destructive"
                >
                  <X size={11} className="mr-1" />
                  {t("whisperx.progress.cancel")}
                </Button>
              )}
              {isRetryable && (
                <Button
                  onClick={() => void retryJob(jobId)}
                  size="sm"
                  variant="ghost"
                  aria-label={t("whisperx.progress.retry")}
                  className="h-7 px-2.5 text-xs text-foreground/50 hover:text-foreground"
                >
                  <RotateCcw size={11} className="mr-1" />
                  {t("whisperx.progress.retry")}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
