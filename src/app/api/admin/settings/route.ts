import { requireAdmin } from "@/lib/admin-auth";
import { api, json, readJson } from "@/lib/http";
import { getDownloadUrl, saveDownloadUrl } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async (request) => {
  await requireAdmin(request);
  return json({ downloadUrl: await getDownloadUrl() });
});

export const PUT = api(async (request) => {
  await requireAdmin(request);
  const body = await readJson(request);
  return json({ downloadUrl: await saveDownloadUrl(body.downloadUrl) });
});
