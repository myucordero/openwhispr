// Recording artifact store (spec 02 §10, 03 §6, 07 §6).
// Layout under a single jobs root (userData/recording-jobs):
//   <jobsRoot>/.incomplete-<jobId>/   — staging dir the worker writes into
//   <jobsRoot>/<jobId>/               — finalized job (atomic dir rename)
// Finalization verifies every artifact hash/size inside staging, writes
// manifest.json, then renames the whole staging directory in one atomic
// operation. Failed/cancelled jobs never produce a finalized directory.
// Pure Node module (fs/path/crypto only) so it is unit-testable.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { isRelativeArtifactPathSafe, resolveInsideRoot } = require("./pathConfinement");

const STAGING_PREFIX = ".incomplete-";
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

class ArtifactStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
    this.details = details;
  }
}

function assertJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    throw new ArtifactStoreError("OUTPUT_PATH_REJECTED", `Invalid job id "${jobId}"`);
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

class RecordingArtifactStore {
  constructor(jobsRoot) {
    if (typeof jobsRoot !== "string" || jobsRoot.length === 0) {
      throw new ArtifactStoreError("OUTPUT_PATH_REJECTED", "jobsRoot is required");
    }
    this.jobsRoot = jobsRoot;
  }

  ensureRoot() {
    fs.mkdirSync(this.jobsRoot, { recursive: true });
    return this.jobsRoot;
  }

  stagingDir(jobId) {
    assertJobId(jobId);
    return path.join(this.jobsRoot, `${STAGING_PREFIX}${jobId}`);
  }

  finalDir(jobId) {
    assertJobId(jobId);
    return path.join(this.jobsRoot, jobId);
  }

  // Fresh staging directory for a job run. Any leftover staging dir from a
  // previous failed/cancelled attempt is removed first.
  createStagingDir(jobId) {
    this.ensureRoot();
    const dir = this.stagingDir(jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  hasFinalizedJob(jobId) {
    try {
      return fs.statSync(this.finalDir(jobId)).isDirectory();
    } catch {
      return false;
    }
  }

  // Verifies each descriptor against the file actually present in staging:
  // path confinement, existence, byte size, and streaming sha256.
  async verifyArtifacts(jobId, descriptors) {
    const staging = this.stagingDir(jobId);
    const failures = [];
    for (const descriptor of descriptors) {
      const rel = descriptor.relativePath;
      if (!isRelativeArtifactPathSafe(rel)) {
        failures.push({ relativePath: rel, reason: "OUTPUT_PATH_REJECTED" });
        continue;
      }
      const resolved = resolveInsideRoot(staging, rel);
      if (!resolved) {
        failures.push({ relativePath: rel, reason: "OUTPUT_PATH_REJECTED" });
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        failures.push({ relativePath: rel, reason: "ARTIFACT_WRITE_FAILED" });
        continue;
      }
      if (!stat.isFile()) {
        failures.push({ relativePath: rel, reason: "ARTIFACT_WRITE_FAILED" });
        continue;
      }
      if (stat.size !== descriptor.bytes) {
        failures.push({
          relativePath: rel,
          reason: "ARTIFACT_HASH_MISMATCH",
          expectedBytes: descriptor.bytes,
          actualBytes: stat.size,
        });
        continue;
      }
      const actualHash = await hashFile(resolved);
      if (actualHash !== descriptor.sha256) {
        failures.push({ relativePath: rel, reason: "ARTIFACT_HASH_MISMATCH" });
      }
    }
    return { ok: failures.length === 0, failures };
  }

  // Writes manifest.json into staging and atomically renames the staging
  // directory to the final job directory. The manifest lists every verified
  // artifact descriptor plus job metadata supplied by the caller.
  async finalizeJob(jobId, { manifest, descriptors }) {
    const staging = this.stagingDir(jobId);
    const final = this.finalDir(jobId);
    if (!fs.existsSync(staging)) {
      throw new ArtifactStoreError("ARTIFACT_WRITE_FAILED", "Staging directory missing", {
        jobId,
      });
    }
    if (fs.existsSync(final)) {
      throw new ArtifactStoreError("ARTIFACT_WRITE_FAILED", "Finalized job already exists", {
        jobId,
      });
    }
    const verification = await this.verifyArtifacts(jobId, descriptors);
    if (!verification.ok) {
      throw new ArtifactStoreError("ARTIFACT_HASH_MISMATCH", "Artifact verification failed", {
        jobId,
        failures: verification.failures,
      });
    }
    const manifestBody = JSON.stringify(
      { ...manifest, artifacts: descriptors },
      null,
      2
    );
    this.writeFileAtomic(staging, "manifest.json", manifestBody);
    fs.renameSync(staging, final);
    return final;
  }

  // Atomic single-file write inside an existing job directory (used for note
  // regeneration artifacts written after the job dir is finalized).
  writeFileAtomic(baseDir, relativePath, content) {
    if (!isRelativeArtifactPathSafe(relativePath)) {
      throw new ArtifactStoreError("OUTPUT_PATH_REJECTED", `Unsafe path "${relativePath}"`);
    }
    const resolvedBase = path.resolve(baseDir);
    const rootRel = path.relative(path.resolve(this.jobsRoot), resolvedBase);
    if (rootRel.startsWith("..") || path.isAbsolute(rootRel)) {
      throw new ArtifactStoreError("OUTPUT_PATH_REJECTED", "Base dir escapes jobs root");
    }
    const target = path.join(resolvedBase, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
    const bytes = Buffer.byteLength(content);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    return { relativePath, sha256, bytes };
  }

  // Removes staging and/or finalized artifacts for a job. Refuses to touch
  // anything outside the jobs root; the external source file lives outside
  // the jobs root by construction and is therefore untouchable from here.
  deleteJobArtifacts(jobId, { keepFinal = false } = {}) {
    assertJobId(jobId);
    const staging = this.stagingDir(jobId);
    fs.rmSync(staging, { recursive: true, force: true });
    if (!keepFinal) {
      const final = this.finalDir(jobId);
      fs.rmSync(final, { recursive: true, force: true });
    }
  }

  // Startup recovery: remove staging directories older than maxAgeMs.
  // Returns the removed directory names.
  cleanupStaleStaging({ maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    let entries;
    try {
      entries = fs.readdirSync(this.jobsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const removed = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
      const full = path.join(this.jobsRoot, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs >= maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
    return removed;
  }

  // Disk usage of a finalized job in bytes (recursive).
  jobDiskUsage(jobId) {
    const dir = this.finalDir(jobId);
    let total = 0;
    const walk = (current) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* removed mid-walk */
          }
        }
      }
    };
    walk(dir);
    return total;
  }

  readArtifact(jobId, relativePath, { maxBytes = 64 * 1024 * 1024 } = {}) {
    const resolved = resolveInsideRoot(this.finalDir(jobId), relativePath);
    if (!resolved) {
      throw new ArtifactStoreError("OUTPUT_PATH_REJECTED", `Unsafe path "${relativePath}"`);
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (error) {
      // Coded error instead of a raw ENOENT (which would surface as an
      // unclassified 500 with a filesystem path over the CLI bridge).
      if (error && error.code === "ENOENT") {
        throw new ArtifactStoreError("AUDIO_FILE_NOT_FOUND", `Artifact not found: ${relativePath}`);
      }
      throw error;
    }
    if (stat.size > maxBytes) {
      throw new ArtifactStoreError("ARTIFACT_WRITE_FAILED", "Artifact exceeds read cap", {
        size: stat.size,
        maxBytes,
      });
    }
    return fs.readFileSync(resolved);
  }
}

module.exports = { RecordingArtifactStore, ArtifactStoreError, hashFile, STAGING_PREFIX };
