-- Fix PasswordReset to match schema.prisma and backend code

-- 1) Colonnes attendues
ALTER TABLE "PasswordReset" 
  ADD COLUMN IF NOT EXISTS "usedAt" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "tokenHash" TEXT;

-- 2) Contrainte d'unicité sur tokenHash
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' AND indexname = 'PasswordReset_tokenHash_key'
  ) THEN
    CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
  END IF;
END$$;

-- 3) (Optionnel) supprimer l'ancienne colonne "token" si elle existe et n'est plus utilisée
ALTER TABLE "PasswordReset" DROP COLUMN IF EXISTS "token";

-- 4) Rendre tokenHash NOT NULL (OK si table vide)
ALTER TABLE "PasswordReset" ALTER COLUMN "tokenHash" SET NOT NULL;
