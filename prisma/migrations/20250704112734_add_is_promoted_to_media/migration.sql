/*
  Warnings:

  - You are about to drop the column `caption` on the `Media` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Media" DROP COLUMN "caption",
ADD COLUMN     "isPromoted" BOOLEAN NOT NULL DEFAULT false;
