-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "closeOfferOnAccept" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offerId" INTEGER;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "offerId" INTEGER;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

