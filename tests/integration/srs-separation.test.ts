// SRS separation regression at the database layer (CLAUDE.md rule 1, spec US-SRS-03, §14.2).
// For every practice source mode × exercise type × direction, and for every content write a
// practice or vocabulary flow can make (answers, change log, flags, entry edits, meanings),
// srs_cards and srs_review_logs must be byte-identical before and after. Parameterized from the
// shared enums, so a new practice mode is covered automatically. LEX-011/012 add the API-level
// version of this test for each mode.
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { DIRECTIONS, EXERCISE_TYPES, PRACTICE_SOURCE_MODES } from '../../shared/constants/enums'
import { connectAs, truncateAll } from './helpers/db'
import { seedUser, type SeededUser } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')

/** Full-row snapshot of both SRS tables, as text so float/timestamp formatting can't hide a change. */
async function srsSnapshot() {
  const cards = await migrator`select to_jsonb(c)::text as row from srs_cards c order by id`
  const logs = await migrator`select to_jsonb(l)::text as row from srs_review_logs l order by id`
  return { cards: cards.map((r) => r.row as string), logs: logs.map((r) => r.row as string) }
}

let alice: SeededUser

beforeEach(async () => {
  await truncateAll(migrator)
  alice = await seedUser(app) // one reviewed card (with a log) and one pristine card
  await seedUser(app)
})

const combos = PRACTICE_SOURCE_MODES.flatMap((sourceMode) =>
  EXERCISE_TYPES.flatMap((exerciseType) =>
    DIRECTIONS.flatMap((direction) =>
      [true, false].map((isCorrect) => ({ sourceMode, exerciseType, direction, isCorrect })),
    ),
  ),
)

describe('practice attempts never touch SRS', () => {
  it.each(combos)(
    'source_mode=$sourceMode exercise_type=$exerciseType direction=$direction correct=$isCorrect',
    async ({ sourceMode, exerciseType, direction, isCorrect }) => {
      const before = await srsSnapshot()
      const sessionId = randomUUID()
      for (let i = 0; i < 3; i++) {
        await app`
          insert into practice_attempts (user_id, entry_id, exercise_type, direction, source_mode,
                                         submitted_answer, matched_answer_id, is_correct, diff, session_id, expected_answer, entry_revision)
          values (${alice.userId}, ${alice.entryId}, ${exerciseType}, ${direction}, ${sourceMode},
                  ${isCorrect ? 'le chat' : 'le chien'}, ${isCorrect ? alice.answerId : null}, ${isCorrect},
                  ${app.json([{ op: 'equal', text: 'le ch' }])}, ${sessionId}, 'le chat', 1)`
      }
      expect(await srsSnapshot()).toEqual(before)
    },
  )
})

describe('content and feedback writes never touch SRS', () => {
  const writes: [string, () => Promise<unknown>][] = [
    [
      'add, edit and delete an accepted answer',
      async () => {
        const [a] = await app<{ id: string }[]>`
        insert into accepted_answers (entry_id, language, answer_text, normalized_text)
        values (${alice.entryId}, 'fr', 'Un chat', 'un chat') returning id`
        await app`update accepted_answers set answer_text = 'Le matou', normalized_text = 'le matou' where id = ${a!.id}`
        await app`update accepted_answers set is_primary = false where id = ${alice.answerId}`
        await app`delete from accepted_answers where id = ${a!.id}`
      },
    ],
    [
      'append to the answer change log',
      () =>
        app`insert into answer_change_log (answer_id, entry_id, user_id, action, before, after)
          values (${alice.answerId}, ${alice.entryId}, ${alice.userId}, 'update',
                  ${app.json({ answerText: 'Le chat' })}, ${app.json({ answerText: 'Le matou' })})`,
    ],
    [
      'flag a rejected answer and resolve the flag',
      async () => {
        const [f] = await app<{ id: string }[]>`
        insert into answer_flags (user_id, entry_id, direction, submitted_answer)
        values (${alice.userId}, ${alice.entryId}, 'recognition', 'cat') returning id`
        await app`update answer_flags set status = 'approved' where id = ${f!.id}`
      },
    ],
    [
      'edit the entry text and bump its revision',
      () =>
        app`update vocabulary_entries set target_expression = 'le chaton', revision = revision + 1,
                 updated_at = now() where id = ${alice.entryId}`,
    ],
    [
      'edit and add meanings',
      async () => {
        await app`update vocabulary_meanings set definition = 'young cat', grammatical_metadata = ${app.json({ gender: 'm' })}
                where id = ${alice.meaningId}`
        await app`insert into vocabulary_meanings (entry_id, definition) values (${alice.entryId}, 'a second meaning')`
      },
    ],
    [
      'rename and archive the collection',
      () =>
        app`update collections set title = 'Renamed', archived_at = now() where id = ${alice.collectionId}`,
    ],
    [
      'change the daily limits and timezone',
      () =>
        app`update users set daily_new_limit = 5, daily_review_limit = 50, timezone = 'Europe/Paris'
          where id = ${alice.userId}`,
    ],
  ]

  it.each(writes)('%s', async (_label, write) => {
    const before = await srsSnapshot()
    await write()
    expect(await srsSnapshot()).toEqual(before)
  })
})
