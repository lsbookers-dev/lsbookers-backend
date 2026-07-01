-- Migration : Ajout de la table PublicationComment
-- À exécuter sur Railway (psql ou interface SQL)

CREATE TABLE "PublicationComment" (
  "id"            SERIAL PRIMARY KEY,
  "content"       TEXT NOT NULL,
  "publicationId" INTEGER NOT NULL,
  "profileId"     INTEGER NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PublicationComment_publicationId_fkey"
    FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE,

  CONSTRAINT "PublicationComment_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE
);

CREATE INDEX "PublicationComment_publicationId_idx" ON "PublicationComment"("publicationId");
CREATE INDEX "PublicationComment_profileId_idx"     ON "PublicationComment"("profileId");
