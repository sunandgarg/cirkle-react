import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError, asyncHandler } from "../lib/errors.js";
import { requireAuth } from "../security/middleware.js";
import { createSignedUrl, loadObject, removeObjects, storeUpload, verifySignedUrl } from "../services/storage.js";

export const storageRouter: Router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

storageRouter.post("/upload", requireAuth, upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "file_required", "Upload file is required");
  const body = z.object({ bucket: z.string(), path: z.string(), options: z.string().optional() }).parse(req.body);
  let options: unknown = {};
  if (body.options) { try { options = JSON.parse(body.options); } catch { throw new ApiError(400, "invalid_upload_options", "Upload options must be valid JSON"); } }
  res.status(201).json({ data: await storeUpload(body.bucket, body.path, req.file, options, { auth: req.auth!, ip: req.ip, userAgent: req.get("user-agent") }) });
}));

storageRouter.post("/signed-url", requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ bucket: z.string(), path: z.string(), expiresIn: z.number().int().optional(), expires_in: z.number().int().optional() }).parse(req.body);
  res.json({ data: { signedUrl: await createSignedUrl(body.bucket, body.path, body.expiresIn ?? body.expires_in ?? 3600, { auth: req.auth!, ip: req.ip }) } });
}));

storageRouter.post("/signed-urls", requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ bucket: z.string(), paths: z.array(z.string()).max(100), expiresIn: z.number().int().optional(), expires_in: z.number().int().optional() }).parse(req.body);
  const rows = await Promise.all(body.paths.map(async (objectPath) => {
    try { return { path: objectPath, signedUrl: await createSignedUrl(body.bucket, objectPath, body.expiresIn ?? body.expires_in ?? 3600, { auth: req.auth!, ip: req.ip }) }; }
    catch (error) { return { path: objectPath, signedUrl: "", error: error instanceof Error ? error.message : "Access denied" }; }
  }));
  res.json({ data: rows });
}));

storageRouter.post("/remove", requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ bucket: z.string(), paths: z.array(z.string()).max(100) }).parse(req.body);
  res.json({ data: await removeObjects(body.bucket, body.paths, { auth: req.auth!, ip: req.ip }) });
}));

storageRouter.get(/^\/public\/([^/]+)\/(.+)$/, asyncHandler(async (req, res) => {
  const bucket = String(req.params[0]);
  const objectPath = String(req.params[1]);
  const object = await loadObject(bucket, objectPath, true);
  res.setHeader("Content-Type", object.mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  if ("download" in req.query) res.setHeader("Content-Disposition", `attachment; filename="${object.name.replace(/["\r\n]/g, "_")}"`);
  res.send(object.bytes);
}));

storageRouter.get(/^\/private\/([^/]+)\/(.+)$/, asyncHandler(async (req, res) => {
  const bucket = String(req.params[0]);
  const objectPath = verifySignedUrl(bucket, String(req.params[1]), req.query.expires, req.query.sig);
  const object = await loadObject(bucket, objectPath, false);
  res.setHeader("Content-Type", object.mime);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(object.bytes);
}));
