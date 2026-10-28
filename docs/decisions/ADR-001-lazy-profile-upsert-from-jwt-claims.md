# ADR-001: Lazy user-profile upsert from JWT claims

## Status

Accepted

## Context

`identity_service` keeps a local mirror of Clerk user profiles in PostgreSQL
(`user_profile`) so that the platform can resolve usernames, display names and
avatars without calling Clerk or another service on every request.

Profiles are normally maintained by the inbound Clerk webhook
(`user.created`, `user.updated`, `user.deleted` on `POST /v1/webhooks/clerk`).
Webhook delivery is, however, an at-least-once, best-effort mechanism:

- Clerk retries on transport errors and eventually gives up after a retry
  window; a delivery can be permanently missed if the service is unavailable
  for an extended period.
- A brand-new user may issue their first authenticated request before the
  `user.created` webhook has been processed, in which case their profile row
  does not exist yet.
- Every service verifies Clerk session JWTs offline. The Clerk session token
  is customized to include `sub` (the Clerk user id), `username` and `email`,
  so a valid JWT is itself a trustworthy, fresh-enough source of the fields the
  mirror needs.

Without a fallback, a missed webhook would cause `username_not_found` errors
for friend requests, missing authors in batch profile lookups, and inconsistent
member lists downstream — all caused purely by infrastructure asynchrony.

## Decision

On every authenticated request that touches profile data, after the Clerk JWT
is verified offline, the handler ensures the calling user's profile row exists
by **lazily upserting from the JWT claims** (`sub`, `username`, `email`) when
no row for that `user_id` is present.

Rules:

- The lazy upsert is an **insert-if-absent** operation (idempotent by primary
  key). It never overwrites a field with a webhook-maintained value, so a
  profile created lazily is corrected later by `user.updated`.
- Only the caller's own profile is touched; the lazy path is never used for
  third-party `user_id` values.
- The operation is included in the same request transaction as the business
  write (e.g. friend-request creation) where one exists, so profile bootstrap
  and business state remain consistent.
- Lazy creation increments `identity_users_synced_total{event=created}` with
  the same metric used by the webhook path, so self-healing is observable.

## Consequences

- **Self-healing mirror:** a permanently missed webhook no longer leaves
  permanent gaps; any authenticated request heals the caller's own row.
- **Bounded staleness:** between sign-up and first request, third parties see
  `404 username_not_found` for the new username. This is acceptable for MVP;
  the window is the webhook delivery latency plus the user's first request.
- **JWT claim coupling:** the mirror depends on the custom session-token
  claims (`sub`, `username`, `email`). Changing the token template requires
  updating the claim mapping in one place.
- **No extra infrastructure:** the fallback uses the same Postgres table and
  the same verified-JWT data already available in the request path; no
  additional polling job or reconciliation service is introduced.

## Alternatives considered

- **Reconciliation job scanning Clerk users periodically:** rejected —
  requires the Backend API secret in the request path services and adds
  unbounded list calls to stay consistent, for a problem solved by one
  insert-if-absent.
- **Rejecting requests until the webhook arrives:** rejected — makes user
  onboarding fail whenever webhook delivery is delayed, which is the exact
  failure mode this ADR exists to remove.
- **Caching profiles in Redis:** rejected for MVP — adds a stateful dependency
  and does not fix the missing-row case.

## Related documents

- `docs/architecture.md` — "Clerk webhook sync" and "Lazy profile bootstrap" flows
- `docs/engineering_guide.md` — Pinned Decisions (outbox, `@clerk/backend`)
