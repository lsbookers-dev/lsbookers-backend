-- Migration: add_agenda_models
-- Ajout des modèles Availability, BookingRequest, EventDocument
-- + enrichissement du modèle Event

-- ─────────────────────────────────────────────
-- Nouveaux enums
-- ─────────────────────────────────────────────

CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'BOOKED', 'TENTATIVE');
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'COMPLETED');

-- ─────────────────────────────────────────────
-- Nouveaux champs sur Event
-- ─────────────────────────────────────────────

ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "category"    TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "coverImage"  TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "maxCapacity" INTEGER;
ALTER TABLE "Event" ALTER COLUMN "end" DROP NOT NULL;

-- Index supplémentaires sur Event
CREATE INDEX IF NOT EXISTS "Event_profileId_idx" ON "Event"("profileId");
CREATE INDEX IF NOT EXISTS "Event_start_idx"     ON "Event"("start");

-- ─────────────────────────────────────────────
-- Table EventDocument
-- ─────────────────────────────────────────────

CREATE TABLE "EventDocument" (
  "id"        SERIAL PRIMARY KEY,
  "eventId"   INTEGER NOT NULL,
  "name"      TEXT NOT NULL,
  "url"       TEXT NOT NULL,
  "fileType"  TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventDocument_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE
);

CREATE INDEX "EventDocument_eventId_idx" ON "EventDocument"("eventId");

-- ─────────────────────────────────────────────
-- Table Availability
-- ─────────────────────────────────────────────

CREATE TABLE "Availability" (
  "id"        SERIAL PRIMARY KEY,
  "profileId" INTEGER NOT NULL,
  "date"      TIMESTAMP(3) NOT NULL,
  "status"    "AvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Availability_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE,
  CONSTRAINT "Availability_profileId_date_key" UNIQUE ("profileId", "date")
);

CREATE INDEX "Availability_profileId_idx" ON "Availability"("profileId");

-- ─────────────────────────────────────────────
-- Table BookingRequest
-- ─────────────────────────────────────────────

CREATE TABLE "BookingRequest" (
  "id"          SERIAL PRIMARY KEY,
  "requesterId" INTEGER NOT NULL,
  "targetId"    INTEGER NOT NULL,
  "eventId"     INTEGER,
  "startDate"   TIMESTAMP(3) NOT NULL,
  "endDate"     TIMESTAMP(3),
  "message"     TEXT,
  "fee"         DOUBLE PRECISION,
  "status"      "BookingStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingRequest_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "Profile"("id"),
  CONSTRAINT "BookingRequest_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "Profile"("id"),
  CONSTRAINT "BookingRequest_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
);

CREATE INDEX "BookingRequest_requesterId_idx" ON "BookingRequest"("requesterId");
CREATE INDEX "BookingRequest_targetId_idx"    ON "BookingRequest"("targetId");
