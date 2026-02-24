const os = require("os");

function parsePositiveIntEnv(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getLogicalCpuCount() {
  const count = os.cpus()?.length || 1;
  return Math.max(1, count);
}

function getBalancedThreadCount({ min = 2, max = 12, reserveRatio = 0.45, reserveAtLeast = 4 } = {}) {
  const cpuCount = getLogicalCpuCount();
  const reserve = Math.max(reserveAtLeast, Math.floor(cpuCount * reserveRatio));
  const target = cpuCount - reserve;
  return clamp(target, min, Math.min(max, cpuCount));
}

function getReasoningThreadCount() {
  return (
    parsePositiveIntEnv("LOCAL_LLM_THREADS") ||
    getBalancedThreadCount({
      min: 4,
      max: 12,
      reserveRatio: 0.45,
      reserveAtLeast: 4,
    })
  );
}

function getParakeetThreadCount() {
  return (
    parsePositiveIntEnv("PARAKEET_THREADS") ||
    getBalancedThreadCount({
      min: 2,
      max: 8,
      reserveRatio: 0.55,
      reserveAtLeast: 4,
    })
  );
}

function deriveGpuLayersFromVramMb(vramMb) {
  if (!Number.isFinite(vramMb) || vramMb <= 0) return 40;
  if (vramMb <= 4096) return 16;
  if (vramMb <= 6144) return 24;
  if (vramMb <= 8192) return 32;
  if (vramMb <= 10240) return 40;
  if (vramMb <= 16384) return 60;
  return 80;
}

function getRecommendedGpuLayers() {
  const explicit = parsePositiveIntEnv("LOCAL_LLM_GPU_LAYERS");
  if (explicit) return explicit;

  const detectedVram = parsePositiveIntEnv("LOCAL_GPU_VRAM_MB");
  return deriveGpuLayersFromVramMb(detectedVram);
}

module.exports = {
  getReasoningThreadCount,
  getParakeetThreadCount,
  getRecommendedGpuLayers,
  deriveGpuLayersFromVramMb,
};
