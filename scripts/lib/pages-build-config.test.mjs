import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePagesBuildEnvironment } from "./pages-build-config.mjs";

const base = {
  VITE_API_URL: "https://api-react.cirkle.world",
  VITE_CHAT_REALTIME_PROVIDER: "appsync",
  VITE_APPSYNC_HTTP_ENDPOINT: "https://hzrd5pmdhvfobbzonf2hffeq5e.appsync-api.ap-south-1.amazonaws.com/event",
  VITE_APPSYNC_REALTIME_ENDPOINT: "wss://hzrd5pmdhvfobbzonf2hffeq5e.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime",
};

describe("Cloudflare Pages build configuration", () => {
  it("defaults Daily calls to disabled", () => {
    assert.deepEqual(validatePagesBuildEnvironment(base), {
      apiUrl: "https://api-react.cirkle.world",
      realtimeProvider: "appsync",
      dailyCallsEnabled: false,
    });
    assert.equal(validatePagesBuildEnvironment({ ...base, VITE_DAILY_CALLS_ENABLED: "false" }).dailyCallsEnabled, false);
  });

  it("permits an explicit client opt-in that is still gated by the API", () => {
    assert.equal(validatePagesBuildEnvironment({ ...base, VITE_DAILY_CALLS_ENABLED: "true" }).dailyCallsEnabled, true);
  });

  it("rejects stale API, downgraded realtime, and ambiguous feature values", () => {
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_API_URL: "https://api.cirkle.world" }), /api-react\.cirkle\.world/);
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_CHAT_REALTIME_PROVIDER: "socketio" }), /AppSync/);
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_DAILY_CALLS_ENABLED: "yes" }), /true, false, or omitted/);
  });

  it("pins both public endpoints to the reviewed AppSync Event API", () => {
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_APPSYNC_HTTP_ENDPOINT: "https://example.invalid/event" }), /VITE_APPSYNC_HTTP_ENDPOINT/);
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_APPSYNC_REALTIME_ENDPOINT: "wss://example.invalid/event/realtime" }), /VITE_APPSYNC_REALTIME_ENDPOINT/);
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_APPSYNC_HTTP_ENDPOINT: "" }), /VITE_APPSYNC_HTTP_ENDPOINT/);
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_APPSYNC_REALTIME_ENDPOINT: "" }), /VITE_APPSYNC_REALTIME_ENDPOINT/);
  });

  it("rejects unreviewed browser-visible variables", () => {
    assert.throws(() => validatePagesBuildEnvironment({ ...base, VITE_SECRET: "must-not-ship" }), /VITE_SECRET/);
  });
});
