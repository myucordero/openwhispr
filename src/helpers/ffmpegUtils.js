const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

let cachedFFmpegPath = null;

function ensureExecutable(pathToBinary) {
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(pathToBinary, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.chmodSync(pathToBinary, 0o755);
      return true;
    } catch (chmodErr) {
      debugLogger.warn("Failed to chmod FFmpeg", { error: chmodErr.message, path: pathToBinary });
      return false;
    }
  }
}

function toUnpackedAsarPath(filePath) {
  if (!filePath || !filePath.includes("app.asar")) return null;
  return filePath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
}

function isInsideAsar(filePath) {
  return typeof filePath === "string" && /app\.asar([/\\]|$)/.test(filePath);
}

function getFFmpegPath() {
  if (cachedFFmpegPath) {
    if (fs.existsSync(cachedFFmpegPath)) {
      return cachedFFmpegPath;
    }
    debugLogger.debug("Clearing stale cached FFmpeg path", { cachedFFmpegPath });
    cachedFFmpegPath = null;
  }

  try {
    const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const candidates = [];

    // Explicit packaged app location (most reliable in production builds)
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "ffmpeg-static", binaryName)
      );
    }

    let ffmpegPath = path.normalize(require("ffmpeg-static"));
    if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
      ffmpegPath += ".exe";
    }

    const unpackedPath = toUnpackedAsarPath(ffmpegPath);
    if (unpackedPath) candidates.push(path.normalize(unpackedPath));

    // Keep original path only if it is not inside app.asar (spawn cannot execute there)
    if (!isInsideAsar(ffmpegPath)) {
      candidates.push(ffmpegPath);
    } else {
      debugLogger.debug("Ignoring FFmpeg path inside app.asar for spawn()", { ffmpegPath });
    }

    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      if (!ensureExecutable(candidate)) continue;
      cachedFFmpegPath = candidate;
      return candidate;
    }
  } catch (err) {
    debugLogger.debug("Bundled FFmpeg not available", { error: err.message });
  }

  const systemCandidates =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
      : process.platform === "win32"
        ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
        : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) {
      cachedFFmpegPath = candidate;
      return candidate;
    }
  }

  const pathEnv = process.env.PATH || "";
  const pathSep = process.platform === "win32" ? ";" : ":";
  const pathDirs = pathEnv.split(pathSep).map((entry) => entry.replace(/^"|"$/g, ""));
  const pathBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, pathBinary);
    if (!fs.existsSync(candidate)) continue;
    if (process.platform !== "win32") {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
    }
    cachedFFmpegPath = candidate;
    return candidate;
  }

  debugLogger.debug("FFmpeg not found");
  return null;
}

function isWavFormat(buffer) {
  if (!buffer || buffer.length < 12) return false;

  return (
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x41 && // A
    buffer[10] === 0x56 && // V
    buffer[11] === 0x45 // E
  );
}

function convertToWav(inputPath, outputPath, options = {}) {
  const { sampleRate = 16000, channels = 1 } = options;

  const args = [
    "-i",
    inputPath,
    "-ar",
    String(sampleRate),
    "-ac",
    String(channels),
    "-c:a",
    "pcm_s16le",
    "-y", // Overwrite output file
    outputPath,
  ];

  debugLogger.debug("Converting audio with FFmpeg", {
    input: inputPath,
    output: outputPath,
    sampleRate,
    channels,
  });

  const runConversion = (attempt = 0) =>
    new Promise((resolve, reject) => {
      const ffmpegPath = getFFmpegPath();
      if (!ffmpegPath) {
        reject(new Error("FFmpeg not found - required for audio conversion"));
        return;
      }

      const proc = spawn(ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (error) => {
        const isNotFound = error?.code === "ENOENT" || /ENOENT/i.test(error?.message || "");
        if (isNotFound && attempt === 0) {
          debugLogger.warn("FFmpeg path became unavailable; retrying with fresh resolution", {
            ffmpegPath,
            error: error.message,
          });
          clearCache();
          runConversion(1).then(resolve).catch(reject);
          return;
        }
        reject(new Error(`FFmpeg process error: ${error.message}`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          const stderrPreview = stderr.slice(-500).trim();
          debugLogger.debug("FFmpeg conversion failed", { code, stderr: stderrPreview });
          reject(
            new Error(`FFmpeg exited with code ${code}${stderrPreview ? `: ${stderrPreview}` : ""}`)
          );
          return;
        }

        if (!fs.existsSync(outputPath)) {
          reject(new Error("FFmpeg conversion produced no output file"));
          return;
        }

        const stats = fs.statSync(outputPath);
        if (stats.size === 0) {
          reject(new Error("FFmpeg conversion produced empty output file"));
          return;
        }

        debugLogger.debug("FFmpeg conversion complete", { outputSize: stats.size });
        resolve();
      });
    });

  return runConversion(0);
}

function wavToFloat32Samples(wavBuffer) {
  if (!isWavFormat(wavBuffer)) {
    throw new Error("Buffer is not a valid WAV file");
  }

  // Parse WAV header to find data chunk
  let offset = 12; // Skip RIFF header (4) + size (4) + WAVE (4)
  let dataOffset = -1;
  let dataSize = 0;
  let bitsPerSample = 16;

  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      bitsPerSample = wavBuffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset < 0) {
    throw new Error("WAV data chunk not found");
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / bytesPerSample);
  const float32 = Buffer.alloc(numSamples * 4);

  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample;
    const intVal =
      bitsPerSample === 16 ? wavBuffer.readInt16LE(sampleOffset) : wavBuffer.readInt8(sampleOffset);
    const maxVal = bitsPerSample === 16 ? 32768 : 128;
    float32.writeFloatLE(intVal / maxVal, i * 4);
  }

  return float32;
}

function computeFloat32RMS(float32Buffer) {
  const numSamples = float32Buffer.length / 4;
  if (numSamples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    const val = float32Buffer.readFloatLE(i * 4);
    sumSquares += val * val;
  }

  return Math.sqrt(sumSquares / numSamples);
}

function clearCache() {
  cachedFFmpegPath = null;
}

module.exports = {
  getFFmpegPath,
  isWavFormat,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
  clearCache,
};
