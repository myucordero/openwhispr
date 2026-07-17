const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isRelativeArtifactPathSafe,
  resolveInsideRoot,
} = require("../../src/helpers/whisperx/pathConfinement");

test("isRelativeArtifactPathSafe rejects unsafe forms", async (t) => {
  const rejects = [
    "",
    "..",
    "../x",
    "a/../b",
    "/abs",
    "\\\\server\\share",
    "C:evil",
    "C:\\evil",
    "\\\\?\\C:\\x",
    "notes.md:ads",
    "CON",
    "con.txt",
    "sub/NUL.log",
    "a/",
    "a//b",
    ".",
    "./a",
    "trailing. ",
    "trailingdot.",
    "x".repeat(600),
  ];
  for (const candidate of rejects) {
    await t.test(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(
        isRelativeArtifactPathSafe(candidate),
        false,
        `expected ${JSON.stringify(candidate)} to be rejected`
      );
    });
  }
});

test("isRelativeArtifactPathSafe accepts safe relative paths", async (t) => {
  const accepts = [
    "transcript.raw.json",
    "sub/dir/notes.md",
    "sub\\win\\style.md",
    "job.json",
    // Internal spaces are legal on every target filesystem; only trailing
    // space/dot segments are Windows-hostile.
    "a b",
  ];
  for (const candidate of accepts) {
    await t.test(`accepts ${JSON.stringify(candidate)}`, () => {
      assert.equal(
        isRelativeArtifactPathSafe(candidate),
        true,
        `expected ${JSON.stringify(candidate)} to be accepted`
      );
    });
  }
});

test("resolveInsideRoot", async (t) => {
  await t.test("returns the resolved path for a safe relative path inside root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-pathconf-"));
    try {
      const resolved = resolveInsideRoot(root, "a/b.txt");
      const expected = path.join(fs.realpathSync(root), "a", "b.txt");
      assert.equal(resolved, expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("returns null for a path that escapes the root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-pathconf-"));
    try {
      assert.equal(resolveInsideRoot(root, "../escape"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    "returns null when a symlink inside root points outside root",
    { skip: process.platform === "win32" },
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-pathconf-root-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "whisperx-pathconf-outside-"));
      try {
        const linkPath = path.join(root, "link");
        fs.symlinkSync(outside, linkPath, "dir");
        assert.equal(resolveInsideRoot(root, "link/x.txt"), null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  await t.test("returns null when root does not exist", () => {
    const missingRoot = path.join(os.tmpdir(), "whisperx-pathconf-does-not-exist-xyz");
    assert.equal(resolveInsideRoot(missingRoot, "a.txt"), null);
  });
});
