-- Migration: add cancellationRequestedBy and cancellationNote to BookingRequest
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "cancellationRequestedBy" INTEGER;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "cancellationNote" TEXT;
