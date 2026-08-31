import { createClient } from "@supabase/supabase-js";

const AGENT_COUNT = Number(process.env.TEST_AGENTS || 50);
const ACK = "PRODUCTION_SYNTHETIC_USERS_WITH_CLEANUP";
const required = [
  "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_PUBLISHABLE_KEY",
  "APPSYNC_HTTP_ENDPOINT", "APPSYNC_REALTIME_ENDPOINT",
];
const missing = required.filter((name) => !process.env[name]);
if (process.env.LIVE_FORUM_TEST_ACK !== ACK || missing.length || AGENT_COUNT < 2 || AGENT_COUNT > 50) {
  throw new Error(`Refusing live forum test. Set LIVE_FORUM_TEST_ACK=${ACK}, TEST_AGENTS=2..50 and: ${missing.join(", ")}`);
}

const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const appSyncHttp = process.env.APPSYNC_HTTP_ENDPOINT;
const appSyncRealtime = process.env.APPSYNC_REALTIME_ENDPOINT;
const runId = `live-forum-50-${Date.now()}`;
const password = `Cirkle-${crypto.randomUUID()}-Aa1!`;
const scope = { type: "GLOBAL", key: "IIT_ALL" };
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [];
const postIds = [];
const sockets = [];
const rootLatencies = [];
const replyLatencies = [];
let sampleDataLogged = false;

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 20_000) => {
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
    const rejected = settled.find((entry) => entry.status === "rejected");
    results.push(...settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value));
    // Wait for the complete batch before surfacing a failure. This guarantees
    // the finally block cannot race user creation that is still in flight.
    if (rejected) throw rejected.reason;
  }
  return results;
};
const cleanupStaleAgents = async () => {
  const staleUsers = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1_000 });
    if (error) throw error;
    const pageUsers = data?.users || [];
    staleUsers.push(...pageUsers.filter((user) =>
      user.email?.startsWith("cirkle-live-live-forum-50-") && user.email.endsWith("@example.invalid")));
    if (pageUsers.length < 1_000) break;
  }
  if (!staleUsers.length) return 0;

  const staleUserIds = staleUsers.map((user) => user.id);
  const { data: stalePosts, error: postError } = await admin
    .from("posts").select("id").in("author_id", staleUserIds);
  if (postError) throw postError;
  await runBatched(staleUsers, 5, async (user) => {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw error;
  });
  const stalePostIds = (stalePosts || []).map((post) => post.id);
  if (stalePostIds.length) {
    const { error } = await admin.from("realtime_delivery_outbox").delete().in("aggregate_id", stalePostIds);
    if (error) throw error;
  }
  return staleUsers.length;
};
const userFetch = async (token, path, init = {}) => {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return body;
};
const signIn = async (email) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json();
    if (response.ok && body.access_token) return body.access_token;
    if (response.status !== 429 || attempt === 9) {
      throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(body)}`);
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : Math.min(30_000, 1_000 * (2 ** attempt));
    await pause(retryMs + Math.floor(Math.random() * 250));
  }
  throw new Error(`Sign-in retry budget exhausted for ${email}`);
};
const sendForumPost = (user, content, replyToId = null) => userFetch(user.token, "/rest/v1/rpc/create_forum_post", {
  method: "POST",
  body: JSON.stringify({
    p_id: crypto.randomUUID(), p_scope_type: scope.type, p_scope_key: scope.key,
    p_content: content, p_is_anonymous: false, p_reply_to_id: replyToId,
  }),
});
const dispatch = (token) => userFetch(token, "/functions/v1/dispatch-realtime-outbox", {
  method: "POST", body: "{}",
});

class AppSyncAgent {
  constructor(user, index) {
    this.user = user;
    this.index = index;
    this.rootIds = new Set();
    this.replyIds = new Set();
    this.reactionEvents = 0;
    this.latestReactionCount = 0;
    this.pendingSubscriptions = new Map();
  }

  async connect() {
    const authorization = { Authorization: this.user.token, host: new URL(appSyncHttp).host };
    const header = Buffer.from(JSON.stringify(authorization)).toString("base64url");
    this.socket = new WebSocket(appSyncRealtime, ["aws-appsync-event-ws", `header-${header}`]);
    this.socket.addEventListener("message", (message) => {
      const data = message.data;
      if (typeof data === "string") this.handleMessage(data);
      else if (data instanceof Blob) void data.text().then((text) => this.handleMessage(text));
      else if (data instanceof ArrayBuffer) this.handleMessage(new TextDecoder().decode(data));
      else if (ArrayBuffer.isView(data)) this.handleMessage(new TextDecoder().decode(data));
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Agent ${this.index} connection timed out`)), 15_000);
      this.socket.addEventListener("open", () => this.socket.send(JSON.stringify({ type: "connection_init" })), { once: true });
      this.connectionReady = () => { clearTimeout(timeout); resolve(); };
      this.connectionRejected = (error) => { clearTimeout(timeout); reject(error); };
      this.socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(`Agent ${this.index} socket error`)); }, { once: true });
    });
  }

  async subscribe(channel) {
    const id = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSubscriptions.delete(id);
        reject(new Error(`Agent ${this.index} subscription timed out: ${channel}`));
      }, 15_000);
      this.pendingSubscriptions.set(id, {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({
      id, type: "subscribe", channel,
      authorization: { Authorization: this.user.token, host: new URL(appSyncHttp).host },
    }));
    return promise;
  }

  async subscribeWithRetry(channel, attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.subscribe(channel);
        return;
      } catch (error) {
        if (attempt === attempts - 1) throw error;
        await pause(Math.min(10_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 750));
      }
    }
  }

  handleMessage(message) {
    let envelope;
    try { envelope = JSON.parse(String(message)); } catch { return; }
    if (envelope.type === "connection_ack") {
      this.connectionReady?.();
      this.connectionReady = null;
      this.connectionRejected = null;
      return;
    }
    if (envelope.type === "connection_error" || (envelope.type === "error" && !envelope.id)) {
      this.connectionRejected?.(new Error(`Agent ${this.index} connection rejected: ${JSON.stringify(envelope)}`));
      this.connectionReady = null;
      this.connectionRejected = null;
      return;
    }
    const pending = envelope.id ? this.pendingSubscriptions.get(envelope.id) : null;
    if (envelope.type === "subscribe_success") {
      pending?.resolve();
      this.pendingSubscriptions.delete(envelope.id);
      return;
    }
    if (envelope.type === "subscribe_error" || envelope.type === "error") {
      pending?.reject(new Error(`Agent ${this.index} subscription rejected: ${JSON.stringify(envelope)}`));
      this.pendingSubscriptions.delete(envelope.id);
      return;
    }
    if (envelope.type !== "data") return;
    const eventValue = envelope.event ?? envelope.events;
    const events = eventValue === undefined || eventValue === null ? [] : Array.isArray(eventValue) ? eventValue : [eventValue];
    if (!sampleDataLogged) {
      sampleDataLogged = true;
      console.log(JSON.stringify({
        phase: "data-sample", agent: this.index, eventCount: events.length,
        eventShape: typeof envelope.event, eventType: typeof events[0],
        preview: JSON.stringify(envelope).slice(0, 500),
      }));
    }
    for (const raw of events) {
      let event;
      try { event = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { continue; }
      const row = event.eventType === "DELETE" ? event.old : event.new;
      if (!row?.id) continue;
      if (event.eventType === "INSERT" && String(row.content || "").includes(`[${runId}:root:`)) {
        this.rootIds.add(row.id);
        const sentAt = Number(String(row.content).match(/:sent=(\d+)\]/)?.[1]);
        if (sentAt) rootLatencies.push(Date.now() - sentAt);
      }
      if (event.eventType === "INSERT" && String(row.content || "").includes(`[${runId}:reply:`)) {
        this.replyIds.add(row.id);
        const sentAt = Number(String(row.content).match(/:sent=(\d+)\]/)?.[1]);
        if (sentAt) replyLatencies.push(Date.now() - sentAt);
      }
      if (event.eventType === "UPDATE" && row.id === this.reactionTargetId && row.reactions) {
        this.reactionEvents += 1;
        this.latestReactionCount = Number(row.reactions["👍"] || 0);
      }
    }
  }

  close() {
    try { this.socket?.close(1000, "test-complete"); } catch { /* no-op */ }
  }
}

const cleanup = async () => {
  sockets.forEach((socket) => socket.close());
  await runBatched(users, 5, async (user) => {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) console.error(`cleanup user ${user.id}: ${error.message}`);
  });
  // Cascading user deletion emits DELETE events for test posts, so remove the
  // corresponding delivery audit rows only after every synthetic user is gone.
  if (postIds.length) {
    await admin.from("realtime_delivery_outbox").delete().in("aggregate_id", postIds);
  }
};

let result;
try {
  const staleAgentsRemoved = await cleanupStaleAgents();
  if (staleAgentsRemoved) console.log(JSON.stringify({ phase: "stale-cleanup", users: staleAgentsRemoved }));
  console.log(JSON.stringify({ phase: "create-agents", agents: AGENT_COUNT, runId }));
  const indexes = Array.from({ length: AGENT_COUNT }, (_, index) => index);
  const created = await runBatched(indexes, 3, async (index) => {
    const email = `cirkle-live-${runId}-${index}@example.invalid`;
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name: `Cirkle Test Agent ${index + 1}` },
    });
    if (error || !data.user) throw error || new Error(`Agent ${index} was not created`);
    const user = { id: data.user.id, email, index };
    users.push(user);
    const { error: profileError } = await admin.from("profiles").upsert({
      user_id: user.id, name: `Cirkle Test Agent ${index + 1}`, iit_name: "IIT Delhi",
      student_status: "current_student", is_verified: true, onboarding_completed: true,
    }, { onConflict: "user_id" });
    if (profileError) throw profileError;
    const { error: affiliationError } = await admin.from("verified_academic_affiliations").upsert({
      user_id: user.id, network_id: "IIT", institute_id: "IIT_DELHI", degree_id: "MBA",
      specialisation_id: "GENERAL", graduation_year: 2026, member_status: "current_student",
      verification_status: "VERIFIED",
    }, { onConflict: "user_id" });
    if (affiliationError) throw affiliationError;
    user.token = await signIn(email);
    return user;
  });

  const channels = await userFetch(created[0].token, "/rest/v1/rpc/get_appsync_forum_channels", {
    method: "POST", body: JSON.stringify({ p_scope_type: scope.type, p_scope_key: scope.key }),
  });
  const messageChannel = (Array.isArray(channels) ? channels[0] : channels).message_channel;

  console.log(JSON.stringify({ phase: "connect-appsync", agents: AGENT_COUNT, messageChannel }));
  const connected = await runBatched(created, 10, async (user, localIndex) => {
    const socket = new AppSyncAgent(user, user.index ?? localIndex);
    sockets.push(socket);
    await socket.connect();
    await socket.subscribeWithRetry(messageChannel);
    return socket;
  });

  console.log(JSON.stringify({ phase: "root-burst", messages: AGENT_COUNT }));
  const rootPosts = await Promise.all(created.map((user, index) => {
    const sentAt = Date.now();
    return sendForumPost(user, `[${runId}:root:${index}:sent=${sentAt}] simultaneous root message ${index + 1}`);
  }));
  postIds.push(...rootPosts.map((post) => post.id));
  console.log(JSON.stringify({ phase: "root-dispatch", result: await dispatch(created[0].token) }));
  const rootDeliveryMs = await waitFor(
    () => connected.every((socket) => socket.rootIds.size === AGENT_COUNT),
    `${AGENT_COUNT} roots to ${AGENT_COUNT} agents`,
  );

  const rootId = rootPosts[0].id;
  connected.forEach((socket) => { socket.reactionTargetId = rootId; });
  await Promise.all(connected.map((socket) => socket.subscribeWithRetry(`/thread/${rootId}`)));

  console.log(JSON.stringify({ phase: "reply-burst", replies: AGENT_COUNT, rootId }));
  const replies = await Promise.all(created.map((user, index) => {
    const sentAt = Date.now();
    return sendForumPost(user, `[${runId}:reply:${index}:sent=${sentAt}] simultaneous reply ${index + 1}`, rootId);
  }));
  postIds.push(...replies.map((post) => post.id));
  console.log(JSON.stringify({ phase: "reply-dispatch", result: await dispatch(created[1].token) }));
  const replyDeliveryMs = await waitFor(
    () => connected.every((socket) => socket.replyIds.size === AGENT_COUNT),
    `${AGENT_COUNT} replies to ${AGENT_COUNT} agents`,
  );

  console.log(JSON.stringify({ phase: "reaction-burst", reactions: AGENT_COUNT, rootId }));
  await Promise.all(created.map((user) => userFetch(user.token, "/rest/v1/reactions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: user.id, entity_type: "forum_msg", entity_id: rootId, emoji: "👍" }),
  })));
  console.log(JSON.stringify({ phase: "reaction-dispatch", result: await dispatch(created[0].token) }));
  const reactionDeliveryMs = await waitFor(
    () => connected.every((socket) => socket.latestReactionCount === AGENT_COUNT),
    `${AGENT_COUNT} reaction totals to ${AGENT_COUNT} agents`,
  );

  const [{ count: persistedRoots, error: rootError }, { count: persistedReplies, error: replyError }, { count: persistedReactions, error: reactionError }] = await Promise.all([
    admin.from("posts").select("id", { count: "exact", head: true }).in("id", rootPosts.map((post) => post.id)),
    admin.from("posts").select("id", { count: "exact", head: true }).eq("reply_to_id", rootId),
    admin.from("reactions").select("id", { count: "exact", head: true }).eq("entity_type", "forum_msg").eq("entity_id", rootId),
  ]);
  if (rootError || replyError || reactionError) throw rootError || replyError || reactionError;
  if (persistedRoots !== AGENT_COUNT || persistedReplies !== AGENT_COUNT || persistedReactions !== AGENT_COUNT) {
    throw new Error(`Persistence mismatch roots=${persistedRoots} replies=${persistedReplies} reactions=${persistedReactions}`);
  }

  result = {
    status: "PASS", runId, agents: AGENT_COUNT,
    rootMessages: AGENT_COUNT, rootFanoutDeliveries: AGENT_COUNT * AGENT_COUNT,
    replies: AGENT_COUNT, replyFanoutDeliveries: AGENT_COUNT * AGENT_COUNT,
    reactions: AGENT_COUNT, reactionFanoutUpdates: connected.reduce((total, socket) => total + socket.reactionEvents, 0),
    persistence: { roots: persistedRoots, replies: persistedReplies, reactions: persistedReactions },
    rootRealtimeMs: { allAgentsComplete: rootDeliveryMs, p50: percentile(rootLatencies, 0.5), p95: percentile(rootLatencies, 0.95), max: Math.max(...rootLatencies) },
    replyRealtimeMs: { allAgentsComplete: replyDeliveryMs, p50: percentile(replyLatencies, 0.5), p95: percentile(replyLatencies, 0.95), max: Math.max(...replyLatencies) },
    reactionRealtimeMs: { allAgentsComplete: reactionDeliveryMs },
  };
  console.log(JSON.stringify(result));
} finally {
  console.log(JSON.stringify({ phase: "cleanup", users: users.length, posts: postIds.length }));
  await cleanup();
}
