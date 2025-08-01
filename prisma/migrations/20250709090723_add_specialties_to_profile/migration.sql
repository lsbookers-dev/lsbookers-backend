-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[];
