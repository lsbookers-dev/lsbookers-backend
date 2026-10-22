-- Migration : index composite Publication(profileId, createdAt)
-- Améliore les requêtes de feed et de profil triées par date

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Publication_profileId_createdAt_idx"
  ON "Publication"("profileId", "createdAt" DESC);
