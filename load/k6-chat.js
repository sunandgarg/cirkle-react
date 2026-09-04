import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter } from "k6/metrics";

const ACK = "I_UNDERSTAND_THIS_WRITES_TEST_CHAT_MESSAGES";
const PRODUCTION_ACK = "I_ACCEPT_PRODUCTION_LOAD_TEST_WRITES";
const allowedTargets = ["local", "development", "test", "staging", "performance", "production"];
const required = ["API_URL", "TEST_JWT", "TEST_USER_ID", "ROOM_ID", "TARGET_ENV"];
const missing = required.filter((name) => !__ENV[name]);

if (__ENV.LOAD_TEST_ACK !== ACK || missing.length > 0) {
  fail(`Refusing chat load test. Set LOAD_TEST_ACK=${ACK} and: ${missing.join(", ")}`);
}

const targetEnvironment = String(__ENV.TARGET_ENV).toLowerCase();
if (!allowedTargets.includes(targetEnvironment)) {
  fail(`TARGET_ENV must be one of: ${allowedTargets.join(", ")}`);
}

const apiOriginMatch = String(__ENV.API_URL).trim().match(/^(https?):\/\/([^/?#]+)\/?$/i);
if (!apiOriginMatch) {
  fail("API_URL must be an HTTP(S) origin without a path, query, or fragment (for example http://localhost:3001).");
}
if (apiOriginMatch[2].includes("@")) {
  fail("API_URL must not contain embedded credentials.");
}
const apiOrigin = String(__ENV.API_URL).trim().replace(/\/+$/, "");
const hostname = apiOriginMatch[2].replace(/^\[|\]$/g, "").split(":")[0].replace(/\.$/, "").toLowerCase();
const isKnownProductionHost = hostname === "cirkle.world" || hostname.endsWith(".cirkle.world");
if (isKnownProductionHost && targetEnvironment !== "production") {
  fail("Refusing a cirkle.world target unless TARGET_ENV=production is explicit.");
}
if ((targetEnvironment === "production" || isKnownProductionHost)
    && (__ENV.ALLOW_PRODUCTION_LOAD_TEST !== "true" || __ENV.PRODUCTION_LOAD_TEST_ACK !== PRODUCTION_ACK)) {
  fail(`Production is disabled. To opt in, set ALLOW_PRODUCTION_LOAD_TEST=true and PRODUCTION_LOAD_TEST_ACK=${PRODUCTION_ACK}.`);
}
if ((targetEnvironment === "production" || isKnownProductionHost) && apiOriginMatch[1].toLowerCase() !== "https") {
  fail("Production load tests require an HTTPS API_URL.");
}

const endpoint = `${apiOrigin}/api/data/query`;
const runId = __ENV.RUN_ID || `k6-chat-${Date.now()}`;
const writeRate = Number(__ENV.WRITE_RATE || 10);
const readRate = Number(__ENV.READ_RATE || 2);
const duration = __ENV.DURATION || "1m";
if (!Number.isFinite(writeRate) || writeRate < 0 || !Number.isFinite(readRate) || readRate < 0) {
  fail("WRITE_RATE and READ_RATE must be non-negative numbers.");
}
if (writeRate === 0 && readRate === 0) {
  fail("At least one of WRITE_RATE or READ_RATE must be greater than zero.");
}

const failedWrites = new Counter("chat_failed_writes");
const scenarios = {};
if (writeRate > 0) {
  scenarios.writes = {
    executor: "constant-arrival-rate",
    exec: "writeMessage",
    rate: writeRate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Number(__ENV.WRITE_VUS || 20),
    maxVUs: Number(__ENV.WRITE_MAX_VUS || 500),
  };
}
if (readRate > 0) {
  scenarios.history_reads = {
    executor: "constant-arrival-rate",
    exec: "readHistory",
    rate: readRate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Number(__ENV.READ_VUS || 5),
    maxVUs: Number(__ENV.READ_MAX_VUS || 100),
    startTime: writeRate > 0 ? "2s" : "0s",
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
    ...(writeRate > 0 ? { chat_failed_writes: ["count<1"] } : {}),
  },
};

const headers = {
  Authorization: `Bearer ${__ENV.TEST_JWT}`,
  "Content-Type": "application/json",
};

const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
  const random = Math.floor(Math.random() * 16);
  return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
});

const parseData = (response) => {
  try {
    return response.json("data");
  } catch (_) {
    return null;
  }
};

export function writeMessage() {
  const clientId = uuid();
  const response = http.post(endpoint, JSON.stringify({
    table: "messages",
    operation: "insert",
    values: {
      id: uuid(),
      room_id: __ENV.ROOM_ID,
      sender_id: __ENV.TEST_USER_ID,
      client_id: clientId,
      content: `[load-test:${runId}] ${clientId}`,
      message_type: "text",
      status: "sent",
      read_by: [__ENV.TEST_USER_ID],
    },
    filters: [],
    order: [],
    cardinality: "many",
  }), { headers, tags: { operation: "chat_write" } });
  const data = parseData(response);
  const ok = check(response, {
    "message persisted": (result) => result.status === 200,
    "write returned the message": () => Array.isArray(data) && data.some((row) => row?.client_id === clientId),
  });
  if (!ok) failedWrites.add(1);
}

export function readHistory() {
  const response = http.post(endpoint, JSON.stringify({
    table: "messages",
    operation: "select",
    columns: ["id", "client_id", "content", "created_at", "sender_id"],
    filters: [{ column: "room_id", operator: "eq", value: __ENV.ROOM_ID }],
    order: [
      { column: "created_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit: 50,
    cardinality: "many",
  }), { headers, tags: { operation: "chat_history" } });
  check(response, {
    "history returned": (result) => result.status === 200,
    "history is an array": () => Array.isArray(parseData(response)),
  });
  sleep(0.05);
}
