-- Checklist : rappel choisi par l'utilisateur (simple ajout ; les checklists existantes gardent J-7 + veille)
ALTER TABLE "EventChecklist" ADD COLUMN "remindMode" TEXT NOT NULL DEFAULT 'J7_J1';
ALTER TABLE "EventChecklist" ADD COLUMN "remindAt" TIMESTAMP(3);
ALTER TABLE "EventChecklist" ADD COLUMN "remindedAt" TIMESTAMP(3);
