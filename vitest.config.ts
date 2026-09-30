import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The domain, NLU and agent layers are plain TypeScript with no React and no
 * Next.js runtime, so they test in a bare Node environment — fast, and proof
 * that the ordering rules do not depend on the framework.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@data': fileURLToPath(new URL('./data', import.meta.url)),
    },
  },
});
