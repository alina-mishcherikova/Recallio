-- Least-privilege grants for the runtime role (ADR 0001 §4.2). Custom migration: never edit once merged.
-- The role is provisioned outside migrations (docker/postgres/initdb locally, the host in production).
-- GRANT fails loudly if it doesn't exist. There are no default privileges: every new table needs an
-- explicit grant in its own migration (tests/integration/roles.test.ts enforces the matrix).
--
-- UPDATE is always column-level. Keys, owner and parent columns (id, owner_id, collection_id,
-- entry_id, user_id) and created_at are never writable by the app role, so a row can't be moved to
-- another user or parent after the insert-time checks (RC001, RC003) ran.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO recallio_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.users, public.collections, public.vocabulary_entries,
  public.vocabulary_meanings, public.accepted_answers, public.answer_flags, public.vocabulary_synonyms,
  public.sentence_examples TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (email, password_hash, native_language, daily_new_limit, daily_review_limit, timezone)
  ON public.users TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (title, native_language, target_language, description, topic, normalization, archived_at)
  ON public.collections TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (target_expression, normalized_target_expression, native_expression, part_of_speech, topic,
  revision, updated_at) ON public.vocabulary_entries TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (definition, grammatical_metadata) ON public.vocabulary_meanings TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (meaning_id, language, answer_text, normalized_text, is_primary)
  ON public.accepted_answers TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (status) ON public.answer_flags TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (meaning_id, language, text, normalized_text, approval_status)
  ON public.vocabulary_synonyms TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (meaning_id, language, sentence, translation, target_answer, slots, approval_status)
  ON public.sentence_examples TO recallio_app;
--> statement-breakpoint
-- Append-only history.
GRANT SELECT, INSERT ON public.answer_change_log, public.practice_attempts, public.srs_review_logs TO recallio_app;
--> statement-breakpoint
-- Cards: create (pristine only, trigger) and update scheduling columns (guarded). No DELETE: cards
-- disappear only through entry/collection/user cascades, which run as the table owner.
-- INSERT stays table-level: Drizzle lists every column in an INSERT (unset ones as DEFAULT), and
-- Postgres checks column privileges even for DEFAULT. srs_cards_guard_insert enforces the pristine
-- values, the due_at bound and updated_at instead. Identity columns and updated_at are not updatable.
GRANT SELECT, INSERT ON public.srs_cards TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (state, schedule_status, due_at, stability, stability_fast, difficulty, scheduled_days,
  learning_steps, reps, lapses, last_review_at, scheduler_version) ON public.srs_cards TO recallio_app;
