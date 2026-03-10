-- Correction du type de colonne tokenHash sans encode()
ALTER TABLE "PasswordReset"
  ALTER COLUMN "tokenHash" TYPE TEXT USING "tokenHash"::text;
