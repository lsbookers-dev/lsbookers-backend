-- Migration: add paymentStatus to BookingRequest
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID';
