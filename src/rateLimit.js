const WINDOW_MS = 60_000;
const buckets = new Map();

function getRate() {
  const rate = Number(process.env.RATE_LIMIT_PER_MIN || 5);
  return Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 5;
}

export function checkAndConsume(userId, nowMs = Date.now()) {
  const rate = getRate();
  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const ent = buckets.get(userId) || { windowStart, count: 0 };

  if (ent.windowStart !== windowStart) {
    ent.windowStart = windowStart;
    ent.count = 0;
  }

  ent.count += 1;
  buckets.set(userId, ent);

  const ok = ent.count <= rate;
  const resetMs = ent.windowStart + WINDOW_MS;
  const remaining = Math.max(rate - ent.count, 0);
  return { ok, remaining, resetMs };
}

export function resetRateLimits() {
  buckets.clear();
}
