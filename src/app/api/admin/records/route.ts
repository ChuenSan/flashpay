import { requireAdmin } from "@/lib/admin-auth";
import { listRecords } from "@/lib/admin-records";
import { api, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async (request) => {
  await requireAdmin(request);
  return json(await listRecords(new URL(request.url)));
});
