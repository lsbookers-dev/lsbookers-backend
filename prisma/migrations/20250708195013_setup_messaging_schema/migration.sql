/*
  Warnings:

  - The values [PUBLIC] on the enum `Role` will be removed.
  - You are about to drop the column `user1Id` on the `Conversation` table.
  - You are about to drop the column `user2Id` on the `Conversation` table.
  - You are about to drop the column `isPromoted` on the `Media` table.
  - You are about to drop the column `profileId` on the `Media` table.
  - You are about to drop the column `recipientId` on the `Message` table.
  - You are about to drop the `Booking` table.
  - You are about to drop the `Follower` table.
  - Added the required column `updatedAt` to the `Conversation` table without a default value.
  - Added the required column `userId` to the `Media` table without a default value.
  - Changed the type of `type` on the `Media` table.
*/

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('ARTIST', 'ORGANIZER');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_artistId_fkey";
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_organizerId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_user1Id_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_user2Id_fkey";
ALTER TABLE "Follower" DROP CONSTRAINT "Follower_followedId_fkey";
ALTER TABLE "Follower" DROP CONSTRAINT "Follower_followerId_fkey";
ALTER TABLE "Media" DROP CONSTRAINT "Media_profileId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_recipientId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_senderId_fkey";

-- AlterTable: Conversation
ALTER TABLE "Conversation" 
  DROP COLUMN "user1Id",
  DROP COLUMN "user2Id",
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: Media
ALTER TABLE "Media"
  DROP COLUMN "isPromoted",
  DROP COLUMN "profileId",
  ADD COLUMN "caption" TEXT,
  ADD COLUMN "userId" INTEGER NOT NULL DEFAULT 1,
  DROP COLUMN "type",
  ADD COLUMN "type" "MediaType" NOT NULL DEFAULT 'IMAGE';

-- AlterTable: Message
ALTER TABLE "Message" DROP COLUMN "recipientId";

-- DropTables
DROP TABLE "Booking";
DROP TABLE "Follower";

-- CreateTable: Follow
CREATE TABLE "Follow" (
    "id" SERIAL NOT NULL,
    "followerId" INTEGER NOT NULL,
    "followingId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ConversationParticipant
CREATE TABLE "ConversationParticipant" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_userId_conversationId_key" ON "ConversationParticipant"("userId", "conversationId");

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;