-- Page Réglages : sécurité, appareils, notifications, confidentialité, pause (ajouts uniquement, non destructif)
-- AlterTable
ALTER TABLE "ConversationParticipant" ADD COLUMN     "lastEmailedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "hiddenFromSearch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messagePolicy" TEXT NOT NULL DEFAULT 'EVERYONE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "loginAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "newsletterOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "newsletterOptInAt" TIMESTAMP(3),
ADD COLUMN     "notifPrefs" JSONB,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "pendingEmailExpiresAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmailTokenHash" TEXT;

-- CreateTable
CREATE TABLE "UserSession" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sid" TEXT NOT NULL,
    "deviceId" TEXT,
    "name" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_sid_key" ON "UserSession"("sid");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserSession_userId_deviceId_idx" ON "UserSession"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "User_pendingEmailTokenHash_key" ON "User"("pendingEmailTokenHash");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

