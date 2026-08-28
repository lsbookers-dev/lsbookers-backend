-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TagStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PublicationTag" (
  "id"             SERIAL PRIMARY KEY,
  "publicationId"  INTEGER NOT NULL,
  "taggedUserId"   INTEGER NOT NULL,
  "taggedByUserId" INTEGER NOT NULL,
  "status"         "TagStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicationTag_publicationId_taggedUserId_key" UNIQUE ("publicationId", "taggedUserId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublicationTag_publicationId_idx" ON "PublicationTag"("publicationId");
CREATE INDEX IF NOT EXISTS "PublicationTag_taggedUserId_idx" ON "PublicationTag"("taggedUserId");

-- AddForeignKey
ALTER TABLE "PublicationTag" ADD CONSTRAINT "PublicationTag_publicationId_fkey"
  FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PublicationTag" ADD CONSTRAINT "PublicationTag_taggedUserId_fkey"
  FOREIGN KEY ("taggedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PublicationTag" ADD CONSTRAINT "PublicationTag_taggedByUserId_fkey"
  FOREIGN KEY ("taggedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
