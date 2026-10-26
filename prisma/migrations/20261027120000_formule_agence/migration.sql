-- Formule Agence : uniquement des ajouts, aucune donnée existante modifiée
-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "pausedByAgency" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AgencySubscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "interval" TEXT NOT NULL DEFAULT 'MONTH',
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "stripeSubId" TEXT,
    "stripeExtraItemId" TEXT,
    "extraProfiles" INTEGER NOT NULL DEFAULT 0,
    "promoCode" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencySubscription_userId_key" ON "AgencySubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencySubscription_stripeSubId_key" ON "AgencySubscription"("stripeSubId");

-- AddForeignKey
ALTER TABLE "AgencySubscription" ADD CONSTRAINT "AgencySubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

