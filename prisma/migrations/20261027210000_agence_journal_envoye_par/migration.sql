-- Journal de l'agence et « envoyé par » sur les messages (ajouts seuls)
-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "sentByUserId" INTEGER;

-- CreateTable
CREATE TABLE "ManagerActionLog" (
    "id" SERIAL NOT NULL,
    "managerUserId" INTEGER NOT NULL,
    "profileId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManagerActionLog_managerUserId_createdAt_idx" ON "ManagerActionLog"("managerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerActionLog_profileId_createdAt_idx" ON "ManagerActionLog"("profileId", "createdAt");

