type FunctionErrorPayload = {
  error?: string;
  message?: string;
  code?: string;
  already_verified?: boolean;
};

export const readEdgeFunctionError = async (
  error: unknown,
  responseData: unknown,
  fallback: string,
): Promise<FunctionErrorPayload & { message: string }> => {
  let payload = responseData && typeof responseData === "object"
    ? responseData as FunctionErrorPayload
    : undefined;

  const context = (error as { context?: Response } | null)?.context;
  if (!payload && context && typeof context.clone === "function") {
    try {
      payload = await context.clone().json() as FunctionErrorPayload;
    } catch {
      // A proxy/gateway response may not be JSON. The safe fallback below is
      // more useful than exposing an internal HTML response to the member.
    }
  }

  const rawMessage = payload?.error || payload?.message || (error as Error | null)?.message || fallback;
  const message = rawMessage === "Edge Function returned a non-2xx status code" ? fallback : rawMessage;
  return { ...payload, message };
};
