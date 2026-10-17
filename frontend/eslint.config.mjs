// Shared lint rules for every package. The Next app extends this with eslint-config-next.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/generated/**', 'tooling/artifacts/out/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]", message: 'Use a token (CSS variable) instead of a hex colour. Only the footage renderer may paint photographic colours.' }],
    },
  },
  { files: ['apps/web/src/ui/Footage/scene.ts'], rules: { 'no-restricted-syntax': 'off' } },
);
