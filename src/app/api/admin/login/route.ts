import { adminRequestLimit, login } from "@/lib/admin-auth";
import { api, json, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = api(async (request) => {
  adminRequestLimit(request, "login");
  const body = await readJson(request);
  const response = json({ authenticated: true });
  await login(request, body, response);
  return response;
});
