/*
  Warnings:

  - You are about to drop the `Booking` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[followerId,followedId]` on the table `Follower` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_artistId_fkey";

-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_organizerId_fkey";

-- AlterTable
ALTER TABLE "Media" ALTER COLUMN "caption" DROP NOT NULL;

-- DropTable
DROP TABLE "Booking";

-- CreateIndex
CREATE UNIQUE INDEX "Follower_followerId_followedId_key" ON "Follower"("followerId", "followedId");
