-- Signalements et modération (ajouts seulement, aucune donnée existante modifiée)
-- AlterTable
ALTER TABLE "User" ADD COLUMN "warningCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PublicationComment" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "reporterId" INTEGER,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "targetUserId" INTEGER,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "snapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" INTEGER,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_targetType_targetId_key" ON "Report"("reporterId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Report_targetUserId_idx" ON "Report"("targetUserId");
