/**
 * Atrapa modułu `cloudflare:workers` dla testów w Node (alias w `vitest.config.ts`): klasa bazowa Durable Object
 * z polami `ctx` i `env`, jak w `workerd`. Prawdziwy moduł sprawdza `workerd.test.ts`.
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
