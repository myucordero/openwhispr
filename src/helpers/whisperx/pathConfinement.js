// Artifact path confinement (spec 03 §6, spec 07 threat matrix).
// Two layers:
//   1. isRelativeArtifactPathSafe(rel)     — pure string checks, no fs access.
//   2. resolveInsideRoot(rootDir, rel)     — resolves symlinks/reparse points on
//      the parts that exist and confirms the final absolute path stays inside
//      the root. Used by the artifact store before reading/writing/finalizing.
// Windows semantics are enforced even when running on POSIX so contract tests
// exercise the same rules everywhere.

const path = require("path");
const fs = require("fs");

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const DRIVE_RE = /^[a-zA-Z]:/;
// Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), with or
// without an extension.
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const MAX_RELATIVE_PATH_LENGTH = 512;

function isRelativeArtifactPathSafe(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return false;
  if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) return false;
  if (CONTROL_CHAR_RE.test(relativePath)) return false;

  // Absolute forms: POSIX, Windows drive, UNC/device (\\server, \\?\, \\.\).
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) return false;
  if (DRIVE_RE.test(relativePath)) return false;

  // Alternate data streams and drive-relative forms both use ":".
  if (relativePath.includes(":")) return false;

  const segments = relativePath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === "" || segment === ".") return false; // empty => "//" or trailing sep
    if (segment === "..") return false;
    if (RESERVED_DEVICE_RE.test(segment)) return false;
    if (segment.endsWith(" ") || segment.endsWith(".")) return false; // Windows quirk
  }
  return true;
}

// Resolves `relativePath` against `rootDir`, following symlinks on every
// existing ancestor, and returns the resolved absolute path only when it
// remains inside the (also resolved) root. Returns null otherwise.
function resolveInsideRoot(rootDir, relativePath) {
  if (!isRelativeArtifactPathSafe(relativePath)) return null;
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync.native
      ? fs.realpathSync.native(rootDir)
      : fs.realpathSync(rootDir);
  } catch {
    return null; // root must exist
  }

  const target = path.resolve(resolvedRoot, relativePath);
  const rel = path.relative(resolvedRoot, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // Walk down from the root, resolving each existing component so a symlink
  // or reparse point inside the tree cannot escape.
  let current = resolvedRoot;
  const parts = rel.split(path.sep);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      // Component does not exist yet — nothing left on disk to escape through.
      break;
    }
    if (stat.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync.native
          ? fs.realpathSync.native(current)
          : fs.realpathSync(current);
      } catch {
        return null;
      }
      const relReal = path.relative(resolvedRoot, real);
      if (relReal === "" || relReal.startsWith("..") || path.isAbsolute(relReal)) {
        return null;
      }
    }
  }
  return target;
}

module.exports = {
  isRelativeArtifactPathSafe,
  resolveInsideRoot,
  MAX_RELATIVE_PATH_LENGTH,
};
