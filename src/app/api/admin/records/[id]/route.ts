import { requireAdmin } from "@/lib/admin-auth";
import { checkpointAfterDeletion, database } from "@/lib/db";
import { api, HttpError, json, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function recordId(context: Context): Promise<string> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new HttpError(400, "记录标识无效", "INVALID_ID");
  return id;
}

export const PATCH = api(async (request, context: Context) => {
  await requireAdmin(request);
  const id = await recordId(context);
  const body = await readJson(request);
  if (typeof body.hidden !== "boolean")
    throw new HttpError(400, "隐藏状态必须为布尔值", "INVALID_HIDDEN");
  const result = await database().sponsorRecord.updateMany({
    where: { id },
    data: { hidden: body.hidden },
  });
  if (!result.count) throw new HttpError(404, "记录不存在", "NOT_FOUND");
  return json({ id, hidden: body.hidden });
});

export const DELETE = api(async (request, context: Context) => {
  await requireAdmin(request);
  const id = await recordId(context);
  await readJson(request);
  await database().$transaction(async (tx) => {
    // Verify on the SAME connection/transaction as DELETE, not a pooled peer.
    // ON (not FAST) zeroes deleted table/index cells, including overflow pages.
    const settings = await tx.$queryRawUnsafe<Array<{ secure_delete: bigint }>>(
      "PRAGMA secure_delete=ON",
    );
    if (Number(settings[0]?.secure_delete) !== 1)
      throw new Error("Secure SQLite deletion unavailable");
    await tx.$queryRawUnsafe("PRAGMA journal_size_limit=0");
    // ON DELETE SET NULL atomically preserves the QQ/IP-free replay tombstone.
    const result = await tx.sponsorRecord.deleteMany({ where: { id } });
    if (!result.count) throw new HttpError(404, "记录不存在", "NOT_FOUND");
  });
  await checkpointAfterDeletion();
  return json({ deleted: true });
});
