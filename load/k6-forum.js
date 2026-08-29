import http from "k6/http";
import ws from "k6/ws";
import { check, fail, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "TEST_JWT", "TEST_USER_ID", "PERF_PROJECT_REF"];
const missing = required.filter((name) => !__ENV[name]);
const projectRef = ((__ENV.SUPABASE_URL || "").match(/https:\/\/([^.]+)\.supabase\.co/) || [])[1];
if (__ENV.FORUM_LOAD_TEST_ACK !== "ISOLATED_PROJECT_ONLY" || missing.length || projectRef !== __ENV.PERF_PROJECT_REF) {
  fail(`Refusing forum load test. Use an isolated project, FORUM_LOAD_TEST_ACK=ISOLATED_PROJECT_ONLY, and set: ${missing.join(", ")}`);
}
if (["bugwubrwvlqayxwcazfd", "yzmqajpjzjgniciafsnk"].includes(projectRef)) {
  fail("Refusing to run against a known application project. Supply a dedicated performance project.");
}

const baseUrl = __ENV.SUPABASE_URL.replace(/\/$/, "");
const scopeType = __ENV.SCOPE_TYPE || "GLOBAL";
const scopeKey = __ENV.SCOPE_KEY || "LOAD_TEST";
const duration = __ENV.DURATION || "1m";
const runId = __ENV.RUN_ID || `forum-k6-${Date.now()}`;
const failedWrites = new Counter("forum_failed_writes");
const realtimeEvents = new Counter("forum_realtime_events");
const realtimeLag = new Trend("forum_realtime_lag_ms", true);

export const options = {
  scenarios: {
    posts: { executor: "constant-arrival-rate", exec: "writePost", rate: Number(__ENV.WRITE_RATE || 10), timeUnit: "1s", duration, preAllocatedVUs: 20, maxVUs: Number(__ENV.MAX_WRITE_VUS || 500) },
    history: { executor: "constant-arrival-rate", exec: "readPosts", rate: Number(__ENV.READ_RATE || 2), timeUnit: "1s", duration, preAllocatedVUs: 5, maxVUs: 100 },
    realtime: { executor: "constant-vus", exec: "subscribeRealtime", vus: Number(__ENV.REALTIME_SUBSCRIBERS || 5), duration, startTime: "1s" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<750", "p(99)<1500"],
    forum_failed_writes: ["count<1"], forum_realtime_events: ["count>0"], realtime_lag_ms: ["p(95)<2000"],
  },
};

const headers = { apikey: __ENV.SUPABASE_ANON_KEY, Authorization: `Bearer ${__ENV.TEST_JWT}`, "Content-Type": "application/json" };
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16); return (c === "x" ? r : (r & 3) | 8).toString(16);
});

export function writePost() {
  const id = uuid();
  const sentAt = Date.now();
  const response = http.post(`${baseUrl}/rest/v1/posts`, JSON.stringify({
    id, community_id: "default", scope_type: scopeType, scope_key: scopeKey, channel: "load-test",
    author_id: __ENV.TEST_USER_ID, content: `[load-test:${runId}:${sentAt}] ${id}`, is_anonymous: false,
  }), { headers: { ...headers, Prefer: "return=minimal" }, tags: { operation: "forum_post_write" } });
  if (!check(response, { "forum post persisted": (r) => r.status === 201 })) failedWrites.add(1);
}

export function readPosts() {
  const query = `select=id,content,created_at&scope_type=eq.${encodeURIComponent(scopeType)}&scope_key=eq.${encodeURIComponent(scopeKey)}&reply_to_id=is.null&order=created_at.desc,id.desc&limit=50`;
  const response = http.get(`${baseUrl}/rest/v1/posts?${query}`, { headers, tags: { operation: "forum_history" } });
  check(response, { "forum page returned": (r) => r.status === 200 });
  sleep(0.05);
}

export function subscribeRealtime() {
  const socketUrl = baseUrl.replace("https://", "wss://") + `/realtime/v1/websocket?apikey=${encodeURIComponent(__ENV.SUPABASE_ANON_KEY)}&vsn=1.0.0`;
  const topic = `realtime:forum:${scopeType}:${scopeKey}`;
  ws.connect(socketUrl, {}, (socket) => {
    socket.on("open", () => socket.send(JSON.stringify(["1", "1", topic, "phx_join", {
      config: { private: true, broadcast: { self: false, ack: false }, presence: { enabled: false }, postgres_changes: [] },
      access_token: __ENV.TEST_JWT,
    }])));
    socket.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw); } catch (_) { return; }
      const payload = frame?.[4]?.payload || frame?.[4];
      const content = payload?.new?.content || payload?.payload?.new?.content;
      const match = content?.match(/\[load-test:[^:]+:(\d+)\]/);
      if (match) { realtimeEvents.add(1); realtimeLag.add(Date.now() - Number(match[1])); }
    });
    socket.setInterval(() => socket.send(JSON.stringify([null, "hb", "phoenix", "heartbeat", {}])), 25_000);
    socket.setTimeout(() => socket.close(), Number(__ENV.REALTIME_SESSION_MS || 55_000));
  });
}
