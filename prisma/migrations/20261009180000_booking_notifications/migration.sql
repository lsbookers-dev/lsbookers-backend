-- Notification « laissez votre avis » envoyée une seule fois par prestation
ALTER TABLE "BookingRequest" ADD COLUMN "reviewInviteSentAt" TIMESTAMP(3);
ALTER TABLE "EventStaff" ADD COLUMN "reviewInviteSentAt" TIMESTAMP(3);

-- Lien direct d'une notification vers l'événement de l'agenda
ALTER TABLE "Notification" ADD COLUMN "eventId" INTEGER;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
