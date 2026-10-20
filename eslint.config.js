import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'dist-electron/**', 'release/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.es2021 } },
    rules: { 'no-console': 'warn', '@typescript-eslint/no-unused-vars': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': hooks, 'react-refresh': refresh },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...hooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
