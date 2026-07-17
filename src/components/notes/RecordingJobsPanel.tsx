import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  FileAudio,
  FileText,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { ConfirmDialog } from "../ui/dialog";
import { cn } from "../lib/utils";
import { useRecordingJobsStore } from "../../stores/recordingJobsStore";
import type { RecordingJobStatus, RecordingJobSummary } from "../../types/whisperx";
import RecordingTranscriptView from "./RecordingTranscriptView";

// Jobs whose canonical transcript exists and can be opened for review.
const OPENABLE_STATUSES: ReadonlySet<RecordingJobStatus> = new Set<RecordingJobStatus>([
  "transcript_complete",
  "complete",
  "transcript_complete_note_failed",
]);

// Jobs that can be re-run from a resting failure/cancel state.
const RETRYABLE_STATUSES: ReadonlySet<RecordingJobStatus> = new Set<RecordingJobStatus>([
  "failed",
  "cancelled",
  "interrupted",
  "transcript_complete_note_failed",
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function RecordingJobsPanel() {
  const { t, i18n } = useTranslation();
  const jobsById = useRecordingJobsStore((s) => s.jobs);
  const order = useRecordingJobsStore((s) => s.order);
  const refreshJobs = useRecordingJobsStore((s) => s.refreshJobs);
  const retryJob = useRecordingJobsStore((s) => s.retryJob);
  const deleteJob = useRecordingJobsStore((s) => s.deleteJob);

  const [open, setOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecordingJobSummary | null>(null);
  const [storageTotal, setStorageTotal] = useState<number | null>(null);

  const jobs = useMemo(
    () => order.map((id) => jobsById[id]).filter((j): j is RecordingJobSummary => Boolean(j)),
    [order, jobsById]
  );

  const refreshStorage = () => {
    void window.electronAPI.whisperxGetStorageUsage?.().then((res) => {
      if (res?.success) setStorageTotal(res.total ?? 0);
    });
  };

  useEffect(() => {
    void refreshJobs();
    refreshStorage();
  }, [refreshJobs]);

  const formatDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString(i18n.language, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    if (selectedJobId === target.id) setSelectedJobId(null);
    const res = await deleteJob(target.id);
    if (res.success) refreshStorage();
  };

  const selectedJob = selectedJobId ? jobsById[selectedJobId] : null;

  return (
    <div className="w-full">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full text-xs font-medium text-foreground/50 hover:text-foreground/70 transition-colors py-1"
      >
        <ChevronRight
          size={12}
          className={cn("transition-transform duration-200", open && "rotate-90")}
        />
        {t("whisperx.review.recordings")}
        {jobs.length > 0 && (
          <Badge variant="outline" className="ml-1">
            {jobs.length}
          </Badge>
        )}
      </button>

      {open && (
        <div className="mt-3">
          {selectedJob ? (
            <RecordingTranscriptView job={selectedJob} onBack={() => setSelectedJobId(null)} />
          ) : jobs.length === 0 ? (
            <p className="text-xs text-foreground/35 text-center py-6">
              {t("whisperx.review.empty")}
            </p>
          ) : (
            <>
              <div className="space-y-2">
                {jobs.map((job) => {
                  const canOpen = OPENABLE_STATUSES.has(job.status);
                  const canRetry = RETRYABLE_STATUSES.has(job.status);
                  return (
                    <div
                      key={job.id}
                      className="rounded-lg border border-foreground/8 dark:border-white/6 bg-surface-1/40 dark:bg-white/[0.03] p-3"
                    >
                      <div className="flex items-center gap-2">
                        <FileAudio size={13} className="text-primary/60 shrink-0" />
                        <p className="flex-1 min-w-0 text-xs font-medium text-foreground/70 truncate">
                          {job.sourceDisplayName}
                        </p>
                        <Badge variant={statusVariant(job.status)} className="shrink-0">
                          {t(`whisperx.status.${job.status}`)}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-xs text-foreground/30">
                        <Badge variant="outline" className="px-2 py-0">
                          {t(`whisperx.profiles.${job.profile}.name`)}
                        </Badge>
                        <span>{formatDate(job.createdAt)}</span>
                        {job.durationSeconds != null && (
                          <span>· {formatDuration(job.durationSeconds)}</span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 mt-2">
                        {canOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedJobId(job.id)}
                            className="h-7 px-2.5 text-xs text-foreground/60 hover:text-foreground"
                          >
                            <FileText size={11} className="mr-1" />
                            {t("whisperx.review.open")}
                          </Button>
                        )}
                        {canRetry && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void retryJob(job.id)}
                            className="h-7 px-2.5 text-xs text-foreground/50 hover:text-foreground"
                          >
                            <RotateCcw size={11} className="mr-1" />
                            {t("whisperx.review.retry")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(job)}
                          aria-label={t("whisperx.review.delete")}
                          className="h-7 px-2.5 text-xs text-foreground/40 hover:text-destructive ml-auto"
                        >
                          <Trash2 size={11} className="mr-1" />
                          {t("whisperx.review.delete")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Storage footer */}
              {storageTotal != null && (
                <p className="text-xs text-foreground/30 text-center mt-3">
                  {t("whisperx.review.storageUsed", { size: formatBytes(storageTotal) })}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("whisperx.review.deleteTitle")}
        description={t("whisperx.review.deleteDescription")}
        confirmText={t("whisperx.review.deleteConfirm")}
        cancelText={t("whisperx.review.cancel")}
        onConfirm={() => void confirmDelete()}
        variant="destructive"
      />
    </div>
  );
}
