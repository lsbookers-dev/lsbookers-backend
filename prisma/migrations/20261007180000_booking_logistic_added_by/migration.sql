-- Qui a ajouté un élément de transport / hébergement (organisateur ou personne bookée).
-- Ajout simple, sans perte de données. Gardé tolérant (IF EXISTS / IF NOT EXISTS) car
-- la table a été créée hors historique de migrations (voir tâche #306).
ALTER TABLE IF EXISTS "BookingLogistic" ADD COLUMN IF NOT EXISTS "addedByProfileId" INTEGER;
