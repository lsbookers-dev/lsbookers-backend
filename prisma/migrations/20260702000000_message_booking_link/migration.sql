-- Migration: message_booking_link
-- Ajoute type et bookingRequestId sur Message

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'TEXT';
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "bookingRequestId" INTEGER;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_bookingRequestId_fkey"
  FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "Message_bookingRequestId_idx" ON "Message"("bookingRequestId");
