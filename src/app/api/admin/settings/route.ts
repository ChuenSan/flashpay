import { requireAdmin } from "@/lib/admin-auth";
import { api, json, readJson } from "@/lib/http";
import { getDownloadSettings, saveDownloadSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async (request) => {
  await requireAdmin(request);
  return json(await getDownloadSettings());
});

export const PUT = api(async (request) => {
  await requireAdmin(request);
  const body = await readJson(request);
  return json(
    await saveDownloadSettings(body.downloadUrl, body.archivePassword),
  );
});
