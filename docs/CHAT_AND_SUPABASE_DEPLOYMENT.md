# Chat and realtime deployment

The filename is retained for old links. The running data layer is Node, Prisma,
and MySQL; there is no runtime Supabase connection. Current production realtime
uses Socket.IO on `https://api-react.cirkle.world`; AppSync is disabled.

## Delivery model

- MySQL is the durable source of truth for forum and direct-message rows.
- The Node API validates each write and emits authorized Socket.IO
  invalidations only after durable MySQL work succeeds.
- Forum scope, thread visibility, chat membership, and personal inbox ownership
  are checked server-side before a socket joins a channel.
- Browser typing/presence uses the same revocable Socket.IO connection.
- Private media still uses expiring Node-signed URLs and server access checks.
- A hidden page immediately disconnects realtime. Visibility recovery
  reconnects and refetches MySQL-backed state, so Socket.IO is not durable
  storage.

Set production Pages to:

```dotenv
VITE_API_URL=https://api-react.cirkle.world
VITE_CHAT_REALTIME_PROVIDER=socketio
VITE_DAILY_CALLS_ENABLED=false
```

Set the API host to `APPSYNC_ENABLED=false`. The optional AppSync design remains
in [`../aws/realtime/README.md`](../aws/realtime/README.md), but it is not a
dependency or fallback for this deployment.

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
