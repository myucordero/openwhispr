const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ACTIVE_STATES,
  RESTING_STATES,
  TERMINAL_FAILURE_STATES,
  assertTransition,
  canTransition,
  isRetryableState,
  canRetryNotes,
  canCancel,
  recoveryStateFor,
} = require("../../src/helpers/whisperx/jobStateMachine");

test("full valid job chain", () => {
  const chain = [
    "created",
    "queued",
    "validating",
    "preparing",
    "transcribing",
    "aligning",
    "diarizing",
    "canonicalizing",
    "persisting",
    "transcript_complete",
    "note_extracting",
    "note_validating",
    "note_rendering",
    "complete",
  ];
  for (let i = 0; i < chain.length - 1; i++) {
    const from = chain[i];
    const to = chain[i + 1];
    assert.doesNotThrow(
      () => assertTransition(from, to),
      `${from} -> ${to} should be a valid transition`
    );
  }
});

test("optional-stage skip paths", async (t) => {
  await t.test("transcribing -> canonicalizing (skip alignment and diarization)", () => {
    assert.doesNotThrow(() => assertTransition("transcribing", "canonicalizing"));
  });
  await t.test("transcribing -> diarizing (skip alignment)", () => {
    assert.doesNotThrow(() => assertTransition("transcribing", "diarizing"));
  });
  await t.test("aligning -> canonicalizing (skip diarization)", () => {
    assert.doesNotThrow(() => assertTransition("aligning", "canonicalizing"));
  });
});

test("invalid transitions throw", async (t) => {
  await t.test("complete -> queued throws", () => {
    assert.throws(() => assertTransition("complete", "queued"));
    assert.equal(canTransition("complete", "queued"), false);
  });
  await t.test("transcript_complete -> complete throws", () => {
    assert.throws(() => assertTransition("transcript_complete", "complete"));
    assert.equal(canTransition("transcript_complete", "complete"), false);
  });
  await t.test("created -> transcribing throws", () => {
    assert.throws(() => assertTransition("created", "transcribing"));
    assert.equal(canTransition("created", "transcribing"), false);
  });
});

test("cancellation is allowed from every active state", () => {
  for (const state of ACTIVE_STATES) {
    assert.equal(canCancel(state), true, `expected canCancel("${state}") to be true`);
    assert.doesNotThrow(
      () => assertTransition(state, "cancelled"),
      `expected ${state} -> cancelled to be valid`
    );
  }
});

test("cancellation is not allowed from resting/failed states", async (t) => {
  const notCancellable = ["transcript_complete", "complete", "failed"];
  for (const state of notCancellable) {
    await t.test(`${state} cannot be cancelled`, () => {
      assert.equal(canCancel(state), false);
      assert.throws(() => assertTransition(state, "cancelled"));
    });
  }
});

test("retry transitions", async (t) => {
  await t.test("failed -> queued", () => {
    assert.doesNotThrow(() => assertTransition("failed", "queued"));
    assert.equal(isRetryableState("failed"), true);
  });
  await t.test("cancelled -> queued", () => {
    assert.doesNotThrow(() => assertTransition("cancelled", "queued"));
    assert.equal(isRetryableState("cancelled"), true);
  });
  await t.test("interrupted -> queued", () => {
    assert.doesNotThrow(() => assertTransition("interrupted", "queued"));
    assert.equal(isRetryableState("interrupted"), true);
  });
});

test("notes retry from transcript_complete_note_failed", () => {
  assert.doesNotThrow(() => assertTransition("transcript_complete_note_failed", "note_extracting"));
  assert.equal(canRetryNotes("transcript_complete_note_failed"), true);
});

test("note regeneration from complete", () => {
  assert.doesNotThrow(() => assertTransition("complete", "note_extracting"));
  assert.equal(canRetryNotes("complete"), true);
});

test("recoveryStateFor", async (t) => {
  await t.test("every active state recovers to interrupted", () => {
    for (const state of ACTIVE_STATES) {
      assert.equal(recoveryStateFor(state), "interrupted", `expected ${state} to recover`);
    }
  });
  await t.test("resting and terminal states do not recover", () => {
    for (const state of [...RESTING_STATES, ...TERMINAL_FAILURE_STATES]) {
      assert.equal(recoveryStateFor(state), null, `expected ${state} to be null`);
    }
  });
});

test("unknown state names throw in assertTransition", async (t) => {
  await t.test("unknown from-state", () => {
    assert.throws(() => assertTransition("bogus-state", "queued"));
  });
  await t.test("unknown to-state", () => {
    assert.throws(() => assertTransition("created", "bogus-state"));
  });
});
