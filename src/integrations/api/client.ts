import { ApiAuthClient } from "./auth";
import { API_ORIGIN, apiRequest } from "./http";
import { ApiQueryBuilder } from "./query";
import { ApiRealtimeChannel, ApiRealtimeClient } from "./realtime";
import { CIRKLE_AUTH_STORAGE_KEY, clearSession } from "./session";
import { ApiStorageClient } from "./storage";
import type { ApiResult } from "./types";

type InvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  region?: string;
};

class ApiFunctionsClient {
  invoke<T = any>(name: string, options: InvokeOptions = {}): Promise<ApiResult<T>> {
    const method = options.method || "POST";
    return apiRequest(`functions/${encodeURIComponent(name)}`, {
      method,
      headers: options.headers,
      ...(method === "GET" ? {} : { body: options.body ?? {} }),
    });
  }
}

class SupabaseCompatibilityClient {
  readonly auth = new ApiAuthClient();
  readonly storage = new ApiStorageClient();
  readonly functions = new ApiFunctionsClient();
  readonly realtime = new ApiRealtimeClient();
  private readonly channels = new Set<ApiRealtimeChannel>();

  from<T = any>(table: string): ApiQueryBuilder<T> {
    return new ApiQueryBuilder<T>(table);
  }

  rpc<T = any>(name: string, args: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Promise<ApiResult<T>> {
    return apiRequest(`rpc/${encodeURIComponent(name)}`, {
      method: "POST",
      body: { ...args, ...(Object.keys(options).length ? { __options: options } : {}) },
    });
  }

  channel(topic: string, options: { config?: Record<string, unknown> } = {}): ApiRealtimeChannel {
    const channel = new ApiRealtimeChannel(topic, options.config || {});
    this.channels.add(channel);
    return channel;
  }

  async removeChannel(channel: ApiRealtimeChannel): Promise<"ok"> {
    this.channels.delete(channel);
    return channel.unsubscribe();
  }

  getChannels(): ApiRealtimeChannel[] {
    return [...this.channels];
  }

  async removeAllChannels(): Promise<"ok"> {
    await Promise.all([...this.channels].map((channel) => channel.unsubscribe()));
    this.channels.clear();
    return "ok";
  }
}

export const apiClient = new SupabaseCompatibilityClient();
export const supabase = apiClient;
export const supabaseUrl = API_ORIGIN;
export const supabaseAuthStorageKey = CIRKLE_AUTH_STORAGE_KEY;
export const clearSupabaseAuthSession = (): void => clearSession();

export type { ApiSession, ApiUser } from "./types";
