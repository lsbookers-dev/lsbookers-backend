-- Émetteur figé à l'envoi d'un devis / d'une facture
ALTER TABLE "Invoice" ADD COLUMN "issuerSnapshot" JSONB;
