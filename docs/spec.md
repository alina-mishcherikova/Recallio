# Recallio — Product & Functional Specification (v1.1)

> Source: requirements v1.1 (2026-11-08), originally drafted under the working name "Lexora". The product is named **Recallio**.

# 1. Product Vision

Recallio is a vocabulary learning platform designed to help people discover, memorize, retain, and actively use vocabulary in a foreign language.

The application combines a scientifically informed Spaced Repetition System (FSRS) with varied learning exercises.

Its distinguishing feature is the separation between long-term memory scheduling and optional learning activities.

**Core product promise:**

Learn vocabulary in different ways, remember it for longer, and develop the ability to use it independently.

## 1.1 Primary Objectives

1. Improve long-term vocabulary retention.
2. Support both recognition and active vocabulary production.
3. Provide engaging alternatives to repetitive flashcard practice.
4. Help learners understand words in context.
5. Support accurate spelling and, subsequently, listening comprehension.
6. Provide transparent learning analytics.
7. Make learning accessible across desktop and mobile devices.
8. Support all core features without generative AI.

## 1.2 Target Audience

- Independent language learners.
- University students learning general or specialized vocabulary.
- Multilingual learners.
- People preparing for language examinations.
- Learners building personal vocabulary collections.

## 1.3 Product Boundaries

Recallio is primarily a vocabulary learning platform, not a complete language course.

The initial product will not attempt to provide full grammar instruction, unrestricted conversational tutoring, or automated evaluation of arbitrary essays.

---

# 2. Confirmed Product Decisions

## DEC-001 — Language Architecture

Each vocabulary collection has exactly one native language and one target language.

Examples:

- Ukrainian ↔ English
- Ukrainian ↔ French
- French ↔ English

Users may create multiple collections with different language pairs.

Both directions must be supported:

**Recognition:** Target language → Native language.

**Production:** Native language → Target language.

The application's question direction must always be explicit.

Language configuration must be saved at collection level. Users may change their default languages without silently modifying existing collections.

## DEC-002 — SRS Isolation

Only the dedicated **Review Mode** is authorized to update FSRS scheduling.

The following modes must never modify FSRS states or due dates:

- Standalone Typing.
- Multiple Choice.
- Contextual Sentence Completion.
- Listening & Dictation.
- Test Mode.
- Guided Memorization.
- Difficult Words Practice.

These modes may save independent exercise results.

A flashcard displayed in the dedicated Review Mode can update FSRS after the user submits a recall rating.

The same vocabulary displayed in an independent practice session must not update FSRS.

## DEC-003 — Contextual Content

Sentence Completion uses:

1. Curated and approved examples.
2. Rule-based sentence templates.
3. Language- and grammar-aware substitutions.
4. Deterministic answer validation.

Generative AI is not required.

Only validated examples may enter the exercise pool.

## DEC-004 — Guided Memorization

Guided Memorization is independent of the main FSRS system.

The progression is:

1. Familiarization.
2. Multiple Choice.
3. Typing.
4. Internal Reinforcement.
5. Final Assessment.

The final assessment combines a mixed vocabulary test and contextual writing.

Guided progress, internal repetition, and final scores are stored separately from FSRS records.

---

# 3. Main User Journey

The primary learning journey is:

1. Register or log in.
2. Select native and target languages.
3. Create a vocabulary collection or import an existing CSV.
4. Add translations, examples, and optional metadata.
5. Choose a learning mode.
6. Complete exercises.
7. Receive feedback.
8. Return for scheduled FSRS reviews.
9. Track progress using the analytics dashboard.

A returning learner should be able to start reviewing due vocabulary directly from the dashboard.

---

# 4. Vocabulary and Collection Management

## Epic VOC — Vocabulary Management

### US-VOC-01 — Create Collections

**As a learner,** I want to create vocabulary collections so that I can organize vocabulary by subject and language pair.

**Acceptance criteria**

- Given an authenticated user, when a collection is created, it is associated with that user.
- A collection requires a title, native language, and target language.
- Both languages must be different.
- A collection may have a description and topic.
- Users can rename and archive collections.
- Destructive deletion requires confirmation.

**Priority:** P0 — MVP

### US-VOC-02 — Create and Edit Vocabulary

**As a learner,** I want to add and edit vocabulary entries so that I can maintain my personal word library.

**Acceptance criteria**

- Each entry contains a target-language expression and at least one native-language equivalent.
- Entries support words, phrases, and short sentences.
- Users can add optional definitions, examples, synonyms, and grammatical information.
- Multiple accepted answers can be stored.
- Editing an entry does not automatically reset its FSRS history.
- Changes to materially different meanings require an explicit reset or new-entry action.

**Priority:** P0 — MVP

### US-VOC-03 — Import CSV

**As a learner,** I want to import CSV files so that I can add vocabulary efficiently.

**Acceptance criteria**

- Users can upload UTF-8 CSV files.
- Comma, semicolon, and tab delimiters are supported.
- Quoted values containing delimiters are parsed correctly.
- Users can map file columns to vocabulary fields.
- The application provides an import preview.
- Invalid rows and duplicate candidates are reported.
- Users can skip, update, or import duplicates as separate entries.
- Importing cannot overwrite existing FSRS history.

**Priority:** P0 — MVP

### US-VOC-04 — Manage Accepted Answers

**As a learner,** I want to define alternative translations so that valid expressions are not incorrectly marked as spelling mistakes.

**Acceptance criteria**

- Accepted answers are attached to a specific vocabulary meaning.
- Answers are associated with the appropriate language.
- One or more alternatives may be accepted.
- Normalization rules are configurable.
- Answer changes are logged for debugging and content quality.

**Priority:** P0 — MVP

---

# 5. Dedicated Review Mode — FSRS

## Epic SRS — Long-Term Retention

The application uses an established FSRS implementation.

Each vocabulary entry generates two independently scheduled review cards:

- Target → Native.
- Native → Target.

Each card stores its own scheduler state, due date, memory parameters, and review history.

The application should default to a desired retention of 0.90, configurable in a later release.

### US-SRS-01 — Review Due Cards

**As a learner,** I want to review vocabulary when it becomes due so that I can retain it over time.

**Acceptance criteria**

- The application displays cards due for review.
- New, learning, review, and relearning states are supported.
- Users reveal the correct answer before rating recall.
- Four ratings are available: Again, Hard, Good, and Easy.
- A review updates only the corresponding FSRS card.
- The scheduler persists the new due date and memory state.
- The review is recorded with a timestamp and rating.

**Priority:** P0 — MVP

### US-SRS-02 — Review Both Directions

**As a learner,** I want independent vocabulary reviews in both directions so that I can distinguish recognition from production.

**Acceptance criteria**

- A vocabulary entry creates two reviewable directions.
- Correctly reviewing one direction does not update the other.
- Users can filter Review Mode by direction.
- Both directions may be mixed in a session.
- Their progress is displayed separately.

**Priority:** P0 — MVP

### US-SRS-03 — Prevent Accidental Scheduling Updates

**As a learner,** I want optional practice activities to remain independent so that my long-term learning schedule remains trustworthy.

**Acceptance criteria**

- Only the Review submission service can create FSRS review events.
- Practice requests cannot update FSRS scheduling records.
- The backend enforces this restriction.
- Automated tests verify that practice attempts leave FSRS states unchanged.
- Repeating the same review submission cannot create duplicate reviews.

**Priority:** P0 — MVP

### US-SRS-04 — Configure Learning Workload

**As a learner,** I want to control my daily workload so that the application fits my schedule.

**Acceptance criteria**

- Users can set a new-card limit.
- Users can set a daily review limit.
- Review limits must not silently delete or mark overdue cards as completed.
- The dashboard displays the remaining review workload.

**Priority:** P0 — MVP

---

# 6. Typing and Spelling Practice

## Epic TYP — Active Recall

### US-TYP-01 — Type Translations

**As a learner,** I want to type translations so that I can practice independent recall and spelling.

**Acceptance criteria**

- The application supports both language directions.
- Users type their answer before seeing the solution.
- The submitted answer is compared with all accepted alternatives.
- The application displays the correct answer.
- Users can proceed to the next question.
- Standalone Typing does not modify FSRS.

**Priority:** P0 — MVP

### US-TYP-02 — Highlight Spelling Differences

**As a learner,** I want to identify exactly where my answer differs from the correct one so that I can improve spelling.

**Acceptance criteria**

- Submitted text remains visible.
- Incorrect, missing, and extra characters are highlighted.
- Correct matching portions remain distinguishable.
- Accents and punctuation can be evaluated using predefined rules.
- Visual feedback does not depend exclusively on color.

**Priority:** P0 — MVP

### US-TYP-03 — Support Multiple Correct Answers

**As a learner,** I want the application to accept valid alternative translations so that I am not penalized for using another correct expression.

**Acceptance criteria**

- All stored accepted alternatives are evaluated.
- The closest accepted answer is used for spelling-difference feedback.
- Unrecognized but potentially valid translations are not automatically accepted.
- Users can flag a rejected answer for later correction.

**Priority:** P0 — MVP

---

# 7. Multiple Choice

## Epic MCQ — Recognition Exercises

### US-MCQ-01 — Choose a Translation

**As a learner,** I want to choose the correct translation from several options so that I can practice recognition.

**Acceptance criteria**

- Both target-to-native and native-to-target directions are supported.
- Every question includes one unambiguous intended correct option.
- Correct answers are selected from validated vocabulary data.
- Distractors use compatible vocabulary and grammatical metadata.
- Answer positions are randomized.
- Incorrect and correct answers receive clear feedback.
- Standalone Multiple Choice does not modify FSRS.

**Priority:** P0 — MVP

### US-MCQ-02 — Practice Synonyms and Definitions

**As a learner,** I want to select a synonym or match a target-language definition so that I can understand vocabulary beyond direct translation.

**Acceptance criteria**

- Synonyms are attached to specific meanings or senses.
- Only validated synonyms are used.
- Definitions must be available in the target language.
- Distractors cannot be synonyms that are also valid answers.
- Exercises are excluded if sufficient validated content is unavailable.

**Priority:** P1 — Post-MVP

---

# 8. Contextual Sentence Completion

## Epic CTX — Contextual Vocabulary

### US-CTX-01 — Complete Curated Sentences

**As a learner,** I want to complete sentences using the appropriate vocabulary so that I can practice words in context.

**Acceptance criteria**

- Sentences are linked to specific vocabulary meanings.
- Each sentence contains one or more explicitly defined answer slots.
- Users enter the missing word or phrase.
- The system checks validated answers.
- The complete sentence and optional translation are displayed after submission.
- Standalone Context Practice does not modify FSRS.

**Priority:** P1 — Post-MVP

### US-CTX-02 — Rotate Examples

**As a learner,** I want to see different examples for the same word so that I do not memorize only one sentence.

**Acceptance criteria**

- Multiple approved examples can be associated with one vocabulary meaning.
- The application tracks recently displayed examples.
- Recently used examples are deprioritized.
- Examples match the selected language, topic, and difficulty.
- When only one example exists, the system may reuse it rather than invent unverified content.

**Priority:** P1 — Post-MVP

### US-CTX-03 — Generate Rule-Based Variations

**As a learner,** I want to practice different verified sentence variations so that I can understand vocabulary across contexts.

**Acceptance criteria**

- Templates define explicit substitution slots.
- Each slot has a validated pool of compatible expressions.
- Substitutions respect grammatical constraints.
- Generated examples are validated before publication.
- Unsupported language structures are not generated.
- Templates have language-specific rules.
- No generative AI service is required.

**Priority:** P1 — Post-MVP

---

# 9. Listening and Dictation

## Epic LIS — Listening Practice

### US-LIS-01 — Listen and Type

**As a learner,** I want to hear words and sentences and type what I hear so that I can improve listening comprehension and spelling.

**Acceptance criteria**

- Audio plays without displaying the expected text.
- Users can replay the audio.
- Users type the transcription.
- The system highlights differences after submission.
- The correct transcript is shown afterward.
- Optional native-language translations are displayed.
- Listening attempts do not modify FSRS.

**Priority:** P1 — Post-MVP

### US-LIS-02 — Handle Unavailable Audio

**As a learner,** I want to know when audio is unavailable so that I am not blocked by unsupported voices.

**Acceptance criteria**

- Available voices are detected.
- Unsupported language voices are reported.
- Unavailable audio questions are skipped or replaced.
- The application never silently uses an incorrect-language voice.

**Priority:** P1 — Post-MVP

---

# 10. Test Mode

## Epic TST — Knowledge Assessment

### US-TST-01 — Complete a Mixed Test

**As a learner,** I want to complete a mixed vocabulary test so that I can assess my current knowledge.

**Acceptance criteria**

- Users select a vocabulary collection.
- Tests contain Multiple Choice and Typing questions.
- Both language directions are represented.
- Different vocabulary entries are used in different sections when sufficient content exists.
- Question types and counts are defined before the session.
- Test submissions do not modify FSRS.

**Priority:** P1 — Post-MVP

### US-TST-02 — Review Assessment Results

**As a learner,** I want to see my test performance so that I can identify weaknesses.

**Acceptance criteria**

- Results show overall accuracy.
- Accuracy is broken down by exercise type and direction.
- Incorrect responses can be reviewed.
- Test history is saved.
- Performance is clearly labeled as assessment performance, not FSRS retention.

**Priority:** P1 — Post-MVP

---

# 11. Guided Memorization

## Epic GDM — Structured Learning

Guided Memorization provides a separate five-stage learning pathway.

It stores its own practice attempts, progression, internal reinforcement queue, and final assessment results.

It must never write to FSRS cards or FSRS review logs.

### US-GDM-01 — Start a Guided Session

**As a learner,** I want to start a guided memorization session so that I can learn unfamiliar vocabulary progressively.

**Acceptance criteria**

- Users select a vocabulary collection and a set of entries.
- The session stores its own progress.
- Users can pause and resume the session.
- Guided learning records remain independent from FSRS.

**Priority:** P2 — Extended product

### US-GDM-02 — Complete Progressive Stages

**As a learner,** I want to progress from recognition to production so that learning becomes gradually more challenging.

**Acceptance criteria**

- Stage 1 introduces flashcards and meanings.
- Stage 2 requires selecting correct answers.
- Stage 3 requires typing without translation hints.
- Stage 4 repeats entries based on guided-session mistakes.
- Stage 5 presents the final assessment.
- Each stage uses predefined progression rules.
- Stage completion is stored persistently.

**Priority:** P2 — Extended product

### US-GDM-03 — Reinforce Difficult Entries

**As a learner,** I want to repeat words I struggle with before completing a session so that I can improve initial memorization.

**Acceptance criteria**

- Incorrect entries are added to an internal reinforcement queue.
- Entries reappear after other questions or a short practice interval.
- Reinforcement scheduling is independent of FSRS.
- Correct answers can remove entries from the internal queue according to configurable rules.
- Session progress can be resumed.

**Priority:** P2 — Extended product

### US-GDM-04 — Complete a Final Mixed Test

**As a learner,** I want to complete a mixed assessment after memorization so that I can evaluate my knowledge.

**Acceptance criteria**

- The assessment includes translation recognition.
- The assessment includes typed translation in both directions.
- Question content is sampled from the selected vocabulary set.
- Each response is scored using deterministic rules.
- Results are saved in Guided Memorization history.
- FSRS states remain unchanged.

**Priority:** P2 — Extended product

### US-GDM-05 — Complete Contextual Writing

**As a learner,** I want to use learned expressions in contextual writing so that I can practice vocabulary production.

**Acceptance criteria**

- Users receive curated writing prompts.
- Each prompt contains one or more target expressions.
- Users submit a short response.
- The application checks explicitly required vocabulary and supported grammatical constraints.
- Users can compare their response with approved model answers.
- The application does not claim to validate unrestricted semantic correctness.
- Self-assessment is available when automatic checking is insufficient.
- Writing results are independent of FSRS.

**Priority:** P2 — Extended product

---

# 12. Learning Analytics

## Epic ANA — Learning Insights

Analytics distinguish:

1. Long-term FSRS reviews.
2. Independent practice attempts.
3. Test assessments.
4. Guided Memorization progress.

These categories must remain separate in storage and reporting.

### US-ANA-01 — View Learning Dashboard

**As a learner,** I want to see my learning progress so that I can understand how consistently I study.

**Acceptance criteria**

- The dashboard shows the number of vocabulary entries.
- Due reviews and completed reviews are displayed.
- Daily and weekly study activity is available.
- Results can be filtered by collection.
- Statistics belong only to the authenticated user.

**Priority:** P0 — MVP

### US-ANA-02 — Compare Skills

**As a learner,** I want to compare recognition, translation production, and spelling accuracy so that I can identify weaknesses.

**Acceptance criteria**

- Performance is grouped by language direction and exercise type.
- Attempt counts accompany accuracy percentages.
- Practice accuracy is not presented as predicted retention.
- Users can inspect frequently missed entries.

**Priority:** P1 — Post-MVP

### US-ANA-03 — Review Difficult Vocabulary

**As a learner,** I want to find words I frequently answer incorrectly so that I can practice them more often.

**Acceptance criteria**

- Difficulty indicators use recorded attempt history.
- Difficulty can differ by translation direction.
- Users can manually flag difficult vocabulary.
- Difficult Words Practice does not change FSRS due dates.
- Difficulty thresholds are configurable and documented.

**Priority:** P1 — Post-MVP

---

# 13. Authentication, Responsive Design and Accessibility

### US-AUTH-01 — Register and Log In

**As a learner,** I want a secure account so that my collections and progress are private.

**Acceptance criteria**

- Users can register, log in, and log out.
- Passwords are securely hashed.
- Protected endpoints require authentication.
- Users cannot access another user's vocabulary or progress.

**Priority:** P0 — MVP

### US-UI-01 — Use the Application on Mobile and Desktop

**As a learner,** I want to study on any screen size so that I can practice anywhere.

**Acceptance criteria**

- Layouts support mobile, tablet, and desktop screens.
- All learning modes support keyboard and touch interaction.
- Typing fields remain visible when the mobile keyboard opens.
- Interactive controls have appropriate touch targets.
- Progress is preserved when switching devices.

**Priority:** P0 — MVP

### US-UI-02 — Use an Accessible Interface

**As a learner,** I want an accessible application so that learning is possible with different interaction methods.

**Acceptance criteria**

- Controls have accessible names.
- Keyboard navigation is supported.
- Focus states are visible.
- Color is not the only feedback mechanism.
- WCAG 2.2 AA is the accessibility target.

**Priority:** P0 — MVP

---

# 14. Data Architecture Requirements

The database should distinguish vocabulary content from learning activity.

## 14.1 Core Entities

**User**

- id
- email
- passwordHash
- nativeLanguage
- createdAt

**Collection**

- id
- ownerId
- title
- nativeLanguage
- targetLanguage
- description
- createdAt

**VocabularyEntry**

- id
- collectionId
- targetExpression
- nativeExpression
- partOfSpeech
- topic
- createdAt

**AcceptedAnswer**

- id
- vocabularyEntryId
- language
- answerText
- meaningId
- isPrimary

**VocabularyMeaning**

- id
- vocabularyEntryId
- definition
- grammaticalMetadata

**SentenceExample**

- id
- vocabularyEntryId
- language
- sentence
- translation
- targetAnswer
- approvalStatus

**SentenceTemplate**

- id
- language
- template
- constraints
- approvalStatus

**SrsCard**

- id
- userId
- vocabularyEntryId
- direction
- schedulerState
- dueAt
- stability
- difficulty
- schedulingMetadata
- schedulerVersion

**SrsReviewLog**

- id
- cardId
- timestamp
- rating
- previousState
- nextState
- previousDueAt
- nextDueAt
- schedulerVersion

**PracticeAttempt**

- id
- userId
- vocabularyEntryId
- exerciseType
- direction
- submittedAnswer
- isCorrect
- createdAt

**GuidedSession**

- id
- userId
- collectionId
- currentStage
- completionStatus
- createdAt

**GuidedSessionEntry**

- id
- sessionId
- vocabularyEntryId
- stageProgress
- reinforcementState

**AssessmentResult**

- id
- userId
- sessionId
- score
- exerciseBreakdown
- completedAt

## 14.2 Data Integrity Rules

- SRS cards must be unique by user, vocabulary entry, and direction.
- An SRS review submission must be idempotent.
- Scheduler transitions and corresponding review logs must be stored atomically.
- Practice attempts must not modify SRS scheduling fields.
- All user-owned resources require ownership checks.
- Language changes must not silently invalidate existing review cards.
- Content revisions must not corrupt existing assessment or review history.

---

# 15. Non-Functional Requirements

## Performance

- Core interfaces should respond without unnecessary full-page reloads.
- Exercise validation should work without generative AI.
- Review scheduling must be deterministic for a fixed scheduler version and input.
- Vocabulary browsing must support pagination.
- Mobile interfaces must remain usable on slower connections.

## Security

- HTTPS must be used in production.
- Authentication and authorization are mandatory.
- User input must be validated server-side.
- API requests must be protected against unauthorized modification.
- Review and practice submissions require abuse protection.

## Privacy

- Personal learning records must be isolated per user.
- Users must be able to request account deletion.
- Data retention must be documented.
- Analytics collection should follow data minimization principles.
- The application should support GDPR requirements where applicable.

## Testing

- Unit tests for answer normalization and validation.
- Unit tests for FSRS integration.
- Integration tests for review persistence.
- Regression tests for the SRS/practice separation.
- Tests for CSV imports and duplicate handling.
- Responsive interface tests.
- End-to-end tests for primary learning journeys.

---

# 16. Release Plan

## Release 1 — MVP

The first usable release includes:

- Authentication.
- Native/target language configuration.
- Vocabulary collections and CRUD.
- CSV import.
- Accepted translation alternatives.
- Dedicated FSRS Review.
- Independent bidirectional review cards.
- Standalone Typing.
- Translation Multiple Choice.
- Basic dashboard.
- Responsive and accessible interface.
- Initial deployment and automated tests.

## Release 2 — Context and Assessment

- Curated sentence completion.
- Rule-based sentence variations.
- Synonym and definition exercises.
- Listening and dictation.
- Mixed Test Mode.
- Difficult Words Practice.
- Expanded analytics.

## Release 3 — Guided Memorization

- Five-stage guided workflow.
- Internal reinforcement queue.
- Session persistence.
- Mixed final assessment.
- Contextual writing.
- Guided progression analytics.

## Future Releases

- Speaking exercises.
- Optional AI-generated learning materials.
- Vocabulary sharing.
- Teacher tools.
- Advanced learning recommendations.
- Optional pronunciation evaluation.

---

# 17. MVP Definition of Done

The MVP is considered complete when:

1. A new user can register and log in.
2. The user can create a language-pair collection.
3. The user can add vocabulary manually or through CSV import.
4. Each valid vocabulary entry can generate two independent FSRS cards.
5. The user can review due cards and save ratings.
6. Review results produce persistent scheduling changes.
7. The user can complete standalone Typing exercises.
8. The user can complete Multiple Choice exercises in both directions.
9. Independent practice never modifies FSRS state.
10. The user can view basic progress analytics.
11. The application is fully usable on desktop and mobile.
12. Core business logic has automated tests.
13. The application is deployed to a production-accessible environment.

---

# 18. Explicit Exclusions from MVP

To keep the initial development scope achievable, the following are excluded:

- AI-generated exercises.
- AI evaluation of free-form writing.
- Advanced grammar correction.
- Speaking assessment.
- Full Guided Memorization.
- Automatic unrestricted sentence generation.
- Shared/public collection marketplace.
- Teacher administration.
- Native iOS/Android applications.

These features remain within the broader product roadmap but are not MVP acceptance requirements.
