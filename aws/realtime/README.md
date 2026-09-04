# Cirkle AppSync Events

This CloudFormation stack adds AWS AppSync Events as Cirkle's low-latency
realtime transport. It does **not** host the React application, Node API, or
MySQL database in AWS. The AWS resources are limited to the Event API, its
minimal Lambda authorizer, an IAM execution role, and authorizer logs.

MySQL remains authoritative. After the Node API writes durable application
data, it derives audience-scoped channels, places a content-free row-ID
invalidation in the MySQL `legacy_records` outbox, and publishes it through the
AppSync HTTP endpoint. Browsers subscribe over AppSync WebSockets and refetch
the row through the normal Node API, which rechecks current authorization. The
existing Socket.IO compatibility transport takes over if AppSync is
unavailable.

## Security model

- The AppSync publisher token and authorizer shared secret are server-only.
  Neither value belongs in a Vite or Cloudflare Pages variable.
- Browsers cannot publish database-change events or force an outbox drain.
  Typing/presence remains on the revocable Socket.IO transport; AppSync is
  intentionally limited to content-free durable invalidations.
- Every connection and subscription is checked by the Lambda authorizer
  against `/api/realtime/appsync/authorize`. Authorizer caching is disabled so
  current account status and channel membership are consulted each time.
- Wildcard subscriptions are not accepted. Forum scope names are represented
  by deterministic SHA-256 digests; direct chat, thread, and inbox channels are
  checked against MySQL membership/visibility.
- Durable AppSync envelopes contain only the table, operation and opaque row
  ID. They never contain message/post text, member identity, media paths,
  ballots, call tokens or other private row data. The browser must refetch via
  the authenticated API before changing durable UI state.
- Event identifiers are stable across outbox retries, so consumers continue to
  refetch and merge by durable database row ID. Enqueue currently follows the business
  transaction; a process crash in that narrow interval can omit low-latency
  fanout. Cursor/database reconciliation is therefore the delivery guarantee,
  and transactionally coupling every write to the outbox remains a hardening
  item.

## Provision in `ap-south-1`

Prerequisites:

1. `https://api.cirkle.world` (or the chosen `ApiBaseUrl`) must already expose
   the Node API over public HTTPS.
2. Generate two different random values of at least 32 characters. Store them
   in the production secret store as `APPSYNC_AUTHORIZER_SECRET` and
   `APPSYNC_PUBLISH_TOKEN`. Do not paste them into source control, shell
   history, screenshots, or Cloudflare Pages.
3. Supply those same values to the CloudFormation `AuthorizerSharedSecret` and
   `PublisherToken` NoEcho parameters. The AWS console's parameter form is the
   safest straightforward setup for this one-time operation.

Validate the template before creating or updating the stack:

```bash
aws cloudformation validate-template \
  --region ap-south-1 \
  --template-body file://aws/realtime/template.yaml
```

Create/update the stack using `aws/realtime/template.yaml` and acknowledge IAM
resource creation. After it reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`,
read these outputs:

- `AppSyncApiId`
- `AppSyncHttpEndpoint`
- `AppSyncRealtimeEndpoint`
- `AuthorizerFunctionArn`

If the AWS account still contains the earlier Supabase-dispatcher AppSync
stack, do not overwrite it while the old client is writable. Provision this
Node-authorized Event API side-by-side with new server-only secrets, configure
and restart the Node API, pass the two-browser allow/deny/fallback checks, then
switch the Pages endpoints. Delete the legacy dispatcher stack only after the
data write-freeze/cutover is complete and its rollback window has closed.
The authorizer Lambda uses a CloudFormation-generated physical name, so a new
stack does not collide with the legacy stack's fixed authorizer function or log
group.

## Runtime configuration

Set on the Node server, then restart the PM2 process:

```text
APPSYNC_ENABLED=true
APPSYNC_HTTP_ENDPOINT=<AppSyncHttpEndpoint>
APPSYNC_PUBLISH_TOKEN=<same value as PublisherToken>
APPSYNC_AUTHORIZER_SECRET=<same value as AuthorizerSharedSecret>
```

Set only these public Cloudflare Pages build variables and rebuild the site:

```text
VITE_CHAT_REALTIME_PROVIDER=appsync
VITE_APPSYNC_HTTP_ENDPOINT=<AppSyncHttpEndpoint>
VITE_APPSYNC_REALTIME_ENDPOINT=<AppSyncRealtimeEndpoint>
```

## Verification and operations

Verify one forum room, one direct-message room, Socket.IO typing,
reconnect-after-token refresh, and Socket.IO fallback while AppSync is
unavailable. Also confirm the
Node readiness endpoint and inspect AppSync 4XX/5XX, connection, subscription,
and event metrics in CloudWatch.

Failed AppSync publishes are retried with bounded exponential backoff. After 12
failed attempts a record is retained for inspection under
`table_name = 'appsync_realtime_dead_letter'`; it is not allowed to block newer
deliveries. Resolve the provider/configuration problem before deliberately
replaying or deleting dead-letter records.

AppSync authorizes when a WebSocket connects or subscribes; it does not
continuously re-run authorization for an already-established subscription.
The Cirkle browser client reconnects before each 15-minute Cirkle JWT expiry,
but a modified client can keep an accepted AppSync connection open until AWS's
24-hour service limit. Such a client can observe that an opaque row ID changed,
but receives no durable content and cannot refetch it after revocation because
the Node API rechecks authorization. Immediate forced disconnection remains an
AWS service limitation, not a private-content disclosure path.
