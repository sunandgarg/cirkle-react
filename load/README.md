# Load-test tooling

These checks target the Cirkle Node API. They intentionally separate HTTP
throughput from Socket.IO fan-out so a result is easy to interpret:

- `load/k6-chat.js` measures direct-message write and history-query traffic.
- `load/k6-forum.js` measures forum post write and history-query traffic.
- `load/live-forum-50.mjs` verifies forum persistence and Socket.IO delivery to
  2–50 connections.

All data operations use authenticated `POST /api/data/query` requests. The live
harness connects to `/api/socket.io`, subscribes with `realtime:subscribe`, and
observes `realtime:event` envelopes.

## Safety rules

Every script requires an exact acknowledgement phrase and `TARGET_ENV`. Allowed
target values are `local`, `development`, `test`, `staging`, `performance`, and
`production`. `API_URL` must be an origin with no `/api` suffix or other path,
for example `http://localhost:3001`.

Production is disabled by default. A target declared as production, or any
`cirkle.world` hostname, additionally requires both:

```text
ALLOW_PRODUCTION_LOAD_TEST=true
PRODUCTION_LOAD_TEST_ACK=I_ACCEPT_PRODUCTION_LOAD_TEST_WRITES
```

A production target must use HTTPS. Setting only one production flag is not
enough. Use a dedicated performance environment whenever possible.

The bearer token and password are secrets. Do not paste them into committed
files or include them in captured load-test output.

## Chat HTTP load test

Required environment:

```text
LOAD_TEST_ACK=I_UNDERSTAND_THIS_WRITES_TEST_CHAT_MESSAGES
API_URL=http://localhost:3001
TARGET_ENV=local
TEST_JWT=...
TEST_USER_ID=...
ROOM_ID=...
```

Run it with:

```sh
k6 run load/k6-chat.js
```

The JWT must belong to `TEST_USER_ID`, and that user must be a member of the
isolated test room. Writes and reads are serialized Node API queries; the script
does not exercise Socket.IO. Generated messages are tagged with
`[load-test:<RUN_ID>]` and remain in the target database for deliberate cleanup.

Optional controls:

```text
RUN_ID=k6-chat-manual-001
WRITE_RATE=10
READ_RATE=2
DURATION=1m
WRITE_VUS=20
WRITE_MAX_VUS=500
READ_VUS=5
READ_MAX_VUS=100
```

Either write or read rate may be `0`, but they cannot both be `0`.

## Forum HTTP load test

Required environment:

```text
FORUM_LOAD_TEST_ACK=I_UNDERSTAND_THIS_WRITES_TEST_FORUM_POSTS
API_URL=http://localhost:3001
TARGET_ENV=local
TEST_JWT=...
```

Run it with:

```sh
npm run test:chat-load:live
```

The account represented by `TEST_JWT` must be verified and authorized for the
selected scope. This k6 test covers only HTTP persistence and history reads; use
the live harness below for Socket.IO delivery. Generated posts use channel
`load-test`, are tagged with `[load-test:<RUN_ID>:<timestamp>]`, and remain in
the database for deliberate cleanup.

Optional controls:

```text
RUN_ID=forum-k6-manual-001
SCOPE_TYPE=GLOBAL
SCOPE_KEY=LOAD_TEST
WRITE_RATE=10
READ_RATE=2
DURATION=1m
WRITE_VUS=20
WRITE_MAX_VUS=500
READ_VUS=5
READ_MAX_VUS=100
```

Either write or read rate may be `0`, but they cannot both be `0`.

## Live 2–50 client forum delivery test

Required environment:

```text
LIVE_FORUM_TEST_ACK=I_UNDERSTAND_THIS_WRITES_AND_DELETES_TEST_FORUM_POSTS
API_URL=http://localhost:3001
TARGET_ENV=local
TEST_USER_EMAIL=load-test-user@example.test
TEST_USER_PASSWORD=...
TEST_AGENTS=50
```

Run it with:

```sh
npm run test:forum:live50
```

The supplied account must already exist, be email-verified, be an active member,
and have permission to post in the selected forum scope. The harness signs in
once, opens `TEST_AGENTS` independent Socket.IO connections with that one access
token, and subscribes them to `forum:<SCOPE_TYPE>:<SCOPE_KEY>`. It then:

1. writes one root post per connection identity slot;
2. requires every socket to observe every root post;
3. writes the same number of replies to the first root;
4. requires every socket to observe every reply;
5. verifies all generated rows through `/api/data/query`;
6. disconnects, deletes only the generated posts, and logs out.

The script does not create, update, or delete user accounts. It therefore tests
connection and fan-out behavior for one authenticated identity, not authorization
isolation between 50 distinct members. It also does not test reactions, typing,
presence, moderation, long-running reconnects, or production-scale capacity.

Optional controls:

```text
RUN_ID=live-forum-manual-001
SCOPE_TYPE=GLOBAL
SCOPE_KEY=LOAD_TEST
SOCKET_CHANNEL=forum:GLOBAL:LOAD_TEST
REQUEST_TIMEOUT_MS=20000
DELIVERY_TIMEOUT_MS=30000
CONNECT_BATCH_SIZE=10
WRITE_BATCH_SIZE=50
```

`CONNECT_BATCH_SIZE` and `WRITE_BATCH_SIZE` must be integers from 1 through 50.
If the process is killed before `finally` runs, automatic post cleanup cannot
complete. Use the printed `RUN_ID` (and, on cleanup failure, the printed IDs) to
remove only that run's generated data.

## Interpreting results

A passing k6 run demonstrates the configured HTTP rates for the configured
duration and thresholds. A passing live run demonstrates a controlled burst of
`2 * TEST_AGENTS` persisted posts and `2 * TEST_AGENTS²` observed deliveries to
at most 50 sockets. Neither result certifies a daily traffic target or a
production connection ceiling. Capacity qualification still requires staged
ramp tests, a soak test, realistic identity distribution, and correlated API,
Socket.IO, MySQL, CPU, memory, network, and error-rate telemetry.
