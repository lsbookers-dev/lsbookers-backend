-- Avis liés à une prestation réellement effectuée (booking ou poste staff)
ALTER TABLE "Review" ADD COLUMN "bookingId" INTEGER;
ALTER TABLE "Review" ADD COLUMN "staffId" INTEGER;

CREATE UNIQUE INDEX "Review_authorId_bookingId_key" ON "Review"("authorId", "bookingId");
CREATE UNIQUE INDEX "Review_authorId_staffId_key" ON "Review"("authorId", "staffId");

ALTER TABLE "Review" ADD CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "EventStaff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Statut « Intermittent du spectacle » proposé à l'inscription (jusqu'ici enregistré comme Particulier)
ALTER TYPE "LegalStatus" ADD VALUE IF NOT EXISTS 'INTERMITTENT';
