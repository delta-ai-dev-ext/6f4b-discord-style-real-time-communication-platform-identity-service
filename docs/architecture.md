# `identity_service` — Service Architecture

**Runtime:** TypeScript (Bun) · **PostgreSQL:** yes (own logical DB) · **Kafka:** producer only · **S3:** not used
**External provider:** Clerk (inbound webhooks + offline JWT verification — no outbound Clerk calls in the request path)

`identity_service` is the platform's local mirror of Clerk identities and the
owner of the friend domain. It never performs authentication: clients sign in
through Clerk, and every request carries a Clerk session JWT that this service
verifies offline against Clerk's published public key. The service exists to
(a) keep a queryable profile mirror, (b) resolve usernames and batch profiles,
(c) manage the friend-request/friendship lifecycle, and (d) emit friend events
for email notification and live UI updates.

This document is the clean architectural specification and the source of truth
for the Diagram Agent. Library and tooling choices live in
`docs/engineering_guide.md`.

---

## 1. Service Responsibilities

| Responsibility | Notes |
|---|---|
| Profile mirror of Clerk users | Keyed by Clerk user id; username, display name, avatar URL, primary email, soft-delete flag. Synced from Clerk webhooks; lazily bootstrapped from JWT claims (ADR-001). |
| Exact username lookup | Case-insensitive exact match, for adding friends. |
| Batch profile lookup | Up to 100 ids per call; used to render authors and member lists. |
| Friend-request lifecycle | Send, accept, decline, cancel — with strict role checks (sender vs recipient) and clear error codes. |
| Friendship management | List and remove friendships (unordered pair). |
| Friend domain events | Produces `identity_friend_events` for `notification_service` (email) and `realtime_gateway` (live updates). |

**Non-goals (per SYSTEM_DESIGN):** no authentication/registration flows (Clerk
owns sign-up/sign-in), no synchronous outbound calls to any other service, no
DMs or direct calls (MVP exclusion), no message reporting.

---

## 2. Internal Components

```
                    ┌────────────────────────────────────────────────────────┐
 Ingress (K8s) ───► │ HTTP layer (router, thin controllers)                  │
                    │  ├── auth middleware ── offline Clerk JWT verification │
                    │  │                                     (JWKS public key)│
                    │  ├── /v1/webhooks/clerk ── Svix signature verification │
                    │  └── /healthz, /readyz                                  │
                    ├────────────────────────────────────────────────────────┤
                    │ Services (business rules, no I/O)                      │
                    │  ├── ProfileService  (mirror sync, lookups, batch)     │
                    │  ├── FriendService   (request lifecycle, friendships)  │
                    │  └── EventMapper     (domain state → event payloads)   │
                    ├────────────────────────────────────────────────────────┤
                    │ Repositories (PostgreSQL access, no business logic)    │
                    │  user_profile · friend_request · friendship ·          │
                    │  processed_webhook · outbox_event                      │
                    ├────────────────────────────────────────────────────────┤
                    │ Outbox worker (in-process) ──► Kafka producer ───────► │ identity_friend_events
                    └────────────────────────────────────────────────────────┘
```

Component boundaries and rules:

- **HTTP layer.** Thin controllers: parse/validate input, resolve the
  authenticated `user_id` from the verified JWT, delegate to services, map
  service errors to the platform error contract
  (`{error: {code, message, details?}}`). The Clerk webhook route is separate:
  it authenticates by signature, not by JWT, and must receive the raw body.
- **Auth middleware.** Verifies the Clerk session JWT offline (JWKS/public
  key) on every `/v1/*` route except the webhook. Extracts `sub`, `username`,
  `email` claims and attaches them to the request context. No per-request call
  to Clerk or to any other service (§2 of SYSTEM_DESIGN).
- **Services.** Own all business rules: duplicate/self/already-friends
  rejection, request-state transitions (only `pending → accepted|declined`,
  only `pending → cancelled`), recipient-only accept/decline, sender-only
  cancel, username case-insensitive exact match. Services are pure orchestration;
  persistence happens in repositories.
- **Repositories.** One repository per table; the only layer allowed to touch
  PostgreSQL. Owns transaction boundaries used by services.
- **Outbox worker.** Drains `outbox_event` rows after commit, publishes to
  Kafka, marks rows published (ADR-002). Runs inside the pod process; scales
  safely with replicas because each worker claims rows via row-level locks
  (`SELECT … FOR UPDATE SKIP LOCKED`).
- **Producer.** Kafka producer with idempotence enabled; publish failures are
  retried by the outbox worker, never inline on the request path.

---

## 3. Request & Event Flows

### 3.1 Authenticated request path (e.g. `GET /v1/users/by-username/{username}`)

```
Client ── Bearer <session_jwt> ──► HTTP layer
  1. Auth middleware verifies JWT offline (JWKS). Invalid/expired → 401.
  2. Context carries user_id (=sub), username, email claims.
  3. Controller delegates to service; repository executes the lookup.
  4. If the caller's profile row is missing, lazy upsert from claims (ADR-001).
  5. Response rendered per OpenAPI contract; JSON log with trace_id.
```

### 3.2 Send friend request (`POST /v1/friend-requests`)

```
  1. Verify JWT → caller user_id + username claim.
  2. Lazy upsert caller profile (if absent).
  3. Resolve {username} case-insensitively → recipient profile or 404 username_not_found.
  4. Reject: self-request (400 self_request), duplicate pending in either direction
     (409 duplicate_request), already friends (409 already_friends).
  5. BEGIN → insert friend_request(pending) + insert outbox_event(friend_request_sent) → COMMIT.
  6. Outbox worker publishes to identity_friend_events (key recipient_user_id).
  7. Respond 201 FriendRequest.
```

### 3.3 Accept friend request (`POST /v1/friend-requests/{request_id}/accept`)

```
  1. Verify JWT; load request; must exist and be addressed to the caller (404 request_not_found).
  2. State transition: only pending → accepted (409 request_not_pending).
  3. BEGIN → update friend_request(accepted) + upsert friendship pair + one outbox_event
     (friend_request_accepted) → COMMIT.   (single transaction; friendship and event never diverge)
  4. Outbox worker publishes; respond 200 Friendship.
```

Decline and cancel follow the same shape: state transition guarded to the
pending state, guarded to recipient (decline) or sender (cancel), one event in
the same transaction. Removing a friend deletes the friendship row and emits
`friendship_removed` in one transaction.

### 3.4 Clerk webhook sync (`POST /v1/webhooks/clerk`) — inbound provider flow

```
Clerk/Svix ── POST + svix-id/timestamp/signature headers ──► HTTP layer
  1. Verify Svix signature against CLERK_WEBHOOK_SIGNING_SECRET. Failure → 401 (no body details).
  2. Parse event: user.created | user.updated | user.deleted.
  3. BEGIN
     a. insert processed_webhook(svix message id) — conflict → already processed → COMMIT, 200, no-op.
     b. user.created → insert user_profile row.
        user.updated → update username/display_name/avatar_url/email.
        user.deleted → soft-delete (deleted_at, username retained for constraint) +
                       cancel all pending friend requests touching that user (status → cancelled).
     c. insert outbox_event for friend_request_sent/accepted/declined/cancelled emissions
        triggered by cancellation.
  4. COMMIT → 200 {status: "ok"}.
```

Idempotency is by Svix message id, so Clerk retries and replays are harmless.
Failures after the signature check return `500` so Svix retries the delivery;
a permanently failing event is counted in
`identity_clerk_webhook_failures_total{reason}` (with `reason=retry_exhausted`
surfaced when it ultimately cannot be processed).

**No outbound Clerk calls are made anywhere in the request path** (§4.1 of
SYSTEM_DESIGN). The Backend API secret is not needed; JWT verification uses
the published public key/JWKS only.

### 3.5 Lazy profile bootstrap (ADR-001)

```
  Authenticated request → verified JWT claims (sub, username, email)
  → profile row for sub missing? → INSERT … ON CONFLICT (user_id) DO NOTHING
  → identity_users_synced_total{event=created}++
  → business operation proceeds in the same transaction.
```

Never overwrites webhook-maintained fields; heals missing rows for the caller
only; never used for third-party ids.

### 3.6 Kafka producer flow — `identity_friend_events` (ADR-002)

| Field | Value |
|---|---|
| Producer | `identity_service` |
| Consumers | `notification_service`, `realtime_gateway` |
| Partition key | `recipient_user_id` (per-recipient ordering) |
| Delivery | transactional outbox, at-least-once, consumers dedupe by `event_id` |

Envelope (platform-wide, §5 of SYSTEM_DESIGN):
`{event_id, event_type, occurred_at, producer: "identity_service", version, trace_parent, data}`

| `event_type` | `data` contract |
|---|---|
| `friend_request_sent` | `{request_id, sender_user_id, sender_username, recipient_user_id, recipient_username, recipient_email}` |
| `friend_request_accepted` | `{request_id, sender_user_id, recipient_user_id}` |
| `friend_request_declined` | `{request_id, sender_user_id, recipient_user_id}` |
| `friend_request_cancelled` | `{request_id, sender_user_id, recipient_user_id}` |
| `friendship_removed` | `{user_id_a, user_id_b}` |

`trace_parent` carries the request's W3C trace context so downstream consumers
continue the same trace. `friend_request_cancelled` events are emitted for
both user-initiated cancels and webhook-driven cancellations of a deleted
user's pending requests.

---

## 4. PostgreSQL Database Schema

One logical database owned exclusively by this service; no cross-service table
sharing (§1 of SYSTEM_DESIGN). All timestamps are `timestamptz`; all primary
keys are `uuid`. `user_id` values are Clerk user ids reused as platform user
ids. Statements below are the normative schema; identifiers are snake_case.

```sql
-- ============ user_profile ============
-- Mirror of Clerk users. `deleted_at` soft-deletes: the row remains so the
-- username stays reserved, but the profile is unsearchable and unreferencable.
CREATE TABLE user_profile (
    user_id       uuid         PRIMARY KEY,              -- Clerk user id (sub claim)
    username      text         NOT NULL,                  -- stored lowercased; unique per Clerk instance
    display_name  text         NOT NULL,
    avatar_url    text         NOT NULL DEFAULT '',
    email         text         NOT NULL DEFAULT '',
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now(),
    deleted_at    timestamptz,                            -- NULL = active
    CONSTRAINT user_profile_username_unique UNIQUE (username),
    CONSTRAINT user_profile_username_format CHECK (username ~ '^[a-z0-9._-]{2,32}$')
);
CREATE INDEX user_profile_deleted_at_idx ON user_profile (deleted_at);

-- ============ friend_request ============
-- Status machine: pending → accepted | declined | cancelled (terminal states).
CREATE TYPE friend_request_status AS ENUM ('pending', 'accepted', 'declined', 'cancelled');

CREATE TABLE friend_request (
    request_id        uuid                  PRIMARY KEY,
    sender_user_id    uuid                  NOT NULL REFERENCES user_profile(user_id),
    recipient_user_id uuid                  NOT NULL REFERENCES user_profile(user_id),
    status            friend_request_status NOT NULL DEFAULT 'pending',
    created_at        timestamptz           NOT NULL DEFAULT now(),
    responded_at      timestamptz,                     -- set on accept/decline/cancel
    CONSTRAINT friend_request_no_self CHECK (sender_user_id <> recipient_user_id)
);
-- At most one live (pending) request per ordered pair; historical rows kept for
-- accepted/declined/cancelled state. This is what makes duplicates impossible.
CREATE UNIQUE INDEX friend_request_pending_pair_idx
    ON friend_request (sender_user_id, recipient_user_id)
    WHERE status = 'pending';

CREATE INDEX friend_request_recipient_pending_idx
    ON friend_request (recipient_user_id, created_at DESC)
    WHERE status = 'pending';
CREATE INDEX friend_request_sender_pending_idx
    ON friend_request (sender_user_id, created_at DESC)
    WHERE status = 'pending';

-- ============ friendship ============
-- Unordered pair, stored with a < b so one row exists per friendship.
CREATE TABLE friendship (
    user_id_a  uuid        NOT NULL REFERENCES user_profile(user_id),
    user_id_b  uuid        NOT NULL REFERENCES user_profile(user_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT friendship_pair_ordered CHECK (user_id_a < user_id_b),
    PRIMARY KEY (user_id_a, user_id_b)
);
-- Covers "friends of X" reads in either direction.
CREATE INDEX friendship_b_idx ON friendship (user_id_b);

-- ============ processed_webhook ============
-- Idempotency ledger for Clerk (Svix) deliveries. Primary key is the Svix
-- message id; a row existing means "already processed, return 200".
CREATE TABLE processed_webhook (
    svix_message_id text        PRIMARY KEY,
    event_type      text        NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now()
);

-- ============ outbox_event ============
-- Transactional outbox (ADR-002). `published_at` NULL = pending.
CREATE TABLE outbox_event (
    event_id     uuid        PRIMARY KEY,
    topic        text        NOT NULL DEFAULT 'identity_friend_events',
    partition_key uuid       NOT NULL,                   -- recipient_user_id (or user_id_a/b for removals)
    event_type   text        NOT NULL,
    payload      jsonb       NOT NULL,                   -- full envelope `data` field
    headers      jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- includes trace_parent
    created_at   timestamptz NOT NULL DEFAULT now(),
    attempts     integer     NOT NULL DEFAULT 0,
    published_at timestamptz,
    last_error   text
);
CREATE INDEX outbox_event_pending_idx
    ON outbox_event (created_at ASC)
    WHERE published_at IS NULL;
```

**Consistency rules**

- Friend-request state changes, friendship creation/removal, and their events
  are written in **one transaction** (friend_request/friendship row + outbox
  row commit together).
- `user.deleted` soft-deletes the profile and cancels pending friend requests
  in the same transaction as the `processed_webhook` ledger row.
- Soft-deleted profiles remain username-unique (the username stays reserved);
  lookups exclude `deleted_at IS NOT NULL` rows, so the username is
  unsearchable.
- Friendships between two users are enforced unique by the ordered-pair
  primary key.

---

## 5. Kubernetes Operational Model

**Stateless pod.** No local state beyond caches; everything durable lives in
PostgreSQL and Kafka. Replicas ≥ 1; horizontal scale is safe because:

- all request paths are read-mostly or short transactions,
- the outbox worker uses `SELECT … FOR UPDATE SKIP LOCKED`, so multiple
  replicas drain the same outbox without double-publishing a row,
- readiness gates a replica out of rotation until its DB pool and Kafka
  producer are functional.

**Probes**

| Probe | Route | Healthy when |
|---|---|---|
| Liveness | `GET /healthz` | process is up and event loop responsive (no dependency checks) |
| Readiness | `GET /readyz` | DB round-trip succeeds **and** Kafka producer is connected |

**Graceful shutdown (`SIGTERM`/`SIGINT`)**

1. Stop accepting new requests; respond `503` to new ones on readiness-gated
   routes while remaining live.
2. Finish in-flight requests within the termination grace period.
3. Stop the outbox worker polling (in-flight publish attempts get a short
   drain window; rows not published stay pending for the next pod).
4. Close Kafka producer (flush, then close) and the DB pool.
5. Exit `0`. Any step that cannot complete within the grace period is aborted;
   the outbox ledger makes this safe (no lost events, no torn state).

**Failure modes & resilience**

| Failure | Handling |
|---|---|
| Clerk webhook delivery fails/retries | Svix retries; idempotency by message id. Permanent gaps are healed by lazy upsert (ADR-001). Verification failures → `401`; processing failures → `500` so Svix retries. |
| Kafka unavailable | Requests still succeed (state committed); outbox rows stay pending and are published with exponential backoff when the broker returns. `kafka_produce_errors_total{topic}` climbs. |
| Outbox event exceeds retry budget | Marked in `last_error`, counted as dead-lettered, alert surfaced; state change itself is never rolled back. |
| DB unavailable | `/readyz` fails, pod removed from rotation; in-flight requests fail with `503`-class errors, clients retry. |
| Missing profile for a third-party id | `404 username_not_found` / omitted from batch results — the lazy upsert only ever touches the caller's own row. |
| Rate-limit pressure (friend requests, lookups) | Per-pod token buckets sized to replica count (§7 of SYSTEM_DESIGN); exceeded → `429`-class rejection, no shared state. |

**Idempotency keys in play**

| Key | Protects |
|---|---|
| Svix message id | duplicate webhook deliveries |
| `event_id` (uuid, envelope) | consumer dedupe for outbox republication |
| unique pending-pair index | duplicate friend requests (also validated in business logic) |
| ordered friendship PK | duplicate friendship creation (also enforced by accept state machine) |

---

## 6. API Surface (summary — full contract in `docs/openapi_spec.yaml`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/me` | Clerk JWT | own profile |
| GET | `/v1/users/by-username/{username}` | Clerk JWT | exact, case-insensitive; `404 username_not_found` |
| POST | `/v1/users:batch` | Clerk JWT | ≤100 ids → public profiles |
| POST | `/v1/friend-requests` | Clerk JWT | 201; 404/409 per business rules |
| GET | `/v1/friend-requests` | Clerk JWT | `direction`, `status`, cursor pagination |
| POST | `/v1/friend-requests/{request_id}/accept` | Clerk JWT | recipient only; 200 Friendship |
| POST | `/v1/friend-requests/{request_id}/decline` | Clerk JWT | recipient only |
| DELETE | `/v1/friend-requests/{request_id}` | Clerk JWT | sender only; 204 |
| GET | `/v1/friends` | Clerk JWT | cursor pagination |
| DELETE | `/v1/friends/{user_id}` | Clerk JWT | 204 |
| POST | `/v1/webhooks/clerk` | Svix signature | no JWT |
| GET | `/healthz`, `/readyz` | none | probes |

---

## 7. Observability

All metrics follow the platform rules: low-cardinality labels only — never
`user_id`, `community_id`, `channel_id`, `request_id`, or timestamps.

**Business metrics**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `identity_friend_requests_total` | counter | `outcome=sent\|accepted\|declined\|cancelled` | friend-request lifecycle outcomes |
| `identity_username_lookups_total` | counter | `result=found\|not_found` | username resolution success rate |
| `identity_users_synced_total` | counter | `event=created\|updated\|deleted` | mirror changes (webhook path and lazy upsert share the labels) |

**Technical / performance metrics**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `route`, `method`, `status_class` | API latency per route |
| `identity_clerk_webhook_failures_total` | counter | `reason` (e.g. `signature`, `parse`, `db`, `retry_exhausted`) | webhook processing failures |
| `kafka_produce_errors_total` | counter | `topic` | producer errors |
| `identity_outbox_events_pending` | gauge | `topic` | outbox backlog (alert if sustained growth) |
| `identity_outbox_events_dead_lettered_total` | counter | `topic` | events exceeding the retry budget |

**SLOs (from SYSTEM_DESIGN §4.1)**

- API p95 latency < 150 ms.
- 99.9% availability.
- Clerk webhook processing success ≥ 99.9%.

**Tracing.** W3C `traceparent` is accepted from inbound HTTP requests, given
to every log line as `trace_id`, stored in `outbox_event.headers`, and
forwarded in the Kafka envelope (`trace_parent`) so `notification_service` and
`realtime_gateway` continue the same trace. Spans are opened for: JWT
verification, DB transactions, webhook processing, and outbox publish attempts.

**Structured logging.** JSON lines with `timestamp`, `level`, `service`
(`identity_service`), `route`, `method`, `status_code`, `trace_id`,
`error_code` (when applicable). Never log raw JWTs, webhook signatures, or
request bodies containing emails.
