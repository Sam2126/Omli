import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

test("rate limit: allow 5 per minute, 6th is 429", async () => {
  const proc = startServer({ PORT: "9092", RATE_LIMIT_PER_MIN: "5" });
  await waitForHealth("http://localhost:9092");

  const base = "http://localhost:9092";
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const code = await postStatus(`${base}/v1/signals`, {
        headers: { "x-api-key": "k" },
        body: { userId: "u1", type: "note", payload: String(i) },
      });
      statuses.push(code);
    }
    const counts = statuses.reduce(
      (acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc),
      {},
    );
    assert.equal(counts[200], 5);
    assert.equal(counts[429], 1);
  } finally {
    proc.kill();
  }
});

test("rate limit is safe under parallel burst for one user", async () => {
  const proc = startServer({ PORT: "9095", RATE_LIMIT_PER_MIN: "5" });
  await waitForHealth("http://localhost:9095");

  const base = "http://localhost:9095";
  try {
    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postStatus(`${base}/v1/signals`, {
          headers: { "x-api-key": "k" },
          body: { userId: "burst-user", type: "note", payload: String(i) },
        }),
      ),
    );

    const counts = statuses.reduce(
      (acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc),
      {},
    );
    assert.equal(counts[200], 5);
    assert.equal(counts[429], 15);
  } finally {
    proc.kill();
  }
});

async function postStatus(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function getStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
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
      const status = await getStatus(`${base}/healthz`);
      if (status === 200) return;
    } catch {
      await wait(100);
    }
  }
  throw new Error(`server did not become healthy: ${base}`);
}
