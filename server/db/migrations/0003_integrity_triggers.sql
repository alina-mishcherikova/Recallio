-- Integrity triggers (ADR 0001 D7). Custom migration: never edit once merged.
--   RC001 user_id on a user-scoped child row doesn't own the entry's collection (CLAUDE.md rule 5)
--   RC002 collection languages are immutable once the collection has entries (DEC-001, spec §14.2)
--   RC003 an answer/synonym/example language is not one of its collection's two languages
--   RC004 entry_revision is ahead of the entry's current revision
-- Owner and parent columns can't be updated by the app role at all (column grants, migration 0004),
-- so these checks run on INSERT (and on UPDATE of the few columns that stay writable).
--
-- (a) Ownership consistency. If the entry doesn't exist, the FK reports it (23503).
CREATE FUNCTION public.check_entry_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner uuid;
BEGIN
  SELECT c.owner_id INTO owner
    FROM public.vocabulary_entries e
    JOIN public.collections c ON c.id = e.collection_id
   WHERE e.id = NEW.entry_id;
  IF FOUND AND owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'integrity: user does not own the entry' USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER srs_cards_check_entry_owner BEFORE INSERT ON public.srs_cards
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_owner();
--> statement-breakpoint
CREATE TRIGGER practice_attempts_check_entry_owner BEFORE INSERT ON public.practice_attempts
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_owner();
--> statement-breakpoint
CREATE TRIGGER answer_change_log_check_entry_owner BEFORE INSERT ON public.answer_change_log
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_owner();
--> statement-breakpoint
CREATE TRIGGER answer_flags_check_entry_owner BEFORE INSERT ON public.answer_flags
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_owner();
--> statement-breakpoint
-- (b) Language changes would silently change the meaning of every card and answer in the collection.
CREATE FUNCTION public.collections_languages_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.native_language, NEW.target_language) IS DISTINCT FROM (OLD.native_language, OLD.target_language)
     AND EXISTS (SELECT 1 FROM public.vocabulary_entries WHERE collection_id = OLD.id) THEN
    RAISE EXCEPTION 'integrity: collection languages are immutable once it has entries' USING ERRCODE = 'RC002';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER collections_languages_immutable BEFORE UPDATE OF native_language, target_language ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.collections_languages_immutable();
--> statement-breakpoint
-- Closes the race with (b): the FK check on an entry insert only takes FOR KEY SHARE on the
-- collection, which doesn't conflict with a language UPDATE. FOR SHARE does, so an entry insert and
-- a language change on the same collection serialize, and RC002 then sees the committed entry.
CREATE FUNCTION public.vocabulary_entries_lock_collection() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.collections WHERE id = NEW.collection_id FOR SHARE;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER vocabulary_entries_lock_collection BEFORE INSERT ON public.vocabulary_entries
  FOR EACH ROW EXECUTE FUNCTION public.vocabulary_entries_lock_collection();
--> statement-breakpoint
-- (c) Answers, synonyms and examples must be in one of the collection's two languages (US-VOC-04).
-- A badly formatted code is left to the CHECK constraint (23514), a missing entry to the FK (23503).
CREATE FUNCTION public.check_entry_language() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  native text;
  target text;
BEGIN
  SELECT c.native_language, c.target_language INTO native, target
    FROM public.vocabulary_entries e
    JOIN public.collections c ON c.id = e.collection_id
   WHERE e.id = NEW.entry_id;
  IF FOUND AND NEW.language ~ '^[a-z]{2}$' AND NEW.language NOT IN (native, target) THEN
    RAISE EXCEPTION 'integrity: language is not one of the collection languages' USING ERRCODE = 'RC003';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER accepted_answers_check_entry_language BEFORE INSERT OR UPDATE OF language ON public.accepted_answers
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_language();
--> statement-breakpoint
CREATE TRIGGER vocabulary_synonyms_check_entry_language BEFORE INSERT OR UPDATE OF language ON public.vocabulary_synonyms
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_language();
--> statement-breakpoint
CREATE TRIGGER sentence_examples_check_entry_language BEFORE INSERT OR UPDATE OF language ON public.sentence_examples
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_language();
--> statement-breakpoint
-- (d) History can't claim a revision the entry hasn't reached. (Review logs: checked in 0002.)
CREATE FUNCTION public.check_entry_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_revision integer;
BEGIN
  SELECT revision INTO current_revision FROM public.vocabulary_entries WHERE id = NEW.entry_id;
  IF FOUND AND NEW.entry_revision > current_revision THEN
    RAISE EXCEPTION 'integrity: entry_revision is ahead of the entry' USING ERRCODE = 'RC004';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER practice_attempts_check_entry_revision BEFORE INSERT ON public.practice_attempts
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_revision();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.check_entry_owner(), public.collections_languages_immutable(),
  public.vocabulary_entries_lock_collection(), public.check_entry_language(),
  public.check_entry_revision() FROM PUBLIC;
