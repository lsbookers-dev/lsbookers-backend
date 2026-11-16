-- Devis envoyés depuis une offre ou déposés par le membre (nouvelle table, aucune donnée modifiée)
-- CreateTable
CREATE TABLE "Quote" (
    "id" SERIAL NOT NULL,
    "senderProfileId" INTEGER,
    "recipientProfileId" INTEGER,
    "uploadedByProfileId" INTEGER,
    "offerId" INTEGER,
    "messageId" INTEGER,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT,
    "counterpartName" TEXT,
    "amount" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_senderProfileId_idx" ON "Quote"("senderProfileId");

-- CreateIndex
CREATE INDEX "Quote_recipientProfileId_idx" ON "Quote"("recipientProfileId");

-- CreateIndex
CREATE INDEX "Quote_uploadedByProfileId_idx" ON "Quote"("uploadedByProfileId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_senderProfileId_fkey" FOREIGN KEY ("senderProfileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_recipientProfileId_fkey" FOREIGN KEY ("recipientProfileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_uploadedByProfileId_fkey" FOREIGN KEY ("uploadedByProfileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
