-- Annonce de l'en-tête (choix B6) : 3 colonnes ajoutées aux réglages, non destructif
-- AlterTable
ALTER TABLE "AdminSettings" ADD COLUMN     "announcementActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "announcementText" TEXT,
ADD COLUMN     "announcementUrl" TEXT;

