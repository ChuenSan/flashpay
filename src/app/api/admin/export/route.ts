import { checkAdminPassword, requireAdmin } from "@/lib/admin-auth";
import { exportRecords, recordFilters } from "@/lib/admin-records";
import { api, HttpError, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = api(async (request) => {
  const session = await requireAdmin(request);
  rateLimit(`export:${session.tokenHash}`, 5, 15 * 60000);
  rateLimit("export-global", 30, 15 * 60000);
  const body = await readJson(request);
  if (!(await checkAdminPassword(body.password)))
    throw new HttpError(403, "密码验证失败", "INVALID_PASSWORD");
  return exportRecords(recordFilters(body));
});
