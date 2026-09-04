import { apiRequest, apiUrl } from "./http";
import type { ApiResult } from "./types";

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export class ApiStorageBucket {
  constructor(private readonly bucket: string) {}

  upload(
    path: string,
    file: Blob | File,
    options: { cacheControl?: string; contentType?: string; upsert?: boolean; metadata?: Record<string, string> } = {},
  ): Promise<ApiResult<{ path: string; fullPath?: string }>> {
    const body = new FormData();
    body.append("bucket", this.bucket);
    body.append("path", path);
    body.append("file", file, file instanceof File ? file.name : path.split("/").pop() || "upload");
    body.append("options", JSON.stringify(options));
    return apiRequest("storage/upload", { method: "POST", body });
  }

  getPublicUrl(path: string, options: { download?: string | boolean; transform?: Record<string, unknown> } = {}): {
    data: { publicUrl: string };
  } {
    const url = new URL(apiUrl(`storage/public/${encodeURIComponent(this.bucket)}/${encodePath(path)}`),
      typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (options.download) url.searchParams.set("download", typeof options.download === "string" ? options.download : "");
    if (options.transform) url.searchParams.set("transform", JSON.stringify(options.transform));
    const publicUrl = url.origin === "http://localhost" && apiUrl("").startsWith("/")
      ? `${url.pathname}${url.search}`
      : url.toString();
    return { data: { publicUrl } };
  }

  async createSignedUrl(
    path: string,
    expiresIn: number,
    options: Record<string, unknown> = {},
  ): Promise<ApiResult<{ signedUrl: string }>> {
    const result = await apiRequest<Record<string, unknown> | string>("storage/signed-url", {
      method: "POST",
      body: { bucket: this.bucket, path, expiresIn, options },
    });
    if (result.error) return result as ApiResult<{ signedUrl: string }>;
    const data = typeof result.data === "string"
      ? { signedUrl: result.data }
      : { ...result.data, signedUrl: String(result.data.signedUrl || result.data.signed_url || "") };
    return { ...result, data };
  }

  async createSignedUrls(paths: string[], expiresIn: number): Promise<ApiResult<Array<{ path: string; signedUrl: string; error?: string }>>> {
    const result = await apiRequest<unknown[]>("storage/signed-urls", {
      method: "POST",
      body: { bucket: this.bucket, paths, expiresIn },
    });
    if (result.error) return result as ApiResult<Array<{ path: string; signedUrl: string; error?: string }>>;
    const rows = Array.isArray(result.data) ? result.data : [];
    return {
      ...result,
      data: rows.map((entry, index) => {
        if (typeof entry === "string") return { path: paths[index], signedUrl: entry };
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        return {
          ...record,
          path: String(record.path || paths[index] || ""),
          signedUrl: String(record.signedUrl || record.signed_url || ""),
          ...(record.error ? { error: String(record.error) } : {}),
        };
      }),
    };
  }

  remove(paths: string[]): Promise<ApiResult<unknown[]>> {
    return apiRequest("storage/remove", { method: "POST", body: { bucket: this.bucket, paths } });
  }
}

export class ApiStorageClient {
  from(bucket: string): ApiStorageBucket {
    return new ApiStorageBucket(bucket);
  }
}
