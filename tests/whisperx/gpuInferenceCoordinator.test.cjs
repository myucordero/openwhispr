// Unit tests for the exclusive GPU lease coordinator
// (src/helpers/whisperx/gpuInferenceCoordinator.js).
//
// Time is fully injected: a manual clock supplies `now` and fake
// setInterval/clearInterval so the watchdog never fires on its own and NO real
// timers are created. Every stale sweep is driven explicitly via sweepStale().

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GpuInferenceCoordinator,
  GpuLeaseCancelledError,
} = require("../../src/helpers/whisperx/gpuInferenceCoordinator.js");

// A deterministic clock. `setInterval` records the callback but never invokes
// it — the coordinator's watchdog stays inert unless a test calls sweepStale().
function makeClock() {
  let t = 0;
  const intervals = new Set();
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      intervals.add(handle);
      return handle;
    },
    clearInterval: (handle) => {
      intervals.delete(handle);
    },
    liveIntervals: () => intervals.size,
  };
}

function makeCoordinator(clock, opts = {}) {
  return new GpuInferenceCoordinator({
    now: clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    ...opts,
  });
}

test("fresh coordinator snapshots: idle, no holder, empty queue", () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock);
  assert.equal(coord.isIdle(), true);
  assert.equal(coord.currentHolder(), null);
  assert.equal(coord.queueLength(), 0);
});

test("FIFO: three acquires resolve in order as each holder releases", async () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock);
  const order = [];

  const p1 = coord.acquire("A").then((l) => {
    order.push("A");
    return l;
  });
  const p2 = coord.acquire("B").then((l) => {
    order.push("B");
    return l;
  });
  const p3 = coord.acquire("C").then((l) => {
    order.push("C");
    return l;
  });

  // Only the first request is granted; the rest queue behind it.
  const leaseA = await p1;
  assert.deepEqual(order, ["A"]);
  assert.equal(coord.currentHolder().ownerId, "A");
  assert.equal(coord.queueLength(), 2);

  assert.equal(leaseA.release(), true);
  const leaseB = await p2;
  assert.deepEqual(order, ["A", "B"]);
  assert.equal(coord.currentHolder().ownerId, "B");
  assert.equal(coord.queueLength(), 1);

  assert.equal(leaseB.release(), true);
  const leaseC = await p3;
  assert.deepEqual(order, ["A", "B", "C"]);
  assert.equal(coord.queueLength(), 0);

  assert.equal(leaseC.release(), true);
  assert.equal(coord.isIdle(), true);
});

test("only one holder at a time; currentHolder exposes label + timestamps", async () => {
  const clock = makeClock();
  clock.advance(1000);
  const coord = makeCoordinator(clock);

  const lease = await coord.acquire("owner-1", { label: "whisperx:job-1" });
  coord.acquire("owner-2"); // queued, must not become a second holder
  const holder = coord.currentHolder();
  assert.equal(holder.ownerId, "owner-1");
  assert.equal(holder.label, "whisperx:job-1");
  assert.equal(holder.acquiredAt, 1000);
  assert.equal(holder.lastTouchAt, 1000);
  assert.equal(coord.queueLength(), 1);
  assert.equal(coord.isIdle(), false);

  lease.release();
  coord.dispose(); // reject the still-queued owner-2 cleanly
});

test("cancelPending rejects a queued request without disturbing the holder", async () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock);

  const leaseA = await coord.acquire("A");
  const p2 = coord.acquire("B");
  const p3 = coord.acquire("C");
  const rejected = assert.rejects(
    p2,
    (e) => e instanceof GpuLeaseCancelledError && e.code === "GPU_LEASE_CANCELLED"
  );

  const cancelled = coord.cancelPending("B");
  assert.equal(cancelled, 1);
  await rejected;

  // Holder untouched, and C is still queued.
  assert.equal(coord.currentHolder().ownerId, "A");
  assert.equal(coord.queueLength(), 1);

  // Releasing the holder grants C (not the cancelled B).
  leaseA.release();
  const leaseC = await p3;
  assert.equal(leaseC.ownerId, "C");
  leaseC.release();
});

test("release() returns false on double-release", async () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock);
  const lease = await coord.acquire("A");
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.equal(coord.isIdle(), true);
});

test("forceRelease grants the lease to the next queued request", async () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock);

  // No holder -> nothing to force-release.
  assert.equal(coord.forceRelease(), false);

  await coord.acquire("A");
  const p2 = coord.acquire("B");
  assert.equal(coord.forceRelease("crash-recovery"), true);
  const leaseB = await p2;
  assert.equal(leaseB.ownerId, "B");
  leaseB.release();
});

test("sweepStale clears a silent holder, fires onStaleLease, and grants the next", async () => {
  const clock = makeClock();
  const staleCalls = [];
  const coord = makeCoordinator(clock, {
    staleMs: 1000,
    onStaleLease: (holder) => staleCalls.push(holder),
  });

  await coord.acquire("A", { label: "stuck" });
  const p2 = coord.acquire("B");

  // Not yet stale.
  clock.advance(999);
  assert.equal(coord.sweepStale(), false);
  assert.equal(coord.currentHolder().ownerId, "A");

  // Crosses the stale threshold.
  clock.advance(1);
  assert.equal(coord.sweepStale(), true);
  assert.equal(staleCalls.length, 1);
  assert.equal(staleCalls[0].ownerId, "A");
  assert.equal(staleCalls[0].label, "stuck");

  // The queued request is now granted.
  const leaseB = await p2;
  assert.equal(leaseB.ownerId, "B");
  leaseB.release();
});

test("touch() resets the heartbeat so a stale sweep is a no-op", async () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock, { staleMs: 1000 });

  const lease = await coord.acquire("A");
  clock.advance(900);
  lease.touch(); // lastTouchAt := 900
  clock.advance(900); // now 1800, but only 900 since the last touch
  assert.equal(coord.sweepStale(), false);
  assert.equal(coord.currentHolder().ownerId, "A");
  lease.release();
});

test("dispose rejects every queued request and clears the holder", async () => {
  const clock = makeClock();
  const coord = makeCoordinator(clock);

  await coord.acquire("A"); // holder (already resolved, unaffected)
  const p2 = coord.acquire("B");
  const p3 = coord.acquire("C");
  const r2 = assert.rejects(
    p2,
    (e) => e instanceof GpuLeaseCancelledError && /disposed/.test(e.message)
  );
  const r3 = assert.rejects(p3, (e) => e instanceof GpuLeaseCancelledError);

  coord.dispose();
  await r2;
  await r3;

  assert.equal(coord.currentHolder(), null);
  assert.equal(coord.queueLength(), 0);
  assert.equal(coord.isIdle(), true);
  assert.equal(clock.liveIntervals(), 0); // watchdog interval cleared
});
