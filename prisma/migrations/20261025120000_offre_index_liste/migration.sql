-- Page Opportunités : offres actives, les plus récentes d'abord (#272)
CREATE INDEX IF NOT EXISTS "Offer_status_createdAt_idx" ON "Offer"("status", "createdAt");
