-- Sécurité de l'admin : code par e-mail à la connexion + journal des actions

CREATE TABLE "AdminLoginCode" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "challenge" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminLoginCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminLoginCode_challenge_key" ON "AdminLoginCode"("challenge");
CREATE INDEX "AdminLoginCode_userId_idx" ON "AdminLoginCode"("userId");
ALTER TABLE "AdminLoginCode" ADD CONSTRAINT "AdminLoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AdminLog" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER,
    "action" TEXT NOT NULL,
    "targetUserId" INTEGER,
    "targetLabel" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminLog_createdAt_idx" ON "AdminLog"("createdAt");
CREATE INDEX "AdminLog_action_idx" ON "AdminLog"("action");
