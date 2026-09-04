# Daily calls: browser acceptance plan

Run this plan against an isolated test database with two ordinary email/Google
accounts that have an accepted connection and a direct chat room. Production
phone OTP is intentionally not a login method.

1. Start an audio call from account A. Confirm Daily prompts for microphone
   access, account B receives the invitation, both can join, mute, leave, and
   see correct participant state.
2. Repeat with video and verify camera denial produces a visible error rather
   than a stuck call screen.
3. Reject and miss separate calls. Confirm both clients converge on the same
   terminal state and no room remains active.
4. Refresh one participant mid-call and reconnect Socket.IO. Confirm chat and
   call events resume without duplicating participants.
5. Attempt to join with an unrelated account and with an expired token. Both
   must be denied.
6. Test two simultaneous calls and verify participant counts/finalization are
   isolated by room.
7. Inspect browser and API logs. Daily keys, JWTs, OAuth codes, and signed media
   query values must never appear.
8. Revoke a participant's verification and delete a separate test participant
   during active calls. Also demote an unverified administrator during a call.
   Confirm Cirkle ends the database session, ejects the affected participant,
   deletes the unique Daily room, and rejects a token obtained before the
   revocation but not yet used. Force a provider failure once and confirm Admin
   shows the pending room-revocation warning.
9. Kill one participant's tab/process without a graceful leave, wait beyond the
   two-minute participant lease, and start another call in the same chat.
   Confirm the stale row is closed and a fresh invitation and unique room are
   created. During a healthy call, confirm the 30-second lease heartbeat keeps
   calls longer than five minutes active.

Configure `DAILY_API_KEY` server-side and optionally a hostname-only
`DAILY_DOMAIN`. The API creates rooms; the key is never sent to the browser.
Record pass/fail evidence for desktop Chrome plus the supported mobile browser
before launch.
