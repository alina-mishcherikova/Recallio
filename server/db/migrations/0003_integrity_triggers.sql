-- Integrity triggers (ADR 0001 D7). Custom migration: never edit once merged.
--   RC001 user_id on a user-scoped child row doesn't own the entry's collection (CLAUDE.md rule 5)
--   RC002 collection languages are immutable once the collection has entries (DEC-001, spec §14.2)
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
CREATE TRIGGER answer_flags_check_entry_owner BEFORE INSERT OR UPDATE OF user_id, entry_id ON public.answer_flags
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
REVOKE EXECUTE ON FUNCTION public.check_entry_owner(), public.collections_languages_immutable() FROM PUBLIC;
