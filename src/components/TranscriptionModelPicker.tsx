import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Download, Trash2, Cloud, Lock, X, Zap, Check, AlertCircle, Loader2 } from "lucide-react";
import { ProviderIcon } from "./ui/ProviderIcon";
import { ProviderTabs } from "./ui/ProviderTabs";
import ModelCardList from "./ui/ModelCardList";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import ApiKeyInput from "./ui/ApiKeyInput";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type DownloadProgress } from "../hooks/useModelDownload";
import {
  getTranscriptionProviders,
  getStreamingTranscriptionProviders,
  TranscriptionProviderData,
  WHISPER_MODEL_INFO,
  PARAKEET_MODEL_INFO,
} from "../models/ModelRegistry";
import {
  MODEL_PICKER_COLORS,
  type ColorScheme,
  type ModelPickerStyles,
} from "../utils/modelPickerStyles";
import { useSettingsStore } from "../stores/settingsStore";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { API_ENDPOINTS, normalizeBaseUrl } from "../config/constants";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { getCachedPlatform } from "../utils/platform";
import type { CudaWhisperStatus } from "../types/electron";
import type { WhisperXReadiness, WhisperXModel } from "../types/whisperx";
import { Badge } from "./ui/badge";
import logger from "../utils/logger";

interface LocalModel {
  model: string;
  size_mb?: number;
  downloaded?: boolean;
}

interface LocalModelCardProps {
  modelId: string;
  name: string;
  description: string;
  size: string;
  actualSizeMb?: number;
  isSelected: boolean;
  isDownloaded: boolean;
  isDownloading: boolean;
  isCancelling: boolean;
  recommended?: boolean;
  provider: string;
  languageLabel?: string;
  onSelect: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onCancel: () => void;
  styles: ModelPickerStyles;
}

function LocalModelCard({
  modelId,
  name,
  description,
  size,
  actualSizeMb,
  isSelected,
  isDownloaded,
  isDownloading,
  isCancelling,
  recommended,
  provider,
  languageLabel,
  onSelect,
  onDelete,
  onDownload,
  onCancel,
  styles: cardStyles,
}: LocalModelCardProps) {
  const { t } = useTranslation();
  const handleClick = () => {
    if (isDownloaded && !isSelected) {
      onSelect();
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`relative w-full text-left overflow-hidden rounded-md border transition-colors duration-200 group ${
        isSelected ? cardStyles.modelCard.selected : cardStyles.modelCard.default
      } ${isDownloaded && !isSelected ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-1.5 p-2">
        <div className="shrink-0">
          {isDownloaded ? (
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isSelected
                  ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)] animate-[pulse-glow_2s_ease-in-out_infinite]"
                  : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]"
              }`}
            />
          ) : isDownloading ? (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)] animate-[spinner-rotate_1s_linear_infinite]" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <ProviderIcon provider={provider} className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold text-sm text-foreground truncate tracking-tight">
            {name}
          </span>
          <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">
            {actualSizeMb ? `${actualSizeMb}MB` : size}
          </span>
          {recommended && (
            <span className={cardStyles.badges.recommended}>{t("common.recommended")}</span>
          )}
          {languageLabel && (
            <span className="text-xs text-muted-foreground/50 font-medium shrink-0">
              {languageLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isDownloaded ? (
            <>
              {isSelected && (
                <span className="text-xs font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
                  {t("common.active")}
                </span>
              )}
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-[color,opacity,transform] active:scale-95"
              >
                <Trash2 size={12} />
              </Button>
            </>
          ) : isDownloading ? (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              disabled={isCancelling}
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-xs text-destructive border-destructive/25 hover:bg-destructive/8"
            >
              <X size={11} className="mr-0.5" />
              {isCancelling ? "..." : t("common.cancel")}
            </Button>
          ) : (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              size="sm"
              variant="default"
              className="h-6 px-2.5 text-xs"
            >
              <Download size={11} className="mr-1" />
              {t("common.download")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TranscriptionModelPickerProps {
  selectedCloudProvider: string;
  onCloudProviderSelect: (providerId: string) => void;
  selectedCloudModel: string;
  onCloudModelSelect: (modelId: string) => void;
  selectedLocalModel: string;
  onLocalModelSelect: (modelId: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl?: (url: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
  mode?: "cloud" | "local";
  streamingOnly?: boolean;
}

const CLOUD_PROVIDER_TABS = [
  { id: "openai", name: "OpenAI" },
  { id: "groq", name: "Groq" },
  { id: "mistral", name: "Mistral" },
  { id: "custom", name: "Custom" },
];

const VALID_CLOUD_PROVIDER_IDS = CLOUD_PROVIDER_TABS.map((p) => p.id);

const LOCAL_PROVIDER_TABS: Array<{ id: string; name: string; disabled?: boolean }> = [
  { id: "whisper", name: "OpenAI" },
  { id: "nvidia", name: "NVIDIA" },
  { id: "whisperx", name: "WhisperX" },
];

const WHISPERX_MODELS: WhisperXModel[] = ["large-v3-turbo", "large-v3"];

interface WhisperXPanelProps {
  styles: ModelPickerStyles;
}

/**
 * WhisperX local-provider panel: readiness summary + one-click runtime
 * provisioning + model selection. All whisperx* preload methods are optional,
 * so every call is guarded and the panel degrades to an "unavailable" state.
 */
function WhisperXPanel({ styles }: WhisperXPanelProps) {
  const { t } = useTranslation();
  const whisperxModel = useSettingsStore((s) => s.whisperxModel);
  const setWhisperxModel = useSettingsStore((s) => s.setWhisperxModel);

  const [readiness, setReadiness] = useState<
    (Partial<WhisperXReadiness> & { success?: boolean; error?: string }) | null
  >(null);
  const [checking, setChecking] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionLog, setProvisionLog] = useState<string[]>([]);

  const checkReadiness = useCallback(async () => {
    if (!window.electronAPI?.whisperxGetReadiness) {
      setUnavailable(true);
      return;
    }
    setChecking(true);
    try {
      const res = await window.electronAPI.whisperxGetReadiness();
      setReadiness(res ?? null);
    } catch (error) {
      logger.error("Failed to check WhisperX readiness", { error }, "whisperx");
      setReadiness(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkReadiness();
  }, [checkReadiness]);

  const handleProvision = useCallback(async () => {
    if (!window.electronAPI?.whisperxProvisionRuntime) return;
    setProvisioning(true);
    setProvisionLog([]);
    const cleanup = window.electronAPI.onWhisperxProvisionProgress?.((p) => {
      setProvisionLog((prev) => [...prev, p.message]);
    });
    try {
      await window.electronAPI.whisperxProvisionRuntime();
    } catch (error) {
      logger.error("WhisperX provisioning failed", { error }, "whisperx");
    } finally {
      cleanup?.();
      setProvisioning(false);
      await checkReadiness();
    }
  }, [checkReadiness]);

  if (unavailable) {
    return (
      <div className="rounded-md border border-border bg-surface-1 p-3">
        <div className="flex items-start gap-2">
          <AlertCircle size={13} className="text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("whisperx.readiness.unavailable")}
          </p>
        </div>
      </div>
    );
  }

  const runtimeInstalled = readiness?.runtimeInstalled ?? false;
  const cudaAvailable = readiness?.cudaAvailable ?? false;
  const asrReady = readiness?.asrModelReady ?? false;
  const tokenConfigured = readiness?.diarizationTokenConfigured ?? false;

  const readyBadge = (label: string, ok: boolean, detail?: string | null) => (
    <Badge variant={ok ? "success" : "outline"} className="gap-1">
      {ok ? <Check size={10} /> : <X size={10} />}
      {label}
      {detail ? <span className="opacity-60">· {detail}</span> : null}
    </Badge>
  );

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">
            {t("whisperx.readiness.title")}
          </span>
          <Button
            onClick={checkReadiness}
            disabled={checking}
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {checking ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              t("whisperx.readiness.recheck")
            )}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {readyBadge(
            t("whisperx.readiness.runtime"),
            runtimeInstalled,
            readiness?.runtimeVersion ?? null
          )}
          {readyBadge(
            t("whisperx.readiness.cuda"),
            cudaAvailable,
            cudaAvailable ? (readiness?.gpuName ?? null) : t("whisperx.readiness.cpuOnly")
          )}
          {readyBadge(t("whisperx.readiness.models"), asrReady)}
          {readyBadge(t("whisperx.readiness.token"), tokenConfigured)}
        </div>

        {!runtimeInstalled && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("whisperx.readiness.setupHint")}
            </p>
            <Button
              onClick={handleProvision}
              disabled={provisioning}
              size="sm"
              variant="default"
              className="h-7 px-3 text-xs"
            >
              {provisioning ? (
                <>
                  <Loader2 size={11} className="mr-1.5 animate-spin" />
                  {t("whisperx.readiness.settingUp")}
                </>
              ) : (
                t("whisperx.readiness.setUp")
              )}
            </Button>
          </div>
        )}

        {provisionLog.length > 0 && (
          <div
            role="log"
            aria-live="polite"
            className="max-h-28 overflow-y-auto rounded-sm bg-background/60 border border-border/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
          >
            {provisionLog.map((line, i) => (
              <div key={i} className="truncate">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">{t("whisperx.upload.model")}</label>
        <div className="space-y-0.5">
          {WHISPERX_MODELS.map((modelId) => {
            const isSelected = modelId === whisperxModel;
            return (
              <button
                key={modelId}
                type="button"
                onClick={() => setWhisperxModel(modelId)}
                aria-pressed={isSelected}
                className={`relative w-full text-left overflow-hidden rounded-md border transition-colors duration-200 ${
                  isSelected ? styles.modelCard.selected : styles.modelCard.default
                } cursor-pointer`}
              >
                <div className="flex items-center gap-1.5 p-2">
                  <div className="shrink-0">
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${
                        isSelected ? "bg-primary" : "bg-muted-foreground/20"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="font-semibold text-sm text-foreground truncate tracking-tight">
                      {t(`whisperx.upload.models.${modelId}.name`)}
                    </span>
                    <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">
                      {t(`whisperx.upload.models.${modelId}.size`)}
                    </span>
                    {modelId === "large-v3-turbo" && (
                      <span className={styles.badges.recommended}>{t("common.recommended")}</span>
                    )}
                  </div>
                  {isSelected && (
                    <span className="text-xs font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm shrink-0">
                      {t("common.active")}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface ModeToggleProps {
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
}

function ModeToggle({ useLocalWhisper, onModeChange }: ModeToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="relative flex p-0.5 rounded-lg bg-surface-1/80 backdrop-blur-xl dark:bg-surface-1 border border-border/60 dark:border-white/8 shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark)">
      <div
        className={`absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-card border border-border/60 dark:border-border-subtle shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark) transition-transform duration-200 ease-out ${
          useLocalWhisper ? "translate-x-[calc(100%)]" : "translate-x-0"
        }`}
      />
      <button
        onClick={() => onModeChange(false)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md transition-colors duration-150 ${
          !useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Cloud className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{t("common.cloud")}</span>
      </button>
      <button
        onClick={() => onModeChange(true)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md transition-colors duration-150 ${
          useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Lock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{t("common.local")}</span>
      </button>
    </div>
  );
}

export default function TranscriptionModelPicker({
  selectedCloudProvider,
  onCloudProviderSelect,
  selectedCloudModel,
  onCloudModelSelect,
  selectedLocalModel,
  onLocalModelSelect,
  selectedLocalProvider = "whisper",
  onLocalProviderSelect,
  useLocalWhisper,
  onModeChange,
  cloudTranscriptionBaseUrl = "",
  setCloudTranscriptionBaseUrl,
  className = "",
  variant = "settings",
  mode,
  streamingOnly = false,
}: TranscriptionModelPickerProps) {
  const { t } = useTranslation();
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const mistralApiKey = useSettingsStore((s) => s.mistralApiKey);
  const setMistralApiKey = useSettingsStore((s) => s.setMistralApiKey);
  const customTranscriptionApiKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const setCustomTranscriptionApiKey = useSettingsStore((s) => s.setCustomTranscriptionApiKey);
  const effectiveLocal = mode === "local" ? true : mode === "cloud" ? false : useLocalWhisper;
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [parakeetModels, setParakeetModels] = useState<LocalModel[]>([]);
  const [internalLocalProvider, setInternalLocalProvider] = useState(selectedLocalProvider);
  const hasLoadedRef = useRef(false);
  const hasLoadedParakeetRef = useRef(false);
  const [cudaStatus, setCudaStatus] = useState<CudaWhisperStatus | null>(null);
  const [cudaDownloading, setCudaDownloading] = useState(false);
  const [cudaProgress, setCudaProgress] = useState<DownloadProgress>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
  });
  const [cudaDismissed, setCudaDismissed] = useState(false);

  useEffect(() => {
    if (selectedLocalProvider !== internalLocalProvider) {
      setInternalLocalProvider(selectedLocalProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync prop→state: only re-run when the prop changes
  }, [selectedLocalProvider]);
  const isLoadingRef = useRef(false);
  const isLoadingParakeetRef = useRef(false);
  const loadLocalModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadParakeetModelsRef = useRef<(() => Promise<void>) | null>(null);
  const ensureValidCloudSelectionRef = useRef<(() => void) | null>(null);
  const selectedLocalModelRef = useRef(selectedLocalModel);
  const onLocalModelSelectRef = useRef(onLocalModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);
  const cloudProviders = useMemo(
    () => (streamingOnly ? getStreamingTranscriptionProviders() : getTranscriptionProviders()),
    [streamingOnly]
  );
  const cloudProviderTabs = useMemo(() => {
    const visibleIds = new Set([...cloudProviders.map((p) => p.id), "custom"]);
    return CLOUD_PROVIDER_TABS.filter((p) => visibleIds.has(p.id)).map((provider) =>
      provider.id === "custom" ? { ...provider, name: t("transcription.customProvider") } : provider
    );
  }, [cloudProviders, t]);

  useEffect(() => {
    selectedLocalModelRef.current = selectedLocalModel;
  }, [selectedLocalModel]);
  useEffect(() => {
    onLocalModelSelectRef.current = onLocalModelSelect;
  }, [onLocalModelSelect]);

  const validateAndSelectModel = useCallback((loadedModels: LocalModel[]) => {
    const current = selectedLocalModelRef.current;
    if (!current) return;

    const downloaded = loadedModels.filter((m) => m.downloaded);
    const isCurrentDownloaded = loadedModels.find((m) => m.model === current)?.downloaded;

    if (!isCurrentDownloaded && downloaded.length > 0) {
      onLocalModelSelectRef.current(downloaded[0].model);
    } else if (!isCurrentDownloaded && downloaded.length === 0) {
      onLocalModelSelectRef.current("");
    }
  }, []);

  const loadLocalModels = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      const result = await window.electronAPI?.listWhisperModels();
      if (result?.success) {
        setLocalModels(result.models);
        validateAndSelectModel(result.models);
      }
    } catch (error) {
      logger.error("Failed to load models", { error }, "models");
      setLocalModels([]);
    } finally {
      isLoadingRef.current = false;
    }
  }, [validateAndSelectModel]);

  const loadParakeetModels = useCallback(async () => {
    if (isLoadingParakeetRef.current) return;
    isLoadingParakeetRef.current = true;

    try {
      const result = await window.electronAPI?.listParakeetModels();
      if (result?.success) {
        setParakeetModels(result.models);
      }
    } catch (error) {
      logger.error("Failed to load Parakeet models", { error }, "models");
      setParakeetModels([]);
    } finally {
      isLoadingParakeetRef.current = false;
    }
  }, []);

  const ensureValidCloudSelection = useCallback(() => {
    const isValidProvider = VALID_CLOUD_PROVIDER_IDS.includes(selectedCloudProvider);

    if (!isValidProvider) {
      const knownProviderUrls = cloudProviders.map((p) => p.baseUrl);
      const hasCustomUrl =
        cloudTranscriptionBaseUrl &&
        cloudTranscriptionBaseUrl.trim() !== "" &&
        cloudTranscriptionBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE &&
        !knownProviderUrls.includes(cloudTranscriptionBaseUrl);

      if (hasCustomUrl) {
        onCloudProviderSelect("custom");
      } else {
        const firstProvider = cloudProviders[0];
        if (firstProvider) {
          onCloudProviderSelect(firstProvider.id);
          if (firstProvider.models?.length) {
            onCloudModelSelect(firstProvider.models[0].id);
          }
        }
      }
    } else if (selectedCloudProvider !== "custom" && !selectedCloudModel) {
      const provider = cloudProviders.find((p) => p.id === selectedCloudProvider);
      if (provider?.models?.length) {
        onCloudModelSelect(provider.models[0].id);
      }
    }
  }, [
    cloudProviders,
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    selectedCloudModel,
    onCloudProviderSelect,
    onCloudModelSelect,
  ]);

  useEffect(() => {
    loadLocalModelsRef.current = loadLocalModels;
  }, [loadLocalModels]);
  useEffect(() => {
    loadParakeetModelsRef.current = loadParakeetModels;
  }, [loadParakeetModels]);
  useEffect(() => {
    ensureValidCloudSelectionRef.current = ensureValidCloudSelection;
  }, [ensureValidCloudSelection]);

  useEffect(() => {
    if (!effectiveLocal) return;

    if (internalLocalProvider === "whisper" && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadLocalModelsRef.current?.();
    } else if (internalLocalProvider === "nvidia" && !hasLoadedParakeetRef.current) {
      hasLoadedParakeetRef.current = true;
      loadParakeetModelsRef.current?.();
    }
  }, [effectiveLocal, internalLocalProvider]);

  useEffect(() => {
    if (effectiveLocal) return;

    hasLoadedRef.current = false;
    hasLoadedParakeetRef.current = false;
    ensureValidCloudSelectionRef.current?.();
  }, [effectiveLocal]);

  useEffect(() => {
    const handleModelsCleared = () => {
      loadLocalModels();
      loadParakeetModels();
    };
    window.addEventListener("openwhispr-models-cleared", handleModelsCleared);
    return () => window.removeEventListener("openwhispr-models-cleared", handleModelsCleared);
  }, [loadLocalModels, loadParakeetModels]);

  useEffect(() => {
    if (!effectiveLocal || internalLocalProvider !== "whisper") return;
    if (getCachedPlatform() === "darwin") return;
    window.electronAPI
      ?.getCudaWhisperStatus?.()
      ?.then(setCudaStatus)
      .catch(() => {});
  }, [effectiveLocal, internalLocalProvider]);

  useEffect(() => {
    if (!cudaDownloading) return;
    const cleanup = window.electronAPI?.onCudaDownloadProgress?.((data) => {
      setCudaProgress(data);
    });
    return cleanup;
  }, [cudaDownloading]);

  const handleCudaDownload = async () => {
    setCudaDownloading(true);
    try {
      const result = await window.electronAPI?.downloadCudaWhisperBinary?.();
      if (result?.success) {
        const status = await window.electronAPI?.getCudaWhisperStatus?.();
        setCudaStatus(status || null);
      }
    } finally {
      setCudaDownloading(false);
    }
  };

  const handleCudaDelete = async () => {
    await window.electronAPI?.deleteCudaWhisperBinary?.();
    const status = await window.electronAPI?.getCudaWhisperStatus?.();
    setCudaStatus(status || null);
  };

  const handleCudaCancel = async () => {
    await window.electronAPI?.cancelCudaWhisperDownload?.();
    setCudaDownloading(false);
  };

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    isInstalling,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: loadLocalModels,
  });

  const {
    downloadingModel: downloadingParakeetModel,
    downloadProgress: parakeetDownloadProgress,
    downloadModel: downloadParakeetModel,
    deleteModel: deleteParakeetModel,
    isDownloadingModel: isDownloadingParakeetModel,
    isInstalling: isInstallingParakeet,
    cancelDownload: cancelParakeetDownload,
    isCancelling: isCancellingParakeet,
  } = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: loadParakeetModels,
  });

  const handleModeChange = useCallback(
    (isLocal: boolean) => {
      onModeChange(isLocal);
      if (!isLocal) ensureValidCloudSelection();
    },
    [onModeChange, ensureValidCloudSelection]
  );

  const handleCloudProviderChange = useCallback(
    (providerId: string) => {
      onCloudProviderSelect(providerId);
      const provider = cloudProviders.find((p) => p.id === providerId);

      if (providerId === "custom") {
        onCloudModelSelect("whisper-1");
        return;
      }

      if (provider) {
        setCloudTranscriptionBaseUrl?.(provider.baseUrl);
        if (provider.models?.length) {
          onCloudModelSelect(provider.models[0].id);
        }
      }
    },
    [cloudProviders, onCloudProviderSelect, onCloudModelSelect, setCloudTranscriptionBaseUrl]
  );

  const handleLocalProviderChange = useCallback(
    (providerId: string) => {
      const tab = LOCAL_PROVIDER_TABS.find((t) => t.id === providerId);
      if (tab?.disabled) return;
      setInternalLocalProvider(providerId);
      onLocalProviderSelect?.(providerId);
    },
    [onLocalProviderSelect]
  );

  const handleWhisperModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("whisper");
      setInternalLocalProvider("whisper");
      onLocalModelSelect(modelId);
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleParakeetModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("nvidia");
      setInternalLocalProvider("nvidia");
      onLocalModelSelect(modelId);
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleBaseUrlBlur = useCallback(() => {
    if (!setCloudTranscriptionBaseUrl || selectedCloudProvider !== "custom") return;

    const trimmed = (cloudTranscriptionBaseUrl || "").trim();
    if (!trimmed) return;

    const normalized = normalizeBaseUrl(trimmed);

    if (normalized && normalized !== cloudTranscriptionBaseUrl) {
      setCloudTranscriptionBaseUrl(normalized);
    }
    if (normalized) {
      for (const provider of cloudProviders) {
        const providerNormalized = normalizeBaseUrl(provider.baseUrl);
        if (normalized === providerNormalized) {
          onCloudProviderSelect(provider.id);
          onCloudModelSelect("whisper-1");
          break;
        }
      }
    }
  }, [
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    setCloudTranscriptionBaseUrl,
    onCloudProviderSelect,
    onCloudModelSelect,
    cloudProviders,
  ]);

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteModel(modelId, async () => {
            const result = await window.electronAPI?.listWhisperModels();
            if (result?.success) {
              setLocalModels(result.models);
              validateAndSelectModel(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, validateAndSelectModel, t]
  );

  const currentCloudProvider = useMemo<TranscriptionProviderData | undefined>(
    () => cloudProviders.find((p) => p.id === selectedCloudProvider),
    [cloudProviders, selectedCloudProvider]
  );

  const cloudModelOptions = useMemo(() => {
    if (!currentCloudProvider) return [];
    return currentCloudProvider.models.map((m) => ({
      value: m.id,
      label: m.name,
      description: m.descriptionKey
        ? t(m.descriptionKey, { defaultValue: m.description })
        : m.description,
      icon: getProviderIcon(selectedCloudProvider),
      invertInDark: isMonochromeProvider(selectedCloudProvider),
    }));
  }, [currentCloudProvider, selectedCloudProvider, t]);

  const progressDisplay = useMemo(() => {
    if (!effectiveLocal) return null;

    if (downloadingModel && internalLocalProvider === "whisper") {
      const modelInfo = WHISPER_MODEL_INFO[downloadingModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingModel}
          progress={downloadProgress}
          isInstalling={isInstalling}
        />
      );
    }

    if (downloadingParakeetModel && internalLocalProvider === "nvidia") {
      const modelInfo = PARAKEET_MODEL_INFO[downloadingParakeetModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingParakeetModel}
          progress={parakeetDownloadProgress}
          isInstalling={isInstallingParakeet}
        />
      );
    }

    return null;
  }, [
    downloadingModel,
    downloadProgress,
    isInstalling,
    downloadingParakeetModel,
    parakeetDownloadProgress,
    isInstallingParakeet,
    effectiveLocal,
    internalLocalProvider,
  ]);

  const renderLocalModels = () => {
    const modelsToRender =
      localModels.length === 0
        ? Object.entries(WHISPER_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : localModels;

    return (
      <div className="space-y-0.5">
        {modelsToRender.map((model) => {
          const modelId = model.model;
          const info = WHISPER_MODEL_INFO[modelId] ?? {
            name: modelId,
            description: t("transcription.fallback.whisperModelDescription"),
            size: t("common.unknown"),
            recommended: false,
          };

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingModel(modelId)}
              isCancelling={isCancelling}
              recommended={info.recommended}
              provider="whisper"
              onSelect={() => handleWhisperModelSelect(modelId)}
              onDelete={() => handleDelete(modelId)}
              onDownload={() =>
                downloadModel(modelId, (downloadedId) => {
                  setLocalModels((prev) =>
                    prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                  );
                  handleWhisperModelSelect(downloadedId);
                })
              }
              onCancel={cancelDownload}
              styles={styles}
            />
          );
        })}
      </div>
    );
  };

  const handleParakeetDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteParakeetModel(modelId, async () => {
            const result = await window.electronAPI?.listParakeetModels();
            if (result?.success) {
              setParakeetModels(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteParakeetModel, t]
  );

  const renderParakeetModels = () => {
    const modelsToRender =
      parakeetModels.length === 0
        ? Object.entries(PARAKEET_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : parakeetModels;

    return (
      <div className="space-y-0.5">
        {modelsToRender.map((model) => {
          const modelId = model.model;
          const info = PARAKEET_MODEL_INFO[modelId] ?? {
            name: modelId,
            description: t("transcription.fallback.parakeetModelDescription"),
            size: t("common.unknown"),
            language: "en",
            recommended: false,
          };

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingParakeetModel(modelId)}
              isCancelling={isCancellingParakeet}
              recommended={info.recommended}
              provider="nvidia"
              onSelect={() => handleParakeetModelSelect(modelId)}
              onDelete={() => handleParakeetDelete(modelId)}
              onDownload={() =>
                downloadParakeetModel(modelId, (downloadedId) => {
                  setParakeetModels((prev) =>
                    prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                  );
                  handleParakeetModelSelect(downloadedId);
                })
              }
              onCancel={cancelParakeetDownload}
              styles={styles}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {!mode && <ModeToggle useLocalWhisper={effectiveLocal} onModeChange={handleModeChange} />}

      {!effectiveLocal ? (
        <>
          <ProviderTabs
            providers={cloudProviderTabs}
            selectedId={selectedCloudProvider}
            onSelect={handleCloudProviderChange}
            colorScheme="purple"
            scrollable
          />

          <div>
            {selectedCloudProvider === "custom" ? (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("transcription.endpointUrl")}
                  </label>
                  <Input
                    value={cloudTranscriptionBaseUrl}
                    onChange={(e) => setCloudTranscriptionBaseUrl?.(e.target.value)}
                    onBlur={handleBaseUrlBlur}
                    placeholder="https://your-api.example.com/v1"
                    className="h-8 text-sm"
                  />
                </div>

                <ApiKeyInput
                  apiKey={customTranscriptionApiKey}
                  setApiKey={setCustomTranscriptionApiKey}
                  label={t("transcription.apiKeyOptional")}
                  helpText=""
                />

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("common.model")}
                  </label>
                  <Input
                    value={selectedCloudModel}
                    onChange={(e) => onCloudModelSelect(e.target.value)}
                    placeholder="whisper-1"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-foreground">
                      {t("common.apiKey")}
                    </label>
                    <button
                      type="button"
                      onClick={createExternalLinkHandler(
                        {
                          groq: "https://console.groq.com/keys",
                          mistral: "https://console.mistral.ai/api-keys",
                          openai: "https://platform.openai.com/api-keys",
                        }[selectedCloudProvider] || "https://platform.openai.com/api-keys"
                      )}
                      className="text-xs text-primary/70 hover:text-primary transition-colors cursor-pointer"
                    >
                      {t("transcription.getKey")}
                    </button>
                  </div>
                  <ApiKeyInput
                    apiKey={
                      { groq: groqApiKey, mistral: mistralApiKey, openai: openaiApiKey }[
                        selectedCloudProvider
                      ] || openaiApiKey
                    }
                    setApiKey={
                      { groq: setGroqApiKey, mistral: setMistralApiKey, openai: setOpenaiApiKey }[
                        selectedCloudProvider
                      ] || setOpenaiApiKey
                    }
                    label=""
                    helpText=""
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t("common.model")}</label>
                  <ModelCardList
                    models={cloudModelOptions}
                    selectedModel={selectedCloudModel}
                    onModelSelect={onCloudModelSelect}
                    colorScheme="purple"
                  />
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <ProviderTabs
            providers={LOCAL_PROVIDER_TABS}
            selectedId={internalLocalProvider}
            onSelect={handleLocalProviderChange}
            colorScheme="purple"
          />

          {progressDisplay}

          {cudaDownloading && internalLocalProvider === "whisper" && (
            <div>
              <DownloadProgressBar modelName="GPU acceleration" progress={cudaProgress} />
              <div className="px-2.5 pb-1 flex justify-end">
                <button
                  onClick={handleCudaCancel}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {internalLocalProvider === "whisper" &&
            !cudaDismissed &&
            !cudaDownloading &&
            getCachedPlatform() !== "darwin" &&
            cudaStatus?.gpuInfo.hasNvidiaGpu && (
              <div className="rounded-md border border-border bg-surface-1 p-2.5">
                {cudaStatus.downloaded ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Check size={13} className="text-success" />
                      <span className="text-xs font-medium text-foreground">{t("gpu.active")}</span>
                    </div>
                    <Button
                      onClick={handleCudaDelete}
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                      {t("gpu.remove")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2.5">
                    <Zap size={13} className="text-primary shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground">
                        {t("gpu.transcriptionBanner")}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Button
                          onClick={handleCudaDownload}
                          size="sm"
                          variant="default"
                          className="h-6 px-2.5 text-xs"
                        >
                          {t("gpu.enableButton")}
                        </Button>
                        <button
                          onClick={() => setCudaDismissed(true)}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {t("gpu.dismiss")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

          <div>
            {internalLocalProvider === "whisper" && renderLocalModels()}
            {internalLocalProvider === "nvidia" && renderParakeetModels()}
            {internalLocalProvider === "whisperx" && <WhisperXPanel styles={styles} />}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
