-- Étape 5 : index pour le fil d'actualité et les notifications (non destructif)

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Publication_createdAt_idx" ON "Publication"("createdAt");
