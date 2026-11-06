import { requireAdmin } from "@/lib/admin-auth";
import { api, json, readJson } from "@/lib/http";
import {
  getResourceReleaseSettings,
  saveResourceReleaseSettings,
} from "@/lib/release-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async (request) => {
  await requireAdmin(request);
  return json(await getResourceReleaseSettings());
});

export const PUT = api(async (request) => {
  await requireAdmin(request);
  return json(
    await saveResourceReleaseSettings(await readJson(request, 16 * 1024)),
  );
});
