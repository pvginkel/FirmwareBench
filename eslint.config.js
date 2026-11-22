// ESLint for the whole repo: the server, the page, the shared protocol and the tests.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Plain Node scripts. TypeScript checks the .ts files' globals; these get Node's, and
    // `window`, which the code they hand to a browser page (page.evaluate) runs against
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'process',
          'console',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'fetch',
          'performance',
          'navigator',
          'Event',
          'EventTarget',
          'DOMException',
          'ReadableStream',
          'WritableStream',
          'TextDecoder',
          'TextEncoder',
          'URL',
          'Buffer',
          'window',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
);
