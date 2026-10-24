-- Index des liaisons entre tables (#277) : listes, compteurs et suppressions plus rapides.
-- IF EXISTS / IF NOT EXISTS : sans risque si un index existe déjà ou manque.
-- DropIndex
DROP INDEX IF EXISTS "Message_seen_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublicationLike_profileId_idx" ON "PublicationLike"("profileId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlbumItem_publicationId_idx" ON "AlbumItem"("publicationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Media_userId_createdAt_idx" ON "Media"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Media_profileId_idx" ON "Media"("profileId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Follow_followingId_idx" ON "Follow"("followingId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversationParticipant_conversationId_idx" ON "ConversationParticipant"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_conversationId_seen_idx" ON "Message"("conversationId", "seen");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_bookingRequestId_idx" ON "Message"("bookingRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingRequest_eventId_idx" ON "BookingRequest"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingRequest_offerId_idx" ON "BookingRequest"("offerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EventStaff_profileId_idx" ON "EventStaff"("profileId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Offer_organizerId_status_idx" ON "Offer"("organizerId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Offer_eventId_idx" ON "Offer"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Contract_eventId_idx" ON "Contract"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Review_bookingId_idx" ON "Review"("bookingId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Review_eventId_idx" ON "Review"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExtraOrder_profileId_idx" ON "ExtraOrder"("profileId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingPayment_payeeId_idx" ON "BookingPayment"("payeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingPayment_payerId_idx" ON "BookingPayment"("payerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_messageId_idx" ON "Notification"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_publicationId_idx" ON "Notification"("publicationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_offerId_idx" ON "Notification"("offerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_actorId_idx" ON "Notification"("actorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_eventId_idx" ON "Notification"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invoice_bookingId_idx" ON "Invoice"("bookingId");

