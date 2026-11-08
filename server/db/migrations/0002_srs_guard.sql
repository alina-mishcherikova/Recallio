-- SRS database guard (ADR 0001 §3, D4 = variant B). Custom migration: never edit once merged.
--
-- Invariant: a scheduling change to srs_cards needs a pending grant, and a grant exists only
-- because a srs_review_logs row was inserted in the same transaction. Grants live in a private table
-- (srs_guard.review_grants) that only the SECURITY DEFINER trigger functions below can read or write.
-- The app role has no privilege on schema srs_guard, so it can't forge, replay, or clear a grant.
--
-- SQLSTATEs (class SR, unused by Postgres):
--   SR001 scheduling update without a pending review log   SR004 review log committed without its card update
--   SR002 update doesn't match the pending log              SR005 card identity columns are immutable
--   SR003 second review log while one is still pending      SR006 card insert is not a pristine new card
CREATE SCHEMA srs_guard;
--> statement-breakpoint
REVOKE ALL ON SCHEMA srs_guard FROM PUBLIC;
--> statement-breakpoint
-- At most one open grant per transaction (keyed by the top-level transaction id, so savepoints share it).
-- Rows never outlive their transaction: a commit requires the grant to be consumed (deferred check),
-- and a rollback removes the row.
CREATE TABLE srs_guard.review_grants (
  log_id uuid PRIMARY KEY REFERENCES public.srs_review_logs (id) ON DELETE CASCADE,
  card_id uuid NOT NULL,
  xact_id xid8 NOT NULL,
  CONSTRAINT review_grants_one_per_xact UNIQUE (xact_id)
);
--> statement-breakpoint
REVOKE ALL ON TABLE srs_guard.review_grants FROM PUBLIC;
--> statement-breakpoint
-- New cards must start unscheduled, so card creation (and import) can't write history (US-VOC-03).
CREATE FUNCTION public.srs_cards_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state <> 'new' OR NEW.schedule_status <> 'new' OR NEW.reps <> 0 OR NEW.lapses <> 0
     OR NEW.stability <> 0 OR coalesce(NEW.stability_fast, 0) <> 0 OR NEW.difficulty <> 0
     OR NEW.scheduled_days <> 0 OR NEW.learning_steps <> 0 OR NEW.last_review_at IS NOT NULL THEN
    RAISE EXCEPTION 'srs guard: new cards must start unscheduled' USING ERRCODE = 'SR006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER srs_cards_guard_insert BEFORE INSERT ON public.srs_cards
  FOR EACH ROW EXECUTE FUNCTION public.srs_cards_guard_insert();
--> statement-breakpoint
-- Opens the grant for the log just inserted. Runs as the owner so it can write srs_guard.
CREATE FUNCTION public.srs_review_logs_open_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM srs_guard.review_grants WHERE xact_id = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'srs guard: previous review log not yet applied' USING ERRCODE = 'SR003';
  END IF;
  INSERT INTO srs_guard.review_grants (log_id, card_id, xact_id)
    VALUES (NEW.id, NEW.card_id, pg_current_xact_id());
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER srs_review_logs_open_grant AFTER INSERT ON public.srs_review_logs
  FOR EACH ROW EXECUTE FUNCTION public.srs_review_logs_open_grant();
--> statement-breakpoint
-- Every scheduling change must match, and consume, the grant opened by this transaction's log.
CREATE FUNCTION public.srs_cards_guard_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  pending srs_guard.review_grants%ROWTYPE;
  log_row public.srs_review_logs%ROWTYPE;
BEGIN
  IF (NEW.id, NEW.user_id, NEW.entry_id, NEW.direction)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.entry_id, OLD.direction) THEN
    RAISE EXCEPTION 'srs guard: card identity is immutable' USING ERRCODE = 'SR005';
  END IF;
  IF (NEW.state, NEW.schedule_status, NEW.due_at, NEW.stability, NEW.stability_fast, NEW.difficulty,
      NEW.scheduled_days, NEW.learning_steps, NEW.reps, NEW.lapses, NEW.last_review_at, NEW.scheduler_version)
     IS NOT DISTINCT FROM
     (OLD.state, OLD.schedule_status, OLD.due_at, OLD.stability, OLD.stability_fast, OLD.difficulty,
      OLD.scheduled_days, OLD.learning_steps, OLD.reps, OLD.lapses, OLD.last_review_at, OLD.scheduler_version) THEN
    RETURN NEW; -- no scheduling change, no grant needed
  END IF;
  SELECT * INTO pending FROM srs_guard.review_grants WHERE xact_id = pg_current_xact_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'srs guard: scheduling update without a review log in this transaction' USING ERRCODE = 'SR001';
  END IF;
  SELECT * INTO log_row FROM public.srs_review_logs WHERE id = pending.log_id;
  IF NOT FOUND OR pending.card_id <> NEW.id OR log_row.card_id <> NEW.id
     OR log_row.previous_due_at <> OLD.due_at OR log_row.next_due_at <> NEW.due_at
     OR log_row.scheduler_version <> NEW.scheduler_version THEN
    RAISE EXCEPTION 'srs guard: card update does not match the pending review log' USING ERRCODE = 'SR002';
  END IF;
  DELETE FROM srs_guard.review_grants WHERE log_id = pending.log_id; -- consume: one log, one update
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER srs_cards_guard_update BEFORE UPDATE ON public.srs_cards
  FOR EACH ROW EXECUTE FUNCTION public.srs_cards_guard_update();
--> statement-breakpoint
-- At COMMIT: a log whose grant was never consumed aborts the transaction (atomic transition + log).
CREATE FUNCTION public.srs_review_logs_require_applied() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM srs_guard.review_grants WHERE log_id = NEW.id) THEN
    RAISE EXCEPTION 'srs guard: review log inserted without a matching card update' USING ERRCODE = 'SR004';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER srs_review_logs_require_applied AFTER INSERT ON public.srs_review_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.srs_review_logs_require_applied();
--> statement-breakpoint
-- Trigger functions are never callable directly. EXECUTE is not needed for a trigger to fire.
REVOKE EXECUTE ON FUNCTION public.srs_cards_guard_insert(), public.srs_cards_guard_update(),
  public.srs_review_logs_open_grant(), public.srs_review_logs_require_applied() FROM PUBLIC;
