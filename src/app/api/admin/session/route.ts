import { adminRequestLimit, getAdminSession } from "@/lib/admin-auth";
import { api, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async (request) => {
  adminRequestLimit(request, "session");
  const session = await getAdminSession(request);
  return json(
    session
      ? { authenticated: true, username: session.username }
      : { authenticated: false },
  );
});
