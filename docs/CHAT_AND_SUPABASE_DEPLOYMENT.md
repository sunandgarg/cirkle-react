# Chat and realtime deployment

The filename is retained for old links. The running data layer is Node, Prisma,
and MySQL; there is no runtime Supabase connection. Production durable
forum/chat/inbox invalidations use AWS AppSync Events. Socket.IO on
`https://api-react.cirkle.world` supplies room fallback and runs in parallel
for personal-state compatibility and typing/presence.

## Delivery model

- MySQL is the durable source of truth for forum and direct-message rows.
- The Node API validates each write and emits content-free AppSync
  invalidations only after durable MySQL work succeeds.
- Forum scope, thread visibility, chat membership, and personal inbox ownership
  are checked server-side before a socket joins a channel.
- Profile, notification, and connection updates currently use the authorized
  Socket.IO compatibility path; call invites use both transports when Daily is
  enabled. Browser typing/presence uses the same revocable Socket.IO connection.
- Private media still uses expiring Node-signed URLs and server access checks.
- A hidden page immediately disconnects realtime. Visibility recovery
  reconnects and refetches MySQL-backed state, so Socket.IO is not durable
  storage.

Set production Pages to the reviewed Event API endpoints:

```dotenv
VITE_API_URL=https://api-react.cirkle.world
VITE_CHAT_REALTIME_PROVIDER=appsync
VITE_APPSYNC_HTTP_ENDPOINT=https://hzrd5pmdhvfobbzonf2hffeq5e.appsync-api.ap-south-1.amazonaws.com/event
VITE_APPSYNC_REALTIME_ENDPOINT=wss://hzrd5pmdhvfobbzonf2hffeq5e.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime
VITE_DAILY_CALLS_ENABLED=false
```

Set the API host to `APPSYNC_ENABLED=true` with the matching HTTP endpoint and
server-only publisher/authorizer values. The complete security and rollback
model is in [`../aws/realtime/README.md`](../aws/realtime/README.md).

Run synthetic checks only against an isolated test database:

```sh
pnpm test:chat-load
k6 run load/k6-chat.js
k6 run load/k6-forum.js
```

Staging acceptance must cover authorized and denied subscriptions, JWT refresh,
offline recovery, duplicate invalidations, and multi-browser Socket.IO message
delivery. Never load-test production member data. See
[`DEPLOYMENT.md`](./DEPLOYMENT.md).
