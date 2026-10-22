-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAST_DUE';

-- DropIndex
DROP INDEX "HomeFeatured_profileId_key";

-- AlterTable
ALTER TABLE "AdminSettings" ADD COLUMN     "planSettings" JSONB;

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" INTEGER,
ADD COLUMN     "lateCancellation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentMode" TEXT NOT NULL DEFAULT 'DIRECT';

-- AlterTable
ALTER TABLE "HomeFeatured" ADD COLUMN     "orderId" INTEGER,
ADD COLUMN     "regionCode" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'ADMIN',
ADD COLUMN     "startsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "regionCode" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "interval" TEXT NOT NULL DEFAULT 'MONTH',
ADD COLUMN     "promoCode" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'STRIPE',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ALTER COLUMN "plan" SET DEFAULT 'PRO',
ALTER COLUMN "priceCents" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedAt" TIMESTAMP(3),
ADD COLUMN     "lateCancelWarnedAt" TIMESTAMP(3),
ADD COLUMN     "payoutMode" TEXT,
ADD COLUMN     "stripeCustomerId" TEXT;

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "freeMonths" INTEGER,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" SERIAL NOT NULL,
    "codeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraOffer" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "options" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtraOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraOrder" (
    "id" SERIAL NOT NULL,
    "offerId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "profileId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "days" INTEGER,
    "scope" TEXT,
    "regionCode" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "desiredStart" TIMESTAMP(3),
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "adminNote" TEXT,
    "paidAt" TIMESTAMP(3),
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtraOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPayment" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "payerId" INTEGER NOT NULL,
    "payeeId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "commissionPct" DOUBLE PRECISION NOT NULL,
    "commissionCents" INTEGER NOT NULL,
    "depositPct" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_CARD',
    "chargeAt" TIMESTAMP(3),
    "stripeSessionId" TEXT,
    "stripePaymentMethodId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "stripeFeeCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "transferId" TEXT,
    "transferredCents" INTEGER NOT NULL DEFAULT 0,
    "releasedAt" TIMESTAMP(3),
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_codeId_userId_key" ON "PromoRedemption"("codeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtraOrder_stripeSessionId_key" ON "ExtraOrder"("stripeSessionId");

-- CreateIndex
CREATE INDEX "ExtraOrder_status_idx" ON "ExtraOrder"("status");

-- CreateIndex
CREATE INDEX "ExtraOrder_userId_idx" ON "ExtraOrder"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPayment_bookingId_key" ON "BookingPayment"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPayment_stripeSessionId_key" ON "BookingPayment"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPayment_stripePaymentIntentId_key" ON "BookingPayment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "BookingPayment_status_chargeAt_idx" ON "BookingPayment"("status", "chargeAt");

-- CreateIndex
CREATE UNIQUE INDEX "HomeFeatured_orderId_key" ON "HomeFeatured"("orderId");

-- CreateIndex
CREATE INDEX "HomeFeatured_profileId_idx" ON "HomeFeatured"("profileId");

-- CreateIndex
CREATE INDEX "HomeFeatured_scope_regionCode_idx" ON "HomeFeatured"("scope", "regionCode");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubId_key" ON "Subscription"("stripeSubId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraOrder" ADD CONSTRAINT "ExtraOrder_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ExtraOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraOrder" ADD CONSTRAINT "ExtraOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraOrder" ADD CONSTRAINT "ExtraOrder_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPayment" ADD CONSTRAINT "BookingPayment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPayment" ADD CONSTRAINT "BookingPayment_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPayment" ADD CONSTRAINT "BookingPayment_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeFeatured" ADD CONSTRAINT "HomeFeatured_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ExtraOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

