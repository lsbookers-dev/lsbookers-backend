/*
  Warnings:

  - Added the required column `profileId` to the `Media` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Media" ADD COLUMN "profileId" INTEGER;
UPDATE "Media" SET "profileId" = 1 WHERE "profileId" IS NULL;
ALTER TABLE "Media" ALTER COLUMN "profileId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

