import { confirm } from "@/lib/confirmations";
import { api, json, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import {
  attachBrowser,
  browserIdentity,
  clientIp,
  keyedDigest,
} from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = api(async (request) => {
  const identity = browserIdentity(request);
  const ip = clientIp(request);
  rateLimit("confirm-global", 1200, 60000);
  rateLimit(`confirm-ip:${keyedDigest("memory-confirm-ip", ip)}`, 120, 60000);
  if (identity.cookie) {
    // Establish browser binding BEFORE a record can be committed. This makes a
    // lost confirmation response retryable with the same pre-existing cookie.
    return attachBrowser(
      json(
        {
          error: "浏览器标识已初始化，请使用同一确认标识重试",
          code: "BROWSER_REQUIRED",
        },
        409,
      ),
      identity,
    );
  }
  rateLimit(`confirm-browser:${identity.id}`, 120, 60000);
  return attachBrowser(
    json(await confirm(identity.id, ip, await readJson(request))),
    identity,
  );
});
