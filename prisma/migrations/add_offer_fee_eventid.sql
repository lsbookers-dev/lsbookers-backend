-- Migration : ajout fee et eventId sur Offer
-- À exécuter dans Railway → PostgreSQL (psql $DATABASE_URL)

ALTER TABLE "Offer"
  ADD COLUMN IF NOT EXISTS "fee"     FLOAT,
  ADD COLUMN IF NOT EXISTS "eventId" INT REFERENCES "Event"(id) ON DELETE SET NULL;
