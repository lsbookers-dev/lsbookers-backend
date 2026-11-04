-- Connexion : 2e repère pour reconnaître un appareil déjà utilisé (ajout uniquement, non destructif)
-- AlterTable
ALTER TABLE "UserSession" ADD COLUMN "deviceHint" TEXT;

-- CreateIndex
CREATE INDEX "UserSession_userId_deviceHint_idx" ON "UserSession"("userId", "deviceHint");
