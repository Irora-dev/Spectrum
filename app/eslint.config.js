// ── THE HOOK GATE (UIGuy greenlit, 2026-08-06 00:04) ─────────────────────────
// Exists because two workers independently shipped the same rules-of-hooks
// crash within an hour (2026-08-05: hooks below Yours' early-return wall —
// every cold /portfolio visit error-boundaried while tsc, vitest, and the
// build all stayed green). rules-of-hooks is ERROR by his ruling: "a warning
// in a repo with no lint habit is a comment."
//
// exhaustive-deps stays OFF as a gate: the codebase carries deliberate,
// commented eslint-disable-next-line markers where a dep is intentionally
// omitted (mount-only effects), and turning the rule on gate-wide would need
// its own reviewed sweep first — flagged to UIGuy rather than decided here.
import reactHooks from 'eslint-plugin-react-hooks'
import tsParser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    // the existing exhaustive-deps disables go quiet, not deleted — they
    // document intent for the day that rule gets its own reviewed sweep
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
]
