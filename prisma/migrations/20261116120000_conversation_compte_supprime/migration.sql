-- Conversation gardée quand un participant supprime son compte (simple ajout, aucune donnée modifiée)
ALTER TABLE "Conversation" ADD COLUMN "accountDeletedAt" TIMESTAMP(3);
