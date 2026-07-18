import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Toggle } from "../ui/toggle";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type {
  RecordingProfile,
  RecordingLanguage,
  WhisperXModel,
  ComputeType,
} from "../../types/whisperx";

export type SpeakerMode = "auto" | "exact" | "range";

export interface WhisperXOptions {
  profile: RecordingProfile;
  language: RecordingLanguage;
  diarization: boolean;
  speakerMode: SpeakerMode;
  exactSpeakers: number;
  minSpeakers: number;
  maxSpeakers: number;
  model: WhisperXModel;
  computeType: ComputeType;
  batchSize: number;
}

const PROFILES: RecordingProfile[] = ["memo", "meeting", "critical-interview"];
const LANGUAGES: RecordingLanguage[] = ["auto", "en", "es"];
const COMPUTE_TYPES: ComputeType[] = ["float16", "int8"];
const BATCH_SIZES = [1, 2, 4, 8];
const SPEAKER_MODES: SpeakerMode[] = ["auto", "exact", "range"];

const MIN_SPEAKERS = 1;
const MAX_SPEAKERS = 32;

interface ProfileDefaults {
  diarization: boolean;
  model: WhisperXModel;
  computeType: ComputeType;
  batchSize: number;
}

// Renderer-side prefill mirroring the main-process profile presets. The main
// process remains the source of truth; these values seed the form so the user
// sees sensible defaults before overriding.
const PROFILE_DEFAULTS: Record<RecordingProfile, ProfileDefaults> = {
  memo: { diarization: false, model: "large-v3-turbo", computeType: "float16", batchSize: 4 },
  meeting: { diarization: true, model: "large-v3-turbo", computeType: "float16", batchSize: 4 },
  "critical-interview": {
    diarization: true,
    model: "large-v3",
    computeType: "float16",
    batchSize: 2,
  },
};

export function defaultWhisperXOptions(
  profile: RecordingProfile,
  model?: WhisperXModel
): WhisperXOptions {
  const defs = PROFILE_DEFAULTS[profile];
  return {
    profile,
    language: "auto",
    diarization: defs.diarization,
    speakerMode: "auto",
    exactSpeakers: 2,
    minSpeakers: 2,
    maxSpeakers: 4,
    model: model ?? defs.model,
    computeType: defs.computeType,
    batchSize: defs.batchSize,
  };
}

/** Returns an i18n key describing the first validation error, or null if valid. */
export function validateWhisperXOptions(opts: WhisperXOptions): string | null {
  if (opts.speakerMode === "exact") {
    if (
      !Number.isInteger(opts.exactSpeakers) ||
      opts.exactSpeakers < MIN_SPEAKERS ||
      opts.exactSpeakers > MAX_SPEAKERS
    ) {
      return "whisperx.upload.speakers.rangeError";
    }
  }
  if (opts.speakerMode === "range") {
    const { minSpeakers, maxSpeakers } = opts;
    if (
      !Number.isInteger(minSpeakers) ||
      !Number.isInteger(maxSpeakers) ||
      minSpeakers < MIN_SPEAKERS ||
      maxSpeakers > MAX_SPEAKERS ||
      minSpeakers < MIN_SPEAKERS
    ) {
      return "whisperx.upload.speakers.rangeError";
    }
    if (minSpeakers > maxSpeakers) {
      return "whisperx.upload.speakers.minMaxError";
    }
  }
  return null;
}

interface WhisperXUploadOptionsProps {
  value: WhisperXOptions;
  onChange: (next: WhisperXOptions) => void;
}

export default function WhisperXUploadOptions({ value, onChange }: WhisperXUploadOptionsProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const patch = (p: Partial<WhisperXOptions>) => onChange({ ...value, ...p });

  const handleProfileChange = (profile: RecordingProfile) => {
    const defs = PROFILE_DEFAULTS[profile];
    // Profile change re-seeds the profile-driven defaults but preserves the
    // user's language and speaker-count choices.
    patch({
      profile,
      diarization: defs.diarization,
      model: defs.model,
      computeType: defs.computeType,
      batchSize: defs.batchSize,
    });
  };

  const clampSpeaker = (raw: string): number => {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return MIN_SPEAKERS;
    return Math.min(MAX_SPEAKERS, Math.max(MIN_SPEAKERS, n));
  };

  const validationError = validateWhisperXOptions(value);

  return (
    <div className="space-y-3 text-left">
      {/* Profile */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">
          {t("whisperx.upload.profile")}
        </label>
        <Select
          value={value.profile}
          onValueChange={(v) => handleProfileChange(v as RecordingProfile)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROFILES.map((p) => (
              <SelectItem key={p} value={p} className="text-xs">
                {t(`whisperx.profiles.${p}.name`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-foreground/35 leading-relaxed">
          {t(`whisperx.profiles.${value.profile}.description`)}
        </p>
      </div>

      {/* Language */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">
          {t("whisperx.upload.language")}
        </label>
        <Select
          value={value.language}
          onValueChange={(v) => patch({ language: v as RecordingLanguage })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l} value={l} className="text-xs">
                {t(`whisperx.upload.languages.${l}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Diarization */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("whisperx.upload.diarization")}
          </p>
          <p className="text-xs text-foreground/35">{t("whisperx.upload.diarizationHint")}</p>
        </div>
        <Toggle
          checked={value.diarization}
          onChange={(checked) => patch({ diarization: checked })}
        />
      </div>

      {/* Speaker count — only meaningful with diarization on */}
      {value.diarization && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">
            {t("whisperx.upload.speakers.label")}
          </label>
          <div
            role="group"
            aria-label={t("whisperx.upload.speakers.label")}
            className="flex items-center rounded-md border border-foreground/8 dark:border-white/6 bg-surface-1/30 p-0.5"
          >
            {SPEAKER_MODES.map((sm) => (
              <button
                key={sm}
                type="button"
                onClick={() => patch({ speakerMode: sm })}
                aria-pressed={value.speakerMode === sm}
                className={cn(
                  "flex-1 h-7 rounded text-xs font-medium transition-colors duration-150",
                  value.speakerMode === sm
                    ? "bg-foreground/[0.06] dark:bg-white/8 text-foreground/80"
                    : "text-foreground/35 hover:text-foreground/55"
                )}
              >
                {t(`whisperx.upload.speakers.${sm}`)}
              </button>
            ))}
          </div>

          {value.speakerMode === "exact" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-foreground/50" htmlFor="whisperx-exact-speakers">
                {t("whisperx.upload.speakers.exactLabel")}
              </label>
              <Input
                id="whisperx-exact-speakers"
                type="number"
                min={MIN_SPEAKERS}
                max={MAX_SPEAKERS}
                value={value.exactSpeakers}
                onChange={(e) => patch({ exactSpeakers: clampSpeaker(e.target.value) })}
                className="h-8 w-20 text-xs"
              />
            </div>
          )}

          {value.speakerMode === "range" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-foreground/50" htmlFor="whisperx-min-speakers">
                {t("whisperx.upload.speakers.min")}
              </label>
              <Input
                id="whisperx-min-speakers"
                type="number"
                min={MIN_SPEAKERS}
                max={MAX_SPEAKERS}
                value={value.minSpeakers}
                onChange={(e) => patch({ minSpeakers: clampSpeaker(e.target.value) })}
                className="h-8 w-20 text-xs"
              />
              <label className="text-xs text-foreground/50" htmlFor="whisperx-max-speakers">
                {t("whisperx.upload.speakers.max")}
              </label>
              <Input
                id="whisperx-max-speakers"
                type="number"
                min={MIN_SPEAKERS}
                max={MAX_SPEAKERS}
                value={value.maxSpeakers}
                onChange={(e) => patch({ maxSpeakers: clampSpeaker(e.target.value) })}
                className="h-8 w-20 text-xs"
              />
            </div>
          )}

          {validationError && (
            <p className="text-xs text-destructive/70">{t(validationError)}</p>
          )}
        </div>
      )}

      {/* Advanced accordion */}
      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="flex items-center gap-1.5 text-xs text-foreground/40 hover:text-foreground/60 transition-colors"
        >
          <ChevronRight
            size={11}
            className={cn("transition-transform duration-200", advancedOpen && "rotate-90")}
          />
          {t("whisperx.upload.advanced")}
        </button>

        {advancedOpen && (
          <div className="mt-2 space-y-3 pl-1">
            {/* Model */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("whisperx.upload.model")}
              </label>
              <Select
                value={value.model}
                onValueChange={(v) => patch({ model: v as WhisperXModel })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["large-v3-turbo", "large-v3"] as WhisperXModel[]).map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">
                      {t(`whisperx.upload.models.${m}.name`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Compute type */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("whisperx.upload.computeType")}
              </label>
              <Select
                value={value.computeType}
                onValueChange={(v) => patch({ computeType: v as ComputeType })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPUTE_TYPES.map((c) => (
                    <SelectItem key={c} value={c} className="text-xs">
                      {t(`whisperx.upload.computeTypes.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Batch size */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("whisperx.upload.batchSize")}
              </label>
              <Select
                value={String(value.batchSize)}
                onValueChange={(v) => patch({ batchSize: Number(v) })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BATCH_SIZES.map((b) => (
                    <SelectItem key={b} value={String(b)} className="text-xs">
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
