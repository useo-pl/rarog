import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Własny config rejestru: bez niego vitest szuka w górę i bierze `vitest.config.ts` korzenia repo (shared, server).
// Testy idą w Node (WebCrypto, `fetch` jak w Workerze); fixture'y czytają z `../shared/fixtures/relay-auth/`.
// `cloudflare:workers` istnieje tylko w `workerd`: w Node zastępuje go atrapa klasy `DurableObject`
// (`test/cloudflare-workers.ts`). Prawdziwy runtime sprawdza `test/workerd.test.ts`.
export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
  },
});
