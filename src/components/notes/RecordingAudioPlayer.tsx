import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { VolumeX } from "lucide-react";

// Audio playback for a WhisperX job's source recording (FR-036).
// The main process exposes `whisperx-read-source-audio`, keyed by job id only
// (the path comes from the job row — the renderer can never request an
// arbitrary file). The buffer is bounded (300 MB) main-side; here it becomes
// a Blob URL feeding a native <audio> element with an imperative seekTo used
// by transcript timestamp clicks. Degrades to a notice when the source file
// is missing, oversized, or the preload method is absent.
export const AUDIO_PLAYBACK_AVAILABLE = true;

export interface RecordingAudioPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface RecordingAudioPlayerProps {
  jobId: string;
  sourcePath: string | null;
}

const RecordingAudioPlayer = forwardRef<RecordingAudioPlayerHandle, RecordingAudioPlayerProps>(
  function RecordingAudioPlayer({ jobId }, ref) {
    const { t } = useTranslation();
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      let cancelled = false;
      let createdUrl: string | null = null;
      setObjectUrl(null);
      setUnavailable(false);
      setLoading(true);

      const load = async () => {
        try {
          const result = await window.electronAPI.whisperxReadSourceAudio?.(jobId);
          if (cancelled) return;
          if (!result?.success || !result.audio) {
            setUnavailable(true);
            return;
          }
          const bytes = result.audio as unknown as ArrayBuffer | Uint8Array;
          const blob = new Blob([bytes instanceof Uint8Array ? (bytes as any) : new Uint8Array(bytes)], {
            type: result.mimeType || "application/octet-stream",
          });
          createdUrl = URL.createObjectURL(blob);
          setObjectUrl(createdUrl);
        } catch {
          if (!cancelled) setUnavailable(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      };
      void load();

      return () => {
        cancelled = true;
        if (createdUrl) URL.revokeObjectURL(createdUrl);
      };
    }, [jobId]);

    useImperativeHandle(
      ref,
      () => ({
        seekTo: (seconds: number) => {
          const el = audioElRef.current;
          if (!el) return;
          el.currentTime = Math.max(0, seconds);
          void el.play().catch(() => {});
        },
      }),
      []
    );

    if (loading) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-foreground/8 dark:border-white/6 bg-surface-1/40 dark:bg-white/[0.03] px-3 py-2">
          <p className="text-xs text-foreground/35">{t("whisperx.review.loadingTranscript")}</p>
        </div>
      );
    }

    if (unavailable || !objectUrl) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-foreground/8 dark:border-white/6 bg-surface-1/40 dark:bg-white/[0.03] px-3 py-2">
          <VolumeX size={13} className="text-foreground/25 shrink-0" />
          <p className="text-xs text-foreground/35">{t("whisperx.review.audioUnavailable")}</p>
        </div>
      );
    }

    return (
      <audio
        ref={audioElRef}
        src={objectUrl}
        controls
        preload="metadata"
        className="w-full h-9"
        aria-label={t("whisperx.review.audioPlayerAria")}
      />
    );
  }
);

export default RecordingAudioPlayer;
