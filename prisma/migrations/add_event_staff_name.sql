-- Migration: add name field to EventStaff for manual (non-linked) members
ALTER TABLE "EventStaff" ADD COLUMN IF NOT EXISTS "name" TEXT;
