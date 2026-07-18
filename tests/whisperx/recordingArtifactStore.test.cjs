// Unit tests for the recording artifact store
// (src/helpers/whisperx/recordingArtifactStore.js).
//
// Every test uses a throwaway jobs root created with fs.mkdtempSync and cleaned
// up afterwards, so nothing touches the user's data. External-source protection
// is exercised with a file deliberately created OUTSIDE the jobs root.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  RecordingArtifactStore,
  ArtifactStoreError,
} = require("../../src/helpers/whisperx/recordingArtifactStore.js");

function mkroot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-store-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Writes a file into staging and returns a matching descriptor.
function stageArtifact(store, jobId, relativePath, content, kind = "raw-transcript") {
  const abs = path.join(store.stagingDir(jobId), relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { kind, relativePath, sha256: sha256(content), bytes: Buffer.byteLength(content) };
}

test("createStagingDir makes a fresh dir and wipes any leftover", () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    const dir = store.createStagingDir("job1");
    assert.equal(fs.existsSync(dir), true);
    assert.deepEqual(fs.readdirSync(dir), []);

    fs.writeFileSync(path.join(dir, "leftover.txt"), "stale");
    const dir2 = store.createStagingDir("job1");
    assert.equal(dir2, dir);
    assert.deepEqual(fs.readdirSync(dir2), []); // leftover wiped
  } finally {
    rm(root);
  }
});

test("verifyArtifacts reports each failure reason precisely", async () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    store.createStagingDir("job1");
    const good = stageArtifact(store, "job1", "ok.txt", "hello world");

    // Baseline: everything valid.
    const okResult = await store.verifyArtifacts("job1", [good]);
    assert.equal(okResult.ok, true);
    assert.deepEqual(okResult.failures, []);

    // Missing file.
    const missing = await store.verifyArtifacts("job1", [
      { relativePath: "nope.txt", sha256: sha256("x"), bytes: 1 },
    ]);
    assert.equal(missing.ok, false);
    assert.equal(missing.failures[0].reason, "ARTIFACT_WRITE_FAILED");

    // Wrong byte count.
    const wrongBytes = await store.verifyArtifacts("job1", [
      { ...good, bytes: good.bytes + 5 },
    ]);
    assert.equal(wrongBytes.ok, false);
    assert.equal(wrongBytes.failures[0].reason, "ARTIFACT_HASH_MISMATCH");
    assert.equal(wrongBytes.failures[0].expectedBytes, good.bytes + 5);
    assert.equal(wrongBytes.failures[0].actualBytes, good.bytes);

    // Correct bytes but wrong hash.
    const wrongHash = await store.verifyArtifacts("job1", [
      { ...good, sha256: "0".repeat(64) },
    ]);
    assert.equal(wrongHash.ok, false);
    assert.equal(wrongHash.failures[0].reason, "ARTIFACT_HASH_MISMATCH");

    // Unsafe relative path.
    const unsafe = await store.verifyArtifacts("job1", [
      { relativePath: "../escape.txt", sha256: sha256("x"), bytes: 1 },
    ]);
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.failures[0].reason, "OUTPUT_PATH_REJECTED");
  } finally {
    rm(root);
  }
});

test("finalizeJob writes manifest.json, renames staging->final atomically", async () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    store.createStagingDir("job1");
    const descriptors = [
      stageArtifact(store, "job1", "transcript.raw.json", '{"schemaVersion":1}', "canonical-transcript"),
      stageArtifact(store, "job1", "transcript.raw.txt", "hola\n"),
    ];

    const finalDir = await store.finalizeJob("job1", {
      manifest: { jobId: "job1", profile: "memo", sourceSha256: "ab".repeat(32) },
      descriptors,
    });

    assert.equal(store.hasFinalizedJob("job1"), true);
    assert.equal(fs.existsSync(store.stagingDir("job1")), false); // staging gone
    assert.equal(finalDir, store.finalDir("job1"));

    const manifest = JSON.parse(fs.readFileSync(path.join(finalDir, "manifest.json"), "utf8"));
    assert.equal(manifest.jobId, "job1");
    assert.equal(manifest.profile, "memo");
    assert.deepEqual(manifest.artifacts, descriptors);

    // The verified artifacts are present in the final dir.
    assert.equal(fs.existsSync(path.join(finalDir, "transcript.raw.json")), true);
    assert.equal(fs.existsSync(path.join(finalDir, "transcript.raw.txt")), true);
  } finally {
    rm(root);
  }
});

test("finalizeJob throws ARTIFACT_HASH_MISMATCH on a tampered file; staging remains", async () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    store.createStagingDir("job1");
    const descriptor = stageArtifact(store, "job1", "data.txt", "hello");
    // Tamper: same byte length, different content -> hash mismatch.
    fs.writeFileSync(path.join(store.stagingDir("job1"), "data.txt"), "world");

    await assert.rejects(
      store.finalizeJob("job1", { manifest: { jobId: "job1" }, descriptors: [descriptor] }),
      (e) => e instanceof ArtifactStoreError && e.code === "ARTIFACT_HASH_MISMATCH"
    );

    assert.equal(store.hasFinalizedJob("job1"), false);
    assert.equal(fs.existsSync(store.stagingDir("job1")), true); // not finalized
  } finally {
    rm(root);
  }
});

test("finalizeJob refuses when the final dir already exists", async () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    store.createStagingDir("job1");
    const descriptors = [stageArtifact(store, "job1", "a.txt", "one")];
    await store.finalizeJob("job1", { manifest: { jobId: "job1" }, descriptors });

    // Second attempt: rebuild staging, then finalize into the occupied slot.
    store.createStagingDir("job1");
    const descriptors2 = [stageArtifact(store, "job1", "a.txt", "two")];
    await assert.rejects(
      store.finalizeJob("job1", { manifest: { jobId: "job1" }, descriptors: descriptors2 }),
      (e) => e instanceof ArtifactStoreError && e.code === "ARTIFACT_WRITE_FAILED"
    );
    assert.equal(fs.existsSync(store.stagingDir("job1")), true); // staging preserved
  } finally {
    rm(root);
  }
});

test("writeFileAtomic writes inside the final dir and reports sha256/bytes", async () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    store.createStagingDir("job1");
    await store.finalizeJob("job1", {
      manifest: { jobId: "job1" },
      descriptors: [stageArtifact(store, "job1", "a.txt", "one")],
    });
    const finalDir = store.finalDir("job1");

    const content = "# Notes\nregenerated\n";
    const desc = store.writeFileAtomic(finalDir, "notes.md", content);
    assert.equal(desc.relativePath, "notes.md");
    assert.equal(desc.bytes, Buffer.byteLength(content));
    assert.equal(desc.sha256, sha256(content));
    assert.equal(fs.readFileSync(path.join(finalDir, "notes.md"), "utf8"), content);

    // Unsafe relative path is rejected.
    assert.throws(
      () => store.writeFileAtomic(finalDir, "../escape.md", content),
      (e) => e instanceof ArtifactStoreError && e.code === "OUTPUT_PATH_REJECTED"
    );

    // A base dir outside the jobs root is rejected.
    assert.throws(
      () => store.writeFileAtomic(os.tmpdir(), "x.md", content),
      (e) => e instanceof ArtifactStoreError && e.code === "OUTPUT_PATH_REJECTED"
    );
  } finally {
    rm(root);
  }
});

test("deleteJobArtifacts removes staging+final; keepFinal preserves the final dir", async () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    store.createStagingDir("job1");
    await store.finalizeJob("job1", {
      manifest: { jobId: "job1" },
      descriptors: [stageArtifact(store, "job1", "a.txt", "one")],
    });
    // Recreate a staging dir so both staging and final exist.
    store.createStagingDir("job1");
    assert.equal(fs.existsSync(store.stagingDir("job1")), true);
    assert.equal(store.hasFinalizedJob("job1"), true);

    store.deleteJobArtifacts("job1", { keepFinal: true });
    assert.equal(fs.existsSync(store.stagingDir("job1")), false);
    assert.equal(store.hasFinalizedJob("job1"), true); // final preserved

    store.deleteJobArtifacts("job1");
    assert.equal(store.hasFinalizedJob("job1"), false); // final now gone
  } finally {
    rm(root);
  }
});

test("deleteJobArtifacts never touches a source file outside the jobs root", () => {
  const root = mkroot();
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-ext-"));
  try {
    const store = new RecordingArtifactStore(root);
    const externalSource = path.join(externalDir, "source.wav");
    fs.writeFileSync(externalSource, "real audio bytes");

    store.createStagingDir("job1");
    store.deleteJobArtifacts("job1");

    assert.equal(fs.existsSync(externalSource), true); // external source untouched
  } finally {
    rm(root);
    rm(externalDir);
  }
});

test("cleanupStaleStaging removes only stale .incomplete-* dirs", () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    const oldStaging = store.createStagingDir("old");
    store.createStagingDir("fresh");
    fs.mkdirSync(store.finalDir("done"), { recursive: true }); // finalized dir, no prefix

    const nowMs = Date.now();
    const pastSec = (nowMs - 120000) / 1000;
    fs.utimesSync(oldStaging, pastSec, pastSec); // make "old" stale

    const removed = store.cleanupStaleStaging({ maxAgeMs: 60000, now: nowMs });
    assert.deepEqual(removed, [".incomplete-old"]);
    assert.equal(fs.existsSync(store.stagingDir("old")), false);
    assert.equal(fs.existsSync(store.stagingDir("fresh")), true); // fresh kept
    assert.equal(fs.existsSync(store.finalDir("done")), true); // finalized kept
  } finally {
    rm(root);
  }
});

test("jobDiskUsage sums nested files recursively", () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    const dir = store.finalDir("usage");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "0123456789"); // 10 bytes
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "x".repeat(20)); // 20 bytes
    assert.equal(store.jobDiskUsage("usage"), 30);
  } finally {
    rm(root);
  }
});

test("readArtifact enforces confinement and the maxBytes cap", () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    const dir = store.finalDir("read");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "file.txt"), "abcdef");

    assert.equal(store.readArtifact("read", "file.txt").toString("utf8"), "abcdef");

    assert.throws(
      () => store.readArtifact("read", "../x"),
      (e) => e instanceof ArtifactStoreError && e.code === "OUTPUT_PATH_REJECTED"
    );
    assert.throws(
      () => store.readArtifact("read", "file.txt", { maxBytes: 1 }),
      (e) => e instanceof ArtifactStoreError && e.code === "ARTIFACT_WRITE_FAILED"
    );
    // Missing files raise a coded error, never a raw ENOENT (which would
    // surface as an unclassified 500 with a filesystem path over the bridge).
    assert.throws(
      () => store.readArtifact("read", "missing.txt"),
      (e) => e instanceof ArtifactStoreError && e.code === "AUDIO_FILE_NOT_FOUND"
    );
  } finally {
    rm(root);
  }
});

test("assertJobId (via stagingDir) rejects traversal and empty ids", () => {
  const root = mkroot();
  try {
    const store = new RecordingArtifactStore(root);
    assert.throws(
      () => store.stagingDir("../evil"),
      (e) => e instanceof ArtifactStoreError && e.code === "OUTPUT_PATH_REJECTED"
    );
    assert.throws(
      () => store.stagingDir(""),
      (e) => e instanceof ArtifactStoreError && e.code === "OUTPUT_PATH_REJECTED"
    );
  } finally {
    rm(root);
  }
});
