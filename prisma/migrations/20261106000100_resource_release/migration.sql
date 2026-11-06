-- CreateTable
CREATE TABLE "ResourceReleaseSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "publishedAt" TEXT NOT NULL,
    "changes" TEXT NOT NULL,
    "knownIssues" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);
