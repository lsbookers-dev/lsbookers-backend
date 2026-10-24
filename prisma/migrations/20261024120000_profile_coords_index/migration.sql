-- Recherche par distance : retrouver vite les profils dans un carré autour d'une ville
CREATE INDEX "Profile_latitude_longitude_idx" ON "Profile"("latitude", "longitude");
