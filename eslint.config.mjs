// @ts-check
import security from 'eslint-plugin-security'
import prettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

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
      'no-restricted-syntax': [
        'error',
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
      ],
      // Too noisy for TS code where keys are typed; real object-injection risks are reviewed manually.
      'security/detect-object-injection': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
)
