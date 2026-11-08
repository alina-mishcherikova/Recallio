CREATE TYPE "public"."answer_change_action" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('recognition', 'production');--> statement-breakpoint
CREATE TYPE "public"."exercise_type" AS ENUM('typing', 'multiple_choice');--> statement-breakpoint
CREATE TYPE "public"."practice_source_mode" AS ENUM('typing', 'multiple_choice', 'difficult_words');--> statement-breakpoint
CREATE TYPE "public"."srs_rating" AS ENUM('again', 'hard', 'good', 'easy');--> statement-breakpoint
CREATE TYPE "public"."srs_schedule_status" AS ENUM('new', 'learning', 'review');--> statement-breakpoint
CREATE TYPE "public"."srs_state" AS ENUM('new', 'learning', 'review', 'relearning');--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"native_language" text NOT NULL,
	"target_language" text NOT NULL,
	"description" text,
	"topic" text,
	"normalization" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_languages_differ" CHECK ("collections"."native_language" <> "collections"."target_language"),
	CONSTRAINT "collections_native_language_code" CHECK ("collections"."native_language" ~ '^[a-z]{2}$'),
	CONSTRAINT "collections_target_language_code" CHECK ("collections"."target_language" ~ '^[a-z]{2}$'),
	CONSTRAINT "collections_title_len" CHECK (char_length("collections"."title") between 1 and 200),
	CONSTRAINT "collections_description_len" CHECK ("collections"."description" is null or char_length("collections"."description") <= 2000),
	CONSTRAINT "collections_topic_len" CHECK ("collections"."topic" is null or char_length("collections"."topic") between 1 and 100),
	CONSTRAINT "collections_normalization_object" CHECK (jsonb_typeof("collections"."normalization") = 'object' and octet_length("collections"."normalization"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"native_language" text NOT NULL,
	"daily_new_limit" integer DEFAULT 20 NOT NULL,
	"daily_review_limit" integer DEFAULT 200 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_len" CHECK (char_length("users"."email") between 3 and 254),
	CONSTRAINT "users_password_hash_len" CHECK (char_length("users"."password_hash") between 1 and 512),
	CONSTRAINT "users_native_language_code" CHECK ("users"."native_language" ~ '^[a-z]{2}$'),
	CONSTRAINT "users_daily_new_limit_range" CHECK ("users"."daily_new_limit" between 0 and 1000),
	CONSTRAINT "users_daily_review_limit_range" CHECK ("users"."daily_review_limit" between 0 and 10000),
	CONSTRAINT "users_timezone_len" CHECK (char_length("users"."timezone") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "accepted_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"meaning_id" uuid,
	"language" text NOT NULL,
	"answer_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "accepted_answers_language_code" CHECK ("accepted_answers"."language" ~ '^[a-z]{2}$'),
	CONSTRAINT "accepted_answers_text_len" CHECK (char_length("accepted_answers"."answer_text") between 1 and 500),
	CONSTRAINT "accepted_answers_normalized_len" CHECK (char_length("accepted_answers"."normalized_text") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "answer_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" "answer_change_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_change_log_shape" CHECK (("answer_change_log"."action" = 'create' and "answer_change_log"."before" is null and "answer_change_log"."after" is not null) or ("answer_change_log"."action" = 'update' and "answer_change_log"."before" is not null and "answer_change_log"."after" is not null) or ("answer_change_log"."action" = 'delete' and "answer_change_log"."before" is not null and "answer_change_log"."after" is null)),
	CONSTRAINT "answer_change_log_objects" CHECK (("answer_change_log"."before" is null or jsonb_typeof("answer_change_log"."before") = 'object') and ("answer_change_log"."after" is null or jsonb_typeof("answer_change_log"."after") = 'object'))
);
--> statement-breakpoint
CREATE TABLE "answer_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"submitted_answer" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_flags_submitted_len" CHECK (char_length("answer_flags"."submitted_answer") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "vocabulary_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"target_expression" text NOT NULL,
	"native_expression" text NOT NULL,
	"part_of_speech" text,
	"topic" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vocabulary_entries_target_len" CHECK (char_length("vocabulary_entries"."target_expression") between 1 and 500),
	CONSTRAINT "vocabulary_entries_native_len" CHECK (char_length("vocabulary_entries"."native_expression") between 1 and 500),
	CONSTRAINT "vocabulary_entries_pos_len" CHECK ("vocabulary_entries"."part_of_speech" is null or char_length("vocabulary_entries"."part_of_speech") between 1 and 50),
	CONSTRAINT "vocabulary_entries_topic_len" CHECK ("vocabulary_entries"."topic" is null or char_length("vocabulary_entries"."topic") between 1 and 100),
	CONSTRAINT "vocabulary_entries_revision_positive" CHECK ("vocabulary_entries"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "vocabulary_meanings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"definition" text,
	"grammatical_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "vocabulary_meanings_id_entry_key" UNIQUE("id","entry_id"),
	CONSTRAINT "vocabulary_meanings_definition_len" CHECK ("vocabulary_meanings"."definition" is null or char_length("vocabulary_meanings"."definition") between 1 and 2000),
	CONSTRAINT "vocabulary_meanings_metadata_object" CHECK (jsonb_typeof("vocabulary_meanings"."grammatical_metadata") = 'object' and octet_length("vocabulary_meanings"."grammatical_metadata"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "srs_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"state" "srs_state" DEFAULT 'new' NOT NULL,
	"schedule_status" "srs_schedule_status" DEFAULT 'new' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"stability" double precision DEFAULT 0 NOT NULL,
	"stability_fast" double precision,
	"difficulty" double precision DEFAULT 0 NOT NULL,
	"scheduled_days" double precision DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"last_review_at" timestamp with time zone,
	"scheduler_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "srs_cards_user_entry_direction_key" UNIQUE("user_id","entry_id","direction"),
	CONSTRAINT "srs_cards_stability_finite" CHECK ("srs_cards"."stability" >= 0 and "srs_cards"."stability" < 'Infinity'::float8),
	CONSTRAINT "srs_cards_stability_fast_finite" CHECK ("srs_cards"."stability_fast" is null or ("srs_cards"."stability_fast" >= 0 and "srs_cards"."stability_fast" < 'Infinity'::float8)),
	CONSTRAINT "srs_cards_difficulty_range" CHECK ("srs_cards"."difficulty" >= 0 and "srs_cards"."difficulty" <= 10),
	CONSTRAINT "srs_cards_scheduled_days_finite" CHECK ("srs_cards"."scheduled_days" >= 0 and "srs_cards"."scheduled_days" < 'Infinity'::float8),
	CONSTRAINT "srs_cards_counters" CHECK ("srs_cards"."learning_steps" >= 0 and "srs_cards"."reps" >= 0 and "srs_cards"."lapses" >= 0 and "srs_cards"."lapses" <= "srs_cards"."reps"),
	CONSTRAINT "srs_cards_scheduler_version_len" CHECK (char_length("srs_cards"."scheduler_version") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "srs_review_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"client_review_id" uuid NOT NULL,
	"rating" "srs_rating" NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"previous_state" jsonb NOT NULL,
	"next_state" jsonb NOT NULL,
	"previous_due_at" timestamp with time zone NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"scheduler_version" text NOT NULL,
	CONSTRAINT "srs_review_logs_states_objects" CHECK (jsonb_typeof("srs_review_logs"."previous_state") = 'object' and jsonb_typeof("srs_review_logs"."next_state") = 'object'),
	CONSTRAINT "srs_review_logs_due_order" CHECK ("srs_review_logs"."next_due_at" >= "srs_review_logs"."reviewed_at"),
	CONSTRAINT "srs_review_logs_scheduler_version_len" CHECK (char_length("srs_review_logs"."scheduler_version") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "practice_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"exercise_type" "exercise_type" NOT NULL,
	"direction" "direction" NOT NULL,
	"source_mode" "practice_source_mode" NOT NULL,
	"submitted_answer" text NOT NULL,
	"matched_answer_id" uuid,
	"is_correct" boolean NOT NULL,
	"diff" jsonb,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_attempts_submitted_len" CHECK (char_length("practice_attempts"."submitted_answer") <= 500),
	CONSTRAINT "practice_attempts_match_implies_correct" CHECK ("practice_attempts"."matched_answer_id" is null or "practice_attempts"."is_correct"),
	CONSTRAINT "practice_attempts_diff_array" CHECK ("practice_attempts"."diff" is null or jsonb_typeof("practice_attempts"."diff") = 'array')
);
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_answers" ADD CONSTRAINT "accepted_answers_entry_id_vocabulary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocabulary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_answers" ADD CONSTRAINT "accepted_answers_meaning_entry_fk" FOREIGN KEY ("meaning_id","entry_id") REFERENCES "public"."vocabulary_meanings"("id","entry_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_change_log" ADD CONSTRAINT "answer_change_log_entry_id_vocabulary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocabulary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_change_log" ADD CONSTRAINT "answer_change_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_flags" ADD CONSTRAINT "answer_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_flags" ADD CONSTRAINT "answer_flags_entry_id_vocabulary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocabulary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_meanings" ADD CONSTRAINT "vocabulary_meanings_entry_id_vocabulary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocabulary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "srs_cards" ADD CONSTRAINT "srs_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "srs_cards" ADD CONSTRAINT "srs_cards_entry_id_vocabulary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocabulary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "srs_review_logs" ADD CONSTRAINT "srs_review_logs_card_id_srs_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."srs_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_entry_id_vocabulary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocabulary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_matched_answer_id_accepted_answers_id_fk" FOREIGN KEY ("matched_answer_id") REFERENCES "public"."accepted_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collections_owner_created_idx" ON "collections" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "accepted_answers_entry_language_idx" ON "accepted_answers" USING btree ("entry_id","language");--> statement-breakpoint
CREATE INDEX "accepted_answers_meaning_idx" ON "accepted_answers" USING btree ("meaning_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accepted_answers_one_primary_idx" ON "accepted_answers" USING btree ("entry_id","language") WHERE "accepted_answers"."is_primary";--> statement-breakpoint
CREATE INDEX "answer_change_log_entry_created_idx" ON "answer_change_log" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "answer_change_log_user_idx" ON "answer_change_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "answer_flags_user_status_created_idx" ON "answer_flags" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "answer_flags_entry_idx" ON "answer_flags" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "vocabulary_entries_collection_page_idx" ON "vocabulary_entries" USING btree ("collection_id","created_at","id");--> statement-breakpoint
CREATE INDEX "vocabulary_meanings_entry_idx" ON "vocabulary_meanings" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "srs_cards_user_due_idx" ON "srs_cards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "srs_cards_entry_idx" ON "srs_cards" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "srs_review_logs_client_review_id_key" ON "srs_review_logs" USING btree ("client_review_id");--> statement-breakpoint
CREATE INDEX "srs_review_logs_card_reviewed_idx" ON "srs_review_logs" USING btree ("card_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "practice_attempts_user_created_idx" ON "practice_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "practice_attempts_entry_idx" ON "practice_attempts" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "practice_attempts_matched_answer_idx" ON "practice_attempts" USING btree ("matched_answer_id");