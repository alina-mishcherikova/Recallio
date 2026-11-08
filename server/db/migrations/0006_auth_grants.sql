-- Least-privilege grants for user_sessions (ADR 0002 §2.3). Custom migration: never edit once merged.
-- The app role creates, reads and deletes sessions, and may only touch last_seen_at. It can never move
-- a session to another user (user_id) or extend its absolute lifetime (created_at, expires_at).
REVOKE ALL ON public.user_sessions FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.user_sessions TO recallio_app;
--> statement-breakpoint
GRANT UPDATE (last_seen_at) ON public.user_sessions TO recallio_app;
