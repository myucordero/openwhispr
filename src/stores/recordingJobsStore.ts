import { create } from "zustand";
import logger from "../utils/logger";
import type {
  RecordingJobSummary,
  RecordingJobProgressEvent,
  RecordingJobStatus,
  RecordingProfile,
  RecordingLanguage,
  WhisperXModel,
  ComputeType,
  DiarizationProvider,
} from "../types/whisperx";

export interface StartJobPayload {
  sourcePath: string;
  displayName?: string;
  profile: RecordingProfile;
  overrides?: Partial<{
    language: RecordingLanguage;
    model: WhisperXModel;
    computeType: ComputeType;
    batchSize: number;
    alignment: boolean;
    diarization: boolean;
    diarizationProvider: DiarizationProvider;
    exactSpeakers: number;
    minSpeakers: number;
    maxSpeakers: number;
  }>;
  customDictionary?: string[];
  allowModelDownload?: boolean;
  noteGeneration?: {
    provider: "local";
    model: string;
    disableThinking: boolean;
  };
}

export interface GenerateNotesOptions {
  llm?: { provider: string; model: string; disableThinking?: boolean };
  strict?: boolean;
}

export interface GenerateNotesResult {
  success: boolean;
  error?: string;
  code?: string;
  noteRunId?: string;
  noteId?: number | null;
  markdown?: string;
  droppedItemIds?: string[];
  issues?: import("../types/whisperx").NoteValidationIssue[];
  failedChunks?: number;
}

interface RecordingJobsStoreState {
  jobs: Record<string, RecordingJobSummary>;
  progress: Record<string, RecordingJobProgressEvent>;
  order: string[];
  refreshJobs: (query?: { status?: string; limit?: number; offset?: number }) => Promise<void>;
  refreshJob: (jobId: string) => Promise<void>;
  startJob: (
    payload: StartJobPayload
  ) => Promise<{ success: boolean; job?: RecordingJobSummary; error?: string; code?: string }>;
  cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
  retryJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
  deleteJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
  generateNotes: (jobId: string, opts?: GenerateNotesOptions) => Promise<GenerateNotesResult>;
  attachEvents: () => void;
}

// Statuses at which a job has reached a resting point and its DB row should be
// refetched so we pick up final artifacts, durations, warnings, and error codes.
const TERMINAL_STATUSES: ReadonlySet<RecordingJobStatus> = new Set<RecordingJobStatus>([
  "transcript_complete",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
  "transcript_complete_note_failed",
]);

function upsertJob(job: RecordingJobSummary) {
  useRecordingJobsStore.setState((s) => {
    const order = s.order.includes(job.id) ? s.order : [job.id, ...s.order];
    return { jobs: { ...s.jobs, [job.id]: job }, order };
  });
}

// attachEvents idempotency guard: hold the single unsubscribe in module scope.
let eventUnsubscribe: (() => void) | null = null;

export const useRecordingJobsStore = create<RecordingJobsStoreState>()(() => ({
  jobs: {},
  progress: {},
  order: [],

  refreshJobs: async (query) => {
    try {
      const res = await window.electronAPI?.whisperxListJobs?.(query);
      if (res?.success && res.jobs) {
        const jobs: Record<string, RecordingJobSummary> = {};
        const order: string[] = [];
        for (const job of res.jobs) {
          jobs[job.id] = job;
          order.push(job.id);
        }
        useRecordingJobsStore.setState({ jobs, order });
      }
    } catch (err) {
      logger.warn(
        "Failed to refresh WhisperX jobs",
        { error: (err as Error).message },
        "whisperx"
      );
    }
  },

  refreshJob: async (jobId) => {
    try {
      const res = await window.electronAPI?.whisperxGetJob?.(jobId);
      if (res?.success && res.job) upsertJob(res.job);
    } catch (err) {
      logger.warn(
        "Failed to refresh WhisperX job",
        { jobId, error: (err as Error).message },
        "whisperx"
      );
    }
  },

  startJob: async (payload) => {
    try {
      const res = await window.electronAPI?.whisperxStartJob?.(payload);
      if (!res) {
        return { success: false, error: "WhisperX is unavailable", code: "RUNTIME_NOT_INSTALLED" };
      }
      if (res.success && res.job) upsertJob(res.job);
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start job";
      logger.warn("Failed to start WhisperX job", { error: message }, "whisperx");
      return { success: false, error: message };
    }
  },

  cancelJob: async (jobId) => {
    const res = (await window.electronAPI?.whisperxCancelJob?.(jobId)) ?? {
      success: false,
      error: "WhisperX is unavailable",
    };
    await useRecordingJobsStore.getState().refreshJob(jobId);
    return res;
  },

  retryJob: async (jobId) => {
    const res = (await window.electronAPI?.whisperxRetryJob?.(jobId)) ?? {
      success: false,
      error: "WhisperX is unavailable",
    };
    await useRecordingJobsStore.getState().refreshJob(jobId);
    return res;
  },

  deleteJob: async (jobId) => {
    const res = (await window.electronAPI?.whisperxDeleteJob?.(jobId)) ?? {
      success: false,
      error: "WhisperX is unavailable",
    };
    if (res.success) {
      useRecordingJobsStore.setState((s) => {
        const jobs = { ...s.jobs };
        const progress = { ...s.progress };
        delete jobs[jobId];
        delete progress[jobId];
        return { jobs, progress, order: s.order.filter((id) => id !== jobId) };
      });
    } else {
      await useRecordingJobsStore.getState().refreshJob(jobId);
    }
    return res;
  },

  generateNotes: async (jobId, opts) => {
    try {
      const res = await window.electronAPI?.whisperxGenerateNotes?.(jobId, opts);
      if (!res) {
        return { success: false, error: "WhisperX is unavailable", code: "WORKER_UNAVAILABLE" };
      }
      await useRecordingJobsStore.getState().refreshJob(jobId);
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate notes";
      logger.warn("Failed to generate WhisperX notes", { jobId, error: message }, "whisperx");
      await useRecordingJobsStore.getState().refreshJob(jobId);
      return { success: false, error: message };
    }
  },

  attachEvents: () => {
    if (eventUnsubscribe) return;
    const unsub = window.electronAPI?.onWhisperxJobEvent?.((event) => {
      useRecordingJobsStore.setState((s) => {
        const prevJob = s.jobs[event.jobId];
        const jobs = prevJob
          ? { ...s.jobs, [event.jobId]: { ...prevJob, status: event.status } }
          : s.jobs;
        return {
          progress: { ...s.progress, [event.jobId]: event },
          jobs,
        };
      });
      if (TERMINAL_STATUSES.has(event.status)) {
        void useRecordingJobsStore.getState().refreshJob(event.jobId);
      }
    });
    eventUnsubscribe = unsub ?? null;
  },
}));
