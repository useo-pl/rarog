import { defineConfig } from 'vitest/config';

// Własny config przekaźnika: bez niego vitest szuka w górę i bierze `vitest.config.ts` korzenia repo (shared, server).
// Testy idą w Node (WebCrypto, `fetch`, strumienie jak w Workerze); fixture'y czytają z `../shared/fixtures/`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
  },
});
