import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit specs only. The `test/*.test.cjs` suites run under `node --test`
    // (they drive the built worker and a real socket server), and vitest would
    // otherwise pick them up and fail on `node:test`.
    include: ['src/**/*.spec.ts'],
  },
});
