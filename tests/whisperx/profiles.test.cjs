const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeHotwords,
  resolveJobSettings,
  oomLadderFor,
  ProfileValidationError,
  OOM_LADDERS,
} = require("../../src/helpers/whisperx/profiles");

test("profile defaults", async (t) => {
  await t.test("memo: turbo/float16/4, alignment on, diarization off", () => {
    const settings = resolveJobSettings("memo");
    assert.equal(settings.model, "large-v3-turbo");
    assert.equal(settings.computeType, "float16");
    assert.equal(settings.batchSize, 4);
    assert.equal(settings.alignment, true);
    assert.equal(settings.diarization, false);
  });

  await t.test("meeting: same asr defaults as memo, diarization on", () => {
    const settings = resolveJobSettings("meeting");
    assert.equal(settings.model, "large-v3-turbo");
    assert.equal(settings.computeType, "float16");
    assert.equal(settings.batchSize, 4);
    assert.equal(settings.alignment, true);
    assert.equal(settings.diarization, true);
  });

  await t.test(
    "critical-interview: large-v3/float16/2, alignment+diarization on, strictNotes, rawTranscriptMandatory",
    () => {
      const settings = resolveJobSettings("critical-interview");
      assert.equal(settings.model, "large-v3");
      assert.equal(settings.computeType, "float16");
      assert.equal(settings.batchSize, 2);
      assert.equal(settings.alignment, true);
      assert.equal(settings.diarization, true);
      assert.equal(settings.strictNotes, true);
      assert.equal(settings.rawTranscriptMandatory, true);
    }
  );
});

test("resolveJobSettings overrides and validation", async (t) => {
  await t.test("language override is validated and applied", () => {
    const settings = resolveJobSettings("memo", { language: "en" });
    assert.equal(settings.language, "en");
    assert.throws(
      () => resolveJobSettings("memo", { language: "xx" }),
      ProfileValidationError
    );
  });

  await t.test("batchSize 3 throws ProfileValidationError", () => {
    assert.throws(
      () => resolveJobSettings("memo", { batchSize: 3 }),
      ProfileValidationError
    );
  });

  await t.test("exactSpeakers combined with minSpeakers throws", () => {
    assert.throws(
      () => resolveJobSettings("meeting", { exactSpeakers: 2, minSpeakers: 1 }),
      ProfileValidationError
    );
  });

  await t.test("minSpeakers > maxSpeakers throws", () => {
    assert.throws(
      () => resolveJobSettings("meeting", { minSpeakers: 5, maxSpeakers: 2 }),
      ProfileValidationError
    );
  });

  await t.test('device "auto" throws', () => {
    assert.throws(
      () => resolveJobSettings("memo", { device: "auto" }),
      ProfileValidationError
    );
  });
});

test("sanitizeHotwords", async (t) => {
  await t.test("dedupes case-insensitively, keeping first casing", () => {
    const out = sanitizeHotwords(["OpenWhispr", "openwhispr", "OPENWHISPR"]);
    assert.deepEqual(out, ["OpenWhispr"]);
  });

  await t.test("strips control chars and collapses whitespace", () => {
    const out = sanitizeHotwords(["bad\x00word", "  a   b  "]);
    assert.deepEqual(out, ["bad word", "a b"]);
  });

  await t.test("caps at 64 entries", () => {
    const words = Array.from({ length: 70 }, (_, i) => `word${i}`);
    const out = sanitizeHotwords(words);
    assert.equal(out.length, 64);
  });

  await t.test("caps each entry at 64 chars", () => {
    const out = sanitizeHotwords(["a".repeat(100)]);
    assert.equal(out[0].length, 64);
  });

  await t.test("drops empties and non-strings", () => {
    const out = sanitizeHotwords([123, null, "", "   ", "valid"]);
    assert.deepEqual(out, ["valid"]);
  });

  await t.test("non-array input returns empty array", () => {
    assert.deepEqual(sanitizeHotwords(null), []);
    assert.deepEqual(sanitizeHotwords(undefined), []);
  });
});

test("oomLadderFor", async (t) => {
  await t.test("meeting default returns the full 4-step ladder from the start", () => {
    const settings = resolveJobSettings("meeting");
    const ladder = oomLadderFor(settings);
    assert.deepEqual(ladder, OOM_LADDERS.meeting);
    assert.equal(ladder.length, 4);
  });

  await t.test("settings already at float16/2 return the ladder starting at that step", () => {
    const settings = resolveJobSettings("meeting", { batchSize: 2 });
    const ladder = oomLadderFor(settings);
    assert.equal(ladder.length, 3);
    assert.deepEqual(ladder[0], {
      model: "large-v3-turbo",
      computeType: "float16",
      batchSize: 2,
    });
  });

  await t.test("memo at float16/2 also returns a 3-step ladder starting at that step", () => {
    const settings = resolveJobSettings("memo", { batchSize: 2 });
    const ladder = oomLadderFor(settings);
    assert.equal(ladder.length, 3);
  });

  await t.test("a custom config not present in the ladder is prepended", () => {
    const settings = resolveJobSettings("meeting", { computeType: "int8", batchSize: 8 });
    const ladder = oomLadderFor(settings);
    assert.equal(ladder.length, OOM_LADDERS.meeting.length + 1);
    assert.deepEqual(ladder[0], {
      model: "large-v3-turbo",
      computeType: "int8",
      batchSize: 8,
    });
  });

  await t.test(
    "critical-interview ladder ends with the disclosed large-v3-turbo downgrade step",
    () => {
      const settings = resolveJobSettings("critical-interview");
      const ladder = oomLadderFor(settings);
      const last = ladder[ladder.length - 1];
      assert.equal(last.model, "large-v3-turbo");
      assert.equal(last.disclosedModelDowngrade, true);
    }
  );
});
