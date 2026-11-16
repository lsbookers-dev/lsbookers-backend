-- Équipe habituelle : personnes ajoutées à la main par un organisateur (nouvelle table, aucune donnée modifiée)
CREATE TABLE "TeamMember" (
    "id" SERIAL NOT NULL,
    "ownerProfileId" INTEGER NOT NULL,
    "memberProfileId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamMember_ownerProfileId_memberProfileId_key" ON "TeamMember"("ownerProfileId", "memberProfileId");
CREATE INDEX "TeamMember_memberProfileId_idx" ON "TeamMember"("memberProfileId");
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_ownerProfileId_fkey" FOREIGN KEY ("ownerProfileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
