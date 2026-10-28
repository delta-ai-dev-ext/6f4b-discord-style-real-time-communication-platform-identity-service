# `identity_service` — Engineering Guide

Persistent technical memory for this service: runtime, libraries and external
provider SDKs, Kubernetes lifecycle, testing strategy, conventions,
configuration, observability, and append-only **Pinned Decisions**.

Architectural behavior (flows, schema, events, failure modes) lives in
`docs/architecture.md`; this file records *how we build it*.

---

## Runtime & Toolchain

| Item | Choice | Notes |
|---|---|---|
| Language | TypeScript (`strict: true`, `ES2020+`, `moduleResolution: bundler`) | ES modules only — never CommonJS |
| Runtime | Bun (only) | All execution via `bun`; never `node` |
| Package manager | `bun` | `bun add` / `bun add -d`; never `npm`/`yarn` |
| Config in tsconfig | `"strict": true` | No `any`-leaks across module boundaries |
| Framework | Elysia | Bun-native HTTP framework |

**Makefile targets**

| Target | Command | Purpose |
|---|---|---|
| `dev` | `bun --watch src/index.ts` | local run with reload |
| `test` | `bun test --coverage` | unit + integration, coverage ≥ 80% |
| `lint` | `bun x eslint src/ tests/` | zero-error gate |
| `run` | `bun run src/index.ts` | production entrypoint |
| `build` | `docker build -t identity_service:latest .` | image build (`oven/bun:1` → `oven/bun:1-slim`, `--frozen-lockfile`, non-root user, `--smol`) |
| `migrate` | `bun x drizzle-kit migrate` | apply PostgreSQL migrations |

---

## Libraries & External Provider SDKs

The Coding Agent resolves latest stable versions with `bun add` (no hardcoded
versions here; see Pinned Decisions for anything pinned).

| Concern | Package / Library | Source | Usage Notes |
|---|---|---|---|
| HTTP framework | `elysia` | language-skill | Bun-native router + typed handlers; raw body must be preserved for the webhook route |
| Validation (runtime) | `zod` | language-skill | All request bodies, query params, path params, and env config; validate at system boundaries only |
| PostgreSQL ORM | `drizzle-orm` | language-skill | Type-safe schema in `src/db/schema.ts`; `uuid`, `text`, `timestamp`, `pgEnum`, partial indexes for the pending-pair/queries |
| PostgreSQL driver | `pg` | language-skill | Connection pool from `DATABASE_URL`; transactions for friend lifecycle + outbox writes |
| DB migrations | `drizzle-kit` | tech-lead-research | Migration companion for drizzle-orm; SQL migrations committed to the repo |
| Kafka client | `kafkajs` | language-skill | Producer only; idempotent producer enabled; `recipient_user_id` as message key for `identity_friend_events` |
| Clerk integration | `@clerk/backend` | tech-lead-research | Offline JWT verification (`verifyToken` with the published public key — no Backend API secret needed); webhook verification via the `@clerk/backend/webhooks` subpath (`verifyWebhook`, reads `CLERK_WEBHOOK_SIGNING_SECRET`) — this is the Clerk-recommended path; do **not** add the generic `svix` package |
| Logging | `winston` | language-skill | JSON format to stdout; levels `error/warn/info/debug`; never `console.log` |
| Metrics | `prom-client` | language-skill | Registry with the metrics defined in `docs/architecture.md` §7; `/metrics` endpoint |
| Testing | `bun:test` | language-skill | Only test runner; coverage via `bunfig.toml` |
| Mocking | `mock()` from `bun:test` | language-skill | Reset all mocks after each test |
| Date utilities | `date-fns` | language-skill | Webhook timestamp comparisons, rate-limit windows |
| Random IDs | `crypto.getRandomValues()` (Bun/Web standard) | language-skill | UUID v4 formatting from 16 random bytes for `request_id`/`event_id`; **never** the `uuid` npm package |
| HTTP client | `fetch` (Bun native) | language-skill | Only for non-request-path needs (e.g. readiness self-check in tests); no outbound Clerk/HTTP calls in the request path |

Forbidden anywhere in this service: `uuid`, `dotenv` in production, `axios`,
`lodash`, NodeJS-specific `crypto`/`stream`/`fs`/`path` imports, Jest/Vitest/Mocha.

---

## Kubernetes Lifecycle & Probes

**Statelessness rules**

- No durable state in the pod: all persistence is PostgreSQL + Kafka. No local
  disk, no in-memory session store, no leader election.
- The outbox worker is safe to run on every replica (`SELECT … FOR UPDATE
  SKIP LOCKED` row claiming) — replicas never double-publish an outbox row.
- Any pod can be killed at any time; correctness must not depend on
  cooperative shutdown (the outbox ledger + idempotent consumers guarantee it).

**Graceful shutdown (`SIGTERM` / `SIGINT`)**

1. Stop the HTTP listener from accepting new connections; existing requests
   finish within the termination grace period.
2. Stop the outbox worker polling loop; give an in-flight publish attempt a
   short drain window, then abandon it (the row stays pending for the next pod).
3. Flush and close the Kafka producer.
4. Close the PostgreSQL pool.
5. Exit `0`. Never lose a committed outbox event on shutdown.

**Probes**

| Probe | Route | Behavior |
|---|---|---|
| Liveness | `GET /healthz` | `200 {status:"ok"}` while the event loop is responsive — deliberately no dependency checks, so a slow DB never causes a restart loop |
| Readiness | `GET /readyz` | `200` only when a PostgreSQL round-trip succeeds **and** the Kafka producer reports connected; otherwise `503 {status:"degraded"}` and the pod leaves rotation |

---

## Testing Strategy

- **Structure:** `tests/unit/` for services and pure logic (state machine,
  claim mapping, event payload building); `tests/integration/` for repository
  + transaction behavior against a real PostgreSQL; `tests/mocks/` for
  shared stubs and fixtures.
- **Runner:** `bun test --coverage` only; thresholds (80% line/branch/function)
  enforced via `bunfig.toml`; fully deterministic — no real clocks, no network.
- **PostgreSQL:** integration tests connect to an ephemeral database provided
  by the test harness (CI service container / local `docker` compose) via
  `DATABASE_URL`; migrations are applied before the suite; each test runs in a
  transaction that is rolled back for isolation.
- **Kafka:** the producer is behind a narrow interface; tests inject a fake
  producer that records `topic`, `key`, `value`, `headers`. The outbox worker
  is tested against the fake producer: pending rows → published rows, retry
 /backoff, dead-letter marking. No real broker in unit/integration suites.
- **Clerk:** `verifyToken` and `verifyWebhook` are stubbed with `mock()`;
  fixtures provide valid/invalid claims, expired tokens, missing signatures,
  replayed message ids, and `user.created/updated/deleted` payloads. Real
  signature-verification logic is covered in one integration test with a
  generated signing secret to guard against wiring mistakes.
- **Webhook HTTP contract:** integration tests post raw bodies with computed
  Svix headers to the real handler to prove the raw-body requirement works.
- **Mocks are always reset** after each test (`afterEach(() => mock.restore())`).

---

## Coding Conventions & Project Structure

**Layering (strict, one direction):** `routes` → `controllers` → `services` →
`repositories` → db. Controllers are thin (validate, delegate, map errors);
services hold business rules and never import HTTP or DB driver types;
repositories own SQL and transaction boundaries.

```
src/
├── index.ts                  # Elysia app factory + graceful shutdown wiring
├── config.ts                 # zod-validated env (see below)
├── routes/                   # route definitions per resource (users, friend-requests, friends, webhooks, health)
├── controllers/              # request handling, delegates to services
├── services/                 # ProfileService, FriendService, EventMapper
├── repositories/             # one repo per table; transactions live here
├── models/                   # zod schemas + TS types (domain + API DTOs)
├── auth/                     # Clerk JWT verification middleware, claim extraction
├── webhooks/                 # Clerk webhook controller (raw body + signature verification)
├── events/                   # outbox worker, Kafka producer wrapper, event builders
├── db/                       # drizzle schema, pool, migrations config
└── observability/            # winston logger, prom-client registry, trace helpers
tests/
├── unit/  ├── integration/  └── mocks/
```

**Conventions**

- API fields `snake_case` (as in the OpenAPI spec); TypeScript identifiers
  `camelCase`; schema/DTO names `PascalCase`; `operationId`-style function
  names for exported service methods.
- Errors: services throw typed domain errors carrying a stable `code`; the
  HTTP layer maps them to the platform contract
  `{error: {code, message, details?}}` — never mixed shapes, never leaked
  stack traces (see `docs/openapi_spec.yaml` → `ErrorResponse`).
- IDs: never parse or trust client-supplied user identity — the caller is
  always the verified JWT subject; `user_id` path parameters are always
  compared against verified values.
- Time: store `timestamptz`; compare with `date-fns`; never use local clocks
  in business logic.
- No inline SQL string interpolation of user input — drizzle query builder
  everywhere.
- Prefer additive changes to public types/endpoints (extension over breaking
  changes).

---

## Configuration & Secrets Management

12-factor: all configuration comes from the environment, validated at startup
with a zod schema (fail fast on boot, never at first request). No `.env`
loading in production.

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | HTTP listen port (default `8080`) |
| `LOG_LEVEL` | no | `debug\|info\|warn\|error` (default `info`) |
| `DATABASE_URL` | **yes** | Portable PostgreSQL DSN (own logical database) |
| `KAFKA_BROKERS` | **yes** | Comma-separated broker list |
| `KAFKA_CLIENT_ID` | no | Defaults to `identity_service` |
| `KAFKA_SSL` | no | `true` for TLS to the broker (production default) |
| `CLERK_JWT_KEY` | **yes** | Clerk published public key (PEM) for offline session-JWT verification; rotate via redeploy |
| `CLERK_WEBHOOK_SIGNING_SECRET` | **yes** | Svix signing secret for `POST /v1/webhooks/clerk` (`whsec_…`) |
| `OUTBOX_POLL_INTERVAL_MS` | no | Outbox worker poll cadence (default `100`) |
| `OUTBOX_BATCH_SIZE` | no | Rows claimed per poll (default `100`) |
| `OUTBOX_MAX_ATTEMPTS` | no | Retry budget before dead-letter (default `10`) |
| `FRIEND_REQUEST_RATE_LIMIT_PER_MINUTE` | no | Per-pod token-bucket size (default `20`) |
| `METRICS_PORT` | no | Separate port for `GET /metrics` when ingress must not expose it |

Rules:

- Secrets (`CLERK_WEBHOOK_SIGNING_SECRET`, DB credentials inside `DATABASE_URL`)
  come from Kubernetes secrets only; never logged, never echoed in errors.
- Topic name `identity_friend_events` is a platform contract, not a config
  knob — it is a constant in code.

---

## Observability & Logging Conventions

- **Structured JSON logs** to stdout: `timestamp`, `level`, `service`
  (`identity_service`), `route`, `method`, `status_code`, `trace_id`,
  `error_code`. Never log raw JWTs, Svix signatures, or emails at `info`.
- **Trace propagation:** read W3C `traceparent` from inbound HTTP requests;
  include it as `trace_id` in every log line; store it in
  `outbox_event.headers`; publish it in the event envelope (`trace_parent`)
  so `notification_service` and `realtime_gateway` continue the trace.
- **Metrics** (registered at startup, exposed via `prom-client`; low-
  cardinality labels only — never ids or timestamps):
  `identity_friend_requests_total{outcome}`,
  `identity_username_lookups_total{result}`,
  `identity_users_synced_total{event}`,
  `http_request_duration_seconds{route,method,status_class}`,
  `identity_clerk_webhook_failures_total{reason}`,
  `kafka_produce_errors_total{topic}`,
  `identity_outbox_events_pending{topic}`,
  `identity_outbox_events_dead_lettered_total{topic}`.
- SLO reference for dashboards: API p95 < 150 ms; 99.9% availability; webhook
  processing success ≥ 99.9% (see `docs/architecture.md` §7).

---

## Pinned Decisions

Append-only. Existing rows are preserved unless explicitly invalidated by a
user request; changed preferences apply only to new choices.

| Dependency / Area | Pin / Constraint | Rationale | Added By | Date |
|---|---|---|---|---|
| Runtime | Bun only — never `node`; ES modules only | Platform standard for all TypeScript services; Bun-native perf and APIs | tech-lead (language-skill) | 2025-01-15 |
| Clerk integration | `@clerk/backend` — offline `verifyToken` with `CLERK_JWT_KEY`; webhook verification via `@clerk/backend/webhooks` (`verifyWebhook`), **not** the generic `svix` package; no `createClerkClient`/Backend API secret in the request path | Official, actively maintained SDK; Clerk documents this exact verification path; service makes no outbound Clerk calls (SYSTEM_DESIGN §4.1) | tech-lead-research | 2025-01-15 |
| Event publication | Transactional outbox table (`outbox_event`) for all `identity_friend_events` — no inline publishing after commit | Dual-write consistency between PostgreSQL state and Kafka (ADR-002) | tech-lead | 2025-01-15 |
| Profile mirror consistency | Lazy upsert from verified JWT claims (`sub`, `username`, `email`) as the fallback for missed webhooks; never overwrites webhook-maintained fields | Self-healing mirror without a reconciliation job (ADR-001) | tech-lead | 2025-01-15 |
| Kafka contract | Topic `identity_friend_events`, partition key `recipient_user_id`, platform envelope `{event_id, event_type, occurred_at, producer, version, trace_parent, data}`; consumers dedupe by `event_id` | Cross-service contract from SYSTEM_DESIGN §5 — must not drift per-service | tech-lead | 2025-01-15 |
| Friend lifecycle transactions | Request transition + friendship write + event row always commit in one PostgreSQL transaction | Friendship and its events can never diverge (ADR-002 consequence) | tech-lead | 2025-01-15 |
| Soft-delete semantics | `user_profile.deleted_at` soft-delete; username stays reserved but unsearchable; pending requests cancelled on `user.deleted` | Matches Clerk `user.deleted` semantics and lookup rules in SYSTEM_DESIGN §4.1 | tech-lead | 2025-01-15 |
