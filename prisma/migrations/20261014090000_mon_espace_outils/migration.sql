-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('QUOTE', 'INVOICE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "lastWeeklyRecapAt" TIMESTAMP(3),
ADD COLUMN     "weeklyRecap" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "reply" TEXT;

-- CreateTable
CREATE TABLE "ProfileView" (
    "id" SERIAL NOT NULL,
    "profileId" INTEGER NOT NULL,
    "viewerUserId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventChecklist" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "profileId" INTEGER NOT NULL,
    "reminded7At" TIMESTAMP(3),
    "reminded1At" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventChecklistItem" (
    "id" SERIAL NOT NULL,
    "checklistId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuerId" INTEGER NOT NULL,
    "clientProfileId" INTEGER,
    "clientName" TEXT NOT NULL,
    "clientAddress" TEXT,
    "bookingId" INTEGER,
    "title" TEXT,
    "serviceDate" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileView_profileId_createdAt_idx" ON "ProfileView"("profileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileView_profileId_viewerUserId_day_key" ON "ProfileView"("profileId", "viewerUserId", "day");

-- CreateIndex
CREATE INDEX "EventChecklist_profileId_idx" ON "EventChecklist"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "EventChecklist_eventId_profileId_key" ON "EventChecklist"("eventId", "profileId");

-- CreateIndex
CREATE INDEX "EventChecklistItem_checklistId_idx" ON "EventChecklistItem"("checklistId");

-- CreateIndex
CREATE INDEX "Invoice_issuerId_kind_idx" ON "Invoice"("issuerId", "kind");

-- CreateIndex
CREATE INDEX "Invoice_clientProfileId_idx" ON "Invoice"("clientProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_issuerId_number_key" ON "Invoice"("issuerId", "number");

-- AddForeignKey
ALTER TABLE "ProfileView" ADD CONSTRAINT "ProfileView_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChecklist" ADD CONSTRAINT "EventChecklist_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChecklist" ADD CONSTRAINT "EventChecklist_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventChecklistItem" ADD CONSTRAINT "EventChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "EventChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

