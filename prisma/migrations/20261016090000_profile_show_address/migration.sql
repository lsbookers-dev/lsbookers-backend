-- Organisateurs : choix d'afficher l'adresse exacte de l'établissement sur le profil public
ALTER TABLE "Profile" ADD COLUMN "showAddress" BOOLEAN NOT NULL DEFAULT false;
