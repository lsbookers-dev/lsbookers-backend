-- Migration: add notes to Event, create EventExpense and EventPurchase tables

ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "EventExpense" (
  "id"        SERIAL PRIMARY KEY,
  "eventId"   INTEGER NOT NULL REFERENCES "Event"("id") ON DELETE CASCADE,
  "label"     TEXT NOT NULL,
  "amount"    DOUBLE PRECISION,
  "category"  TEXT,
  "paid"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "EventExpense_eventId_idx" ON "EventExpense"("eventId");

CREATE TABLE IF NOT EXISTS "EventPurchase" (
  "id"        SERIAL PRIMARY KEY,
  "eventId"   INTEGER NOT NULL REFERENCES "Event"("id") ON DELETE CASCADE,
  "item"      TEXT NOT NULL,
  "quantity"  INTEGER,
  "price"     DOUBLE PRECISION,
  "done"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "EventPurchase_eventId_idx" ON "EventPurchase"("eventId");
