# identity_service

Platform identity mirror and friend domain owner: Clerk profile mirror,
username/batch lookups, friend-request lifecycle, friendships, and the
`identity_friend_events` producer. Authentication is owned by Clerk; this
service only verifies session JWTs offline.

Specifications live in [`docs/`](./docs): `architecture.md` (behavior, DDL,
events, metrics), `openapi_spec.yaml` (API contract), `user_stories.md`
(acceptance criteria), `engineering_guide.md` (stack, conventions, config,
pinned decisions) and `docs/decisions/` (ADRs 001–002).

## Stack

TypeScript on Bun (ESM, `strict`) · Elysia · zod · drizzle-orm + `pg` ·
drizzle-kit migrations · kafkajs (producer only, idempotent) · winston ·
prom-client · `bun:test`.

## Layout

```
src/
├── index.ts          # runtime wiring: config → db → producer → HTTP + shutdown
├── app.ts            # Elysia app factory (routes, auth, error mapping, metrics)
├── config.ts         # zod-validated env (fail fast)
├── routes/           # route composition lives in app.ts (thin controllers)
├── controllers/      # validate → delegate → map results
├── services/         # business rules: profile, friend state machine, events
├── repositories/     # ports + drizzle adapters (transactions live here)
├── models/           # zod DTOs, domain records, typed domain errors
├── auth/             # offline Clerk JWT verification + claim mapping
├── webhooks/         # Svix-verified Clerk webhook ingestion
├── events/           # Kafka producer wrapper + outbox worker
├── db/               # drizzle schema, pool, migrations
└── observability/    # winston logger, prom-client metrics, trace context
tests/
├── unit/  ├── integration/  └── mocks/
```

## Commands

```bash
make dev           # bun --watch src/index.ts
make test          # bun test --coverage (unit + integration, ≥80% gate)
make lint          # bun x eslint src/ tests/
make typecheck     # bun x tsc --noEmit
make run           # bun run src/index.ts
make migrate       # bun x drizzle-kit migrate (needs DATABASE_URL)
make generate      # bun x drizzle-kit generate
make build         # docker build -t identity_service:latest .
```

## Configuration

Validated at boot with zod; the pod fails fast on missing/invalid values.

| Variable | Required | Default |
|---|---|---|
| `DATABASE_URL` | yes | — |
| `KAFKA_BROKERS` | yes | — |
| `CLERK_JWT_KEY` | yes | — |
| `CLERK_WEBHOOK_SIGNING_SECRET` | yes | — |
| `PORT` | no | `8080` |
| `LOG_LEVEL` | no | `info` |
| `KAFKA_CLIENT_ID` | no | `identity_service` |
| `KAFKA_SSL` | no | `false` |
| `OUTBOX_POLL_INTERVAL_MS` | no | `100` |
| `OUTBOX_BATCH_SIZE` | no | `100` |
| `OUTBOX_MAX_ATTEMPTS` | no | `10` |
| `FRIEND_REQUEST_RATE_LIMIT_PER_MINUTE` | no | `20` |
| `METRICS_PORT` | no | unset (metrics served on `GET /metrics`) |

## Operations

- `GET /healthz` — liveness only, never touches dependencies.
- `GET /readyz` — `200` only when a PostgreSQL round-trip succeeds **and** the
  Kafka producer is connected; `503 {"status":"degraded"}` otherwise.
- Graceful `SIGTERM`/`SIGINT`: stop intake (new `/v1/*` requests get `503`) →
  drain the outbox worker → flush/close the Kafka producer → close the DB pool.
- Friend events are published only by the in-process outbox worker
  (`SELECT … FOR UPDATE SKIP LOCKED`, exponential backoff, dead-letter after
  `OUTBOX_MAX_ATTEMPTS`).

## Tests

`bun test --coverage` runs unit suites (services, state machine, event builders,
claim mapping, config, cursor, metrics, worker) plus integration suites that
apply the real drizzle migrations to an embedded PostgreSQL (PGlite) and drive
the full HTTP stack — including Svix-signed webhook deliveries and outbox
draining. Set `DATABASE_URL` only if you additionally run `drizzle-kit migrate`
against a real server.
