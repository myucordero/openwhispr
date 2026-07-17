const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  renderNotesMarkdown,
  formatTimestamp,
  NoteRenderError,
} = require("../../src/helpers/whisperx/noteRenderer");

const fixturesDir = path.resolve(__dirname, "../fixtures/whisperx-contracts");

function transcript() {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, "valid-transcript.json"), "utf8"));
}

function fullExtraction() {
  return {
    summaryClaims: [
      {
        id: "summary-001",
        text: "The team kicked off Atlas and discussed the database choice.",
        evidence: { segmentIds: ["seg-0001", "seg-0002"] },
      },
    ],
    discussionPoints: [],
    decisions: [
      {
        id: "decision-001",
        text: "Use SQLite for Atlas.",
        evidence: { segmentIds: ["seg-0003"] },
      },
    ],
    proposals: [],
    actionItems: [
      {
        id: "action-001",
        task: "Prepare a migration plan.",
        ownerSpeakerId: "SPEAKER_01",
        dueDateText: null,
        evidence: { segmentIds: ["seg-0004"] },
        reviewRequired: true,
      },
    ],
    followUps: [],
    openQuestions: [],
    risksOrBlockers: [],
    importantQuotes: [
      {
        id: "quote-001",
        quote: "Decidimos usar SQLite para mantener la implementacion simple y portable.",
        speakerId: "SPEAKER_00",
        evidence: { segmentIds: ["seg-0003"] },
      },
    ],
    unresolvedAmbiguities: [],
  };
}

const JOB_ID = "job-test-1";
const SPEAKER_MAPPINGS = { SPEAKER_00: "Marco", SPEAKER_01: "Elena" };

test("renderNotesMarkdown golden output", () => {
  const markdown = renderNotesMarkdown(fullExtraction(), {
    jobId: JOB_ID,
    transcript: transcript(),
    speakerMappings: SPEAKER_MAPPINGS,
    linkMode: "app",
  });

  const expected = [
    "## Summary",
    "",
    "The team kicked off Atlas and discussed the database choice. " +
      "[00:00:00](openwhispr://recording/job-test-1/t/seg-0001) " +
      "[00:00:04](openwhispr://recording/job-test-1/t/seg-0002)",
    "",
    "## Decisions Made",
    "",
    "- Use SQLite for Atlas.",
    "  [00:00:09](openwhispr://recording/job-test-1/t/seg-0003)",
    "",
    "## Action Items",
    "",
    "- [ ] Elena: Prepare a migration plan. ⚠️ *Needs review*",
    "  Due date: **Not stated**. [00:00:15](openwhispr://recording/job-test-1/t/seg-0004)",
    "",
    "## Important Quotes",
    "",
    "- > Decidimos usar SQLite para mantener la implementacion simple y portable. — Marco",
    "  [00:00:09](openwhispr://recording/job-test-1/t/seg-0003)",
  ].join("\n") + "\n";

  assert.equal(markdown, expected);
});

test("renderNotesMarkdown behaviors", async (t) => {
  await t.test("empty categories are omitted", () => {
    const extraction = fullExtraction();
    extraction.summaryClaims = [];
    extraction.decisions = [];
    extraction.importantQuotes = [];
    const markdown = renderNotesMarkdown(extraction, {
      jobId: JOB_ID,
      transcript: transcript(),
      speakerMappings: SPEAKER_MAPPINGS,
    });
    assert.ok(!markdown.includes("## Summary"));
    assert.ok(!markdown.includes("## Decisions Made"));
    assert.ok(!markdown.includes("## Important Quotes"));
    assert.ok(markdown.includes("## Action Items"));
  });

  await t.test('linkMode "plain" renders bare timestamps, no link', () => {
    const markdown = renderNotesMarkdown(fullExtraction(), {
      jobId: JOB_ID,
      transcript: transcript(),
      speakerMappings: SPEAKER_MAPPINGS,
      linkMode: "plain",
    });
    assert.ok(markdown.includes("[00:00:09]"));
    assert.ok(!markdown.includes("(openwhispr://"));
  });

  await t.test("speakerMappings replace ids in action owner and quote attribution", () => {
    const markdown = renderNotesMarkdown(fullExtraction(), {
      jobId: JOB_ID,
      transcript: transcript(),
      speakerMappings: SPEAKER_MAPPINGS,
    });
    assert.ok(markdown.includes("Elena: Prepare a migration plan."));
    assert.ok(markdown.includes("— Marco"));
    assert.ok(!markdown.includes("SPEAKER_01:"));
    assert.ok(!markdown.includes("— SPEAKER_00"));
  });

  await t.test("without speakerMappings, raw speaker ids are used", () => {
    const markdown = renderNotesMarkdown(fullExtraction(), {
      jobId: JOB_ID,
      transcript: transcript(),
    });
    assert.ok(markdown.includes("SPEAKER_01: Prepare a migration plan."));
    assert.ok(markdown.includes("— SPEAKER_00"));
  });

  await t.test("item citing only nonexistent segments throws NoteRenderError", () => {
    const extraction = fullExtraction();
    extraction.decisions = [
      {
        id: "decision-bad",
        text: "A claim with no real evidence.",
        evidence: { segmentIds: ["seg-9999"] },
      },
    ];
    assert.throws(
      () =>
        renderNotesMarkdown(extraction, {
          jobId: JOB_ID,
          transcript: transcript(),
        }),
      (error) => {
        assert.ok(error instanceof NoteRenderError);
        assert.equal(error.itemId, "decision-bad");
        return true;
      }
    );
  });

  await t.test("maxCitationsPerItem caps citations (4 segments cited, cap 3)", () => {
    const extraction = fullExtraction();
    extraction.summaryClaims = [];
    extraction.actionItems = [];
    extraction.importantQuotes = [];
    extraction.decisions = [
      {
        id: "decision-many",
        text: "A claim citing every segment.",
        evidence: { segmentIds: ["seg-0001", "seg-0002", "seg-0003", "seg-0004"] },
      },
    ];
    const markdown = renderNotesMarkdown(extraction, {
      jobId: JOB_ID,
      transcript: transcript(),
      linkMode: "plain",
    });
    assert.ok(markdown.includes("[00:00:00]"));
    assert.ok(markdown.includes("[00:00:04]"));
    assert.ok(markdown.includes("[00:00:09]"));
    assert.ok(!markdown.includes("[00:00:15]"));
  });

  await t.test("determinism: rendering twice yields identical strings", () => {
    const options = {
      jobId: JOB_ID,
      transcript: transcript(),
      speakerMappings: SPEAKER_MAPPINGS,
    };
    const a = renderNotesMarkdown(fullExtraction(), options);
    const b = renderNotesMarkdown(fullExtraction(), options);
    assert.equal(a, b);
  });
});

test("formatTimestamp", async (t) => {
  await t.test("0 seconds -> 00:00:00", () => {
    assert.equal(formatTimestamp(0), "00:00:00");
  });

  await t.test("3661 seconds -> 01:01:01", () => {
    assert.equal(formatTimestamp(3661), "01:01:01");
  });

  await t.test("negative seconds clamp to 00:00:00", () => {
    assert.equal(formatTimestamp(-5), "00:00:00");
  });
});
