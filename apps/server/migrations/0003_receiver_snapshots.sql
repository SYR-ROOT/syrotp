-- v0.5 — Multi-receiver routing.
--
-- Snapshot the chosen receiver's msisdn + operator on the verification
-- row at start_verification time. The hosted page (and any future
-- consumer) reads from the snapshot first, falling back to the
-- receivers-join only for pre-existing rows that don't carry the
-- snapshot yet.
--
-- Why snapshots even with the existing FK + ON DELETE RESTRICT:
-- the FK guarantees the receiver row stays alive, but does NOT
-- prevent an in-place UPDATE of receivers.msisdn / .operator. The
-- end user already saw the SMS instructions ("send VERIFY ABC123 to
-- +963998887777"); changing the displayed number afterwards would
-- silently break their verification.
--
-- Both columns are nullable so the migration is non-destructive for
-- pre-existing pending rows. New rows always populate them.

ALTER TABLE "verifications"
  ADD COLUMN "receiver_msisdn_snapshot" text,
  ADD COLUMN "receiver_operator_snapshot" text;
