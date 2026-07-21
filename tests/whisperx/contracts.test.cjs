const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  validateJobRequest,
  validateWorkerEvent,
  validateArtifactDescriptor,
  validateCanonicalTranscript,
  validateNoteExtraction,
} = require("../../src/helpers/whisperx/contracts");

const fixturesDir = path.resolve(__dirname, "../fixtures/whisperx-contracts");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

function cloneFixture(name) {
  return JSON.parse(JSON.stringify(loadFixture(name)));
}

function codesOf(result) {
  return result.errors.map((e) => e.code);
}

test("job request fixtures", async (t) => {
  await t.test("valid-job-request.json passes", () => {
    const r = validateJobRequest(loadFixture("valid-job-request.json"));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  await t.test("invalid-path-request.json fails with both violations", () => {
    const r = validateJobRequest(loadFixture("invalid-path-request.json"));
    assert.equal(r.valid, false);
    const codes = codesOf(r);
    assert.ok(codes.includes("INVALID_VALUE"));
    assert.ok(
      r.errors.some((e) => e.path === "$.output.formats"),
      "expected a formats violation"
    );
    assert.ok(
      r.errors.some((e) => e.path === "$.diarization.exactSpeakers"),
      "expected an exactSpeakers/minSpeakers violation"
    );
  });

  await t.test("invalid-secret-request.json fails with FORBIDDEN_FIELD", () => {
    const r = validateJobRequest(loadFixture("invalid-secret-request.json"));
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some((e) => e.code === "FORBIDDEN_FIELD" && e.path === "$.asr.hfToken")
    );
  });
});

test("worker event fixtures", async (t) => {
  await t.test("ready-event.json passes", () => {
    const r = validateWorkerEvent(loadFixture("ready-event.json"));
    assert.equal(r.valid, true);
  });

  await t.test("progress-event.json passes", () => {
    const r = validateWorkerEvent(loadFixture("progress-event.json"));
    assert.equal(r.valid, true);
  });
});

test("transcript fixtures", async (t) => {
  await t.test("valid-transcript.json passes", () => {
    const r = validateCanonicalTranscript(loadFixture("valid-transcript.json"));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  await t.test("invalid-transcript-duplicate-id.json fails", () => {
    const r = validateCanonicalTranscript(
      loadFixture("invalid-transcript-duplicate-id.json")
    );
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(
        (e) => e.code === "TRANSCRIPT_SCHEMA_INVALID" && /Duplicate segment id/.test(e.message)
      )
    );
  });
});

test("note extraction fixtures", async (t) => {
  await t.test("valid-note-extraction.json passes", () => {
    const r = validateNoteExtraction(loadFixture("valid-note-extraction.json"));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  await t.test("invalid-note-missing-evidence.json fails with MISSING_EVIDENCE", () => {
    const r = validateNoteExtraction(loadFixture("invalid-note-missing-evidence.json"));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "MISSING_EVIDENCE"));
  });
});

test("validateJobRequest unit cases", async (t) => {
  await t.test("batchSize 3 is rejected", () => {
    const req = cloneFixture("valid-job-request.json");
    req.asr.batchSize = 3;
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.asr.batchSize"));
  });

  await t.test('device "auto" is rejected', () => {
    const req = cloneFixture("valid-job-request.json");
    req.asr.device = "auto";
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.asr.device"));
  });

  await t.test("hotword containing newline is rejected", () => {
    const req = cloneFixture("valid-job-request.json");
    req.asr.hotwords.push("bad\nword");
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.asr.hotwords[2]"));
  });

  await t.test("hotword count over the limit is rejected", () => {
    const req = cloneFixture("valid-job-request.json");
    req.asr.hotwords = Array.from({ length: 65 }, (_, i) => `word${i}`);
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.asr.hotwords"));
  });

  await t.test("initialPrompt over 2048 chars is rejected", () => {
    const req = cloneFixture("valid-job-request.json");
    req.asr.initialPrompt = "a".repeat(2049);
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.asr.initialPrompt"));
  });

  await t.test("minSpeakers > maxSpeakers is rejected", () => {
    const req = cloneFixture("valid-job-request.json");
    req.diarization.minSpeakers = 5;
    req.diarization.maxSpeakers = 3;
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.diarization.minSpeakers"));
  });

  await t.test("uppercase expectedSha256 is rejected", () => {
    const req = cloneFixture("valid-job-request.json");
    req.source.expectedSha256 = req.source.expectedSha256.toUpperCase();
    const r = validateJobRequest(req);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.source.expectedSha256"));
  });
});

test("validateWorkerEvent unit cases", async (t) => {
  await t.test("unknown event type -> UNKNOWN_EVENT_TYPE", () => {
    const r = validateWorkerEvent({ type: "not-a-real-type" });
    assert.equal(r.valid, false);
    assert.deepEqual(codesOf(r), ["UNKNOWN_EVENT_TYPE"]);
  });

  await t.test("progress completed > total is rejected", () => {
    const event = cloneFixture("progress-event.json");
    event.completed = 200;
    const r = validateWorkerEvent(event);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.completed"));
  });

  await t.test('artifact event with relativePath "..\\evil" -> OUTPUT_PATH_REJECTED', () => {
    const event = {
      type: "artifact",
      kind: "canonical-transcript",
      relativePath: "..\\evil",
      sha256: "a".repeat(64),
      bytes: 10,
      createdAt: "2026-07-16T00:00:00Z",
    };
    const r = validateWorkerEvent(event);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "OUTPUT_PATH_REJECTED"));
  });
});

test("validateArtifactDescriptor unit cases", async (t) => {
  await t.test('relativePath "..\\evil" -> OUTPUT_PATH_REJECTED', () => {
    const r = validateArtifactDescriptor({
      kind: "canonical-transcript",
      relativePath: "..\\evil",
      sha256: "a".repeat(64),
      bytes: 10,
      createdAt: "2026-07-16T00:00:00Z",
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "OUTPUT_PATH_REJECTED"));
  });
});

test("validateCanonicalTranscript unit cases", async (t) => {
  await t.test("segment speakerId not in speakers is rejected", () => {
    const transcript = cloneFixture("valid-transcript.json");
    transcript.segments[0].speakerId = "SPEAKER_99";
    const r = validateCanonicalTranscript(transcript);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(
        (e) => e.code === "TRANSCRIPT_SCHEMA_INVALID" && e.path === "$.segments[0].speakerId"
      )
    );
  });

  await t.test("unsorted segments are rejected", () => {
    const transcript = cloneFixture("valid-transcript.json");
    [transcript.segments[0], transcript.segments[1]] = [
      transcript.segments[1],
      transcript.segments[0],
    ];
    const r = validateCanonicalTranscript(transcript);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(
        (e) => e.code === "TRANSCRIPT_SCHEMA_INVALID" && /sorted by time/.test(e.message)
      )
    );
  });

  await t.test("word start going backwards is rejected", () => {
    const transcript = cloneFixture("valid-transcript.json");
    transcript.segments[0].words[1].start = -1;
    const r = validateCanonicalTranscript(transcript);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(
        (e) => e.code === "TRANSCRIPT_SCHEMA_INVALID" && /time-ordered/.test(e.message)
      )
    );
  });

  await t.test("quality field with non-number value is rejected", () => {
    const transcript = cloneFixture("valid-transcript.json");
    transcript.segments[0].quality = { averageLogProb: "not-a-number" };
    const r = validateCanonicalTranscript(transcript);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.segments[0].quality.averageLogProb"));
  });
});

test("validateNoteExtraction unit cases", async (t) => {
  await t.test("duplicate item ids -> DUPLICATE_ITEM", () => {
    const extraction = cloneFixture("valid-note-extraction.json");
    extraction.openQuestions.push({
      id: extraction.decisions[0].id,
      text: "A second question reusing the decision's id.",
      evidence: { segmentIds: ["seg-0004"] },
    });
    const r = validateNoteExtraction(extraction);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "DUPLICATE_ITEM"));
  });

  await t.test("dueDateIso set while dueDateText is null -> DATE_NOT_EXPLICIT", () => {
    const extraction = cloneFixture("valid-note-extraction.json");
    extraction.actionItems[0].dueDateIso = "2026-08-01";
    assert.equal(extraction.actionItems[0].dueDateText, null);
    const r = validateNoteExtraction(extraction);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "DATE_NOT_EXPLICIT"));
  });

  await t.test('actionItem status "guessed" is rejected', () => {
    const extraction = cloneFixture("valid-note-extraction.json");
    extraction.actionItems[0].status = "guessed";
    const r = validateNoteExtraction(extraction);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "$.actionItems[0].status"));
  });

  await t.test("missing category field -> NOTE_SCHEMA_INVALID", () => {
    const extraction = cloneFixture("valid-note-extraction.json");
    delete extraction.decisions;
    const r = validateNoteExtraction(extraction);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some((e) => e.code === "NOTE_SCHEMA_INVALID" && e.path === "$.decisions")
    );
  });
});
