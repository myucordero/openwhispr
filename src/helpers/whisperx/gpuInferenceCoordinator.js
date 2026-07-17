// Exclusive GPU lease coordinator (spec 02 §7, 08 §4).
// One heavy GPU workload at a time: WhisperX worker stages and local
// llama.cpp note generation both acquire a lease before touching the GPU.
// FIFO queue, cancellable while queued, heartbeat deadline on the holder so
// a crashed owner cannot wedge the pipeline. Pure module — the caller wires
// llama stop/start and worker kill callbacks; time is injectable for tests.

class GpuLeaseCancelledError extends Error {
  constructor(message = "GPU lease request cancelled") {
    super(message);
    this.name = "GpuLeaseCancelledError";
    this.code = "GPU_LEASE_CANCELLED";
  }
}

class GpuInferenceCoordinator {
  constructor({
    staleMs = 10 * 60 * 1000,
    checkIntervalMs = 30 * 1000,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    onStaleLease = null,
    logger = null,
  } = {}) {
    this.staleMs = staleMs;
    this.checkIntervalMs = checkIntervalMs;
    this._now = now;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._onStaleLease = onStaleLease;
    this._logger = logger;

    this._holder = null; // { ownerId, label, acquiredAt, lastTouchAt, lease }
    this._queue = []; // [{ ownerId, label, resolve, reject }]
    this._watchdog = null;
    this._leaseSeq = 0;
  }

  // Acquire the exclusive lease. Resolves with a lease object:
  //   { id, ownerId, touch(), release() }
  // Rejects with GpuLeaseCancelledError if cancelled while queued.
  acquire(ownerId, { label = "" } = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ ownerId, label, resolve, reject });
      this._pump();
    });
  }

  // Removes every queued (not yet granted) request for this owner.
  // Returns how many were cancelled. Does not touch a granted lease.
  cancelPending(ownerId) {
    let cancelled = 0;
    this._queue = this._queue.filter((entry) => {
      if (entry.ownerId !== ownerId) return true;
      entry.reject(new GpuLeaseCancelledError());
      cancelled += 1;
      return false;
    });
    return cancelled;
  }

  // Force-release the current lease no matter who holds it (crash recovery,
  // app shutdown). Returns true when something was released.
  forceRelease(reason = "forced") {
    if (!this._holder) return false;
    this._log("warn", `GPU lease force-released (${reason})`, {
      ownerId: this._holder.ownerId,
      label: this._holder.label,
    });
    this._holder = null;
    this._pump();
    return true;
  }

  currentHolder() {
    if (!this._holder) return null;
    return {
      ownerId: this._holder.ownerId,
      label: this._holder.label,
      acquiredAt: this._holder.acquiredAt,
      lastTouchAt: this._holder.lastTouchAt,
    };
  }

  queueLength() {
    return this._queue.length;
  }

  isIdle() {
    return this._holder === null && this._queue.length === 0;
  }

  dispose() {
    if (this._watchdog) {
      this._clearInterval(this._watchdog);
      this._watchdog = null;
    }
    const pending = this._queue;
    this._queue = [];
    for (const entry of pending) {
      entry.reject(new GpuLeaseCancelledError("coordinator disposed"));
    }
    this._holder = null;
  }

  // Test hook / manual sweep: releases the lease if the holder went silent
  // longer than staleMs. Returns true when a stale lease was cleared.
  sweepStale() {
    if (!this._holder) return false;
    const silentFor = this._now() - this._holder.lastTouchAt;
    if (silentFor < this.staleMs) return false;
    const holder = this.currentHolder();
    this._log("warn", "Stale GPU lease cleared by watchdog", holder);
    this._holder = null;
    if (typeof this._onStaleLease === "function") {
      try {
        this._onStaleLease(holder);
      } catch (error) {
        this._log("error", "onStaleLease callback failed", { error: error.message });
      }
    }
    this._pump();
    return true;
  }

  _pump() {
    if (this._holder || this._queue.length === 0) {
      this._maybeStopWatchdog();
      return;
    }
    const entry = this._queue.shift();
    const id = ++this._leaseSeq;
    const holder = {
      ownerId: entry.ownerId,
      label: entry.label,
      acquiredAt: this._now(),
      lastTouchAt: this._now(),
    };
    const lease = {
      id,
      ownerId: entry.ownerId,
      touch: () => {
        if (this._holder && this._holder.lease === lease) {
          this._holder.lastTouchAt = this._now();
        }
      },
      release: () => {
        if (this._holder && this._holder.lease === lease) {
          this._holder = null;
          this._pump();
          return true;
        }
        return false; // already released / superseded by watchdog
      },
    };
    holder.lease = lease;
    this._holder = holder;
    this._ensureWatchdog();
    entry.resolve(lease);
  }

  _ensureWatchdog() {
    if (this._watchdog || !this._setInterval) return;
    this._watchdog = this._setInterval(() => this.sweepStale(), this.checkIntervalMs);
    if (this._watchdog && typeof this._watchdog.unref === "function") {
      this._watchdog.unref();
    }
  }

  _maybeStopWatchdog() {
    if (this._watchdog && !this._holder && this._queue.length === 0) {
      this._clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  _log(level, message, meta) {
    if (this._logger && typeof this._logger[level] === "function") {
      this._logger[level](message, meta);
    }
  }
}

module.exports = { GpuInferenceCoordinator, GpuLeaseCancelledError };
