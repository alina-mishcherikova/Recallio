// The indexes serve the queries LEX-005/008/009/014 will run (ADR 0001 §2.3). Tables are tiny in
// tests, so seq scans are disabled per transaction: the assertion is "the planner CAN use the
// intended index for this query shape", which fails if a column order or predicate doesn't fit.
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { connectAs, truncateAll } from './helpers/db'
import { T0 } from './helpers/factories'

const app = connectAs('app')
const migrator = connectAs('migrator')
const id = randomUUID()

beforeAll(async () => {
  await truncateAll(migrator)
  await migrator`analyze`
})

async function plan(query: string, params: unknown[]): Promise<string> {
  return app.begin(async (tx) => {
    await tx`set local enable_seqscan = off`
    await tx`set local enable_bitmapscan = off`
    const rows = await tx.unsafe(`explain (costs off) ${query}`, params as never[])
    return rows.map((r) => r['QUERY PLAN'] as string).join('\n')
  })
}

// [description, query, params, index that must appear]. Queries mirror the ADR comments.
const cases: [string, string, unknown[], string | RegExp][] = [
  [
    'due queue: user, due before now, oldest first',
    `select * from srs_cards where user_id = $1 and due_at <= $2 order by due_at limit 50`,
    [id, T0],
    'srs_cards_user_due_idx',
  ],
  [
    'due queue filtered by direction (US-SRS-02)',
    `select * from srs_cards where user_id = $1 and due_at <= $2 and direction = 'production' order by due_at limit 50`,
    [id, T0],
    'srs_cards_user_due_idx',
  ],
  [
    'due count for the dashboard',
    `select count(*) from srs_cards where user_id = $1 and due_at <= $2`,
    [id, T0],
    'srs_cards_user_due_idx',
  ],
  [
    'entry list: keyset page, ascending',
    `select * from vocabulary_entries where collection_id = $1 and (created_at, id) > ($2, $3)
      order by created_at, id limit 50`,
    [id, T0, id],
    'vocabulary_entries_collection_page_idx',
  ],
  [
    'entry list: keyset page, newest first',
    `select * from vocabulary_entries where collection_id = $1 and (created_at, id) < ($2, $3)
      order by created_at desc, id desc limit 50`,
    [id, T0, id],
    'vocabulary_entries_collection_page_idx',
  ],
  [
    'collection list for the owner, newest first',
    `select * from collections where owner_id = $1 order by created_at desc limit 50`,
    [id],
    'collections_owner_created_idx',
  ],
  [
    'card history for a card',
    `select * from srs_review_logs where card_id = $1 order by reviewed_at desc limit 50`,
    [id],
    'srs_review_logs_card_reviewed_idx',
  ],
  [
    // The owner check then joins srs_cards on its primary key; on empty tables the planner's join
    // choice is noise, so only the lookup itself is asserted.
    'idempotent replay lookup (per card, security L4)',
    `select * from srs_review_logs where card_id = $1 and client_review_id = $2`,
    [id, id],
    // Both indexes lead with card_id; on empty tables the planner may pick either.
    /srs_review_logs_card_(client_review_id_key|reviewed_idx)/,
  ],
  [
    'practice activity for a date range (US-ANA-01)',
    `select direction, exercise_type, count(*), sum(is_correct::int) from practice_attempts
      where user_id = $1 and created_at >= $2 and created_at < $3 group by 1, 2`,
    [id, T0, T0],
    'practice_attempts_user_created_idx',
  ],
  [
    'pending answer flags for a user',
    `select * from answer_flags where user_id = $1 and status = 'pending' order by created_at limit 50`,
    [id],
    'answer_flags_user_status_created_idx',
  ],
  [
    'accepted answers for an entry and language (answer engine)',
    `select * from accepted_answers where entry_id = $1 and language = 'fr'`,
    [id],
    'accepted_answers_entry_language_text_key',
  ],
  [
    'reviews today for the daily limits (US-SRS-04)',
    `select count(*) from srs_review_logs where user_id = $1 and reviewed_at >= $2 and reviewed_at < $3`,
    [id, T0, T0],
    'srs_review_logs_user_reviewed_idx',
  ],
  [
    'duplicate lookup on create and CSV import (US-VOC-03)',
    `select id, normalized_target_expression from vocabulary_entries
      where collection_id = $1 and normalized_target_expression = any($2)`,
    [id, ['le chat', 'le chien']],
    'vocabulary_entries_collection_normalized_idx',
  ],
  [
    'answer change log for an entry',
    `select * from answer_change_log where entry_id = $1 order by created_at desc`,
    [id],
    'answer_change_log_entry_created_idx',
  ],
]

describe('indexes match the planned query shapes', () => {
  it.each(cases)('%s', async (_label, query, params, index) => {
    const p = await plan(query, params)
    if (typeof index === 'string') expect(p).toContain(index)
    else expect(p).toMatch(index)
  })
})
