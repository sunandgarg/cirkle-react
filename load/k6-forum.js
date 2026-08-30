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
const realtimeWarmup = __ENV.REALTIME_WARMUP || "3s";
const writeRate = Number(__ENV.WRITE_RATE || 10);
const readRate = Number(__ENV.READ_RATE || 2);
const realtimeSubscribers = Number(__ENV.REALTIME_SUBSCRIBERS || 5);
const realtimeJwt = __ENV.REALTIME_JWT || __ENV.TEST_JWT;
const durationToMs = (value) => {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) fail(`Unsupported duration: ${value}`);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]];
  return Number(match[1]) * multiplier;
};
const realtimeDuration = `${durationToMs(duration) + durationToMs(realtimeWarmup)}ms`;
const runId = __ENV.RUN_ID || `forum-k6-${Date.now()}`;
const debugRealtime = __ENV.DEBUG_REALTIME === "1";
if (__ENV.PLAN_PROFILE === "PRO_SPEND_CAP") {
  const estimatedRealtimeEventsPerSecond = writeRate * (realtimeSubscribers + 1);
  if (realtimeSubscribers > 500 || estimatedRealtimeEventsPerSecond > 500) {
    fail(`Refusing to exceed the Supabase Pro Spend Cap profile: estimated ${estimatedRealtimeEventsPerSecond} Realtime events/s across ${realtimeSubscribers} subscribers.`);
  }
}
const failedWrites = new Counter("forum_failed_writes");
const realtimeEvents = new Counter("forum_realtime_events");
const realtimeLag = new Trend("forum_realtime_lag_ms", true);

export const options = {
  scenarios: {
    posts: { executor: "constant-arrival-rate", exec: "writePost", rate: writeRate, timeUnit: "1s", duration, startTime: realtimeWarmup, preAllocatedVUs: 20, maxVUs: Number(__ENV.MAX_WRITE_VUS || 500) },
    history: { executor: "constant-arrival-rate", exec: "readPosts", rate: readRate, timeUnit: "1s", duration, startTime: realtimeWarmup, preAllocatedVUs: 5, maxVUs: 100 },
    realtime: { executor: "constant-vus", exec: "subscribeRealtime", vus: realtimeSubscribers, duration: realtimeDuration },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<750", "p(99)<1500"],
    forum_failed_writes: ["count<1"], forum_realtime_events: ["count>0"], forum_realtime_lag_ms: ["p(95)<2000"],
  },
};

const headers = { apikey: __ENV.SUPABASE_ANON_KEY, Authorization: `Bearer ${__ENV.TEST_JWT}`, "Content-Type": "application/json" };
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16); return (c === "x" ? r : (r & 3) | 8).toString(16);
});

// k6's goja runtime does not expose the browser TextDecoder global.
const decodeUtf8 = (bytes) => {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let codePoint;
    if (first < 0x80) {
      codePoint = first;
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = ((first & 0x1f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = ((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    } else {
      codePoint = ((first & 0x07) << 18) | ((bytes[index++] & 0x3f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    }
    if (codePoint <= 0xffff) {
      result += String.fromCharCode(codePoint);
    } else {
      codePoint -= 0x10000;
      result += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    }
  }
  return result;
};
const decodeServerBroadcast = (raw) => {
  const bytes = new Uint8Array(raw);
  if (bytes.length < 5 || bytes[0] !== 0x04) return null;
  const topicSize = bytes[1];
  const eventSize = bytes[2];
  const metadataSize = bytes[3];
  const payloadEncoding = bytes[4];
  let offset = 5;
  const topic = decodeUtf8(bytes.slice(offset, offset += topicSize));
  const event = decodeUtf8(bytes.slice(offset, offset += eventSize));
  const metadataText = decodeUtf8(bytes.slice(offset, offset += metadataSize));
  const payloadBytes = bytes.slice(offset);
  let payload = payloadBytes;
  if (payloadEncoding === 1) {
    try { payload = JSON.parse(decodeUtf8(payloadBytes)); } catch (_) { return null; }
  }
  let meta = {};
  try { meta = metadataText ? JSON.parse(metadataText) : {}; } catch (_) { return null; }
  return { topic, event, meta, payload };
};

const recordRealtimePayload = (payload) => {
  const content = payload?.record?.content || payload?.new?.content || payload?.payload?.record?.content || payload?.payload?.new?.content;
  const match = content?.match(/\[load-test:[^:]+:(\d+)\]/);
  if (match) {
    realtimeEvents.add(1);
    realtimeLag.add(Date.now() - Number(match[1]));
  }
};

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
  // Array frames require Phoenix/Supabase protocol v2. A v1 URL accepts the
  // WebSocket but silently ignores these frames, producing a false zero-event test.
  const socketUrl = baseUrl.replace("https://", "wss://") + `/realtime/v1/websocket?apikey=${encodeURIComponent(__ENV.SUPABASE_ANON_KEY)}&vsn=2.0.0`;
  const topic = `realtime:forum:${scopeType}:${scopeKey}`;
  ws.connect(socketUrl, {}, (socket) => {
    socket.on("open", () => socket.send(JSON.stringify(["1", "1", topic, "phx_join", {
      config: { private: true, broadcast: { self: false, ack: false, replication_ready: true }, presence: { enabled: false }, postgres_changes: [] },
      access_token: realtimeJwt,
    }])));
    socket.on("message", (raw) => {
      if (debugRealtime) console.log(`realtime-frame ${raw}`);
      let frame;
      try { frame = JSON.parse(raw); } catch (_) { return; }
      const payload = frame?.[4]?.payload || frame?.[4];
      recordRealtimePayload(payload);
    });
    socket.on("binaryMessage", (raw) => {
      const frame = decodeServerBroadcast(raw);
      if (debugRealtime && frame) console.log(`realtime-binary event=${frame.event} topic=${frame.topic}`);
      if (frame) recordRealtimePayload(frame.payload);
    });
    socket.on("error", (error) => {
      if (debugRealtime) console.error(`realtime-error ${String(error)}`);
    });
    socket.setInterval(() => socket.send(JSON.stringify([null, "hb", "phoenix", "heartbeat", {}])), 25_000);
    socket.setTimeout(() => socket.close(), Number(__ENV.REALTIME_SESSION_MS || 55_000));
  });
}
