import { api, json } from "@/lib/http";
import { database } from "@/lib/db";
import { maskQQ } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = api(async () => {
  const records = await database().sponsorRecord.findMany({
    where: { qq: { not: null }, hidden: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, qq: true, amountCents: true, createdAt: true },
  });
  return json({
    items: records.map((record) => ({
      id: record.id,
      qqMasked: maskQQ(record.qq!),
      amountCents: record.amountCents,
      createdAt: record.createdAt.toISOString(),
    })),
  });
});
