// Content-safe diagnostics redaction (spec 07 §7, §11).
// Applied to worker stderr captures, error messages, and diagnostic bundles
// before anything is persisted or shown. Default logs must never contain
// tokens, API keys, full user paths, or transcript content — transcript
// content never flows through here at all; this guards the incidental leaks.

const SENSITIVE_ENV_KEY_RE = /(token|secret|api[-_]?key|password|credential|authorization)/i;

// Hugging Face tokens ("hf_" + alnum), generic bearer values, and common
// key=value / key: value assignments for sensitive-looking keys.
const HF_TOKEN_RE = /\bhf_[A-Za-z0-9]{10,}\b/g;
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_RE =
  /\b([A-Za-z0-9_-]*(?:token|secret|api[-_]?key|password|credential|authorization)[A-Za-z0-9_-]*)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;

// Home directories on both platforms; keeps the tail of the path so
// diagnostics stay useful without leaking the user name.
const WIN_USER_PATH_RE = /[A-Za-z]:\\Users\\[^\\/:*?"<>|\s]+/g;
const POSIX_HOME_RE = /\/(?:home|Users)\/[^/\s]+/g;

const REDACTED = "[REDACTED]";
const REDACTED_HOME = "<home>";

function redactText(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  return input
    .replace(HF_TOKEN_RE, REDACTED)
    .replace(BEARER_RE, (m, word) => `${word} ${REDACTED}`)
    .replace(KEY_VALUE_RE, (m, key, sep) => `${key}${sep}${REDACTED}`)
    .replace(WIN_USER_PATH_RE, REDACTED_HOME)
    .replace(POSIX_HOME_RE, REDACTED_HOME);
}

// Builds the minimal environment allowlist for the worker and reports which
// keys were dropped (spawn uses an allowlist, never process.env wholesale).
function isSensitiveEnvKey(key) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function redactObjectStrings(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactObjectStrings(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveEnvKey(k) ? REDACTED : redactObjectStrings(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Bounded stderr capture: keeps the newest bytes up to the cap and redacts.
class BoundedRedactedCapture {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this._chunks = [];
    this._bytes = 0;
    this.truncated = false;
  }

  append(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this._chunks.push(buf);
    this._bytes += buf.length;
    while (this._bytes > this.maxBytes && this._chunks.length > 0) {
      const dropped = this._chunks.shift();
      this._bytes -= dropped.length;
      this.truncated = true;
    }
  }

  toRedactedString() {
    const joined = Buffer.concat(this._chunks).toString("utf8");
    const prefix = this.truncated ? "[truncated]\n" : "";
    return prefix + redactText(joined);
  }
}

module.exports = {
  redactText,
  redactObjectStrings,
  isSensitiveEnvKey,
  BoundedRedactedCapture,
  REDACTED,
};
