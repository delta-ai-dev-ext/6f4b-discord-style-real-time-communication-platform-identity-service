# ADR-002: Transactional outbox for `identity_friend_events`

## Status

Accepted

## Context

`identity_service` owns state in PostgreSQL (profiles, friend requests,
friendships) and must emit domain events on the Kafka topic
`identity_friend_events` (`friend_request_sent`, `friend_request_accepted`,
`friend_request_declined`, `friend_request_cancelled`, `friendship_removed`).
Two consumers depend on these events:

- `notification_service` — renders and sends transactional email through Resend.
- `realtime_gateway` — live friend-request status for connected sessions.

Writing the state change in PostgreSQL and publishing to Kafka are two
different commit boundaries. Publishing directly after committing the
transaction (or, worse, before) means one of two failures:

1. **State committed, event lost** — the recipient never gets the friend
   request email or live notification; the request silently sits pending.
2. **Event published, transaction rolled back** — a phantom "friend request
   sent" notification for a request that does not exist.

This is a dual-write consistency problem that cannot be solved by retrying the
HTTP request alone.

## Decision

Every `identity_friend_events` message is written **inside the same PostgreSQL
transaction as the domain state change**, into an `outbox_event` table.

A separate in-process worker (draining the outbox table):

- polls/reads pending rows after the transaction commits,
- publishes each row to Kafka in `recipient_user_id` partition order,
- marks the row published only after a broker acknowledgement,
- retries with exponential backoff and a bounded-attempts policy before the
  row is surfaced as a dead-letter metric
  (`identity_outbox_events_dead_lettered_total`).

Consumers (already the platform norm) are idempotent by `event_id`, so
at-least-once publication from the outbox is safe.

## Consequences

- **Atomicity:** a friend request can never exist without its event, and no
  event exists for a rolled-back request.
- **Ordering:** outbox rows are read in insertion order, which preserves
  per-recipient ordering before the partitioner groups by `recipient_user_id`.
- **Schema addition:** one `outbox_event` table owned by this service,
  including indexes for the polling query.
- **Eventual latency:** events are delivered within the polling interval
  (target p95 lag < 1 s) instead of inline on the request thread; the request
  response time is no longer coupled to broker availability.
- **No distributed transactions:** avoids 2PC across Postgres and Kafka; uses
  only the database the service already owns.

## Alternatives considered

- **Publish inline after commit:** rejected — any crash or broker outage
  between commit and publish permanently loses the event.
- **Change-data-capture / logical replication (e.g. Debezium):** rejected for
  MVP — heavier operational footprint than an outbox table; revisit if event
  volume grows beyond MVP scale.
- **Listen/notify or trigger-based publishing:** rejected — couples event
  durability to a listening process's liveness and loses backlog on restart.

## Related documents

- `docs/architecture.md` — "Transactional outbox" and failure modes sections
- `docs/engineering_guide.md` — Pinned Decisions (outbox row)
