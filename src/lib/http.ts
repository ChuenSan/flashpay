import { NextResponse } from "next/server";
import { ConfigurationError, serverConfig } from "./config";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Vary", "Cookie");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export function json(value: unknown, status = 200): NextResponse {
  const response = NextResponse.json(value, { status });
  privateResponse(response);
  return response;
}

export function requireOrigin(request: Request): void {
  if (request.headers.get("origin") !== serverConfig().appOrigin) {
    throw new HttpError(403, "请求来源不受信任", "INVALID_ORIGIN");
  }
}

// Route bodies are small; enforce a streaming limit rather than trusting Content-Length.
export async function readJson(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HttpError(415, "请使用 JSON 请求", "INVALID_CONTENT_TYPE");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "缺少请求内容", "INVALID_BODY");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) {
        await reader.cancel();
        throw new HttpError(413, "请求内容过大", "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid object");
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "请求内容无效", "INVALID_BODY");
  } finally {
    reader.releaseLock();
  }
}

export function api<T extends unknown[]>(
  handler: (request: Request, ...args: T) => Promise<Response>,
) {
  return async (request: Request, ...args: T): Promise<Response> => {
    try {
      serverConfig();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
        requireOrigin(request);
      return privateResponse(await handler(request, ...args));
    } catch (error) {
      if (error instanceof HttpError) {
        const response = json(
          {
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(error.retryAfter !== undefined
              ? { retryAfter: error.retryAfter }
              : {}),
          },
          error.status,
        );
        if (error.retryAfter !== undefined)
          response.headers.set("Retry-After", String(error.retryAfter));
        return response;
      }
      // Never serialize exceptions, Prisma details, credentials, request bodies, or URLs.
      return json(
        {
          error:
            error instanceof ConfigurationError
              ? "服务器配置不可用"
              : "操作未完成，请稍后重试",
          code:
            error instanceof ConfigurationError
              ? "CONFIGURATION_ERROR"
              : "INTERNAL_ERROR",
        },
        error instanceof ConfigurationError ? 503 : 500,
      );
    }
  };
}
