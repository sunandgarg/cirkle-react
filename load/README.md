# Chat capacity validation

The repository includes two complementary checks:

- `npm run test:chat-load` is a deterministic local simulation that validates ordering, room isolation, fan-out and cache behavior without touching production.
- `npm run test:chat-load:live` writes real forum `posts`, reads paginated history, and keeps real private Supabase Realtime subscribers connected against an isolated performance project.

## Safety and required environment

Never run the live test against the production database. Use a separate project populated with synthetic users and a room whose members are only test accounts. The script refuses to start unless these variables exist:

```text
FORUM_LOAD_TEST_ACK=ISOLATED_PROJECT_ONLY
PERF_PROJECT_REF=dedicated-performance-project-ref
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_ANON_KEY=...
TEST_JWT=...
TEST_USER_ID=...
SCOPE_TYPE=GLOBAL
SCOPE_KEY=LOAD_TEST
```

Optional controls are `WRITE_RATE`, `READ_RATE`, `REALTIME_SUBSCRIBERS`, `DURATION`, `MAX_WRITE_VUS`, `REALTIME_SESSION_MS`, and `RUN_ID`. The harness refuses both known application project refs and any URL that does not match `PERF_PROJECT_REF`. Every generated message is tagged `[load-test:<RUN_ID>:<timestamp>]` for isolated-project cleanup and end-to-end Realtime latency measurement.

## 100 million messages/day qualification

One hundred million persisted messages/day averages about 1,158 writes/second. Qualify at no less than ten times that average (about 12,000 writes/second) for the expected peak window, with realistic concurrent history reads and Realtime subscribers. Increase in stages (10, 100, 1,000, 5,000, then 12,000 writes/second), stop on the first failed threshold, and retain the Supabase database, Realtime, connection-pool, WAL, storage, CPU and egress metrics for each run.

Passing the local simulation or a small live run is not a 100-million/day certification. Certification requires an isolated full-scale test on the actual Supabase plan and region, followed by a soak test and a reviewed capacity report.
