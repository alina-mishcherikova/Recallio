// @ts-check
import security from 'eslint-plugin-security'
import prettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  security.configs.recommended,
  {
    rules: {
      // OWASP A05 — injection
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'vue/no-v-html': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'sql',
          property: 'raw',
          message: 'sql.raw() bypasses parameterization. Use sql`` templates.',
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
