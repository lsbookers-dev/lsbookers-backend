-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "availableForBooking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showRealName" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "styles" TEXT[],
ADD COLUMN     "youtubeUrl" TEXT;
