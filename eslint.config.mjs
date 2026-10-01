import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

// Only the React hooks rules, and only where React lives: TypeScript already covers the rest of what a
// linter would flag, and main-process helpers named useX (git's useSide) are not hooks.
export default [
  { ignores: ['out/**', 'release/**', 'node_modules/**'] },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
