-- Migration de rattrapage (#306) : amène une base recréée depuis les migrations au même état que la production.
-- La production a été modifiée hors migrations : cette migration y est marquée « déjà appliquée » sans être exécutée.

-- CreateEnum
CREATE TYPE "LogisticType" AS ENUM ('HOTEL', 'TRANSPORT');

-- AlterEnum
ALTER TYPE "StaffStatus" ADD VALUE 'PENDING';

-- DropForeignKey
ALTER TABLE "Availability" DROP CONSTRAINT "Availability_profileId_fkey";

-- DropForeignKey
ALTER TABLE "BookingRequest" DROP CONSTRAINT "BookingRequest_eventId_fkey";

-- DropForeignKey
ALTER TABLE "BookingRequest" DROP CONSTRAINT "BookingRequest_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "BookingRequest" DROP CONSTRAINT "BookingRequest_targetId_fkey";

-- DropForeignKey
ALTER TABLE "EventDocument" DROP CONSTRAINT "EventDocument_eventId_fkey";

-- DropForeignKey
ALTER TABLE "EventExpense" DROP CONSTRAINT "EventExpense_eventId_fkey";

-- DropForeignKey
ALTER TABLE "EventPurchase" DROP CONSTRAINT "EventPurchase_eventId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_bookingRequestId_fkey";

-- DropIndex
DROP INDEX "Message_bookingRequestId_idx";

-- AlterTable
ALTER TABLE "AdminPost" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AdminSettings" ADD COLUMN     "headerLogoUrl" TEXT,
ADD COLUMN     "landingBgUrl" TEXT,
ADD COLUMN     "landingLogoUrl" TEXT,
ADD COLUMN     "loginBgUrl" TEXT,
ADD COLUMN     "registerBgUrl" TEXT;

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "sharedNotes" TEXT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "type";

-- AlterTable
ALTER TABLE "EventStaff" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "publicationId" INTEGER,
ADD COLUMN     "staffId" INTEGER;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "eventId" INTEGER,
ADD COLUMN     "fee" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "cvText" TEXT,
ADD COLUMN     "facebookUrl" TEXT,
ADD COLUMN     "feeInfo" TEXT,
ADD COLUMN     "instagramUrl" TEXT,
ADD COLUMN     "linkedinUrl" TEXT,
ADD COLUMN     "showStyles" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showYoutubeUrl" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tiktokUrl" TEXT,
ADD COLUMN     "twitterUrl" TEXT,
ADD COLUMN     "websiteUrl" TEXT;

-- AlterTable
ALTER TABLE "PublicationTag" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "PublicationComment" (
    "id" SERIAL NOT NULL,
    "content" TEXT NOT NULL,
    "publicationId" INTEGER NOT NULL,
    "profileId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentId" INTEGER,

    CONSTRAINT "PublicationComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationCommentLike" (
    "id" SERIAL NOT NULL,
    "commentId" INTEGER NOT NULL,
    "profileId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicationCommentLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationMedia" (
    "id" SERIAL NOT NULL,
    "publicationId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'image',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicationMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Album" (
    "id" SERIAL NOT NULL,
    "profileId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coverUrl" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumItem" (
    "id" SERIAL NOT NULL,
    "albumId" INTEGER NOT NULL,
    "publicationId" INTEGER,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "caption" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingLogistic" (
    "id" SERIAL NOT NULL,
    "bookingRequestId" INTEGER NOT NULL,
    "type" "LogisticType" NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT,
    "fileName" TEXT,
    "addedByProfileId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingLogistic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingMedia" (
    "id" SERIAL NOT NULL,
    "bookingRequestId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'IMAGE',
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublicationComment_publicationId_idx" ON "PublicationComment"("publicationId");

-- CreateIndex
CREATE INDEX "PublicationComment_profileId_idx" ON "PublicationComment"("profileId");

-- CreateIndex
CREATE INDEX "PublicationComment_parentId_idx" ON "PublicationComment"("parentId");

-- CreateIndex
CREATE INDEX "PublicationCommentLike_commentId_idx" ON "PublicationCommentLike"("commentId");

-- CreateIndex
CREATE INDEX "PublicationCommentLike_profileId_idx" ON "PublicationCommentLike"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicationCommentLike_commentId_profileId_key" ON "PublicationCommentLike"("commentId", "profileId");

-- CreateIndex
CREATE INDEX "PublicationMedia_publicationId_idx" ON "PublicationMedia"("publicationId");

-- CreateIndex
CREATE INDEX "Album_profileId_idx" ON "Album"("profileId");

-- CreateIndex
CREATE INDEX "AlbumItem_albumId_idx" ON "AlbumItem"("albumId");

-- CreateIndex
CREATE INDEX "BookingLogistic_bookingRequestId_idx" ON "BookingLogistic"("bookingRequestId");

-- CreateIndex
CREATE INDEX "BookingMedia_bookingRequestId_idx" ON "BookingMedia"("bookingRequestId");

-- CreateIndex
CREATE INDEX "Notification_staffId_idx" ON "Notification"("staffId");

-- CreateIndex
CREATE INDEX "Publication_profileId_createdAt_idx" ON "Publication"("profileId", "createdAt");

-- AddForeignKey
ALTER TABLE "PublicationComment" ADD CONSTRAINT "PublicationComment_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationComment" ADD CONSTRAINT "PublicationComment_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationComment" ADD CONSTRAINT "PublicationComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PublicationComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationCommentLike" ADD CONSTRAINT "PublicationCommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "PublicationComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationCommentLike" ADD CONSTRAINT "PublicationCommentLike_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationMedia" ADD CONSTRAINT "PublicationMedia_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumItem" ADD CONSTRAINT "AlbumItem_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumItem" ADD CONSTRAINT "AlbumItem_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventExpense" ADD CONSTRAINT "EventExpense_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPurchase" ADD CONSTRAINT "EventPurchase_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDocument" ADD CONSTRAINT "EventDocument_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLogistic" ADD CONSTRAINT "BookingLogistic_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingMedia" ADD CONSTRAINT "BookingMedia_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "EventStaff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

