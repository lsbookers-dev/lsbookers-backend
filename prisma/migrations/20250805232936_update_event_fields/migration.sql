/*
  Warnings:

  - You are about to drop the column `date` on the `Event` table. All the data in the column will be lost.
  - Added the required column `end` to the `Event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `start` to the `Event` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Event" DROP COLUMN "date",
ADD COLUMN     "allDay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "end" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "lieu" TEXT,
ADD COLUMN     "start" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "type" TEXT;
