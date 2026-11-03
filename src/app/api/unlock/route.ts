import { api, json } from "@/lib/http";
import { attachBrowser, browserIdentity } from "@/lib/security";
import { recover } from "@/lib/confirmations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async (request) => {
  const identity = browserIdentity(request);
  // Initialization does not write a visitor/IP record (or inspect forwarding headers).
  return attachBrowser(
    json(identity.cookie ? { unlocked: false } : await recover(identity.id)),
    identity,
  );
});
