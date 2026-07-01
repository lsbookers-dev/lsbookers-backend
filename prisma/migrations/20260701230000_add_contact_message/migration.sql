-- Migration: add_contact_message

CREATE TABLE "ContactMessage" (
  "id"         SERIAL PRIMARY KEY,
  "name"       TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "subject"    TEXT,
  "message"    TEXT NOT NULL,
  "isRead"     BOOLEAN NOT NULL DEFAULT false,
  "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ContactMessage_isRead_idx"     ON "ContactMessage"("isRead");
CREATE INDEX "ContactMessage_isArchived_idx" ON "ContactMessage"("isArchived");
