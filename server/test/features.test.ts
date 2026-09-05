import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { featuresRouter, publicFeaturePayload } from "../src/routes/features.js";

describe("public runtime features", () => {
  it("fails closed when Daily is not configured", () => {
    expect(publicFeaturePayload({ DAILY_API_KEY: undefined })).toEqual({ daily_calls: false });
    expect(publicFeaturePayload({ DAILY_API_KEY: "   " })).toEqual({ daily_calls: false });
  });

  it("exposes only a capability boolean when Daily is configured", () => {
    const secret = "server-only-daily-secret";
    const payload = publicFeaturePayload({ DAILY_API_KEY: secret });
    expect(payload).toEqual({ daily_calls: true });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it("mounts the unauthenticated feature router", () => {
    const appStack = (createApp() as unknown as { router: { stack: Array<{ handle: unknown }> } }).router.stack;
    const routePaths = (featuresRouter as unknown as { stack: Array<{ route?: { path?: string } }> }).stack
      .flatMap((layer) => layer.route?.path ?? []);
    expect(appStack.some((layer) => layer.handle === featuresRouter)).toBe(true);
    expect(routePaths).toEqual(["/"]);
  });
});
