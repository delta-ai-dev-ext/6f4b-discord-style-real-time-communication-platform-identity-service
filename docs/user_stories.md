# `identity_service` — User Stories

Derived from the platform architecture (SYSTEM_DESIGN §4.1, §2, §5): profile
mirror of Clerk users, username/batch lookups, friend-request lifecycle,
friendships, friend events, and Clerk webhook sync. Authentication itself is
owned by Clerk; this service only verifies session tokens and mirrors profiles.

Actors:

- **Signed-in user** — any platform user with a valid Clerk session
  (email/password, Google, Apple or Discord).
- **Clerk** — the external identity provider acting as a webhook sender.
- **Peer service** — another backend service calling this one (consumes
  `identity_friend_events`; no synchronous dependency on this service).

---

## US-001: View my own profile

**As a** signed-in user,
**I want to** fetch my own profile (username, display name, avatar, email),
**So that** the app can bootstrap my session state without another service call.

### Acceptance Criteria
- Given I send an authenticated `GET /v1/me` request, when the request is valid, then I receive my profile with `user_id`, `username`, `display_name`, `avatar_url` and `email`.
- Given my profile row does not exist yet (Clerk webhook not yet processed), when I send my first authenticated request, then my profile is created from my session-token claims and returned (lazy bootstrap).
- Given I send the request without a valid session token, when it is processed, then I receive `401` and no profile data.

### Out of Scope
- Editing profile fields (Clerk owns identity data; changes arrive via webhook).
- Other users' profiles (covered by US-002/US-003).

---

## US-002: Find a user by exact username

**As a** signed-in user,
**I want to** look up a user by their exact username,
**So that** I can find them to send a friend request.

### Acceptance Criteria
- Given an existing active user, when I request their username with different letter casing, then I receive their public profile (`user_id`, `username`, `display_name`, `avatar_url`) — lookup is case-insensitive.
- Given a username with no matching active user, when I look it up, then I receive `404` with error code `username_not_found`.
- Given a user whose account was deleted, when I look up their username, then I receive `404 username_not_found` (soft-deleted profiles are unsearchable).
- Given I send the request without a valid session token, when it is processed, then I receive `401`.

### Out of Scope
- Partial/fuzzy search or username suggestions.
- Returning private fields (email) for other users.

---

## US-003: Batch-resolve user profiles

**As a** signed-in user (via the client rendering a member list or message authors),
**I want to** fetch many public profiles in one request,
**So that** the UI can display names and avatars without one request per user.

### Acceptance Criteria
- Given a list of up to 100 user ids, when I submit the batch, then I receive the public profiles for every id that resolves to an active user.
- Given the batch contains ids of deleted or unknown users, when I submit it, then those ids are silently omitted from the response (no error for the whole request).
- Given a batch larger than 100 ids, when I submit it, then I receive `422` with error code `batch_limit_exceeded`.
- Given an empty or malformed id list, when I submit it, then I receive `400`.

### Out of Scope
- Returning private fields (email) for other users.
- More than 100 ids per call.

---

## US-004: Send a friend request by username

**As a** signed-in user,
**I want to** send a friend request to someone by their username,
**So that** we can connect after they accept.

### Acceptance Criteria
- Given an existing active user, when I send a request with their username, then a pending friend request is created and I receive `201` with the `FriendRequest` (id, sender, recipient, status `pending`, timestamps).
- Given a username that does not match any active user, when I send the request, then I receive `404 username_not_found` and no request is created.
- Given I already have a pending request to that user (in either direction), when I send another request, then I receive `409 duplicate_request`.
- Given the target user is already my friend, when I send a request, then I receive `409 already_friends`.
- Given I target my own username, when I send the request, then I receive `400 self_request`.
- Given I hit the per-user friend-request rate limit, when I send a request, then I receive `429` and no request is created.

### Out of Scope
- Sending requests to an arbitrary email (friend connections are username-based).
- DMs/direct calls (explicit MVP exclusion).

---

## US-005: List my friend requests with direction and status

**As a** signed-in user,
**I want to** list incoming and outgoing friend requests filtered by status,
**So that** I can see what is pending, accepted or declined.

### Acceptance Criteria
- Given I have incoming and outgoing requests, when I list with `direction=incoming|outgoing` and a `status` filter, then I receive only matching requests as the sender/recipient profile is rendered.
- Given no filter, when I list, then I receive requests relevant to me with a sensible default ordering (newest first).
- Given more results than one page, when I list, then the response includes a cursor for the next page and I can continue with it.
- Given an invalid `direction` or `status` value, when I list, then I receive `400`.

### Out of Scope
- Requests belonging to other users (only my sent/received requests are visible).

---

## US-006: Accept a friend request

**As a** recipient of a friend request,
**I want to** accept it,
**So that** we become friends and can find each other across communities.

### Acceptance Criteria
- Given a pending request addressed to me, when I accept it, then I receive the created `Friendship` and the request status becomes `accepted`.
- Given a request addressed to someone else, when I try to accept it, then I receive `404 request_not_found`.
- Given an already-accepted or already-declined/cancelled request, when I try to accept it, then I receive `409 request_not_pending`.
- Given I accept a pending request, when the acceptance is committed, then the sender and recipient are both notified via the emitted event (email to the sender, live update where online).

### Out of Scope
- Accepting a request I sent (only the recipient may accept).

---

## US-007: Decline a friend request

**As a** recipient of a friend request,
**I want to** decline it,
**So that** the requester sees it was declined rather than ignored forever.

### Acceptance Criteria
- Given a pending request addressed to me, when I decline it, then the request status becomes `declined` and I receive the updated `FriendRequest`.
- Given a request addressed to someone else, when I try to decline it, then I receive `404 request_not_found`.
- Given a request not in the pending state, when I try to decline it, then I receive `409 request_not_pending`.

### Out of Scope
- Feedback or messages attached to a decline (no member-facing explanation flows here).

---

## US-008: Cancel my outgoing friend request

**As a** sender of a pending friend request,
**I want to** cancel it,
**So that** the recipient no longer sees an unwanted pending request.

### Acceptance Criteria
- Given a pending request I sent, when I cancel it, then I receive `204`, the request becomes `cancelled`, and it disappears from the recipient's pending list.
- Given a request I did not send, when I try to cancel it, then I receive `404 request_not_found`.
- Given a request not in the pending state, when I try to cancel it, then I receive `409 request_not_pending`.

### Out of Scope
- Cancelling an accepted friendship (covered by US-010 remove friend).

---

## US-009: List my friends

**As a** signed-in user,
**I want to** list my friends with their public profiles,
**So that** I can find them across communities.

### Acceptance Criteria
- Given I have friendships, when I list them, then I receive pages of friend public profiles (`user_id`, `username`, `display_name`, `avatar_url`).
- Given more friends than one page, when I list, then the response includes a cursor for the next page.
- Given I have no friends, when I list, then I receive an empty list with a `200`.

### Out of Scope
- "Suggested friends" or social-graph recommendations.
- Friends-of-friends visibility.

---

## US-010: Remove a friend

**As a** signed-in user,
**I want to** remove someone from my friends,
**So that** they no longer appear in my list and can send a fresh request later.

### Acceptance Criteria
- Given an existing friendship, when I remove that friend, then I receive `204` and the friendship no longer exists for either user (friendship is mutual).
- Given a user who is not my friend, when I try to remove them, then I receive `404 friendship_not_found`.
- Given a removal succeeds, when the change is committed, then both users are informed via the emitted event (live update where online).

### Out of Scope
- Blocking/ignore-list features (not part of the friend domain in the MVP).

---

## US-011: Keep my profile mirrored from Clerk (webhook sync)

**As a** platform user,
**I want to** my profile changes in Clerk to be reflected on the platform,
**So that** other users see my current name and avatar everywhere.

### Acceptance Criteria
- Given a Clerk `user.created` event, when the signed webhook is delivered, then my profile row is created with username, display name, avatar and primary email.
- Given a Clerk `user.updated` event, when the signed webhook is delivered, then my mirrored fields are updated accordingly.
- Given a Clerk `user.deleted` event, when the signed webhook is delivered, then my profile is soft-deleted (my username becomes unsearchable) and all pending friend requests involving me are cancelled.
- Given the same webhook delivery is retried, when it is processed again, then the second delivery is a no-op (idempotent by message id) and returns `200`.
- Given a delivery with an invalid or missing signature, when it is processed, then I receive `401` and nothing is changed.

### Out of Scope
- Any outbound call to Clerk's API in the request path (verification is offline; sync is webhook-driven).
- Profile edits initiated by this service.

---

## US-012: First request works even if the webhook was missed

**As a** newly signed-up user,
**I want to** be able to use the app immediately,
**So that** a delayed or lost profile-sync webhook does not block my first actions.

### Acceptance Criteria
- Given my profile row does not exist yet, when I make my first authenticated request that touches profile data, then my profile is created from my session-token claims and my action succeeds.
- Given a webhook-maintained profile already exists, when I make requests, then lazy bootstrap never overwrites the maintained values.
- Given lazy bootstrap creates my row, when it happens, then it is recorded with the same metric used for webhook-created profiles.

### Out of Scope
- Backfilling other users' profiles (lazy bootstrap only heals the caller's own row).

---

## US-013: Friend events notify and update in real time

**As a** friend-request participant,
**I want to** receive an email for a received friend request and see live status updates,
**So that** I learn about connections whether or not I am online.

### Acceptance Criteria
- Given a pending request I sent, when the recipient accepts/declines it (or I cancel it), then a corresponding event is emitted exactly once per state change and carries the request id, both user ids and the sender username where applicable.
- Given a friend request is sent, when the event is published, then it includes the recipient's username and email so an email can be rendered without further lookups.
- Given a friendship is removed, when the change commits, then a removal event identifying both users is emitted.
- Given an event publication fails, when the system recovers, then the event is still published without being lost and without duplicating consumer effects (at-least-once delivery, idempotent by event id).

### Out of Scope
- Rendering or sending the email itself (owned by `notification_service`).
- Pushing live updates to sessions (owned by `realtime_gateway`).
