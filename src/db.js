import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath = process.env.DATABASE_URL || "./data/signals.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
`);

// failure simulation
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error("simulated_db_failure");
    err.code = "SQLITE_BUSY";
    throw err;
  }
}

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const stmt = db.prepare(
    "INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)",
  );
  return stmt.run(userId, type, String(payload), idemKey || null, nowMs);
}

export function insertSignalIdempotent(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)",
  );
  insert.run(userId, type, String(payload), idemKey, nowMs);

  const row = getByIdemKey(idemKey);
  if (!row) {
    const err = new Error("idempotency_resolution_failed");
    err.code = "SQLITE_BUSY";
    throw err;
  }
  return row;
}

export function getByIdemKey(idemKey) {
  maybeFail();
  const stmt = db.prepare(
    "SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?",
  );
  return stmt.get(idemKey);
}

export function listSignals(userId, limit) {
  maybeFail();
  const stmt = db.prepare(
    "SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  );
  return stmt.all(userId, limit);
}
