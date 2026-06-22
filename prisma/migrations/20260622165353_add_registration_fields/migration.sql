/*
  Warnings:

  - You are about to drop the column `name` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[pseudo]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "LegalStatus" AS ENUM ('INDIVIDUAL', 'AUTO_ENTREPRENEUR', 'COMPANY');

-- CreateEnum
CREATE TYPE "OrganizerType" AS ENUM ('INDIVIDUAL', 'PROFESSIONAL');

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "establishmentName" TEXT,
ADD COLUMN     "legalStatus" "LegalStatus",
ADD COLUMN     "organizerType" "OrganizerType",
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "siret" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "name",
ADD COLUMN     "countryOfResidence" TEXT,
ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "isIdentityVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPaymentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "pseudo" TEXT,
ADD COLUMN     "registrationStep" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "stripeAccountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_pseudo_key" ON "User"("pseudo");
