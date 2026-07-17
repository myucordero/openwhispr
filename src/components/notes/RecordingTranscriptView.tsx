import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Download, Loader2, Pencil, Users, X } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import type {
  ArtifactDescriptor,
  ArtifactKind,
  RecordingJobSummary,
  SegmentFlag,
  TranscriptSegment,
} from "../../types/whisperx";
import RecordingAudioPlayer, {
  AUDIO_PLAYBACK_AVAILABLE,
  type RecordingAudioPlayerHandle,
} from "./RecordingAudioPlayer";

const PAGE_SIZE = 200;

// Exportable artifact kinds, in the order they appear in the header. Each maps
// to a file extension and MIME type for the browser Blob download.
const EXPORT_KINDS: Array<{ kind: ArtifactKind; ext: string; mime: string; labelKey: string }> = [
  { kind: "raw-transcript", ext: "txt", mime: "text/plain", labelKey: "whisperx.review.export.raw" },
  {
    kind: "speaker-transcript",
    ext: "md",
    mime: "text/markdown",
    labelKey: "whisperx.review.export.speaker",
  },
  { kind: "srt", ext: "srt", mime: "application/x-subrip", labelKey: "whisperx.review.export.srt" },
  { kind: "vtt", ext: "vtt", mime: "text/vtt", labelKey: "whisperx.review.export.vtt" },
];

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function sanitizeFileBase(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "").replace(/[/\\?%*:|"<>]/g, "_").trim();
  return base.length > 0 ? base : "transcript";
}

interface Provenance {
  model: string | null;
  languageDetected: string | null;
  createdAt: string | null;
}

interface RecordingTranscriptViewProps {
  job: RecordingJobSummary;
  onBack: () => void;
}

export default function RecordingTranscriptView({ job, onBack }: RecordingTranscriptViewProps) {
  const { t } = useTranslation();
  const jobId = job.id;

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [total, setTotal] = useState(0);
  const [speakers, setSpeakers] = useState<Array<{ id: string; displayName?: string }>>([]);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Speaker display names: current input values + last persisted values.
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const savedSpeakerNames = useRef<Record<string, string>>({});
  const [speakerError, setSpeakerError] = useState<string | null>(null);

  // Transcript edits: latest revised text per segment (overlaid client-side).
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const [exportError, setExportError] = useState<string | null>(null);
  const [exportingKind, setExportingKind] = useState<ArtifactKind | null>(null);

  const audioRef = useRef<RecordingAudioPlayerHandle | null>(null);

  const loadPage = useCallback(
    async (offset: number) => {
      const res = await window.electronAPI.whisperxReadTranscriptPage?.({
        jobId,
        offset,
        limit: PAGE_SIZE,
      });
      if (!res?.success) {
        throw new Error(res?.error || "read failed");
      }
      const page = res.segments ?? [];
      setSegments((prev) => (offset === 0 ? page : [...prev, ...page]));
      setTotal(res.total ?? 0);
      if (offset === 0) {
        setSpeakers(res.speakers ?? []);
        setProvenance(res.provenance ?? null);
      }
    },
    [jobId]
  );

  // Initial load: job artifacts + speaker mappings, first transcript page, and
  // the revision history (overlaid latest-per-segment).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const jobRes = await window.electronAPI.whisperxGetJob?.(jobId);
        const revRes = await window.electronAPI.whisperxListTranscriptRevisions?.(jobId);
        await loadPage(0);
        if (cancelled) return;

        if (jobRes?.success) {
          setArtifacts(jobRes.artifacts ?? []);
          const mappings = jobRes.speakerMappings ?? {};
          setSpeakerNames(mappings);
          savedSpeakerNames.current = { ...mappings };
        }
        if (revRes?.success && Array.isArray(revRes.revisions)) {
          // Ordered ascending by createdAt — last write per segment wins.
          const overlay: Record<string, string> = {};
          for (const r of revRes.revisions) overlay[r.segmentId] = r.newText;
          setRevisions(overlay);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, loadPage]);

  const handleLoadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await loadPage(segments.length);
    } catch {
      setError(t("whisperx.review.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  };

  const speakerList = useMemo(() => {
    const ids = new Set<string>();
    for (const s of speakers) ids.add(s.id);
    for (const seg of segments) if (seg.speakerId) ids.add(seg.speakerId);
    return Array.from(ids);
  }, [speakers, segments]);

  const speakerLabel = useCallback(
    (speakerId: string | undefined): string => {
      if (!speakerId) return t("whisperx.review.unknownSpeaker");
      return speakerNames[speakerId]?.trim() || speakerId;
    },
    [speakerNames, t]
  );

  const saveSpeakerName = async (speakerId: string) => {
    const value = (speakerNames[speakerId] ?? "").trim();
    if (value === (savedSpeakerNames.current[speakerId] ?? "")) return;
    setSpeakerError(null);
    const res = await window.electronAPI.whisperxSaveSpeakerMapping?.({
      jobId,
      speakerId,
      displayName: value,
    });
    if (res?.success) {
      savedSpeakerNames.current = { ...savedSpeakerNames.current, [speakerId]: value };
      if (res.speakerMappings) {
        setSpeakerNames((prev) => ({ ...prev, ...res.speakerMappings }));
        savedSpeakerNames.current = { ...savedSpeakerNames.current, ...res.speakerMappings };
      }
    } else {
      setSpeakerError(t("whisperx.review.speakerSaveError"));
    }
  };

  const displayedText = useCallback(
    (seg: TranscriptSegment): string => revisions[seg.id] ?? seg.text,
    [revisions]
  );

  const startEdit = (seg: TranscriptSegment) => {
    setEditError(null);
    setEditingId(seg.id);
    setDraftText(displayedText(seg));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftText("");
  };

  const saveEdit = async (seg: TranscriptSegment) => {
    const newText = draftText;
    const oldText = displayedText(seg);
    if (newText === oldText) {
      cancelEdit();
      return;
    }
    setEditError(null);
    const res = await window.electronAPI.whisperxSaveTranscriptRevision?.({
      jobId,
      segmentId: seg.id,
      oldText,
      newText,
    });
    if (res?.success) {
      setRevisions((prev) => ({ ...prev, [seg.id]: newText }));
      cancelEdit();
    } else {
      setEditError(t("whisperx.review.saveRevisionError"));
    }
  };

  const handleSeek = (seconds: number) => {
    audioRef.current?.seekTo(seconds);
  };

  const availableExports = useMemo(() => {
    const byKind = new Map(artifacts.map((a) => [a.kind, a]));
    return EXPORT_KINDS.filter((e) => byKind.has(e.kind)).map((e) => ({
      ...e,
      descriptor: byKind.get(e.kind)!,
    }));
  }, [artifacts]);

  const handleExport = async (
    entry: { kind: ArtifactKind; ext: string; mime: string; descriptor: ArtifactDescriptor }
  ) => {
    setExportError(null);
    setExportingKind(entry.kind);
    try {
      const res = await window.electronAPI.whisperxReadArtifact?.({
        jobId,
        relativePath: entry.descriptor.relativePath,
      });
      if (!res?.success || typeof res.text !== "string") {
        throw new Error(res?.error || "export failed");
      }
      const blob = new Blob([res.text], { type: entry.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sanitizeFileBase(job.sourceDisplayName)}.${entry.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(t("whisperx.review.exportError"));
    } finally {
      setExportingKind(null);
    }
  };

  const canSeek = AUDIO_PLAYBACK_AVAILABLE;
  const languageLabel =
    provenance?.languageDetected || t("whisperx.review.provenance.languageUnknown");

  return (
    <div className="space-y-4" style={{ animation: "float-up 0.25s ease-out" }}>
      {/* Header */}
      <div className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={t("whisperx.review.back")}
          className="h-7 px-2 text-xs text-foreground/50 hover:text-foreground shrink-0"
        >
          <ArrowLeft size={13} className="mr-1" />
          {t("whisperx.review.back")}
        </Button>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-foreground truncate">{job.sourceDisplayName}</h3>
        <p className="text-xs text-foreground/35 mt-0.5">
          {t("whisperx.review.provenance.summary", {
            model: provenance?.model || t("whisperx.review.provenance.modelUnknown"),
            language: languageLabel,
          })}
        </p>
      </div>

      {/* Audio player (graceful degradation when playback is unavailable) */}
      <RecordingAudioPlayer ref={audioRef} jobId={job.id} sourcePath={job.sourcePath} />

      {/* Exports */}
      {availableExports.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground/50">{t("whisperx.review.exports")}</p>
          <div className="flex flex-wrap gap-1.5">
            {availableExports.map((entry) => (
              <Button
                key={entry.kind}
                variant="outline"
                size="sm"
                onClick={() => void handleExport(entry)}
                disabled={exportingKind !== null}
                className="h-7 px-2.5 text-xs"
              >
                {exportingKind === entry.kind ? (
                  <Loader2 size={11} className="mr-1 animate-spin" />
                ) : (
                  <Download size={11} className="mr-1" />
                )}
                {t(entry.labelKey)}
              </Button>
            ))}
          </div>
          {exportError && <p className="text-xs text-destructive/70">{exportError}</p>}
        </div>
      )}

      {/* Speakers */}
      {speakerList.length > 0 && (
        <div className="rounded-lg border border-foreground/8 dark:border-white/6 bg-surface-1/40 dark:bg-white/[0.03] p-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <Users size={12} className="text-foreground/40" />
            <p className="text-xs font-medium text-foreground/60">
              {t("whisperx.review.speakers")}
            </p>
          </div>
          <p className="text-xs text-foreground/35 leading-relaxed">
            {t("whisperx.review.speakerMappingNote")}
          </p>
          <div className="space-y-1.5">
            {speakerList.map((id) => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-xs text-foreground/40 w-24 shrink-0 truncate" title={id}>
                  {id}
                </span>
                <Input
                  value={speakerNames[id] ?? ""}
                  onChange={(e) =>
                    setSpeakerNames((prev) => ({ ...prev, [id]: e.target.value }))
                  }
                  onBlur={() => void saveSpeakerName(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  placeholder={t("whisperx.review.speakerNamePlaceholder")}
                  aria-label={t("whisperx.review.speakerNameAria", { speaker: id })}
                  className="h-7 text-xs flex-1"
                />
              </div>
            ))}
          </div>
          {speakerError && <p className="text-xs text-destructive/70">{speakerError}</p>}
        </div>
      )}

      {/* Transcript */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-foreground/40">
          <Loader2 size={13} className="animate-spin" />
          {t("whisperx.review.loadingTranscript")}
        </div>
      ) : error ? (
        <p className="text-xs text-destructive/70 py-4 text-center">{error}</p>
      ) : segments.length === 0 ? (
        <p className="text-xs text-foreground/40 py-6 text-center">
          {t("whisperx.review.noTranscript")}
        </p>
      ) : (
        <div className="space-y-3">
          {editError && <p className="text-xs text-destructive/70">{editError}</p>}
          {segments.map((seg) => {
            const isEditing = editingId === seg.id;
            const isRevised = seg.id in revisions;
            const text = displayedText(seg);
            return (
              <div key={seg.id} className="group">
                <div className="flex items-center gap-2 mb-0.5">
                  {canSeek ? (
                    <button
                      type="button"
                      onClick={() => handleSeek(seg.start)}
                      className="text-xs tabular-nums text-primary/70 hover:text-primary transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
                    >
                      {formatTimestamp(seg.start)}
                    </button>
                  ) : (
                    <span className="text-xs tabular-nums text-foreground/30">
                      {formatTimestamp(seg.start)}
                    </span>
                  )}
                  <span className="text-xs font-medium text-foreground/55 truncate">
                    {speakerLabel(seg.speakerId)}
                  </span>
                  {isRevised && (
                    <Badge
                      variant="info"
                      className="shrink-0"
                      title={t("whisperx.review.originalLabel", { text: seg.text })}
                    >
                      {t("whisperx.review.edited")}
                    </Badge>
                  )}
                  {seg.flags?.map((flag: SegmentFlag) => (
                    <Badge key={flag} variant="warning" className="shrink-0">
                      {t(`whisperx.review.flags.${flag}`)}
                    </Badge>
                  ))}
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => startEdit(seg)}
                      aria-label={t("whisperx.review.edit")}
                      className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-foreground/30 hover:text-foreground/60 transition-opacity p-0.5 rounded"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      aria-label={t("whisperx.review.editPlaceholder")}
                      rows={3}
                      autoFocus
                      className={cn(
                        "w-full text-xs rounded-md border border-foreground/12 dark:border-white/10 bg-surface-1/60 dark:bg-white/[0.04] p-2 leading-relaxed",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 resize-y"
                      )}
                    />
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => void saveEdit(seg)}
                        className="h-6 px-2 text-xs"
                      >
                        <Check size={11} className="mr-1" />
                        {t("whisperx.review.save")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={cancelEdit}
                        className="h-6 px-2 text-xs text-foreground/40"
                      >
                        <X size={11} className="mr-1" />
                        {t("whisperx.review.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p
                    className="text-xs text-foreground/70 leading-relaxed"
                    title={isRevised ? t("whisperx.review.originalLabel", { text: seg.text }) : undefined}
                  >
                    {text}
                  </p>
                )}
              </div>
            );
          })}

          {total > segments.length && (
            <div className="flex flex-col items-center gap-1 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
                className="h-7 px-3 text-xs text-foreground/50"
              >
                {loadingMore ? (
                  <Loader2 size={11} className="mr-1 animate-spin" />
                ) : null}
                {t("whisperx.review.loadMore")}
              </Button>
              <p className="text-xs text-foreground/25">
                {t("whisperx.review.segmentCount", { loaded: segments.length, total })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
