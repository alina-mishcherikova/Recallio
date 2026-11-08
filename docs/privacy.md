# Recallio — Privacy

What personal data Recallio stores, why, and for how long. The schema is in
[`architecture.md`](./architecture.md) §4 and [ADR 0001](./decisions/0001-database-schema.md).

## What is stored

| Data                     | Where                                                                                                  | Why                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Email address            | `users.email`                                                                                          | Log in and identify the account                                    |
| Password hash (scrypt)   | `users.password_hash`                                                                                  | Verify the password. The password itself is never stored or logged |
| Account settings         | `users`: native language, time zone, daily new/review limits                                           | Serve the right cards on the right day                             |
| Learning content you add | `collections`, `vocabulary_entries`, meanings, accepted answers, synonyms, example sentences           | The vocabulary you study                                           |
| Review history           | `srs_cards`, `srs_review_logs`: schedule, rating, time, card state before and after                    | Spaced repetition scheduling and statistics                        |
| Practice history         | `practice_attempts`: the answer you typed or chose, the expected answer, result, time                  | Practice feedback and statistics (kept apart from review history)  |
| Answer edits and flags   | `answer_change_log`, `answer_flags`: what an accepted answer was before and after, answers you flagged | Show the edit history; let you approve answers                     |
| Sessions                 | `user_sessions`: session id, user id, created, last seen, and expiry times                             | Keep you logged in; let logout and timeouts work                   |

Nothing else is stored in the database: no name, no tracking, no data from third parties. The
session cookie is sealed and holds the user id and a session id, and no learning data. Session rows store no IP address and no user agent. Learning content is free text
that you type, so don't enter personal data there.

## Sessions

A session row lives until you log out, it reaches 30 days after login (absolute), or it is unused for
7 days (idle). An hourly job deletes expired rows, and logging in prunes your own. At most 10 sessions
per user are kept. Deleting the account removes all of them.

## Logs

Security events (register, login, logout, rate limits, denied access, server errors) are written to the
application log as JSON. They contain the client **IP address in clear**, a request id, the user id when
known, and a reason code. Emails appear only as a short keyed hash (16 hex characters), never in clear.
Passwords, cookies, session ids, and request bodies are never logged. Log retention depends on the hosting
provider and is still to be decided (LEX-017). Logs are not removed when you delete your account.
Rate-limit counters (keyed by IP or email hash) are kept in memory only, for at most 24 hours.

## Password blocklist

New passwords are checked against a list of common passwords shipped with the app
(`server/assets/password-blocklist.txt`). It comes from public datasets, contains no user data, and
nothing about your password is sent to a third party.

## Retention

Data is kept until you delete your account. Account deletion is a **hard delete**: all rows
above are removed in one transaction through database cascades. There is no soft-delete flag and no
"deleted" copy. Backups of the hosting provider expire on their own schedule (to be documented when
hosting is chosen).

## Append-only history

While the account exists, review and practice history is **append-only**. The application's
database role can insert these rows but not change or delete them (`srs_review_logs`,
`practice_attempts`, `answer_change_log`). Editing a vocabulary entry never rewrites past reviews or
attempts. The only way to remove them is to delete the vocabulary entry, collection, or account they
belong to, which cascades.

## Security of the data

Access is checked per user on every query. The database connection uses a least-privilege role
(architecture §8). Logs never contain passwords, tokens, or request bodies.
