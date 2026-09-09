import { Router } from "express";
import { config } from "../config.js";
import { setPrivateNoStore } from "../security/cachePolicy.js";

type ProviderFeatureConfig = Pick<typeof config, "DAILY_API_KEY">;

export const publicFeaturePayload = (value: ProviderFeatureConfig) => ({
  daily_calls: Boolean(value.DAILY_API_KEY?.trim()),
});

export const featuresRouter: Router = Router();

// This endpoint exposes capability booleans only. Provider credentials always
// remain in the protected API environment.
featuresRouter.get("/", (_req, res) => {
  // The response body is public, but credentialed CORS varies by Origin. Keep
  // it out of shared caches unless the edge has a proven origin-aware key.
  setPrivateNoStore(res);
  res.json(publicFeaturePayload(config));
});
