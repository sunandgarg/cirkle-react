import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter } from "k6/metrics";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "TEST_JWT", "TEST_USER_ID", "ROOM_ID"];
const missing = required.filter((name) => !__ENV[name]);
if (__ENV.LOAD_TEST_ACK !== "I_UNDERSTAND" || missing.length > 0) {
  fail(`Refusing to write test messages. Set LOAD_TEST_ACK=I_UNDERSTAND and: ${missing.join(", ")}`);
}

const baseUrl = __ENV.SUPABASE_URL.replace(/\/$/, "");
const runId = __ENV.RUN_ID || `k6-${Date.now()}`;
const writeRate = Number(__ENV.WRITE_RATE || 10);
const readRate = Number(__ENV.READ_RATE || 2);
const duration = __ENV.DURATION || "1m";
const failedWrites = new Counter("chat_failed_writes");

export const options = {
  scenarios: {
    writes: {
      executor: "constant-arrival-rate",
      exec: "writeMessage",
      rate: writeRate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: Number(__ENV.WRITE_VUS || 20),
      maxVUs: Number(__ENV.WRITE_MAX_VUS || 500),
    },
    history_reads: {
      executor: "constant-arrival-rate",
      exec: "readHistory",
      rate: readRate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: Number(__ENV.READ_VUS || 5),
      maxVUs: Number(__ENV.READ_MAX_VUS || 100),
      startTime: "2s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
    chat_failed_writes: ["count<1"],
  },
};

const headers = {
  apikey: __ENV.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${__ENV.TEST_JWT}`,
  "Content-Type": "application/json",
};

const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
  const random = Math.floor(Math.random() * 16);
  return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
});

export function writeMessage() {
  const clientId = uuid();
  const response = http.post(`${baseUrl}/rest/v1/messages`, JSON.stringify({
    room_id: __ENV.ROOM_ID,
    sender_id: __ENV.TEST_USER_ID,
    client_id: clientId,
    content: `[load-test:${runId}] ${clientId}`,
    message_type: "text",
    status: "sent",
    read_by: [__ENV.TEST_USER_ID],
  }), { headers: { ...headers, Prefer: "return=minimal" }, tags: { operation: "chat_write" } });
  const ok = check(response, { "message persisted": (result) => result.status === 201 });
  if (!ok) failedWrites.add(1);
}

export function readHistory() {
  const query = "select=id,client_id,content,created_at,sender_id&room_id=eq." +
    encodeURIComponent(__ENV.ROOM_ID) + "&order=created_at.desc,id.desc&limit=50";
  const response = http.get(`${baseUrl}/rest/v1/messages?${query}`, {
    headers,
    tags: { operation: "chat_history" },
  });
  check(response, {
    "history returned": (result) => result.status === 200,
    "history is JSON": (result) => result.headers["Content-Type"]?.includes("application/json"),
  });
  sleep(0.05);
}
