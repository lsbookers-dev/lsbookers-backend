-- Fix: align PasswordReset.id (SERIAL -> TEXT) + enforce tokenHash NOT NULL

-- 1) Retirer le default SERIAL puis convertir en TEXT
ALTER TABLE "PasswordReset" 
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE TEXT USING "id"::text,
  ALTER COLUMN "id" SET NOT NULL;

-- 2) Supprimer la séquence auto générée si elle existe (nettoyage)
DO $$
DECLARE 
  seq text;
BEGIN
  SELECT pg_get_serial_sequence('"PasswordReset"', 'id') INTO seq;
  IF seq IS NOT NULL THEN
    EXECUTE 'DROP SEQUENCE IF EXISTS ' || seq || ' CASCADE';
  END IF;
END$$;

-- 3) S'assurer que tokenHash est bien NOT NULL (attendu par Prisma + code)
ALTER TABLE "PasswordReset" 
  ALTER COLUMN "tokenHash" SET NOT NULL;
