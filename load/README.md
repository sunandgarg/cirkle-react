# Chat capacity validation

The repository includes two complementary checks:

- `npm run test:chat-load` is a deterministic local simulation that validates ordering, room isolation, fan-out and cache behavior without touching production.
- `npm run test:chat-load:live` runs an authenticated k6 write/read test against an isolated Supabase performance project.

## Safety and required environment

Never run the live test against the production database. Use a separate project populated with synthetic users and a room whose members are only test accounts. The script refuses to start unless these variables exist:

```text
LOAD_TEST_ACK=I_UNDERSTAND
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_ANON_KEY=...
TEST_JWT=...
TEST_USER_ID=...
ROOM_ID=...
```

Optional controls are `WRITE_RATE`, `READ_RATE`, `DURATION`, `WRITE_VUS`, `WRITE_MAX_VUS`, `READ_VUS`, `READ_MAX_VUS`, and `RUN_ID`. Every generated message begins with `[load-test:<RUN_ID>]` so it can be removed safely from the isolated project.

## 100 million messages/day qualification

One hundred million persisted messages/day averages about 1,158 writes/second. Qualify at no less than ten times that average (about 12,000 writes/second) for the expected peak window, with realistic concurrent history reads and Realtime subscribers. Increase in stages (10, 100, 1,000, 5,000, then 12,000 writes/second), stop on the first failed threshold, and retain the Supabase database, Realtime, connection-pool, WAL, storage, CPU and egress metrics for each run.

Passing the local simulation or a small live run is not a 100-million/day certification. Certification requires an isolated full-scale test on the actual Supabase plan and region, followed by a soak test and a reviewed capacity report.
