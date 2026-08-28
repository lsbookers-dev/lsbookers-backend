-- CreateTable DeviceVerification
CREATE TABLE IF NOT EXISTS "DeviceVerification" (
  "id"          SERIAL PRIMARY KEY,
  "token"       TEXT NOT NULL UNIQUE,
  "userId"      INTEGER NOT NULL,
  "deviceToken" TEXT NOT NULL,
  "deviceName"  TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "usedAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeviceVerification_userId_idx" ON "DeviceVerification"("userId");
CREATE INDEX IF NOT EXISTS "DeviceVerification_token_idx"  ON "DeviceVerification"("token");

-- AddForeignKey
ALTER TABLE "DeviceVerification"
  ADD CONSTRAINT "DeviceVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
