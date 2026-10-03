import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

test("idempotency returns same resource for same key", async () => {
  const proc = startServer({ PORT: "9091" });
  await waitForHealth("http://localhost:9091");

  const base = "http://localhost:9091";
  const idem = "same-key";

  try {
    const a = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u1", type: "note", payload: "x" },
    });
    const b = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u1", type: "note", payload: "x" },
    });

    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(a.body.id, b.body.id);
    assert.equal(a.body.idempotencyKey, b.body.idempotencyKey);
  } finally {
    proc.kill();
  }
});

test("concurrent requests with one idempotency key create one signal", async () => {
  const proc = startServer({ PORT: "9093", RATE_LIMIT_PER_MIN: "1" });
  await waitForHealth("http://localhost:9093");

  const base = "http://localhost:9093";
  const idem = "parallel-key";

  try {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        postJson(`${base}/v1/signals`, {
          headers: { "x-api-key": "k", "Idempotency-Key": idem },
          body: { userId: "u-concurrent", type: "note", payload: "x" },
        }),
      ),
    );

    assert.ok(responses.every((res) => res.statusCode === 200));
    assert.equal(new Set(responses.map((res) => res.body.id)).size, 1);

    const listed = await getJson(
      `${base}/v1/signals?userId=u-concurrent&limit=50`,
      {
        "x-api-key": "k",
      },
    );
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.items.length, 1);
  } finally {
    proc.kill();
  }
});

test("idempotency retry returns the same resource even after rate limit is exhausted", async () => {
  const proc = startServer({ PORT: "9094", RATE_LIMIT_PER_MIN: "1" });
  await waitForHealth("http://localhost:9094");

  const base = "http://localhost:9094";
  const idem = "retry-after-limit";

  try {
    const first = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u-retry", type: "note", payload: "x" },
    });
    const second = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u-retry", type: "note", payload: "x" },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.id, second.body.id);
  } finally {
    proc.kill();
  }
});

test("transient database failures are retried without duplicate idempotent rows", async () => {
  const proc = startServer({
    PORT: "9096",
    RATE_LIMIT_PER_MIN: "100",
    DB_FAIL_RATE: "0.5",
    DB_RETRY_ATTEMPTS: "10",
    DB_RETRY_BASE_MS: "1",
    DB_RETRY_MAX_MS: "20",
  });
  await waitForHealth("http://localhost:9096");

  const base = "http://localhost:9096";
  const idem = "db-retry-key";

  try {
    const first = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u-db-retry", type: "note", payload: "x" },
    });
    const second = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u-db-retry", type: "note", payload: "x" },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.id, second.body.id);
  } finally {
    proc.kill();
  }
});

async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => (chunks += d));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(chunks || "{}"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
      let chunks = "";
      res.on("data", (d) => (chunks += d));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(chunks || "{}"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function startServer(env) {
  const dbPath = path.join(
    os.tmpdir(),
    `signals-${env.PORT}-${Date.now()}-${Math.random()}.db`,
  );
  return spawn("node", ["src/server.js"], {
    env: { ...process.env, API_KEY: "k", DATABASE_URL: dbPath, ...env },
  });
}

async function waitForHealth(base) {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await getJson(`${base}/healthz`, {});
      if (res.statusCode === 200) return;
    } catch {
      await wait(100);
    }
  }
  throw new Error(`server did not become healthy: ${base}`);
}
