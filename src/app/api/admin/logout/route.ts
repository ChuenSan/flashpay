import { adminRequestLimit, logout } from "@/lib/admin-auth";
import { api, json, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = api(async (request) => {
  adminRequestLimit(request, "logout");
  await readJson(request);
  const response = json({ authenticated: false });
  await logout(request, response);
  return response;
});
