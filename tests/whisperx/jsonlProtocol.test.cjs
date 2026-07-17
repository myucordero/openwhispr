const test = require("node:test");
const assert = require("node:assert/strict");

const {
  JsonlLineReader,
  ProtocolSession,
  ProtocolError,
} = require("../../src/helpers/whisperx/jsonlProtocol");

function readyEvent(overrides = {}) {
  return {
    type: "ready",
    protocolVersion: 1,
    workerVersion: "0.1.0",
    whisperxVersion: "3.1.1",
    pythonVersion: "3.11.8",
    ...overrides,
  };
}

function stageEvent(stage = "transcribing") {
  return { type: "stage", stage, timestamp: "2026-07-16T00:00:00Z" };
}

function progressEvent(overrides = {}) {
  return {
    type: "progress",
    stage: "transcribing",
    completed: 10,
    total: 100,
    unit: "segments",
    ...overrides,
  };
}

function artifactEvent() {
  return {
    type: "artifact",
    kind: "canonical-transcript",
    relativePath: "transcript.json",
    sha256: "a".repeat(64),
    bytes: 1024,
    createdAt: "2026-07-16T00:05:00Z",
  };
}

function completeEvent() {
  return { type: "complete", result: { summary: "ok" } };
}

function errorEvent() {
  return { type: "error", error: { code: "WORKER_CRASHED", message: "boom" } };
}

test("JsonlLineReader", async (t) => {
  await t.test("multiple lines in one chunk", () => {
    const reader = new JsonlLineReader();
    const lines = reader.feed("line1\nline2\n");
    assert.deepEqual(lines, ["line1", "line2"]);
  });

  await t.test("single line split across 3 chunks", () => {
    const reader = new JsonlLineReader();
    assert.deepEqual(reader.feed("li"), []);
    assert.deepEqual(reader.feed("ne"), []);
    assert.deepEqual(reader.feed("1\n"), ["line1"]);
  });

  await t.test("\\r\\n is tolerated", () => {
    const reader = new JsonlLineReader();
    const lines = reader.feed("line1\r\nline2\r\n");
    assert.deepEqual(lines, ["line1", "line2"]);
  });

  await t.test("oversized line throws WORKER_PROTOCOL_ERROR", () => {
    const reader = new JsonlLineReader({ maxLineBytes: 64 });
    const bigChunk = "x".repeat(100);
    assert.throws(
      () => reader.feed(bigChunk),
      (err) => {
        assert.ok(err instanceof ProtocolError);
        assert.equal(err.code, "WORKER_PROTOCOL_ERROR");
        assert.equal(err.details.reason, "oversized-line");
        return true;
      }
    );
  });

  await t.test("pendingBytes reflects partial line", () => {
    const reader = new JsonlLineReader();
    const partial = "partial-line-no-newline-yet";
    reader.feed(partial);
    assert.equal(reader.pendingBytes(), Buffer.byteLength(partial, "utf8"));
  });
});

test("ProtocolSession", async (t) => {
  await t.test("happy path ready -> stage -> progress -> artifact -> complete", () => {
    const session = new ProtocolSession();
    const ready = session.acceptLine(JSON.stringify(readyEvent()));
    assert.equal(ready.type, "ready");
    const stage = session.acceptLine(JSON.stringify(stageEvent()));
    assert.equal(stage.type, "stage");
    const progress = session.acceptLine(JSON.stringify(progressEvent()));
    assert.equal(progress.type, "progress");
    const artifact = session.acceptLine(JSON.stringify(artifactEvent()));
    assert.equal(artifact.type, "artifact");
    const complete = session.acceptLine(JSON.stringify(completeEvent()));
    assert.equal(complete.type, "complete");
    assert.equal(session.isTerminal(), true);
  });

  await t.test("first event not ready throws", () => {
    const session = new ProtocolSession();
    assert.throws(
      () => session.acceptLine(JSON.stringify(stageEvent())),
      (err) => {
        assert.ok(err instanceof ProtocolError);
        assert.equal(err.details.reason, "ready-not-first");
        return true;
      }
    );
  });

  await t.test("duplicate ready throws", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    assert.throws(
      () => session.acceptLine(JSON.stringify(readyEvent())),
      (err) => {
        assert.equal(err.details.reason, "duplicate-ready");
        return true;
      }
    );
  });

  await t.test("malformed JSON line throws", () => {
    const session = new ProtocolSession();
    assert.throws(
      () => session.acceptLine("{not json"),
      (err) => {
        assert.equal(err.details.reason, "malformed-json");
        return true;
      }
    );
  });

  await t.test("blank line throws", () => {
    const session = new ProtocolSession();
    assert.throws(
      () => session.acceptLine("   "),
      (err) => {
        assert.equal(err.details.reason, "blank-line");
        return true;
      }
    );
  });

  await t.test("unknown event type throws WORKER_PROTOCOL_ERROR", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    assert.throws(
      () => session.acceptLine(JSON.stringify({ type: "not-a-real-type" })),
      (err) => {
        assert.equal(err.code, "WORKER_PROTOCOL_ERROR");
        return true;
      }
    );
  });

  await t.test("wrong protocolVersion on ready throws PROTOCOL_VERSION_UNSUPPORTED", () => {
    const session = new ProtocolSession();
    assert.throws(
      () => session.acceptLine(JSON.stringify(readyEvent({ protocolVersion: 2 }))),
      (err) => {
        assert.equal(err.code, "PROTOCOL_VERSION_UNSUPPORTED");
        return true;
      }
    );
  });

  await t.test("event after complete throws", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    session.acceptLine(JSON.stringify(completeEvent()));
    assert.throws(
      () => session.acceptLine(JSON.stringify(stageEvent())),
      (err) => {
        assert.equal(err.details.reason, "event-after-terminal");
        return true;
      }
    );
  });

  await t.test("event after error throws", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    session.acceptLine(JSON.stringify(errorEvent()));
    assert.throws(
      () => session.acceptLine(JSON.stringify(stageEvent())),
      (err) => {
        assert.equal(err.details.reason, "event-after-terminal");
        return true;
      }
    );
  });

  await t.test("non-monotonic progress within same stage throws", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    session.acceptLine(JSON.stringify(progressEvent({ completed: 50 })));
    assert.throws(
      () => session.acceptLine(JSON.stringify(progressEvent({ completed: 10 }))),
      (err) => {
        assert.equal(err.details.reason, "non-monotonic-progress");
        return true;
      }
    );
  });

  await t.test("progress resetting in a different stage is allowed", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    session.acceptLine(JSON.stringify(progressEvent({ stage: "transcribing", completed: 50 })));
    assert.doesNotThrow(() =>
      session.acceptLine(JSON.stringify(progressEvent({ stage: "aligning", completed: 5 })))
    );
  });

  await t.test("duplicate complete throws (terminal)", () => {
    const session = new ProtocolSession();
    session.acceptLine(JSON.stringify(readyEvent()));
    session.acceptLine(JSON.stringify(completeEvent()));
    assert.throws(
      () => session.acceptLine(JSON.stringify(completeEvent())),
      (err) => {
        assert.equal(err.details.reason, "event-after-terminal");
        return true;
      }
    );
  });
});
