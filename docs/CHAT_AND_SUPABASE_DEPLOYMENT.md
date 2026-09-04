# Chat and realtime deployment

The filename is retained for old links. The running data layer is Node, Prisma,
and MySQL; there is no runtime Supabase connection. Production realtime uses
AWS AppSync Events, while the frontend and API remain on Cloudflare Pages and
the Nginx/PM2 host respectively.

## Delivery model

- MySQL is the durable source of truth for forum and direct-message rows.
- The Node API validates every write and publishes content-free row-ID
  invalidations through AppSync's HTTP endpoint. The browser then refetches
  through the authenticated API; AppSync never carries durable row content.
- Once enqueued, a MySQL-backed retry outbox survives transient AppSync
  outages. Enqueue currently follows the business transaction, so cursor
  reconciliation remains authoritative after reconnects and after the narrow
  process-crash window between a committed write and its outbox insert.
- A minimal AWS Lambda authorizer validates each connection/subscription with
  the Node API. Forum scope, thread visibility, chat membership, and personal
  inbox ownership are checked server-side.
- Browser typing/presence stays on the revocable Socket.IO path. AppSync is
  limited to content-free durable invalidations, and its publisher credential
  is never shipped to the browser.
- Private media still uses expiring Node-signed URLs and server access checks.
- Socket.IO at `/api/socket.io` remains the authorized local/outage fallback.

Set production Pages to:

```dotenv
VITE_CHAT_REALTIME_PROVIDER=appsync
VITE_APPSYNC_HTTP_ENDPOINT=<AppSyncHttpEndpoint stack output>
VITE_APPSYNC_REALTIME_ENDPOINT=<AppSyncRealtimeEndpoint stack output>
```

Set the API host to `APPSYNC_ENABLED=true`, use the HTTP stack output, and set
the same two independently generated server secrets passed to CloudFormation.
See [`../aws/realtime/README.md`](../aws/realtime/README.md) for exact deployment
and rotation steps. AWS hosts only this realtime transport and authorizer.

Run synthetic checks only against an isolated test database:

```sh
pnpm test:chat-load
k6 run load/k6-chat.js
k6 run load/k6-forum.js
```

Staging acceptance must cover authorized and denied subscriptions, JWT refresh,
offline recovery, duplicate retries, the Socket.IO fallback, and multi-browser
message delivery. Never load-test production member data. See
[`DEPLOYMENT.md`](./DEPLOYMENT.md).
