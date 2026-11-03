CREATE TABLE "BrowserState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lastConfirmedAt" DATETIME
);

CREATE TABLE "SponsorRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "browserId" TEXT NOT NULL,
    "qq" TEXT,
    "ip" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL CHECK ("amountCents" BETWEEN 1 AND 1000000),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "unlocked" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "ConfirmationClaim" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "browserId" TEXT NOT NULL,
    "recordId" TEXT,
    CONSTRAINT "ConfirmationClaim_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "SponsorRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ConfirmationRate" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

CREATE TABLE "AdminSession" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "credentialFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

CREATE INDEX "SponsorRecord_browserId_createdAt_idx" ON "SponsorRecord"("browserId", "createdAt");
CREATE INDEX "SponsorRecord_createdAt_idx" ON "SponsorRecord"("createdAt");
CREATE INDEX "SponsorRecord_hidden_createdAt_idx" ON "SponsorRecord"("hidden", "createdAt");
CREATE UNIQUE INDEX "ConfirmationClaim_recordId_key" ON "ConfirmationClaim"("recordId");
CREATE INDEX "ConfirmationRate_expiresAt_idx" ON "ConfirmationRate"("expiresAt");
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");
