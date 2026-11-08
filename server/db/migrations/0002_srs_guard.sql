-- SRS database guard (ADR 0001 §3, D4 = variant B). Custom migration: never edit once merged.
--
-- Invariant: a scheduling change to srs_cards needs a pending grant, and a grant exists only
-- because a srs_review_logs row was inserted in the same transaction. The update must be exactly the
-- transition the log describes (previous_state = card before, next_state = card after, one more rep).
-- Grants live in a private table (srs_guard.review_grants) that only the SECURITY DEFINER trigger
-- functions below can read or write. The app role has no privilege on schema srs_guard, so it can't
-- forge, replay, or clear a grant.
--
-- SQLSTATEs (class SR, unused by Postgres; RC001 is shared with migration 0003):
--   SR001 scheduling update without a pending review log   SR004 review log committed without its card update
--   SR002 update doesn't match the pending log              SR005 card identity columns are immutable
--   SR003 second review log while one is still pending      SR006 card insert is not a pristine new card
--   RC001 the log's user_id is not the card's user          RC004 entry_revision is ahead of the entry
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
-- True when `snap` is exactly the scheduling state of card `c` in the documented snapshot format
-- (server/db/schema/srs.ts SRS_SNAPSHOT_KEYS): the 12 camelCase keys and nothing else, enum labels as
-- strings, numbers as JSON numbers (so no NaN/Infinity), timestamps as ISO 8601 strings, JSON null
-- only for an absent stabilityFast / lastReviewAt. Any malformed value means "no match", never an error.
CREATE FUNCTION srs_guard.snapshot_matches(snap jsonb, c public.srs_cards) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  iso CONSTANT text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$';
BEGIN
  IF snap IS NULL OR jsonb_typeof(snap) <> 'object'
     OR NOT snap ?& ARRAY['state', 'scheduleStatus', 'dueAt', 'stability', 'stabilityFast', 'difficulty',
                          'scheduledDays', 'learningSteps', 'reps', 'lapses', 'lastReviewAt', 'schedulerVersion']
     OR (SELECT count(*) FROM jsonb_object_keys(snap)) <> 12 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(snap->'state') <> 'string' OR jsonb_typeof(snap->'scheduleStatus') <> 'string'
     OR jsonb_typeof(snap->'schedulerVersion') <> 'string'
     OR jsonb_typeof(snap->'dueAt') <> 'string' OR NOT (snap->>'dueAt') ~ iso
     OR jsonb_typeof(snap->'lastReviewAt') NOT IN ('string', 'null')
     OR (jsonb_typeof(snap->'lastReviewAt') = 'string' AND NOT (snap->>'lastReviewAt') ~ iso)
     OR jsonb_typeof(snap->'stability') <> 'number' OR jsonb_typeof(snap->'difficulty') <> 'number'
     OR jsonb_typeof(snap->'scheduledDays') <> 'number' OR jsonb_typeof(snap->'learningSteps') <> 'number'
     OR jsonb_typeof(snap->'reps') <> 'number' OR jsonb_typeof(snap->'lapses') <> 'number'
     OR jsonb_typeof(snap->'stabilityFast') NOT IN ('number', 'null') THEN
    RETURN false;
  END IF;
  RETURN (snap->>'state') = c.state::text
     AND (snap->>'scheduleStatus') = c.schedule_status::text
     AND (snap->>'schedulerVersion') = c.scheduler_version
     AND (snap->>'dueAt')::timestamptz = c.due_at
     AND (snap->>'lastReviewAt')::timestamptz IS NOT DISTINCT FROM c.last_review_at
     AND (snap->>'stability')::float8 = c.stability
     AND (snap->>'stabilityFast')::float8 IS NOT DISTINCT FROM c.stability_fast
     AND (snap->>'difficulty')::float8 = c.difficulty
     AND (snap->>'scheduledDays')::float8 = c.scheduled_days
     AND (snap->>'learningSteps')::numeric = c.learning_steps
     AND (snap->>'reps')::numeric = c.reps
     AND (snap->>'lapses')::numeric = c.lapses;
EXCEPTION WHEN data_exception THEN
  RETURN false; -- out-of-range or unparsable value
END $$;
--> statement-breakpoint
-- New cards must start unscheduled, so card creation (and import) can't write history (US-VOC-03).
-- due_at may not be pushed into the future (a silently suspended card); timestamps are truncated to
-- milliseconds so the first review's previous_state (built from JS) matches exactly.
CREATE FUNCTION public.srs_cards_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state <> 'new' OR NEW.schedule_status <> 'new' OR NEW.reps <> 0 OR NEW.lapses <> 0
     OR NEW.stability <> 0 OR coalesce(NEW.stability_fast, 0) <> 0 OR NEW.difficulty <> 0
     OR NEW.scheduled_days <> 0 OR NEW.learning_steps <> 0 OR NEW.last_review_at IS NOT NULL
     OR NEW.due_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'srs guard: new cards must start unscheduled' USING ERRCODE = 'SR006';
  END IF;
  NEW.due_at := date_trunc('milliseconds', NEW.due_at);
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER srs_cards_guard_insert BEFORE INSERT ON public.srs_cards
  FOR EACH ROW EXECUTE FUNCTION public.srs_cards_guard_insert();
--> statement-breakpoint
-- Opens the grant for the log just inserted. Runs as the owner so it can write srs_guard.
CREATE FUNCTION public.srs_review_logs_open_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  card_user uuid;
  revision integer;
BEGIN
  SELECT c.user_id, e.revision INTO card_user, revision
    FROM public.srs_cards c
    JOIN public.vocabulary_entries e ON e.id = c.entry_id
   WHERE c.id = NEW.card_id;
  IF card_user IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'integrity: review log user is not the card user' USING ERRCODE = 'RC001';
  END IF;
  IF NEW.entry_revision > revision THEN
    RAISE EXCEPTION 'integrity: entry_revision is ahead of the entry' USING ERRCODE = 'RC004';
  END IF;
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
-- Every scheduling change must be exactly the transition described by, and consume, the grant opened
-- by this transaction's log.
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
    NEW.updated_at := OLD.updated_at;
    RETURN NEW; -- no scheduling change, no grant needed
  END IF;
  SELECT * INTO pending FROM srs_guard.review_grants WHERE xact_id = pg_current_xact_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'srs guard: scheduling update without a review log in this transaction' USING ERRCODE = 'SR001';
  END IF;
  SELECT * INTO log_row FROM public.srs_review_logs WHERE id = pending.log_id;
  IF NOT FOUND OR pending.card_id <> NEW.id OR log_row.card_id <> NEW.id
     OR log_row.previous_due_at <> OLD.due_at OR log_row.next_due_at <> NEW.due_at
     OR log_row.scheduler_version <> NEW.scheduler_version
     -- the review happened at reviewed_at, after the previous review, and moves the card forward
     OR NEW.last_review_at IS DISTINCT FROM log_row.reviewed_at
     OR log_row.reviewed_at < OLD.last_review_at
     OR NEW.due_at <= log_row.reviewed_at
     -- exactly one review; a lapse only on Again
     OR NEW.reps <> OLD.reps + 1
     OR NEW.lapses NOT IN (OLD.lapses, OLD.lapses + 1)
     OR (NEW.lapses = OLD.lapses + 1 AND log_row.rating <> 'again')
     -- the snapshots are the card before and after
     OR NOT srs_guard.snapshot_matches(log_row.previous_state, OLD)
     OR NOT srs_guard.snapshot_matches(log_row.next_state, NEW) THEN
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
  public.srs_review_logs_open_grant(), public.srs_review_logs_require_applied(),
  srs_guard.snapshot_matches(jsonb, public.srs_cards) FROM PUBLIC;
