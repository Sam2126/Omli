import {
  insertSignal,
  insertSignalIdempotent,
  getByIdemKey,
  listSignals,
} from "./db.js";
import { checkAndConsume } from "./rateLimit.js";

function nowMs() {
  return Date.now();
}

const RETRY_ATTEMPTS = Number(process.env.DB_RETRY_ATTEMPTS || 4);
const RETRY_BASE_MS = Number(process.env.DB_RETRY_BASE_MS || 10);
const RETRY_MAX_MS = Number(process.env.DB_RETRY_MAX_MS || 150);
const idemLocks = new Map();

const TRANSIENT_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_IOERR",
  "SQLITE_INTERRUPT",
  "SQLITE_PROTOCOL",
  "SQLITE_FULL",
]);

function isTransientDbError(err) {
  return (
    TRANSIENT_CODES.has(err?.code) || err?.message === "simulated_db_failure"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDbRetry(operation, attempts = RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === attempts) {
        throw err;
      }

      const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * exp);
      await sleep(exp + jitter);
    }
  }
  throw lastError;
}

async function withIdempotencyLock(idemKey, operation) {
  const previous = idemLocks.get(idemKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  idemLocks.set(idemKey, current);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (idemLocks.get(idemKey) === current) {
      idemLocks.delete(idemKey);
    }
  }
}

export async function postSignal(req, reply) {
  const idem = req.headers["idempotency-key"] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === "undefined") {
    return reply.code(400).send({ error: "invalid_body" });
  }

  if (idem) {
    return withIdempotencyLock(idem, async () => {
      try {
        const existing = await withDbRetry(() => getByIdemKey(idem));
        if (existing) return existing;
      } catch (e) {
        req.log.error({ err: e, ctx: "getByIdemKey" });
        return reply.code(503).send({ error: "db_unavailable" });
      }

      const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
      if (!ok)
        return reply
          .code(429)
          .send({ error: "rate_limited", remaining, resetMs });

      try {
        return await withDbRetry(() =>
          insertSignalIdempotent(userId, type, payload, idem, nowMs()),
        );
      } catch (e) {
        req.log.error({ err: e, ctx: "insertSignalIdempotent" });
        return reply.code(503).send({ error: "db_unavailable" });
      }
    });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok)
    return reply.code(429).send({ error: "rate_limited", remaining, resetMs });

  try {
    const t = nowMs();
    const info = await withDbRetry(() =>
      insertSignal(userId, type, payload, null, t),
    );
    return {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: null,
      createdAt: t,
    };
  } catch (e) {
    req.log.error({ err: e, ctx: "insertSignal" });
    return reply.code(503).send({ error: "db_unavailable" });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: "missing_userId" });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withDbRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: "listSignals" });
    return reply.code(503).send({ error: "db_unavailable" });
  }
}
