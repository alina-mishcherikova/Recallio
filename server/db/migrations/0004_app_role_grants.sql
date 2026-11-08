-- Least-privilege grants for the runtime role (ADR 0001 §4.2). Custom migration: never edit once merged.
-- The role is provisioned outside migrations (docker/postgres/initdb locally, the host in production).
-- GRANT fails loudly if it doesn't exist. There are no default privileges: every new table needs an
-- explicit grant in its own migration (tests/integration/roles.test.ts enforces the matrix).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO recallio_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.collections, public.vocabulary_entries,
  public.vocabulary_meanings, public.accepted_answers, public.answer_flags TO recallio_app;
--> statement-breakpoint
-- Append-only history.
GRANT SELECT, INSERT ON public.answer_change_log, public.practice_attempts, public.srs_review_logs TO recallio_app;
--> statement-breakpoint
-- Cards: create (pristine only, trigger) and update scheduling columns (guarded). No DELETE: cards
-- disappear only through entry/collection/user cascades, which run as the table owner.
-- Identity columns and updated_at (set by the guard) are not writable by privilege.
GRANT SELECT, INSERT ON public.srs_cards TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (state, schedule_status, due_at, stability, stability_fast, difficulty, scheduled_days,
  learning_steps, reps, lapses, last_review_at, scheduler_version) ON public.srs_cards TO recallio_app;
