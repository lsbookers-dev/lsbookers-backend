-- Étape 5 : carrousel géré par l'admin, tendances (profils ouverts depuis la recherche), index (non destructif)
-- CreateTable
CREATE TABLE "ProfileSearchHit" (
    "id" SERIAL NOT NULL,
    "profileId" INTEGER NOT NULL,
    "viewerUserId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileSearchHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeFeatured" (
    "id" SERIAL NOT NULL,
    "profileId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "endsAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HomeFeatured_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileSearchHit_createdAt_idx" ON "ProfileSearchHit"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSearchHit_profileId_viewerUserId_day_key" ON "ProfileSearchHit"("profileId", "viewerUserId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "HomeFeatured_profileId_key" ON "HomeFeatured"("profileId");

-- CreateIndex
CREATE INDEX "ProfileView_createdAt_idx" ON "ProfileView"("createdAt");

-- CreateIndex
CREATE INDEX "PublicationLike_createdAt_idx" ON "PublicationLike"("createdAt");

-- AddForeignKey
ALTER TABLE "ProfileSearchHit" ADD CONSTRAINT "ProfileSearchHit_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeFeatured" ADD CONSTRAINT "HomeFeatured_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

