import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";

const ACK = "I_UNDERSTAND_THIS_WRITES_AND_DELETES_TEST_FORUM_POSTS";
const PRODUCTION_ACK = "I_ACCEPT_PRODUCTION_LOAD_TEST_WRITES";
const allowedTargets = new Set(["local", "development", "test", "staging", "performance", "production"]);
const required = ["API_URL", "TARGET_ENV", "TEST_USER_EMAIL", "TEST_USER_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
const agentCount = Number(process.env.TEST_AGENTS || 50);

if (process.env.LIVE_FORUM_TEST_ACK !== ACK || missing.length > 0) {
  throw new Error(`Refusing live forum test. Set LIVE_FORUM_TEST_ACK=${ACK} and: ${missing.join(", ")}`);
}
if (!Number.isInteger(agentCount) || agentCount < 2 || agentCount > 50) {
  throw new Error("TEST_AGENTS must be an integer from 2 through 50.");
}

const targetEnvironment = String(process.env.TARGET_ENV).toLowerCase();
if (!allowedTargets.has(targetEnvironment)) {
  throw new Error(`TARGET_ENV must be one of: ${[...allowedTargets].join(", ")}`);
}

let target;
try {
  target = new URL(process.env.API_URL);
} catch {
  throw new Error("API_URL must be a valid HTTP(S) origin (for example http://localhost:3001).");
}
if (!/^https?:$/.test(target.protocol)
    || target.username
    || target.password
    || (target.pathname && target.pathname !== "/")
    || target.search
    || target.hash) {
  throw new Error("API_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.");
}

const targetHostname = target.hostname.replace(/\.$/, "").toLowerCase();
const isKnownProductionHost = targetHostname === "cirkle.world" || targetHostname.endsWith(".cirkle.world");
if (isKnownProductionHost && targetEnvironment !== "production") {
  throw new Error("Refusing a cirkle.world target unless TARGET_ENV=production is explicit.");
}
if ((targetEnvironment === "production" || isKnownProductionHost)
    && (process.env.ALLOW_PRODUCTION_LOAD_TEST !== "true" || process.env.PRODUCTION_LOAD_TEST_ACK !== PRODUCTION_ACK)) {
  throw new Error(`Production is disabled. To opt in, set ALLOW_PRODUCTION_LOAD_TEST=true and PRODUCTION_LOAD_TEST_ACK=${PRODUCTION_ACK}.`);
}
if ((targetEnvironment === "production" || isKnownProductionHost) && target.protocol !== "https:") {
  throw new Error("Production load tests require an HTTPS API_URL.");
}

const apiOrigin = target.origin;
const apiBase = `${apiOrigin}/api`;
const socketPath = "/api/socket.io";
const scope = {
  type: process.env.SCOPE_TYPE || "GLOBAL",
  key: process.env.SCOPE_KEY || "LOAD_TEST",
};
const socketChannel = process.env.SOCKET_CHANNEL || `forum:${scope.type}:${scope.key}`;
const runId = process.env.RUN_ID || `live-forum-50-${Date.now()}`;
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 20_000);
const deliveryTimeoutMs = Number(process.env.DELIVERY_TIMEOUT_MS || 30_000);
const connectBatchSize = Number(process.env.CONNECT_BATCH_SIZE || 10);
const writeBatchSize = Number(process.env.WRITE_BATCH_SIZE || agentCount);

for (const [name, value] of [
  ["REQUEST_TIMEOUT_MS", requestTimeoutMs],
  ["DELIVERY_TIMEOUT_MS", deliveryTimeoutMs],
  ["CONNECT_BATCH_SIZE", connectBatchSize],
  ["WRITE_BATCH_SIZE", writeBatchSize],
]) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
}
if (connectBatchSize > 50 || writeBatchSize > 50) {
  throw new Error("CONNECT_BATCH_SIZE and WRITE_BATCH_SIZE cannot exceed 50.");
}

const sockets = [];
const generatedPostIds = new Set();
const expectedRoots = new Map();
const expectedReplies = new Map();
const rootLatencies = [];
const replyLatencies = [];
let accessToken;
let refreshCookie;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
};
const latencySummary = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : null,
});

const waitFor = async (predicate, label, timeoutMs = deliveryTimeoutMs) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await pause(25);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
};

const runBatched = async (items, batchSize, operation) => {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const settled = await Promise.allSettled(items.slice(index, index + batchSize).map(operation));
    results.push(...settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value));
    const rejected = settled.find((entry) => entry.status === "rejected");
    if (rejected) throw rejected.reason;
  }
  return results;
};

const apiFetch = async (path, { token, body, headers = {}, ...init } = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(requestTimeoutMs),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!response.ok) {
    const preview = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    throw new Error(`${path} returned ${response.status}: ${String(preview).slice(0, 500)}`);
  }
  return { body: parsed, response };
};

const dataQuery = async (query) => {
  const { body } = await apiFetch("/data/query", {
    method: "POST",
    token: accessToken,
    body: query,
  });
  return body?.data;
};

const logIn = async () => {
  const { body, response } = await apiFetch("/auth/login", {
    method: "POST",
    body: {
      email: process.env.TEST_USER_EMAIL,
      password: process.env.TEST_USER_PASSWORD,
    },
  });
  if (!body?.access_token || !body?.user?.id) {
    throw new Error("The login response did not contain an access token and user id.");
  }
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()[0]
    : response.headers.get("set-cookie");
  refreshCookie = setCookie?.split(";", 1)[0];
  accessToken = body.access_token;
  return body.user;
};

const logOut = async () => {
  if (!accessToken) return;
  await apiFetch("/auth/logout", {
    method: "POST",
    token: accessToken,
    headers: refreshCookie ? { Cookie: refreshCookie } : {},
  });
};

const insertPost = async ({ id, phase, index, replyToId = null }) => {
  generatedPostIds.add(id);
  const sentAt = Date.now();
  const expected = phase === "root" ? expectedRoots : expectedReplies;
  expected.set(id, sentAt);
  const data = await dataQuery({
    table: "posts",
    operation: "insert",
    values: {
      id,
      scope_type: scope.type,
      scope_key: scope.key,
      channel: "load-test",
      content: `[load-test:${runId}:${phase}:${index}:sent=${sentAt}]`,
      is_anonymous: false,
      ...(replyToId ? { reply_to_id: replyToId } : {}),
    },
    filters: [],
    order: [],
    cardinality: "single",
  });
  if (data?.id !== id) throw new Error(`Insert did not return expected ${phase} post ${id}`);
  return data;
};

const extractChange = (envelope) => {
  if (!envelope || typeof envelope !== "object") return null;
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : envelope;
  const event = String(envelope.event || payload.eventType || payload.event || "").toUpperCase();
  const row = event === "DELETE"
    ? payload.old || envelope.old
    : payload.new || payload.row || payload.record || envelope.new;
  return row && typeof row === "object" ? { event, row } : null;
};

class SocketAgent {
  constructor(index) {
    this.index = index;
    this.rootIds = new Set();
    this.replyIds = new Set();
    this.errors = [];
    this.disconnectedEarly = false;
  }

  recordEnvelope = (envelope) => {
    if (envelope?.channel && envelope.channel !== socketChannel) return;
    const change = extractChange(envelope);
    if (!change || change.event !== "INSERT") return;
    const { row } = change;
    if (row.scope_type !== scope.type || row.scope_key !== scope.key) return;

    const rootSentAt = expectedRoots.get(row.id);
    if (rootSentAt && !this.rootIds.has(row.id)) {
      this.rootIds.add(row.id);
      rootLatencies.push(Date.now() - rootSentAt);
    }
    const replySentAt = expectedReplies.get(row.id);
    if (replySentAt && !this.replyIds.has(row.id)) {
      this.replyIds.add(row.id);
      replyLatencies.push(Date.now() - replySentAt);
    }
  };

  async connect() {
    this.socket = io(apiOrigin, {
      path: socketPath,
      transports: ["websocket", "polling"],
      auth: { token: accessToken },
      extraHeaders: { Authorization: `Bearer ${accessToken}` },
      forceNew: true,
      reconnection: false,
      timeout: requestTimeoutMs,
    });
    this.socket.on("realtime:event", this.recordEnvelope);
    this.socket.on("connect_error", (error) => this.errors.push(`connect_error: ${error.message}`));
    this.socket.on("error", (error) => this.errors.push(`error: ${error?.message || String(error)}`));
    this.socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") this.disconnectedEarly = true;
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error(`Socket agent ${this.index} subscription timed out`)),
        requestTimeoutMs,
      );
      this.socket.once("connect_error", (error) => finish(new Error(`Socket agent ${this.index} failed: ${error.message}`)));
      this.socket.once("connect", () => {
        this.socket.emit("realtime:subscribe", {
          channel: socketChannel,
          config: { private: true },
          bindings: [{
            type: "postgres_changes",
            filter: {
              event: "INSERT",
              schema: "public",
              table: "posts",
              filter: `scope_type=eq.${scope.type},scope_key=eq.${scope.key}`,
            },
          }],
        }, (acknowledgement = {}) => {
          if (acknowledgement.ok === false || acknowledgement.status === "error") {
            finish(new Error(`Socket agent ${this.index} subscription rejected: ${acknowledgement.error || "unknown error"}`));
          } else {
            finish();
          }
        });
      });
    });
  }

  close() {
    try {
      this.socket?.emit("realtime:unsubscribe", { channel: socketChannel });
      this.socket?.disconnect();
    } catch {
      // Cleanup is best-effort; persistence cleanup still runs below.
    }
  }
}

const cleanupPosts = async () => {
  const ids = [...generatedPostIds];
  for (let index = 0; index < ids.length; index += 100) {
    await dataQuery({
      table: "posts",
      operation: "delete",
      filters: [{ column: "id", operator: "in", value: ids.slice(index, index + 100) }],
      order: [],
      cardinality: "many",
    });
  }
};

let failure;
try {
  const user = await logIn();
  console.log(JSON.stringify({
    phase: "connect-sockets",
    runId,
    socketClients: agentCount,
    testUserId: user.id,
    scope,
    socketChannel,
  }));

  const agents = Array.from({ length: agentCount }, (_, index) => new SocketAgent(index));
  sockets.push(...agents);
  const connectStarted = Date.now();
  await runBatched(agents, connectBatchSize, (agent) => agent.connect());
  const connectMs = Date.now() - connectStarted;

  console.log(JSON.stringify({ phase: "root-burst", posts: agentCount }));
  const rootPlans = Array.from({ length: agentCount }, (_, index) => ({ id: randomUUID(), phase: "root", index }));
  const rootPosts = await runBatched(rootPlans, writeBatchSize, insertPost);
  const rootDeliveryMs = await waitFor(
    () => agents.every((agent) => agent.rootIds.size === agentCount),
    `${agentCount} roots to ${agentCount} socket clients`,
  );

  const rootId = rootPosts[0].id;
  console.log(JSON.stringify({ phase: "reply-burst", posts: agentCount, rootId }));
  const replyPlans = Array.from({ length: agentCount }, (_, index) => ({
    id: randomUUID(),
    phase: "reply",
    index,
    replyToId: rootId,
  }));
  const replies = await runBatched(replyPlans, writeBatchSize, insertPost);
  const replyDeliveryMs = await waitFor(
    () => agents.every((agent) => agent.replyIds.size === agentCount),
    `${agentCount} replies to ${agentCount} socket clients`,
  );

  const allPostIds = [...rootPosts, ...replies].map((post) => post.id);
  const persisted = await dataQuery({
    table: "posts",
    operation: "select",
    columns: ["id", "reply_to_id"],
    filters: [{ column: "id", operator: "in", value: allPostIds }],
    order: [],
    limit: allPostIds.length,
    cardinality: "many",
  });
  const persistedIds = new Set((Array.isArray(persisted) ? persisted : []).map((post) => post.id));
  const missingPostIds = allPostIds.filter((id) => !persistedIds.has(id));
  if (missingPostIds.length) throw new Error(`Persistence verification missed ${missingPostIds.length} generated posts.`);

  const socketErrors = agents.flatMap((agent) => agent.errors.map((error) => ({ agent: agent.index, error })));
  const disconnectedEarly = agents.filter((agent) => agent.disconnectedEarly).map((agent) => agent.index);
  if (socketErrors.length || disconnectedEarly.length) {
    throw new Error(`Socket health failed: errors=${socketErrors.length}, earlyDisconnects=${disconnectedEarly.length}`);
  }

  console.log(JSON.stringify({
    status: "PASS",
    runId,
    identityMode: "one-existing-test-user",
    socketClients: agentCount,
    scope,
    socketChannel,
    connectMs,
    roots: {
      persisted: rootPosts.length,
      expectedFanoutDeliveries: agentCount * agentCount,
      observedFanoutDeliveries: agents.reduce((sum, agent) => sum + agent.rootIds.size, 0),
      allClientsCompleteMs: rootDeliveryMs,
      latencyMs: latencySummary(rootLatencies),
    },
    replies: {
      persisted: replies.length,
      expectedFanoutDeliveries: agentCount * agentCount,
      observedFanoutDeliveries: agents.reduce((sum, agent) => sum + agent.replyIds.size, 0),
      allClientsCompleteMs: replyDeliveryMs,
      latencyMs: latencySummary(replyLatencies),
    },
  }));
} catch (error) {
  failure = error;
} finally {
  sockets.forEach((socket) => socket.close());
  if (accessToken && generatedPostIds.size) {
    try {
      await cleanupPosts();
      console.log(JSON.stringify({ phase: "cleanup", deletedGeneratedPosts: generatedPostIds.size }));
    } catch (error) {
      console.error(JSON.stringify({ phase: "cleanup-failed", runId, generatedPostIds: [...generatedPostIds], error: error.message }));
      if (!failure) failure = error;
    }
  }
  if (accessToken) {
    try {
      await logOut();
    } catch (error) {
      console.error(JSON.stringify({ phase: "logout-failed", error: error.message }));
      if (!failure) failure = error;
    }
  }
}

if (failure) throw failure;
