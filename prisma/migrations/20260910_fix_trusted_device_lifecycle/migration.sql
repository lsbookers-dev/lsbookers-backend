-- Reconcile the device-security tables that were introduced before a dedicated
-- migration existed. IF NOT EXISTS keeps this safe on the current production
-- database while making a fresh migration history complete.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "requiresPasswordReset" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Notification"
  ADD COLUMN IF NOT EXISTS "deviceToken" TEXT;

CREATE TABLE IF NOT EXISTS "LoginEvent" (
  "id"          SERIAL PRIMARY KEY,
  "userId"      INTEGER NOT NULL,
  "userAgent"   TEXT,
  "deviceToken" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "TrustedDevice" (
  "id"          SERIAL PRIMARY KEY,
  "userId"      INTEGER NOT NULL,
  "deviceToken" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "userAgent"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "LoginEvent"
  ADD COLUMN IF NOT EXISTS "deviceToken" TEXT;

ALTER TABLE "TrustedDevice"
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LoginEvent_userId_fkey'
  ) THEN
    ALTER TABLE "LoginEvent"
      ADD CONSTRAINT "LoginEvent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TrustedDevice_userId_fkey'
  ) THEN
    ALTER TABLE "TrustedDevice"
      ADD CONSTRAINT "TrustedDevice_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS "TrustedDevice_deviceToken_key";
CREATE UNIQUE INDEX IF NOT EXISTS "TrustedDevice_userId_deviceToken_key"
  ON "TrustedDevice"("userId", "deviceToken");
CREATE INDEX IF NOT EXISTS "TrustedDevice_userId_idx"
  ON "TrustedDevice"("userId");
CREATE INDEX IF NOT EXISTS "LoginEvent_userId_idx"
  ON "LoginEvent"("userId");
CREATE INDEX IF NOT EXISTS "LoginEvent_userId_deviceToken_idx"
  ON "LoginEvent"("userId", "deviceToken");
CREATE INDEX IF NOT EXISTS "LoginEvent_createdAt_idx"
  ON "LoginEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "DeviceVerification_userId_deviceToken_idx"
  ON "DeviceVerification"("userId", "deviceToken");
CREATE INDEX IF NOT EXISTS "Notification_userId_type_deviceToken_idx"
  ON "Notification"("userId", "type", "deviceToken");

CREATE TABLE IF NOT EXISTS "PendingTrustedDevice" (
  "id"          SERIAL PRIMARY KEY,
  "userId"      INTEGER NOT NULL,
  "deviceToken" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "userAgent"   TEXT,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "PendingTrustedDevice"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PendingTrustedDevice_userId_fkey'
  ) THEN
    ALTER TABLE "PendingTrustedDevice"
      ADD CONSTRAINT "PendingTrustedDevice_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PendingTrustedDevice_userId_key"
  ON "PendingTrustedDevice"("userId");

-- One outstanding approval challenge per account and browser. This partial
-- index closes the race between simultaneous successful logins.
WITH ranked_active AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "userId", "deviceToken"
           ORDER BY "createdAt" DESC, "id" DESC
         ) AS duplicate_rank
  FROM "DeviceVerification"
  WHERE "usedAt" IS NULL
)
UPDATE "DeviceVerification" AS verification
SET "usedAt" = CURRENT_TIMESTAMP
FROM ranked_active
WHERE verification."id" = ranked_active."id"
  AND ranked_active.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "DeviceVerification_active_user_device_key"
  ON "DeviceVerification"("userId", "deviceToken")
  WHERE "usedAt" IS NULL;
