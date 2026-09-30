import next from 'eslint-config-next';

/**
 * Flat ESLint config. The Next.js preset covers React hooks rules and the
 * framework's own correctness checks, which is what matters most here; the
 * TypeScript compiler in strict mode does the rest.
 */
export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'build/**'],
  },
  ...next,
];
