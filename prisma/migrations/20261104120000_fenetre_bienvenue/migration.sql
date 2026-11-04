-- Fenêtre de bienvenue : vue une seule fois, à la première connexion (simple ajout, aucune donnée modifiée)
ALTER TABLE "User" ADD COLUMN "welcomeSeenAt" TIMESTAMP(3);
