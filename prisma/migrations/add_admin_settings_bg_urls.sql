-- Migration : ajout des champs URLs de fond dans AdminSettings
-- À exécuter dans Railway → PostgreSQL (Query runner)

ALTER TABLE "AdminSettings"
  ADD COLUMN IF NOT EXISTS "landingBgUrl"  TEXT,
  ADD COLUMN IF NOT EXISTS "loginBgUrl"    TEXT,
  ADD COLUMN IF NOT EXISTS "registerBgUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "headerLogoUrl" TEXT;

-- S'assurer que la ligne de settings existe (id = 1)
INSERT INTO "AdminSettings" (id, "createdAt", "updatedAt")
VALUES (1, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
