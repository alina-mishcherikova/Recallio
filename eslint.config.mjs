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

// Auth guardrails (ADR 0002 §6.3). A local plugin with one rule per boundary, so these never
// replace the `no-restricted-syntax` lists above (flat config overrides a rule, it doesn't merge it).
// Each rule bans calling a name (auto-imported or imported) and importing it explicitly.
function restrictedNamesRule(names, message) {
  const banned = new Set(names)
  return {
    meta: { type: 'problem', schema: [] },
    create(context) {
      const report = (node, name) => context.report({ node, message: `${name}(): ${message}` })
      return {
        CallExpression(node) {
          const callee = node.callee
          if (callee.type === 'Identifier' && banned.has(callee.name)) report(node, callee.name)
          if (callee.type === 'MemberExpression' && !callee.computed && banned.has(callee.property.name)) {
            report(node, callee.property.name)
          }
        },
        ImportSpecifier(node) {
          const name = node.imported.name ?? node.imported.value
          if (banned.has(name)) report(node, name)
        },
      }
    },
  }
}

const recallio = {
  rules: {
    'no-session-helpers': restrictedNamesRule(
      ['getUserSession', 'requireUserSession', 'setUserSession', 'replaceUserSession', 'clearUserSession'],
      'session helpers are used only in server/services/auth/session.ts and server/handlers/02.auth.ts. ' +
        'Use requireAuth(event); reading a session can create anonymous cookies, writing it extends the TTL.',
    ),
    'no-password-hash': restrictedNamesRule(
      ['hashPassword', 'verifyPassword', 'passwordNeedsReHash'],
      'password hashing lives in server/services/auth/** only.',
    ),
    'no-direct-zod': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (node.source.value !== 'zod' || node.importKind === 'type') return
            if (node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === 'type')) return
            context.report({
              node,
              message:
                "Import z from shared/zod.ts (it sets jitless before any schema exists: Zod's eval probe breaks the CSP).",
            })
          },
        }
      },
    },
    'no-session-clear': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const message =
          'useUserSession().clear calls the blocked DELETE /api/_auth/session. POST /api/auth/logout, then fetch().'
        const isUseUserSession = (node) =>
          node?.type === 'CallExpression' &&
          node.callee.type === 'Identifier' &&
          node.callee.name === 'useUserSession'
        return {
          MemberExpression(node) {
            if (isUseUserSession(node.object) && !node.computed && node.property.name === 'clear') {
              context.report({ node, message })
            }
          },
          VariableDeclarator(node) {
            if (!isUseUserSession(node.init) || node.id.type !== 'ObjectPattern') return
            for (const prop of node.id.properties) {
              if (prop.type === 'Property' && prop.key.type === 'Identifier' && prop.key.name === 'clear') {
                context.report({ node: prop, message })
              }
            }
          },
        }
      },
    },
  },
}

const authGuardrails = [
  { plugins: { recallio } },
  {
    files: ['server/**/*.{ts,mts,js,mjs}'],
    ignores: ['server/services/auth/session.ts', 'server/handlers/02.auth.ts'],
    rules: { 'recallio/no-session-helpers': 'error' },
  },
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs,vue}'],
    ignores: ['server/services/auth/**', 'tests/**', 'eslint.config.mjs'],
    rules: { 'recallio/no-password-hash': 'error' },
  },
  {
    files: ['app/**/*.{ts,js,vue}'],
    rules: { 'recallio/no-session-clear': 'error' },
  },
  {
    files: ['shared/**/*.ts', 'server/**/*.ts'],
    ignores: ['shared/zod.ts'],
    rules: { 'recallio/no-direct-zod': 'error' },
  },
]

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
  ...authGuardrails,
  {
    // Offline build tool (reads two files from a directory the developer passes, writes one fixed
    // path) and tests (read repo files and their own temp log). Not reachable from requests.
    files: ['scripts/build-password-blocklist.ts', 'tests/**'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  prettier,
)
