# Cirkle AWS realtime

This stack makes AppSync Events the low-latency transport while Supabase remains
the durable source of truth. It creates Lambda-authorized room subscriptions,
a server-only publisher, a one-minute retry schedule, CloudWatch retention and
an SNS topic reserved for push delivery.

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

No AppSync API key, AWS credential, Lambda secret or Supabase service-role key
belongs in the browser build.
