import { PrismaClient } from "@prisma/client";
import { serverConfig } from "./config";

const globalDb = globalThis as unknown as { flashpaySecureDb?: PrismaClient };

function sqliteUrl(): string {
  const [file, query = ""] = serverConfig().databaseUrl.split("?");
  const parameters = new URLSearchParams(query);
  // secure_delete is connection-local. One SQLite connection guarantees that
  // initialization covers every application write (SQLite has one writer anyway).
  parameters.set("connection_limit", "1");
  return `${file}?${parameters}`;
}

function secureClient(): PrismaClient {
  const base = new PrismaClient({
    datasources: { db: { url: sqliteUrl() } },
    // Never log SQL parameters: these include QQ and confirmation IPs.
    log: [],
  });
  let initialized: Promise<void> | undefined;
  function initialize(): Promise<void> {
    initialized ??= (async () => {
      const result = await base.$queryRawUnsafe<
        Array<{ secure_delete: bigint }>
      >("PRAGMA secure_delete=ON");
      if (Number(result[0]?.secure_delete) !== 1)
        throw new Error("Secure SQLite deletion unavailable");
      // PERSIST rollback journals and reset WAL files must not retain excess pages.
      await base.$queryRawUnsafe("PRAGMA journal_size_limit=0");
    })().catch((error) => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  }
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        await initialize();
        return query(args);
      },
    },
    client: {
      async $connect() {
        await initialize();
      },
      async $disconnect() {
        try {
          await base.$disconnect();
        } finally {
          initialized = undefined;
        }
      },
      async $transaction(...args: unknown[]) {
        // Initialize BEFORE acquiring the interactive transaction's connection.
        // Callback queries use that initialized connection, without nested work.
        await initialize();
        return Reflect.apply(base.$transaction, base, args);
      },
    },
  }) as unknown as PrismaClient;
}

/** After commit, try to remove old WAL frames WITHOUT waiting for active readers.
 * Readers may pin pre-delete frames; never unlink live -wal/-shm files or fail an
 * already committed deletion. A later delete/idle checkpoint or offline cleanup
 * must truncate deferred frames. No visitor data/logs are created by this work.
 */
export async function checkpointAfterDeletion(): Promise<void> {
  const maintenance = new PrismaClient({
    datasources: { db: { url: sqliteUrl() } },
    log: [],
  });
  try {
    await maintenance.$queryRawUnsafe("PRAGMA busy_timeout=0");
    await maintenance.$queryRawUnsafe("PRAGMA secure_delete=ON");
    await maintenance.$queryRawUnsafe("PRAGMA journal_size_limit=0");
    await maintenance.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Best effort only: a busy reader or storage fault must not undo HTTP success
    // for an already committed deletion. Fresh backups independently VACUUM.
  } finally {
    await maintenance.$disconnect().catch(() => {});
  }
}

// Upgrade strategy for databases previously written with secure_delete=OFF:
// stop ALL app/worker connections, then run
//   python3 -B scripts/backup.py sanitize-source --database /absolute/path/to/db
// This checkpoints/truncates WAL, switches to DELETE journaling and VACUUMs the
// live DB. Restart the app afterwards. Do not run live VACUUM on visitor requests.
// Neither this nor SQLite PRAGMAs promises physical SSD/filesystem-snapshot erasure.

export function database(): PrismaClient {
  globalDb.flashpaySecureDb ??= secureClient();
  return globalDb.flashpaySecureDb;
}
