-- Migration: add landingLogoUrl to AdminSettings
ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "landingLogoUrl" TEXT;
