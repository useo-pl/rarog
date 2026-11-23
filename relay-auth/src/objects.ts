/**
 * Registry Durable Objects classes (bindings `ENDPOINT`, `GATE`, `ADMIN` and the SQLite migration in `wrangler.toml`),
 * thin wrappers around the platform-free machines from `registry.ts`, called over RPC:
 * - `Endpoint`: the entry of one EndpointId (`idFromName(endpointId)`), an app or a server;
 * - `Gate`: one object (`idFromName('gate')`), serializes registrations and calls Apple;
 * - `Admin`: one object (`idFromName('admin')`), the denial list with a mirror in the `DENIED` KV.
 *
 * The object clock is the Worker clock with `CLOCK_OFFSET` (only outside production); Apple calls always use the
 * real clock (provider token and DeviceCheck timestamp).
 */
import { DurableObject } from 'cloudflare:workers';
import { createAppleGate } from './apple.ts';
import { prepare, settingsOf } from './config.ts';
import type { Settings } from './config.ts';
import { DenyBook, EndpointBook, GateDesk } from './registry.ts';
import type {
  Admission, AdminApi, Clock, DenyMirror, EndpointApi, GateApi, GateProof, RegisterOutcome, SponsorLimits, SponsorRef,
} from './registry.ts';
import type { Env } from './worker.ts';
import { sha256Hex } from './wspolne.ts';

/** Names of the classes exported from `worker.ts`; a guard compares them with `wrangler.toml`. */
export const DURABLE_OBJECT_CLASSES = ['Endpoint', 'Gate', 'Admin'] as const;

/**
 * Stub of the object named `name` in the jurisdiction from the settings (`Settings.jurisdiction`); the only way to
 * the registry objects. The identifier depends on the jurisdiction, so changing it after deployment gives new, empty
 * objects. No location hint: the Durable Objects docs do not describe it together with a jurisdiction.
 */
export function stubOf<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  jurisdiction: Settings['jurisdiction'],
): DurableObjectStub<T> {
  const scoped = jurisdiction === null ? namespace : namespace.jurisdiction(jurisdiction);
  return scoped.get(scoped.idFromName(name));
}

export const GATE_NAME = 'gate';
export const ADMIN_NAME = 'admin';

/** Registry clock shifted by `offsetSeconds`; the platform alarm is computed back in real time. */
export const clockOf = (offsetSeconds: number): Clock => ({
  nowMs: () => Date.now() + offsetSeconds * 1000,
  alarmAt: (ms) => ms - offsetSeconds * 1000,
});

/** Denial mirror in KV: key = EndpointId, expires with the denial's term. */
export const kvMirror = (kv: KVNamespace): DenyMirror => ({
  put: (endpointId, until, now) => kv.put(endpointId, '1', { expirationTtl: Math.max(60, until - now) }),
  delete: (endpointId) => kv.delete(endpointId),
});

export class Endpoint extends DurableObject<Env> implements EndpointApi {
  readonly #book: EndpointBook;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The app entry's alarm drops its sponsorships at the servers over RPC to their objects.
    const settings = settingsOf(env);
    const peers = (id: string) => stubOf(env.ENDPOINT, id, settings.jurisdiction);
    this.#book = new EndpointBook(ctx.storage, clockOf(settings.clockOffset), peers);
  }

  status() { return this.#book.status(); }
  extendApp() { return this.#book.extendApp(); }
  admitApp(id: string, admission: Admission) { return this.#book.admitApp(id, admission); }
  renew(servers: readonly string[]) { return this.#book.renew(servers); }
  reserve(server: string, limits: SponsorLimits) { return this.#book.reserve(server, limits); }
  commit(server: string, epoch: string, ticket: string, expiresAt: number) {
    return this.#book.commit(server, epoch, ticket, expiresAt);
  }
  cancel(server: string, epoch: string, ticket: string) { return this.#book.cancel(server, epoch, ticket); }
  orphans(epoch: string, items: readonly SponsorRef[]) { return this.#book.orphans(epoch, items); }
  addSponsor(app: string, epoch: string, ticket: string, expiresAt: number) {
    return this.#book.addSponsor(app, epoch, ticket, expiresAt);
  }
  dropSponsor(app: string, epoch: string, ticket: string) { return this.#book.dropSponsor(app, epoch, ticket); }
  forget() { return this.#book.forget(); }

  override alarm(): Promise<void> {
    return this.#book.alarm();
  }
}

export class Gate extends DurableObject<Env> implements GateApi {
  #desk: Promise<GateDesk> | undefined;

  /** Gate machine with the Apple key, computed once per instance (new deployment = new instance). */
  #ready(): Promise<GateDesk> {
    this.#desk ??= prepare(this.env).then((prepared) => {
      const { settings } = prepared;
      const apple = prepared.registrations && prepared.apple !== null
        ? createAppleGate({
          fetch: (url, init) => fetch(url, init),
          now: () => Date.now(),
          tokens: prepared.apple.tokens,
          transactionId: () => crypto.randomUUID(),
        })
        : null;
      return new GateDesk({
        store: this.ctx.storage,
        clock: clockOf(settings.clockOffset),
        settings: {
          gate: settings.gate,
          registerMonthly: settings.quotas.registerMonthly,
          registerDailyBrake: settings.quotas.registerDailyBrake,
          graceUntil: settings.graceUntil,
        },
        apple,
        endpoint: (id) => stubOf(this.env.ENDPOINT, id, settings.jurisdiction),
        sha256Hex,
      });
    });
    return this.#desk;
  }

  async register(endpointId: string, proof: GateProof): Promise<RegisterOutcome> {
    return (await this.#ready()).register(endpointId, proof);
  }

  override async alarm(): Promise<void> {
    await (await this.#ready()).alarm();
  }
}

export class Admin extends DurableObject<Env> implements AdminApi {
  readonly #book: DenyBook;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#book = new DenyBook(ctx.storage, clockOf(settingsOf(env).clockOffset), kvMirror(env.DENIED));
  }

  deny(endpointId: string) { return this.#book.deny(endpointId); }
  allow(endpointId: string) { return this.#book.allow(endpointId); }

  override alarm(): Promise<void> {
    return this.#book.alarm();
  }
}
