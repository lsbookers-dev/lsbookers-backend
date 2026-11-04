-- E-mails de notification en attente (envoi différé de 10 min, groupé)
CREATE TABLE "PendingEmail" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "ctaLabel" TEXT NOT NULL,
    "details" JSONB,
    "notificationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingEmail_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PendingEmail_createdAt_idx" ON "PendingEmail"("createdAt");
CREATE INDEX "PendingEmail_userId_idx" ON "PendingEmail"("userId");
ALTER TABLE "PendingEmail" ADD CONSTRAINT "PendingEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
