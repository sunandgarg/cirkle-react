# Cirkle AWS realtime

This stack makes AppSync Events the low-latency transport while Supabase remains
the durable source of truth. It creates Lambda-authorized room subscriptions,
a server-only publisher, CloudWatch retention and an SNS topic reserved for
push delivery. Authenticated clients trigger a coalesced dispatcher with bounded
backoff; a one-minute secret-protected server retry drains stranded deliveries;
database cursors recover anything missed while a browser is offline.

Deploy in `ap-south-1` with CloudFormation. Generate a random 32-byte bridge
secret, pass it to the stack as `BridgeSecret`, and set the identical value as
the Supabase secret `AWS_REALTIME_BRIDGE_SECRET`. Set the stack output
`PublisherFunctionUrl` as `AWS_REALTIME_PUBLISHER_URL` in Supabase.

Set these public Cloudflare Pages build variables from the stack outputs:

```text
VITE_CHAT_REALTIME_PROVIDER=appsync
VITE_APPSYNC_HTTP_ENDPOINT=<AppSyncHttpEndpoint>
VITE_APPSYNC_REALTIME_ENDPOINT=<AppSyncRealtimeEndpoint>
```

The delivery Lambda publishes with short-lived IAM role credentials and SigV4.
Its function URL also requires SigV4 from the dedicated, least-privilege
`cirkle-supabase-realtime-dispatcher` user; the bridge secret remains a second
server-side check. There is no public Lambda invocation path or expiring AppSync
API key in the delivery flow. No AWS credential, Lambda secret or Supabase
service-role key belongs in the browser build.
