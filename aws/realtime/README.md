# Cirkle AppSync Events

This CloudFormation stack adds AWS AppSync Events as Cirkle's low-latency
realtime transport. It does **not** host the React application, Node API, or
MySQL database in AWS. The AWS resources are limited to the Event API, its
minimal Lambda authorizer, an IAM execution role, and authorizer logs.

MySQL remains authoritative. After the Node API writes durable application
data, it derives audience-scoped channels, places a content-free row-ID
invalidation in the MySQL `legacy_records` outbox, and publishes it through the
AppSync HTTP endpoint. Browsers subscribe over AppSync WebSockets and refetch
the row through the normal Node API, which rechecks current authorization.
Integrated forum/chat room consumers retire their Socket.IO row-delivery
subscription after AppSync succeeds and restore it automatically if AppSync is
unavailable. Socket.IO also remains a parallel authorized transport for
personal-state compatibility and typing/presence; it is not globally
fallback-only.

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

1. `https://api-react.cirkle.world` (or the chosen `ApiBaseUrl`) must already expose
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

Set on the Node server, then restart its production systemd service:

```text
APPSYNC_ENABLED=true
APPSYNC_HTTP_ENDPOINT=<AppSyncHttpEndpoint>
APPSYNC_PUBLISH_TOKEN=<same value as PublisherToken>
APPSYNC_AUTHORIZER_SECRET=<same value as AuthorizerSharedSecret>
```

Set only these public Cloudflare Pages build variables and rebuild the site:

```text
VITE_CHAT_REALTIME_PROVIDER=appsync
VITE_APPSYNC_HTTP_ENDPOINT=https://hzrd5pmdhvfobbzonf2hffeq5e.appsync-api.ap-south-1.amazonaws.com/event
VITE_APPSYNC_REALTIME_ENDPOINT=wss://hzrd5pmdhvfobbzonf2hffeq5e.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime
```

## Verification and operations

Verify one forum room, one direct-message room, the Socket.IO personal-state
and typing/presence paths, reconnect-after-token refresh, and room fallback
while AppSync is unavailable. Also confirm the
Node readiness endpoint and inspect AppSync 4XX/5XX, connection, subscription,
and event metrics in CloudWatch.

The dedicated realtime account has a USD 3 monthly account-wide AWS Budget
named `cirkle-appsync-monthly-usd-3`. It includes AppSync, Lambda, CloudWatch,
and any other charge incurred in that account, and emails the account owner at
80% forecast and 100% actual spend. A budget is an alert, not a hard spending
cap; review AppSync and Lambda metrics together if it fires. The production
CloudFormation stack also has termination protection enabled.

Event API request logging is intentionally disabled. AWS documents that those
request-level logs include request and response HTTP headers; this deployment's
authorization header contains either a short-lived Cirkle access token or the
server publisher token. CloudWatch's built-in Event API metrics provide error,
latency, connection, subscription, and message-volume observability without
persisting bearer material. The Lambda authorizer keeps only 14 days of its own
sanitized error logs and never logs the supplied token or shared secret.

The browser requests a synchronous WebSocket close on visibility loss, page
freeze/hide, or window blur. No browser can promise delivery of that close frame
after an abrupt process kill, device sleep, or network loss; in those cases AWS
recognizes the disconnect through its normal connection lifecycle. Treat the
foreground rule as a strong cost optimization, not a zero-connection-minute
guarantee.

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
