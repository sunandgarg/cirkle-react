import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter } from "k6/metrics";

const ACK = "I_UNDERSTAND_THIS_WRITES_TEST_FORUM_POSTS";
const PRODUCTION_ACK = "I_ACCEPT_PRODUCTION_LOAD_TEST_WRITES";
const allowedTargets = ["local", "development", "test", "staging", "performance", "production"];
const required = ["API_URL", "TEST_JWT", "TARGET_ENV"];
const missing = required.filter((name) => !__ENV[name]);

if (__ENV.FORUM_LOAD_TEST_ACK !== ACK || missing.length > 0) {
  fail(`Refusing forum load test. Set FORUM_LOAD_TEST_ACK=${ACK} and: ${missing.join(", ")}`);
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
const scopeType = __ENV.SCOPE_TYPE || "GLOBAL";
const scopeKey = __ENV.SCOPE_KEY || "LOAD_TEST";
const duration = __ENV.DURATION || "1m";
const writeRate = Number(__ENV.WRITE_RATE || 10);
const readRate = Number(__ENV.READ_RATE || 2);
if (!Number.isFinite(writeRate) || writeRate < 0 || !Number.isFinite(readRate) || readRate < 0) {
  fail("WRITE_RATE and READ_RATE must be non-negative numbers.");
}
if (writeRate === 0 && readRate === 0) {
  fail("At least one of WRITE_RATE or READ_RATE must be greater than zero.");
}

const runId = __ENV.RUN_ID || `forum-k6-${Date.now()}`;
const failedWrites = new Counter("forum_failed_writes");
const scenarios = {};
if (writeRate > 0) {
  scenarios.posts = {
    executor: "constant-arrival-rate",
    exec: "writePost",
    rate: writeRate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs: Number(__ENV.WRITE_VUS || 20),
    maxVUs: Number(__ENV.WRITE_MAX_VUS || 500),
  };
}
if (readRate > 0) {
  scenarios.history = {
    executor: "constant-arrival-rate",
    exec: "readPosts",
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
    ...(writeRate > 0 ? { forum_failed_writes: ["count<1"] } : {}),
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

export function writePost() {
  const id = uuid();
  const sentAt = Date.now();
  const response = http.post(endpoint, JSON.stringify({
    table: "posts",
    operation: "insert",
    values: {
      id,
      scope_type: scopeType,
      scope_key: scopeKey,
      channel: "load-test",
      content: `[load-test:${runId}:${sentAt}] ${id}`,
      is_anonymous: false,
    },
    filters: [],
    order: [],
    cardinality: "many",
  }), { headers, tags: { operation: "forum_post_write" } });
  const data = parseData(response);
  const ok = check(response, {
    "forum post persisted": (result) => result.status === 200,
    "write returned the post": () => Array.isArray(data) && data.some((row) => row?.id === id),
  });
  if (!ok) failedWrites.add(1);
}

export function readPosts() {
  const response = http.post(endpoint, JSON.stringify({
    table: "posts",
    operation: "select",
    columns: ["id", "content", "created_at"],
    filters: [
      { column: "scope_type", operator: "eq", value: scopeType },
      { column: "scope_key", operator: "eq", value: scopeKey },
      { column: "reply_to_id", operator: "is", value: null },
    ],
    order: [
      { column: "created_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit: 50,
    cardinality: "many",
  }), { headers, tags: { operation: "forum_history" } });
  check(response, {
    "forum page returned": (result) => result.status === 200,
    "forum page is an array": () => Array.isArray(parseData(response)),
  });
  sleep(0.05);
}
