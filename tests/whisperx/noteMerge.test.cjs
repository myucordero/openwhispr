const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { mergeFragments } = require("../../src/helpers/whisperx/noteMerge");

const fixturesDir = path.resolve(__dirname, "../fixtures/whisperx-contracts");

function transcript() {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, "valid-transcript.json"), "utf8"));
}

// mergeFragments only reads extraction[category] arrays; categories not
// under test are simply omitted (mergeFragments still fills them as []).
function fragment(overrides) {
  return { ...overrides };
}

test("mergeFragments: duplicate detection and wording", async (t) => {
  await t.test("same decision text, different punctuation/case -> single merged item, evidence union in transcript order, first wording kept", () => {
    const fragments = [
      fragment({
        decisions: [
          {
            id: "x1",
            text: "Use SQLite for the project.",
            evidence: { segmentIds: ["seg-0003"] },
          },
        ],
      }),
      fragment({
        decisions: [
          {
            id: "x2",
            text: "USE SQLITE FOR THE PROJECT!!",
            evidence: { segmentIds: ["seg-0002"] },
          },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.equal(merged.decisions.length, 1);
    assert.equal(merged.decisions[0].text, "Use SQLite for the project.");
    // Evidence unioned and sorted in transcript order (seg-0002 before seg-0003).
    assert.deepEqual(merged.decisions[0].evidence.segmentIds, ["seg-0002", "seg-0003"]);
    assert.equal(merged.decisions[0].id, "decision-001");
  });

  await t.test("action items with same task but different owners are NOT merged", () => {
    const fragments = [
      fragment({
        actionItems: [
          {
            id: "a1",
            task: "Prepare the migration plan.",
            ownerSpeakerId: "SPEAKER_01",
            dueDateText: null,
            status: "explicit",
            evidence: { segmentIds: ["seg-0004"] },
          },
        ],
      }),
      fragment({
        actionItems: [
          {
            id: "a2",
            task: "Prepare the migration plan.",
            ownerSpeakerId: "SPEAKER_00",
            dueDateText: null,
            status: "explicit",
            evidence: { segmentIds: ["seg-0004"] },
          },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.equal(merged.actionItems.length, 2);
    const owners = merged.actionItems.map((i) => i.ownerSpeakerId).sort();
    assert.deepEqual(owners, ["SPEAKER_00", "SPEAKER_01"]);
  });

  await t.test("action items with same task, owner, status, and due date ARE merged", () => {
    const fragments = [
      fragment({
        actionItems: [
          {
            id: "a1",
            task: "Send the report.",
            ownerSpeakerId: "SPEAKER_00",
            dueDateText: "tomorrow",
            status: "explicit",
            evidence: { segmentIds: ["seg-0001"] },
          },
        ],
      }),
      fragment({
        actionItems: [
          {
            id: "a2",
            task: "send the report",
            ownerSpeakerId: "SPEAKER_00",
            dueDateText: "Tomorrow!",
            status: "explicit",
            evidence: { segmentIds: ["seg-0002"] },
          },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.equal(merged.actionItems.length, 1);
    assert.equal(merged.actionItems[0].task, "Send the report.");
    assert.deepEqual(merged.actionItems[0].evidence.segmentIds, ["seg-0001", "seg-0002"]);
  });

  await t.test("disagreement is preserved: 'Use SQLite' vs 'Do not use SQLite' both kept", () => {
    const fragments = [
      fragment({
        decisions: [
          { id: "d1", text: "Use SQLite.", evidence: { segmentIds: ["seg-0003"] } },
        ],
      }),
      fragment({
        decisions: [
          { id: "d2", text: "Do not use SQLite.", evidence: { segmentIds: ["seg-0002"] } },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.equal(merged.decisions.length, 2);
    const texts = merged.decisions.map((i) => i.text).sort();
    assert.deepEqual(texts, ["Do not use SQLite.", "Use SQLite."]);
  });

  await t.test("reviewRequired true on either duplicate survives the merge", () => {
    const fragments = [
      fragment({
        decisions: [
          { id: "d1", text: "Use SQLite.", evidence: { segmentIds: ["seg-0003"] } },
        ],
      }),
      fragment({
        decisions: [
          {
            id: "d2",
            text: "use sqlite",
            evidence: { segmentIds: ["seg-0002"] },
            reviewRequired: true,
          },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.equal(merged.decisions.length, 1);
    assert.equal(merged.decisions[0].reviewRequired, true);
  });
});

test("mergeFragments: ordering and stable ids", async (t) => {
  await t.test("items sorted by earliest cited segment start, regardless of input order", () => {
    const fragments = [
      fragment({
        followUps: [
          { id: "f1", text: "Follow up C.", evidence: { segmentIds: ["seg-0004"] } },
          { id: "f2", text: "Follow up A.", evidence: { segmentIds: ["seg-0001"] } },
          { id: "f3", text: "Follow up B.", evidence: { segmentIds: ["seg-0002"] } },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.deepEqual(
      merged.followUps.map((i) => i.text),
      ["Follow up A.", "Follow up B.", "Follow up C."]
    );
    assert.deepEqual(
      merged.followUps.map((i) => i.id),
      ["followup-001", "followup-002", "followup-003"]
    );
  });

  await t.test("stable id prefixes per category", () => {
    const fragments = [
      fragment({
        decisions: [{ id: "d1", text: "Decision one.", evidence: { segmentIds: ["seg-0001"] } }],
        actionItems: [
          {
            id: "a1",
            task: "Task one.",
            ownerSpeakerId: null,
            dueDateText: null,
            status: "unclear",
            evidence: { segmentIds: ["seg-0002"] },
          },
        ],
      }),
    ];
    const merged = mergeFragments(fragments, transcript());
    assert.equal(merged.decisions[0].id, "decision-001");
    assert.equal(merged.actionItems[0].id, "action-001");
  });

  await t.test("empty categories still come back as empty arrays", () => {
    const merged = mergeFragments([fragment({})], transcript());
    assert.deepEqual(merged.risksOrBlockers, []);
    assert.deepEqual(merged.openQuestions, []);
  });
});
