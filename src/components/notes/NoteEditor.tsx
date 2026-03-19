import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Loader2,
  FileText,
  Sparkles,
  AlignLeft,
  Radio,
  MessageSquareText,
} from "lucide-react";
import { RichTextEditor } from "../ui/RichTextEditor";
import type { Editor } from "@tiptap/react";
import { MeetingTranscriptChat } from "./MeetingTranscriptChat";
import type { TranscriptSegment } from "../../hooks/useMeetingTranscription";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { NoteItem } from "../../types/electron";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import ActionProcessingOverlay from "./ActionProcessingOverlay";
import DictationWidget from "./DictationWidget";
import { normalizeDbDate } from "../../utils/dateFormatting";
import { useSettingsStore } from "../../stores/settingsStore";

function formatNoteDate(dateStr: string): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} \u00b7 ${timePart}`;
}

export interface Enhancement {
  content: string;
  isStale: boolean;
  onChange: (content: string) => void;
}

type MeetingViewMode = "raw" | "transcript" | "enhanced";

interface NoteEditorProps {
  note: NoteItem;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  isSaving: boolean;
  isRecording: boolean;
  partialTranscript: string;
  finalTranscript: string | null;
  onFinalTranscriptConsumed: () => void;
  streamingCommit: string | null;
  onStreamingCommitConsumed: () => void;
  isProcessing: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onExportNote?: (format: "md" | "txt") => void;
  enhancement?: Enhancement;
  actionPicker?: React.ReactNode;
  actionProcessingState?: ActionProcessingState;
  actionName?: string | null;
  isMeetingRecording?: boolean;
  meetingTranscript?: string;
  meetingSegments?: TranscriptSegment[];
  meetingMicPartial?: string;
  meetingSystemPartial?: string;
  onStopMeetingRecording?: () => void;
  liveTranscript?: string;
}

interface DictationRange {
  start: number;
  partialStart: number;
  end: number;
  committedChars: number;
}

export default function NoteEditor({
  note,
  onTitleChange,
  onContentChange,
  isSaving,
  isRecording,
  isProcessing,
  partialTranscript,
  finalTranscript,
  onFinalTranscriptConsumed,
  streamingCommit,
  onStreamingCommitConsumed,
  onStartRecording,
  onStopRecording,
  onExportNote,
  enhancement,
  actionPicker,
  actionProcessingState,
  actionName,
  isMeetingRecording,
  meetingTranscript,
  meetingSegments,
  meetingMicPartial,
  meetingSystemPartial,
  onStopMeetingRecording,
  liveTranscript,
}: NoteEditorProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<MeetingViewMode>("raw");
  const editorRef = useRef<Editor | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const prevNoteIdRef = useRef<number>(note.id);

  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const cloudMode = useSettingsStore((s) => s.cloudTranscriptionMode);
  const useLocalWhisper = useSettingsStore((s) => s.useLocalWhisper);
  const canStream = isSignedIn && cloudMode === "openwhispr" && !useLocalWhisper;

  const [liveMode, setLiveMode] = useState(() => {
    const pref = localStorage.getItem("notesStreamingPreference");
    return pref === "streaming";
  });

  const handleLiveToggle = useCallback(() => {
    setLiveMode((prev) => {
      const next = !prev;
      localStorage.setItem("notesStreamingPreference", next ? "streaming" : "batch");
      return next;
    });
  }, []);

  const cursorPosRef = useRef(0);
  const dictationRef = useRef<DictationRange | null>(null);
  const prevRecordingRef = useRef(false);
  const contentRef = useRef(note.content);
  contentRef.current = note.content;

  const commitContentChange = useCallback(
    (newContent: string) => {
      contentRef.current = newContent;
      onContentChange(newContent);
    },
    [onContentChange]
  );

  // Insert text directly into TipTap at ProseMirror positions (fast, no full-doc replace).
  // TipTap's onUpdate callback handles syncing markdown back to the parent.
  const editorInsertText = useCallback((from: number, to: number, text: string) => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    ed.chain().deleteRange({ from, to }).insertContentAt(from, text).run();
  }, []);

  const segmentContainerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({ opacity: 0 });

  const effectiveTranscript = liveTranscript || meetingTranscript || note.transcript || "";
  const hasMeetingTranscript = !isMeetingRecording && !!effectiveTranscript;

  const displaySegments = useMemo<TranscriptSegment[]>(() => {
    if (meetingSegments && meetingSegments.length > 0) return meetingSegments;
    const raw = note.transcript || "";
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as Array<{
          text: string;
          source: "mic" | "system";
          timestamp?: number;
        }>;
        return parsed.map((s, i) => ({
          id: `stored-${i}`,
          text: s.text,
          source: s.source,
          timestamp: s.timestamp,
        }));
      } catch {}
    }
    return [];
  }, [meetingSegments, note.transcript]);

  const hasChatSegments = displaySegments.length > 0;

  const updateSegmentIndicator = useCallback(() => {
    const container = segmentContainerRef.current;
    if (!container) return;

    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-segment-button]");
    const activeBtn = Array.from(buttons).find((btn) => btn.dataset.segmentValue === viewMode);
    if (!activeBtn) return;

    const cr = container.getBoundingClientRect();
    const br = activeBtn.getBoundingClientRect();
    setIndicatorStyle({
      width: br.width,
      height: br.height,
      transform: `translateX(${br.left - cr.left}px)`,
      opacity: 1,
    });
  }, [viewMode]);

  useEffect(() => {
    updateSegmentIndicator();
  }, [updateSegmentIndicator]);

  useEffect(() => {
    const observer = new ResizeObserver(() => updateSegmentIndicator());
    if (segmentContainerRef.current) observer.observe(segmentContainerRef.current);
    return () => observer.disconnect();
  }, [updateSegmentIndicator]);

  const prevProcessingStateRef = useRef(actionProcessingState);
  useEffect(() => {
    if (prevProcessingStateRef.current === "processing" && actionProcessingState === "success") {
      setViewMode("enhanced");
    }
    prevProcessingStateRef.current = actionProcessingState;
  }, [actionProcessingState]);

  useEffect(() => {
    if (note.id !== prevNoteIdRef.current) {
      prevNoteIdRef.current = note.id;
      if (!isMeetingRecording) {
        setViewMode("raw");
      }
      if (titleRef.current && titleRef.current.textContent !== note.title) {
        titleRef.current.textContent = note.title || "";
      }
      editorRef.current?.commands.focus();
    }
  }, [note.id, isMeetingRecording]);

  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== note.title) {
      titleRef.current.textContent = note.title || "";
    }
  }, [note.title]);

  const handleTitleInput = useCallback(() => {
    if (titleRef.current) {
      const text = titleRef.current.textContent || "";
      onTitleChange(text);
    }
  }, [onTitleChange]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editorRef.current?.commands.focus();
    }
  }, []);

  const handleTitlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\n/g, " ");
    document.execCommand("insertText", false, text);
  }, []);

  const handleStartRecording = useCallback(() => {
    const ed = editorRef.current;
    if (ed) {
      cursorPosRef.current = ed.state.selection.from;
    }
    onStartRecording();
  }, [onStartRecording]);

  const prevMeetingRecRef = useRef(false);
  useEffect(() => {
    prevMeetingRecRef.current = !!isMeetingRecording;
  }, [isMeetingRecording]);

  const pendingTranscriptSwitchRef = useRef(false);

  useEffect(() => {
    if (isRecording && !prevRecordingRef.current) {
      const pos = cursorPosRef.current;
      dictationRef.current = {
        start: pos,
        partialStart: pos,
        end: pos,
        committedChars: 0,
      };
      if (viewMode === "enhanced") setViewMode("raw");
      // Mark that we should switch to transcript view once transcript arrives
      pendingTranscriptSwitchRef.current = true;
    }
    if (!isRecording && prevRecordingRef.current) {
      // Only clear if no progressive text was inserted (non-streaming case).
      // For streaming, keep dictationRef alive so the final transcript replaces
      // the partial zone instead of inserting a duplicate at cursor.
      const range = dictationRef.current;
      if (range && range.partialStart === range.start && range.end === range.start) {
        dictationRef.current = null;
      }
    }
    prevRecordingRef.current = isRecording;
  }, [isRecording]);

  // Auto-switch to transcript view after recording stops and transcript is ready
  useEffect(() => {
    if (!isRecording && !isProcessing && pendingTranscriptSwitchRef.current && liveTranscript) {
      pendingTranscriptSwitchRef.current = false;
      setViewMode("transcript");
    }
  }, [isRecording, isProcessing, liveTranscript]);

  // Partial effect: only replace the active partial zone [partialStart, end].
  // Committed text before partialStart is untouched — users can edit it freely.
  useEffect(() => {
    if (!partialTranscript || !dictationRef.current) return;

    const { partialStart, end } = dictationRef.current;
    const hasCommitted = partialStart > dictationRef.current.start;
    const textToInsert = (hasCommitted ? " " : "") + partialTranscript;
    const newEnd = partialStart + textToInsert.length;

    editorInsertText(partialStart, end, textToInsert);
    dictationRef.current.end = newEnd;
  }, [partialTranscript, editorInsertText]); // note.content intentionally excluded

  // Streaming commit: a Deepgram segment was finalized. Replace the partial zone
  // with the committed text and advance partialStart for the next utterance.
  useEffect(() => {
    if (streamingCommit == null || !dictationRef.current) return;

    const { partialStart, end } = dictationRef.current;
    const newPartialStart = partialStart + streamingCommit.length;

    editorInsertText(partialStart, end, streamingCommit);
    dictationRef.current.partialStart = newPartialStart;
    dictationRef.current.end = newPartialStart;
    dictationRef.current.committedChars += streamingCommit.length;

    onStreamingCommitConsumed();
  }, [streamingCommit, onStreamingCommitConsumed, editorInsertText]); // note.content intentionally excluded

  // Final transcript (on recording stop).
  useEffect(() => {
    if (finalTranscript == null) return;

    const range = dictationRef.current;
    if (!range) {
      // Non-streaming: insert at cursor position
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed) {
        const pos = cursorPosRef.current;
        ed.chain().insertContentAt(pos, finalTranscript).run();
      } else {
        commitContentChange(contentRef.current + finalTranscript);
      }
      onFinalTranscriptConsumed();
      return;
    }

    // Streaming: committed text is already in the note. Only finalize the
    // remaining partial zone with the tail of the final transcript.
    const { partialStart, end, committedChars } = range;
    const remainingFinal = finalTranscript.slice(committedChars);

    // If partial zone is empty and nothing new to insert, just clean up
    if (partialStart === end && !remainingFinal.trim()) {
      dictationRef.current = null;
      onFinalTranscriptConsumed();
      return;
    }

    editorInsertText(partialStart, end, remainingFinal);
    dictationRef.current = null;
    onFinalTranscriptConsumed();
  }, [finalTranscript, commitContentChange, onFinalTranscriptConsumed, editorInsertText]); // note.content intentionally excluded

  // Safety: clear dictation range when processing ends without a final transcript
  // (e.g. cancelled recording with no captured text). Declared after the final
  // transcript effect so it runs second if both trigger in the same render.
  const prevDictationProcessingRef = useRef(false);
  useEffect(() => {
    if (prevDictationProcessingRef.current && !isProcessing && dictationRef.current) {
      dictationRef.current = null;
    }
    prevDictationProcessingRef.current = isProcessing;
  }, [isProcessing]);

  const handleSelect = useCallback(() => {
    const ed = editorRef.current;
    if (ed) {
      cursorPosRef.current = ed.state.selection.from;
    }
  }, []);

  const handleContentChange = useCallback(
    (newValue: string) => {
      if (newValue === contentRef.current) return;

      if (dictationRef.current) {
        const delta = newValue.length - contentRef.current.length;
        if (delta !== 0) {
          const range = dictationRef.current;
          range.start = Math.max(0, range.start + delta);
          range.partialStart = Math.max(range.start, range.partialStart + delta);
          range.end = Math.max(range.partialStart, range.end + delta);
        }
      }

      contentRef.current = newValue;
      onContentChange(newValue);
    },
    [onContentChange]
  );

  const handleEnhancedChange = useCallback(
    (value: string) => {
      enhancement?.onChange(value);
    },
    [enhancement]
  );

  const wordCount = useMemo(() => {
    const trimmed = note.content.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [note.content]);

  const noteDate = formatNoteDate(note.created_at);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 pt-4 pb-0">
        <div
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleTitleInput}
          onKeyDown={handleTitleKeyDown}
          onPaste={handleTitlePaste}
          data-placeholder={t("notes.editor.untitled")}
          className="text-base font-semibold text-foreground bg-transparent outline-none tracking-[-0.01em] empty:before:content-[attr(data-placeholder)] empty:before:text-foreground/15 empty:before:pointer-events-none"
          role="textbox"
          aria-label={t("notes.editor.noteTitle")}
        />
        <div className="flex items-center mt-1">
          <div className="flex items-center text-xs text-foreground/50 dark:text-foreground/20 min-w-0">
            {noteDate && <span>{noteDate}</span>}
            {noteDate && (isSaving || wordCount > 0) && <span className="mx-1.5">&middot;</span>}
            <span className="tabular-nums flex items-center gap-1 shrink-0">
              {isSaving && <Loader2 size={8} className="animate-spin" />}
              {isSaving
                ? t("notes.editor.saving")
                : wordCount > 0
                  ? t("notes.editor.wordsCount", { count: wordCount })
                  : ""}
            </span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            {(enhancement || hasMeetingTranscript || hasChatSegments || isMeetingRecording) && (
              <div
                ref={segmentContainerRef}
                className="relative flex items-center shrink-0 rounded-md bg-foreground/3 dark:bg-white/3 p-0.5"
              >
                <div
                  className="absolute top-0.5 left-0 rounded bg-background dark:bg-surface-2 shadow-sm transition-[width,height,transform,opacity] duration-200 ease-out pointer-events-none"
                  style={indicatorStyle}
                />
                {(hasMeetingTranscript || hasChatSegments || isMeetingRecording) && (
                  <button
                    data-segment-button
                    data-segment-value="transcript"
                    onClick={() => setViewMode("transcript")}
                    className={cn(
                      "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                      viewMode === "transcript"
                        ? "text-foreground/60"
                        : "text-foreground/25 hover:text-foreground/40"
                    )}
                  >
                    <MessageSquareText size={10} />
                    {t("notes.editor.transcript")}
                  </button>
                )}
                <button
                  data-segment-button
                  data-segment-value="raw"
                  onClick={() => setViewMode("raw")}
                  className={cn(
                    "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                    viewMode === "raw"
                      ? "text-foreground/60"
                      : "text-foreground/25 hover:text-foreground/40"
                  )}
                >
                  <AlignLeft size={10} />
                  {t("notes.editor.notes")}
                </button>
                {enhancement && (
                  <button
                    data-segment-button
                    data-segment-value="enhanced"
                    onClick={() => setViewMode("enhanced")}
                    className={cn(
                      "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                      viewMode === "enhanced"
                        ? "text-foreground/60"
                        : "text-foreground/25 hover:text-foreground/40"
                    )}
                  >
                    <Sparkles size={9} />
                    {t("notes.editor.enhanced")}
                    {enhancement.isStale && (
                      <span
                        className="w-1 h-1 rounded-full bg-amber-400/60"
                        title={t("notes.editor.staleIndicator")}
                      />
                    )}
                  </button>
                )}
              </div>
            )}
            {canStream && (
              <button
                onClick={handleLiveToggle}
                className={cn(
                  "shrink-0 h-6 px-1.5 flex items-center gap-1 rounded-md text-xs font-medium transition-colors duration-150",
                  liveMode
                    ? "bg-primary/8 text-primary/70 hover:bg-primary/12 dark:bg-primary/12 dark:text-primary/80"
                    : "bg-foreground/3 dark:bg-white/3 text-foreground/25 hover:text-foreground/40 hover:bg-foreground/6 dark:hover:bg-white/6"
                )}
                aria-label={t("notes.editor.live")}
              >
                <Radio size={9} />
                {t("notes.editor.live")}
              </button>
            )}
            {onExportNote && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md bg-foreground/3 dark:bg-white/3 text-foreground/25 hover:text-foreground/40 hover:bg-foreground/6 dark:hover:bg-white/6 transition-colors duration-150"
                    aria-label={t("notes.editor.export")}
                  >
                    <Download size={11} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4}>
                  <DropdownMenuItem onClick={() => onExportNote("md")} className="text-xs gap-2">
                    <FileText size={13} className="text-foreground/40" />
                    {t("notes.editor.asMarkdown")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExportNote("txt")} className="text-xs gap-2">
                    <FileText size={13} className="text-foreground/40" />
                    {t("notes.editor.asPlainText")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 relative min-h-0">
        <div className="h-full overflow-y-auto">
          {viewMode === "transcript" && (hasChatSegments || isMeetingRecording) ? (
            <MeetingTranscriptChat
              segments={displaySegments}
              micPartial={isMeetingRecording ? meetingMicPartial : undefined}
              systemPartial={isMeetingRecording ? meetingSystemPartial : undefined}
            />
          ) : viewMode === "transcript" && hasMeetingTranscript ? (
            <RichTextEditor value={effectiveTranscript} disabled />
          ) : viewMode === "enhanced" && enhancement ? (
            <RichTextEditor value={enhancement.content} onChange={handleEnhancedChange} />
          ) : (
            <RichTextEditor
              value={note.content}
              onChange={handleContentChange}
              onSelect={handleSelect}
              editorRef={editorRef}
              placeholder={t("notes.editor.startWriting")}
              disabled={actionProcessingState === "processing"}
            />
          )}
        </div>
        <ActionProcessingOverlay
          state={actionProcessingState ?? "idle"}
          actionName={actionName ?? null}
        />
        <div
          className="absolute bottom-0 left-0 right-0 h-24 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, transparent, var(--color-background))" }}
        />
        <DictationWidget
          isRecording={isRecording || !!isMeetingRecording}
          isProcessing={isProcessing}
          onStart={handleStartRecording}
          onStop={isMeetingRecording ? onStopMeetingRecording! : onStopRecording}
          actionPicker={isMeetingRecording ? undefined : actionPicker}
        />
      </div>
    </div>
  );
}
