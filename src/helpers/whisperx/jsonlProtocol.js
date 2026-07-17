// JSONL worker protocol (spec 02 §6, 03 §3, 06 §2).
// JsonlLineReader turns raw stdout chunks into complete lines with a hard
// per-line byte cap. ProtocolSession enforces event ordering:
//   ready first → (heartbeat|stage|progress|warning|artifact)* → complete|error
// Anything malformed, unknown, duplicated, or after a terminal event is a
// protocol error. stderr is never fed into this module.

const { validateWorkerEvent } = require("./contracts");
const { WHISPERX_PROTOCOL_VERSION, LIMITS } = require("./constants");

class ProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

class JsonlLineReader {
  constructor({ maxLineBytes = LIMITS.MAX_JSONL_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
    this._buffer = Buffer.alloc(0);
  }

  // Feed a Buffer (or utf8 string) chunk; returns an array of complete line
  // strings (without trailing newline). Throws ProtocolError when a single
  // line exceeds the cap.
  feed(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this._buffer = this._buffer.length === 0 ? incoming : Buffer.concat([this._buffer, incoming]);

    const lines = [];
    let start = 0;
    while (true) {
      const nl = this._buffer.indexOf(0x0a, start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && this._buffer[end - 1] === 0x0d) end -= 1; // tolerate \r\n
      lines.push(this._buffer.toString("utf8", start, end));
      start = nl + 1;
    }
    this._buffer = start === 0 ? this._buffer : this._buffer.subarray(start);

    if (this._buffer.length > this.maxLineBytes) {
      const size = this._buffer.length;
      this._buffer = Buffer.alloc(0);
      throw new ProtocolError(
        "WORKER_PROTOCOL_ERROR",
        `Protocol line exceeded ${this.maxLineBytes} bytes`,
        { reason: "oversized-line", size }
      );
    }
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        throw new ProtocolError(
          "WORKER_PROTOCOL_ERROR",
          `Protocol line exceeded ${this.maxLineBytes} bytes`,
          { reason: "oversized-line" }
        );
      }
    }
    return lines;
  }

  // Remaining buffered partial line (for diagnostics after worker exit).
  pendingBytes() {
    return this._buffer.length;
  }
}

class ProtocolSession {
  constructor() {
    this.readyReceived = false;
    this.terminal = null; // "complete" | "error" | null
    this._progressByStage = new Map();
  }

  isTerminal() {
    return this.terminal !== null;
  }

  // Parses and validates a single protocol line; returns the typed event.
  // Throws ProtocolError on any violation.
  acceptLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") {
      throw new ProtocolError("WORKER_PROTOCOL_ERROR", "Blank protocol line", {
        reason: "blank-line",
      });
    }

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (parseError) {
      throw new ProtocolError("WORKER_PROTOCOL_ERROR", "Malformed JSON protocol line", {
        reason: "malformed-json",
        parseError: parseError.message,
      });
    }

    const { valid, errors } = validateWorkerEvent(event);
    if (!valid) {
      const versionIssue = errors.find((e) => e.code === "PROTOCOL_VERSION_UNSUPPORTED");
      throw new ProtocolError(
        versionIssue ? "PROTOCOL_VERSION_UNSUPPORTED" : "WORKER_PROTOCOL_ERROR",
        versionIssue
          ? `Worker protocol version is unsupported (expected ${WHISPERX_PROTOCOL_VERSION})`
          : "Invalid worker event",
        { reason: "invalid-event", errors }
      );
    }

    return this._advance(event);
  }

  _advance(event) {
    if (this.terminal) {
      throw new ProtocolError(
        "WORKER_PROTOCOL_ERROR",
        `Event "${event.type}" received after terminal "${this.terminal}"`,
        { reason: "event-after-terminal", eventType: event.type }
      );
    }

    if (!this.readyReceived) {
      if (event.type !== "ready") {
        throw new ProtocolError(
          "WORKER_PROTOCOL_ERROR",
          `First protocol event must be "ready", got "${event.type}"`,
          { reason: "ready-not-first", eventType: event.type }
        );
      }
      this.readyReceived = true;
      return event;
    }

    switch (event.type) {
      case "ready":
        throw new ProtocolError("WORKER_PROTOCOL_ERROR", "Duplicate ready event", {
          reason: "duplicate-ready",
        });
      case "progress": {
        const previous = this._progressByStage.get(event.stage);
        if (previous !== undefined && event.completed < previous) {
          throw new ProtocolError(
            "WORKER_PROTOCOL_ERROR",
            `Non-monotonic progress in stage "${event.stage}" (${previous} -> ${event.completed})`,
            { reason: "non-monotonic-progress", stage: event.stage }
          );
        }
        this._progressByStage.set(event.stage, event.completed);
        return event;
      }
      case "complete":
        this.terminal = "complete";
        return event;
      case "error":
        this.terminal = "error";
        return event;
      default:
        return event;
    }
  }
}

module.exports = { JsonlLineReader, ProtocolSession, ProtocolError };
