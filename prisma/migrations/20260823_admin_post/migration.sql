CREATE TABLE IF NOT EXISTS "AdminPost" (
  "id" SERIAL PRIMARY KEY,
  "title" TEXT,
  "content" TEXT,
  "mediaUrl" TEXT,
  "mediaType" "MediaType",
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
