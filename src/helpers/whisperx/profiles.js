// Recording profiles and OOM fallback ladders (spec 00 §5, 02 §8, 08 §3/§6).
// resolveJobSettings() merges a profile's locked defaults with allowlisted
// user overrides and sanitized custom-dictionary hotwords. It never accepts
// arbitrary command arguments — everything funnels into the validated job
// request contract.

const {
  RECORDING_PROFILES,
  RECORDING_LANGUAGES,
  WHISPERX_MODELS,
  COMPUTE_TYPES,
  BATCH_SIZES,
  DIARIZATION_PROVIDERS,
  LIMITS,
} = require("./constants");

const PROFILES = {
  memo: {
    profile: "memo",
    model: "large-v3-turbo",
    computeType: "float16",
    batchSize: 4,
    alignment: true,
    diarization: false,
    noteSections: ["ideas", "tasks", "questions", "followUps"],
  },
  meeting: {
    profile: "meeting",
    model: "large-v3-turbo",
    computeType: "float16",
    batchSize: 4,
    alignment: true,
    diarization: true,
    noteSections: [
      "summary",
      "discussionPoints",
      "decisions",
      "actionItems",
      "followUps",
      "openQuestions",
    ],
  },
  "critical-interview": {
    profile: "critical-interview",
    model: "large-v3",
    computeType: "float16",
    batchSize: 2,
    alignment: true,
    diarization: true,
    rawTranscriptMandatory: true,
    strictNotes: true,
    noteSections: ["summary", "discussionPoints", "importantQuotes", "openQuestions"],
  },
};

// Deterministic OOM fallback ladders (spec 08 §6). Each entry is the full
// configuration to attempt, in order. The first entry is the starting point;
// entries are attempted only on recognized CUDA OOM, with model unload +
// cache clear between attempts, and retries are capped by ladder length.
const OOM_LADDERS = {
  memo: [
    { model: "large-v3-turbo", computeType: "float16", batchSize: 4 },
    { model: "large-v3-turbo", computeType: "float16", batchSize: 2 },
    { model: "large-v3-turbo", computeType: "int8", batchSize: 4 },
    { model: "large-v3-turbo", computeType: "int8", batchSize: 2 },
  ],
  meeting: [
    { model: "large-v3-turbo", computeType: "float16", batchSize: 4 },
    { model: "large-v3-turbo", computeType: "float16", batchSize: 2 },
    { model: "large-v3-turbo", computeType: "int8", batchSize: 4 },
    { model: "large-v3-turbo", computeType: "int8", batchSize: 2 },
  ],
  "critical-interview": [
    { model: "large-v3", computeType: "float16", batchSize: 2 },
    { model: "large-v3", computeType: "float16", batchSize: 1 },
    { model: "large-v3", computeType: "int8", batchSize: 2 },
    // Disclosed profile-policy fallback: switching model off large-v3 is
    // surfaced to the user as a warning (spec 08 §6).
    {
      model: "large-v3-turbo",
      computeType: "float16",
      batchSize: 2,
      disclosedModelDowngrade: true,
    },
  ],
};

function sanitizeHotwords(words) {
  if (!Array.isArray(words)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of words) {
    if (typeof raw !== "string") continue;
    //

    const cleaned = raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, LIMITS.MAX_HOTWORD_LENGTH);
    if (cleaned.length === 0) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= LIMITS.MAX_HOTWORDS) break;
  }
  return out;
}

class ProfileValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ProfileValidationError";
    this.field = field;
  }
}

// overrides: { language?, model?, computeType?, batchSize?, alignment?,
//              diarization?, diarizationProvider?, exactSpeakers?,
//              minSpeakers?, maxSpeakers?, device? }
// Returns a plain settings object consumed by the job manager when building
// the WhisperXJobRequest. Throws ProfileValidationError on bad overrides.
function resolveJobSettings(profileName, overrides = {}, customDictionary = []) {
  if (!RECORDING_PROFILES.includes(profileName)) {
    throw new ProfileValidationError(`Unknown profile "${profileName}"`, "profile");
  }
  const base = PROFILES[profileName];
  const settings = {
    profile: base.profile,
    language: "auto",
    model: base.model,
    computeType: base.computeType,
    batchSize: base.batchSize,
    device: "cuda",
    alignment: base.alignment,
    diarization: base.diarization,
    diarizationProvider: "pyannote-community-1",
    exactSpeakers: undefined,
    minSpeakers: undefined,
    maxSpeakers: undefined,
    hotwords: sanitizeHotwords(customDictionary),
    strictNotes: Boolean(base.strictNotes),
    rawTranscriptMandatory: Boolean(base.rawTranscriptMandatory),
    noteSections: [...base.noteSections],
  };

  if (overrides.language !== undefined) {
    if (!RECORDING_LANGUAGES.includes(overrides.language)) {
      throw new ProfileValidationError(`Unknown language "${overrides.language}"`, "language");
    }
    settings.language = overrides.language;
  }
  if (overrides.model !== undefined) {
    if (!WHISPERX_MODELS.includes(overrides.model)) {
      throw new ProfileValidationError(`Unknown model "${overrides.model}"`, "model");
    }
    settings.model = overrides.model;
  }
  if (overrides.computeType !== undefined) {
    if (!COMPUTE_TYPES.includes(overrides.computeType)) {
      throw new ProfileValidationError(
        `Unknown computeType "${overrides.computeType}"`,
        "computeType"
      );
    }
    settings.computeType = overrides.computeType;
  }
  if (overrides.batchSize !== undefined) {
    if (!BATCH_SIZES.includes(overrides.batchSize)) {
      throw new ProfileValidationError(
        `batchSize must be one of ${BATCH_SIZES.join(", ")}`,
        "batchSize"
      );
    }
    settings.batchSize = overrides.batchSize;
  }
  if (overrides.device !== undefined) {
    if (!["cuda", "cpu"].includes(overrides.device)) {
      throw new ProfileValidationError('device must be "cuda" or "cpu"', "device");
    }
    settings.device = overrides.device;
  }
  for (const flag of ["alignment", "diarization"]) {
    if (overrides[flag] !== undefined) {
      if (typeof overrides[flag] !== "boolean") {
        throw new ProfileValidationError(`${flag} must be a boolean`, flag);
      }
      settings[flag] = overrides[flag];
    }
  }
  if (overrides.diarizationProvider !== undefined) {
    if (!DIARIZATION_PROVIDERS.includes(overrides.diarizationProvider)) {
      throw new ProfileValidationError(
        `Unknown diarization provider "${overrides.diarizationProvider}"`,
        "diarizationProvider"
      );
    }
    settings.diarizationProvider = overrides.diarizationProvider;
  }

  const counts = ["exactSpeakers", "minSpeakers", "maxSpeakers"];
  for (const field of counts) {
    const v = overrides[field];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < 1 || v > LIMITS.MAX_SPEAKERS) {
      throw new ProfileValidationError(
        `${field} must be an integer between 1 and ${LIMITS.MAX_SPEAKERS}`,
        field
      );
    }
    settings[field] = v;
  }
  if (
    settings.exactSpeakers !== undefined &&
    (settings.minSpeakers !== undefined || settings.maxSpeakers !== undefined)
  ) {
    throw new ProfileValidationError(
      "exactSpeakers cannot be combined with minSpeakers/maxSpeakers",
      "exactSpeakers"
    );
  }
  if (
    settings.minSpeakers !== undefined &&
    settings.maxSpeakers !== undefined &&
    settings.minSpeakers > settings.maxSpeakers
  ) {
    throw new ProfileValidationError("minSpeakers must be <= maxSpeakers", "minSpeakers");
  }

  return settings;
}

// The ladder for a resolved settings object: starts from the user's actual
// configuration when it matches a ladder entry, otherwise prepends it.
function oomLadderFor(settings) {
  const ladder = OOM_LADDERS[settings.profile] || OOM_LADDERS.memo;
  const matchIndex = ladder.findIndex(
    (step) =>
      step.model === settings.model &&
      step.computeType === settings.computeType &&
      step.batchSize === settings.batchSize
  );
  if (matchIndex >= 0) return ladder.slice(matchIndex);
  return [
    { model: settings.model, computeType: settings.computeType, batchSize: settings.batchSize },
    ...ladder,
  ];
}

module.exports = {
  PROFILES,
  OOM_LADDERS,
  sanitizeHotwords,
  resolveJobSettings,
  oomLadderFor,
  ProfileValidationError,
};
