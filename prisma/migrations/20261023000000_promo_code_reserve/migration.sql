-- Code Fondateur réservé à un membre
ALTER TABLE "PromoCode" ADD COLUMN "reservedUserId" INTEGER;
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_reservedUserId_fkey" FOREIGN KEY ("reservedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
