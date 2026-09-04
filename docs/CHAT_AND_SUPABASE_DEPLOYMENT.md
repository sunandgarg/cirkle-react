# Chat and realtime deployment

The filename is retained for old links; this is now a Node/MySQL deployment.
There is no runtime Supabase or AppSync connection.

- Durable chat/forum data is stored through Prisma in MySQL.
- Socket.IO at `/api/socket.io` provides realtime delivery.
- Nginx forwards WebSocket upgrades to one PM2 API process.
- Private media is served through expiring signed URLs and server-side access
  checks.
- Client retries use deterministic IDs so duplicate message submission is
  idempotent.

Keep `VITE_CHAT_REALTIME_PROVIDER=socketio`. PM2 intentionally runs one process
because subscriptions are in memory. Before adding multiple API workers, add a
shared Socket.IO adapter, shared presence state, and sticky-session validation.

Run the synthetic load checks only against an isolated test database:

```sh
pnpm test:chat-load
k6 run load/k6-chat.js
k6 run load/k6-forum.js
```

Never load-test production member data. See [DEPLOYMENT.md](./DEPLOYMENT.md).
