import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  loadObject: vi.fn(),
  verifySignedUrl: vi.fn(),
}));

vi.mock("../src/services/storage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/storage.js")>(),
  loadObject: storageMocks.loadObject,
  verifySignedUrl: storageMocks.verifySignedUrl,
}));

import { createApp } from "../src/app.js";
import { ApiError, errorHandler } from "../src/lib/errors.js";
import { attachSocketServer } from "../src/realtime/socket.js";
import {
  defaultPrivateCachePolicy,
  PRIVATE_NO_STORE_CACHE_CONTROL,
  PUBLIC_OBJECT_CACHE_CONTROL,
  setPublicCache,
} from "../src/security/cachePolicy.js";

const expectPrivateNoStore = (headers: Record<string, string | string[] | undefined>) => {
  expect(headers["cache-control"]).toBe(PRIVATE_NO_STORE_CACHE_CONTROL);
  expect(headers.pragma).toBe("no-cache");
  expect(headers.expires).toBe("0");
};

describe("fail-safe HTTP cache policy", () => {
  beforeEach(() => {
    storageMocks.loadObject.mockResolvedValue({
      bytes: Buffer.from("public-object"),
      mime: "image/webp",
      name: "avatar.webp",
    });
    storageMocks.verifySignedUrl.mockResolvedValue("member/private.pdf");
  });

  it("defaults liveness, private APIs, and API 404 errors to private no-store", async () => {
    const app = createApp();
    const responses = await Promise.all([
      request(app).get("/healthz"),
      request(app).get("/api/auth/session"),
      request(app).post("/api/data/query").send({}),
      request(app).post("/api/rpc/not_a_real_rpc").send({}),
      request(app).post("/api/storage/signed-url").send({ bucket: "chat-media", path: "member/private.pdf" }),
      request(app).get("/api/not-a-route"),
    ]);

    for (const response of responses) expectPrivateNoStore(response.headers);
  });

  it("keeps parser and CORS failures private before a route can answer", async () => {
    const app = createApp();
    const [parserFailure, corsFailure] = await Promise.all([
      request(app)
        .post("/api/data/query")
        .set("Content-Type", "application/json")
        .send("{")
        .expect(500),
      request(app)
        .get("/api/features")
        .set("Origin", "https://attacker.invalid")
        .expect(403),
    ]);

    expectPrivateNoStore(parserFailure.headers);
    expectPrivateNoStore(corsFailure.headers);
  });

  it("overrides a public route policy when that route subsequently fails", async () => {
    const app = express();
    app.use(defaultPrivateCachePolicy);
    app.get("/public-then-error", (_req, res, next) => {
      setPublicCache(res, PUBLIC_OBJECT_CACHE_CONTROL);
      next(new ApiError(503, "temporary_failure", "Temporary failure"));
    });
    app.use(errorHandler);

    const response = await request(app).get("/public-then-error").expect(503);
    expectPrivateNoStore(response.headers);
  });

  it("keeps the public feature payload out of shared caches because CORS varies by origin", async () => {
    const app = createApp();
    const plainResponse = await request(app)
      .get("/api/features")
      .set("Origin", "https://cirkle.world")
      .expect(200);
    expectPrivateNoStore(plainResponse.headers);
    expect(plainResponse.headers["set-cookie"]).toBeUndefined();
    expect(plainResponse.headers.vary).toContain("Origin");

    const privateVariants = await Promise.all([
      request(app).get("/api/features?cache-bust=1"),
      request(app).get("/api/features").set("Authorization", "Bearer untrusted"),
      request(app).get("/api/features").set("Cookie", "unrelated=value"),
      request(app).post("/api/features").send({}),
    ]);
    for (const response of privateVariants) expectPrivateNoStore(response.headers);
  });

  it("keeps bounded public-object caching narrow and every other storage shape private", async () => {
    const app = createApp();
    const publicResponse = await request(app)
      .get("/api/storage/public/avatars/member/avatar.webp")
      .expect(200);
    expect(publicResponse.headers["cache-control"]).toBe(PUBLIC_OBJECT_CACHE_CONTROL);
    expect(publicResponse.headers.pragma).toBeUndefined();
    expect(publicResponse.headers.expires).toBeUndefined();
    expect(publicResponse.headers["set-cookie"]).toBeUndefined();
    expect(publicResponse.headers["x-request-id"]).toBeUndefined();
    expect(publicResponse.headers.ratelimit).toBeUndefined();
    expect(publicResponse.headers["ratelimit-policy"]).toBeUndefined();
    expect(publicResponse.headers.vary).toContain("Origin");

    const [download, queryVariant, emptyParsedQuery, credentialed, corsVariant, rangeVariant, privateObject] = await Promise.all([
      request(app).get("/api/storage/public/avatars/member/avatar.webp?download=avatar.webp"),
      request(app).get("/api/storage/public/avatars/member/avatar.webp?transform=anything"),
      request(app).get("/api/storage/public/avatars/member/avatar.webp?&&"),
      request(app).get("/api/storage/public/avatars/member/avatar.webp").set("Cookie", "unrelated=value"),
      request(app).get("/api/storage/public/avatars/member/avatar.webp").set("Origin", "https://cirkle.world"),
      request(app).get("/api/storage/public/avatars/member/avatar.webp").set("Range", "bytes=0-9"),
      request(app).get("/api/storage/private/chat-media/member/private.pdf?expires=1&sig=signature"),
    ]);
    expect(download.headers["content-disposition"]).toContain("attachment");
    for (const response of [download, queryVariant, emptyParsedQuery, credentialed, corsVariant, rangeVariant, privateObject]) expectPrivateNoStore(response.headers);
  });

  it("never caches a missing public object as a public response", async () => {
    storageMocks.loadObject.mockRejectedValueOnce(new ApiError(404, "object_not_found", "Object not found"));
    const response = await request(createApp())
      .get("/api/storage/public/avatars/member/missing.webp")
      .expect(404);
    expectPrivateNoStore(response.headers);
  });

  it("sets private no-store on Socket.IO polling outside the Express stack", async () => {
    const server = createServer(createApp());
    const io = attachSocketServer(server);
    try {
      const response = await request(server)
        .get("/api/socket.io/?EIO=4&transport=polling")
        .expect(200);
      expectPrivateNoStore(response.headers);
    } finally {
      io.close();
      server.close();
    }
  });
});
