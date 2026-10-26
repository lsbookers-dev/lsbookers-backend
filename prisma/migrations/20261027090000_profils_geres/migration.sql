-- Profils gérés (formule Agence) : uniquement des ajouts, aucune donnée existante modifiée
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "canManageProfiles" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "approvalRequestedById" INTEGER,
ADD COLUMN     "awaitingArtistSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProfileManager" (
    "id" SERIAL NOT NULL,
    "managerUserId" INTEGER NOT NULL,
    "profileId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "origin" TEXT NOT NULL DEFAULT 'INVITED',
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "invitedEmail" TEXT,
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileManager_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileManager_tokenHash_key" ON "ProfileManager"("tokenHash");

-- CreateIndex
CREATE INDEX "ProfileManager_managerUserId_status_idx" ON "ProfileManager"("managerUserId", "status");

-- CreateIndex
CREATE INDEX "ProfileManager_profileId_status_idx" ON "ProfileManager"("profileId", "status");

-- AddForeignKey
ALTER TABLE "ProfileManager" ADD CONSTRAINT "ProfileManager_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileManager" ADD CONSTRAINT "ProfileManager_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

