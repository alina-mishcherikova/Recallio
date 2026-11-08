// @ts-check
import security from 'eslint-plugin-security'
import prettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

// Shared by every config block below: a later `no-restricted-syntax` replaces, not merges, earlier ones.
const restrictedSyntax = [
  {
    selector: "MemberExpression[property.name='raw']:not([object.name='String'])",
    message: 'sql.raw() (under any alias) bypasses parameterization.',
  },
  {
    selector: "ImportSpecifier[imported.name='sql'][local.name!='sql']",
    message: 'Do not alias drizzle `sql`: it hides raw-SQL usage from review and lint.',
  },
  {
    selector:
      "CallExpression[callee.property.name='execute'] > :matches(Literal, TemplateLiteral, BinaryExpression).arguments",
    message: 'db.execute(string) runs raw SQL. Pass a sql`` template.',
  },
  {
    selector: "ImportExpression[source.type!='Literal']",
    message: 'Dynamic import() must use a literal specifier.',
  },
  {
    selector:
      'CallExpression[callee.name=/^(setTimeout|setInterval)$/] > :not(ArrowFunctionExpression, FunctionExpression, Identifier, MemberExpression).arguments:first-child',
    message: 'Pass a function to timers, never a string.',
  },
]

// SRS isolation, layer 1 (CLAUDE.md rule 1, ADR 0001 D12). Only the SRS module (and the DB layer that
// defines the tables) may reference srs_cards / srs_review_logs. The database guard (migration 0002)
// is layer 3; this rule keeps other modules from even trying.
const srsMessage =
  'SRS tables are accessed only in server/services/srs/** (writes only in review.service.ts). Call the SRS service instead.'
const srsBoundary = {
  files: ['**/*.{ts,mts,cts,js,mjs,cjs,vue}'],
  ignores: [
    'server/services/srs/**',
    'server/db/**',
    'tests/**',
    'eslint.config.mjs',
    // Read-only catalog check (ADR 0001 D9): names srs_guard and the SRS tables in has_*_privilege().
    'server/utils/db-privileges.ts',
  ],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { regex: '(^|/)db/schema/srs(\\.ts)?$', message: srsMessage },
          {
            regex: '(^|/)db/schema(/index(\\.ts)?)?$',
            importNames: ['srsCards', 'srsReviewLogs'],
            message: srsMessage,
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...restrictedSyntax,
      {
        // schema.srsCards, db.query.srsCards, ...
        selector: 'MemberExpression[property.name=/^(srsCards|srsReviewLogs)$/]',
        message: srsMessage,
      },
      {
        selector: 'Literal[value=/srs_guard|srs_cards|srs_review_logs|set_config|session_replication_role/i]',
        message: 'Raw references to the SRS guard or SRS tables are only allowed in server/services/srs/**.',
      },
      {
        selector:
          'TemplateElement[value.raw=/srs_guard|srs_cards|srs_review_logs|set_config|session_replication_role/i]',
        message: 'Raw references to the SRS guard or SRS tables are only allowed in server/services/srs/**.',
      },
    ],
  },
}

export default withNuxt(
  {
    // Inline `eslint-disable` comments are not allowed: security rules can't be silenced in code.
    // Justified exceptions go in this file, where they are reviewed.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  security.configs.recommended,
  {
    rules: {
      // OWASP A05: injection
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'vue/no-v-html': 'error',
      'vue/no-restricted-v-bind': [
        'error',
        { argument: 'innerHTML', message: 'Renders unescaped HTML (same as v-html).' },
        { argument: 'outerHTML', message: 'Renders unescaped HTML (same as v-html).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'sql',
          property: 'raw',
          message: 'sql.raw() bypasses parameterization. Use sql`` templates.',
        },
        { property: 'innerHTML', message: 'Unescaped HTML sink. Use textContent or Vue templates.' },
        { property: 'outerHTML', message: 'Unescaped HTML sink.' },
        { property: 'insertAdjacentHTML', message: 'Unescaped HTML sink.' },
        { object: 'document', property: 'write', message: 'Unescaped HTML sink.' },
      ],
      'no-restricted-syntax': ['error', ...restrictedSyntax],
      // Too noisy for TS code where keys are typed; real object-injection risks are reviewed manually.
      'security/detect-object-injection': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  srsBoundary,
  prettier,
)
