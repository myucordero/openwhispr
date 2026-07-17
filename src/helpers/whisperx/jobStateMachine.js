// Recording job state machine (spec 02 §9, 06 §2, 10 §5).
// Pure transition table — persistence and side effects live in the job
// manager. "interrupted" covers jobs found in an active state at startup
// (stale running job must become interrupted, never complete).

const ACTIVE_STATES = [
  "created",
  "queued",
  "validating",
  "preparing",
  "transcribing",
  "aligning",
  "diarizing",
  "canonicalizing",
  "persisting",
  "note_extracting",
  "note_validating",
  "note_rendering",
];

// Resting states: job is not running but is not failed either.
const RESTING_STATES = ["transcript_complete", "complete"];

const TERMINAL_FAILURE_STATES = [
  "cancelled",
  "failed",
  "interrupted",
  "transcript_complete_note_failed",
];

const ALL_STATES = [...ACTIVE_STATES, ...RESTING_STATES, ...TERMINAL_FAILURE_STATES];

// Optional pipeline stages may be skipped, so each processing state may jump
// past the next ones (alignment/diarization off).
const TRANSITIONS = {
  created: ["queued", "cancelled", "failed"],
  queued: ["validating", "cancelled", "failed"],
  validating: ["preparing", "cancelled", "failed"],
  preparing: ["transcribing", "cancelled", "failed"],
  transcribing: ["aligning", "diarizing", "canonicalizing", "cancelled", "failed"],
  aligning: ["diarizing", "canonicalizing", "cancelled", "failed"],
  diarizing: ["canonicalizing", "cancelled", "failed"],
  canonicalizing: ["persisting", "cancelled", "failed"],
  persisting: ["transcript_complete", "cancelled", "failed"],
  transcript_complete: [
    "note_extracting",
    // A job whose profile skips notes rests here; deletion handled outside.
  ],
  note_extracting: ["note_validating", "transcript_complete_note_failed", "cancelled"],
  note_validating: ["note_rendering", "transcript_complete_note_failed", "cancelled"],
  note_rendering: ["complete", "transcript_complete_note_failed", "cancelled"],
  complete: ["note_extracting"], // regenerate notes without ASR
  cancelled: ["queued"], // retry
  failed: ["queued"], // retry
  interrupted: ["queued"], // retry after startup recovery
  transcript_complete_note_failed: ["note_extracting"], // retry notes only
};

function isValidState(state) {
  return ALL_STATES.includes(state);
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// Throwing guard used by the job manager before persisting a transition.
function assertTransition(from, to) {
  if (!isValidState(from)) {
    throw new Error(`Unknown job state "${from}"`);
  }
  if (!isValidState(to)) {
    throw new Error(`Unknown job state "${to}"`);
  }
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job state transition "${from}" -> "${to}"`);
  }
}

function isActiveState(state) {
  return ACTIVE_STATES.includes(state);
}

function isTerminalFailureState(state) {
  return TERMINAL_FAILURE_STATES.includes(state);
}

function isRetryableState(state) {
  return ["cancelled", "failed", "interrupted"].includes(state);
}

function canRetryNotes(state) {
  return state === "transcript_complete_note_failed" || state === "transcript_complete" || state === "complete";
}

function canCancel(state) {
  return isActiveState(state);
}

// Startup recovery: any job left in an active state has no live worker and
// must be marked interrupted (never complete) — EXCEPT the note states,
// which are only reachable after the transcript directory finalized: a crash
// there must land on transcript_complete_note_failed so the finalized
// transcript survives and only notes are retried (re-running ASR would hit
// the finalize already-exists guard and dead-end the job).
const NOTE_ACTIVE_STATES = ["note_extracting", "note_validating", "note_rendering"];

function recoveryStateFor(state) {
  if (NOTE_ACTIVE_STATES.includes(state)) return "transcript_complete_note_failed";
  return isActiveState(state) ? "interrupted" : null;
}

module.exports = {
  ACTIVE_STATES,
  RESTING_STATES,
  TERMINAL_FAILURE_STATES,
  ALL_STATES,
  TRANSITIONS,
  isValidState,
  canTransition,
  assertTransition,
  isActiveState,
  isTerminalFailureState,
  isRetryableState,
  canRetryNotes,
  canCancel,
  recoveryStateFor,
};
