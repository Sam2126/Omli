# Scale Plan

## Horizontal scaling and load balancing

Run stateless Fastify instances behind an L7 load balancer such as ALB, NGINX, Envoy, or a Kubernetes ingress. Health checks should target `GET /healthz`; failed instances should be removed from rotation quickly. Keep request authentication, validation, idempotency, and rate-limit decisions independent of local process memory so any instance can handle any retry.

## Rate limiting architecture

The local implementation is safe inside one Node.js process because each request consumes from a synchronous per-user fixed-window counter. For multiple instances, move this to Redis using an atomic Lua script or a single `INCR` plus `EXPIRE` transaction keyed by `rate:{userId}:{windowStart}`. Redis Cluster can shard by userId. Return remaining quota and reset time from the same atomic script to avoid races during bursts.

## Idempotency storage

The service stores `idempotency_key` with a database-level unique constraint and uses an atomic insert-or-return-existing pattern. In production, keep this in the primary SQL database or a strongly consistent idempotency table with:

- `idempotency_key` unique
- request fingerprint/hash
- response resource id
- status, created_at, expires_at

Repeated requests should return the original resource. If the same key is reused with a different request fingerprint, return a conflict instead of creating a second record.

## Database indexing and data model

Required indexes:

- Unique index on `idempotency_key`
- Composite index on `(user_id, created_at DESC)` for `GET /v1/signals?userId=...`
- Optional partitioning by `created_at` when retention grows

For high write volume, use PostgreSQL or MySQL instead of SQLite. Use `INSERT ... ON CONFLICT DO NOTHING` / `ON DUPLICATE KEY` plus a follow-up select inside a retryable transaction for idempotent writes.

## Connection pooling

Use a bounded pool per instance. Size it below database capacity, not by traffic peak. For example, with 20 app instances and a database that supports 400 active connections, cap each instance around 10-15 connections and leave headroom for migrations, workers, and admin tasks. Add timeouts so requests fail fast instead of piling up.

## Queue systems

If signal ingestion later triggers heavy downstream work, write the signal synchronously, then enqueue follow-up processing to Kafka, SQS, RabbitMQ, or Redis Streams. The queue consumer should also be idempotent using the signal id as the dedupe key. Keep the POST path small: validate, rate limit, persist, acknowledge.

## Monitoring and observability

Track structured logs with request id, userId, idempotency key hash, status code, latency, and retry count. Export metrics for:

- RPS and latency percentiles
- Rate-limit allowed/blocked counts
- Idempotency hits/misses/conflicts
- DB retry count and failure count
- DB pool saturation
- Queue lag if asynchronous workers are added

Add alerts for elevated 5xx, sustained DB retries, high pool wait time, Redis errors, and p95/p99 latency breaches. Distributed tracing should connect the HTTP request, DB write, Redis calls, and queued jobs.

## Failure recovery

Transient DB errors are retried with exponential backoff and jitter. Idempotent writes are safe to retry because the unique key prevents duplicate resources. If Redis is unavailable, prefer fail-closed for strict rate limits or use a small local emergency limiter with clear alerts, depending on business tolerance. Backups, point-in-time recovery, and migration rollback plans are required for the primary database.

## 10k RPS strategy

At 10k RPS, deploy many small app instances with autoscaling on CPU, event-loop lag, and request latency. Put Redis Cluster in front for shared rate limiting, use a managed SQL database with read replicas for list queries, and keep writes on the primary with proper indexes and pooling. Cache only safe read paths; do not cache idempotent write decisions outside the authoritative store unless the cache operation is atomic and durable enough for the desired guarantee.

Start with an architecture like:

- Load balancer across 20-40 Fastify instances
- Redis Cluster for rate limiting and short-lived idempotency acceleration
- PostgreSQL primary for signal writes, read replica for `GET /v1/signals`
- Kafka/SQS for downstream processing
- OpenTelemetry, Prometheus/Grafana, and centralized logs

Capacity should be verified with load tests that include realistic payload sizes, hot users, duplicate idempotency keys, Redis latency, DB failover, and retry storms.
