/**
 * Test modelowy rejestru (fast-check): losowe ciągi żądań `register`, `sponsor`, `renew` i `forget` dwóch apek
 * przeciw dwóm serwerom i sobie nawzajem. Żądanie może stanąć na zatrzasku w jednym kroku RPC (wznawia je
 * późniejsza komenda), paść przed skutkiem (`failOnce`) albo zgubić odpowiedź po skutku (`loseReply`), najwyżej dwa
 * takie zdarzenia na żądanie; między żądaniami alarmy obiektów i zegar, także tuż przed i tuż po ich terminach. Po
 * każdej komendzie sprawdza niezmiennik roszczeń z `src/registry.ts`, na końcu stan po wznowieniu wszystkiego
 * i wszystkich alarmach.
 *
 * 1. Każde żywe poręczenie u serwera ma w obiekcie apki roszczenie z tym samym `ticket` i terminem nie krótszym
 *    (`term` rezerwacji albo `expiresAt` poręczenia) albo ślad zdjęcia.
 * 2. Każde rozliczenie bramki założyło najwyżej jedną inkarnację, a każdą inkarnację założyło rozliczenie, które
 *    bramka wydała temu EndpointId (każdy trwały zapis stanu apki).
 * 3. Znaczników kwoty poręczeń w oknie nie mniej niż poręczeń tej inkarnacji, które zapisał serwer.
 * 4. Po wygaszeniu żaden serwer nie ma poręczenia, którego apka nie trzyma jako poręczenia.
 *
 * A violation message starts with `I` and the number of the invariant.
 *
 * Zegar nie przesuwa się tak, żeby zapis u serwera stojący na zatrzasku doszedł 10 min po kroku apki albo później:
 * to przypadek, którego niezmiennik świadomie nie obejmuje (README, „What the model leaves open”). Ziarno stałe;
 * `RAROG_MODEL_RUNS` zmienia liczbę przebiegów (lokalny przebieg długi).
 */
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RelayAuthAppRoute } from '../../shared/src/relay-auth.ts';
import { ENTRY_TTL_SECONDS, QUOTA_WINDOW_SECONDS, RESERVATION_TTL_SECONDS, settle } from '../src/registry.ts';
import type {
  Admission, AppRecord, EndpointState, ReserveOutcome, Sponsor, SponsorOutcome, SponsorRef,
} from '../src/registry.ts';
import { DAY, SERVER_A, SERVER_B, T0, appKey, deviceCheckProof, harness, request } from './helpers.ts';
import type { AppKey, Harness, Latch } from './helpers.ts';

const SEED = 20_261_104;
const RUNS = Number(process.env['RAROG_MODEL_RUNS'] ?? '3000');
/** Najwięcej żądań stojących naraz na zatrzasku. */
const MAX_FLIGHTS = 3;

type HookKind = 'pause' | 'fail' | 'lose';
interface Hook {
  readonly kind: HookKind;
  /** `self`: wpis apki, która wysyła; `peer`: wpis jej celu (serwer albo druga apka). */
  readonly on: 'self' | 'peer';
  readonly method: string;
}

type Command =
  | { readonly t: 'register'; readonly app: number; readonly hooks: readonly Hook[] }
  | { readonly t: 'sponsor'; readonly app: number; readonly peer: number; readonly hooks: readonly Hook[] }
  | { readonly t: 'renew'; readonly app: number; readonly servers: readonly number[]; readonly peer: number;
    readonly hooks: readonly Hook[] }
  | { readonly t: 'forget'; readonly app: number; readonly peer: number; readonly hooks: readonly Hook[] }
  | { readonly t: 'alarm'; readonly who: number }
  | { readonly t: 'advance'; readonly by: number }
  | { readonly t: 'near'; readonly who: number; readonly delta: number }
  | { readonly t: 'resume'; readonly k: number };

type AppCall = Extract<Command, { readonly hooks: readonly Hook[] }>;

const kindArb = fc.constantFrom<HookKind>('pause', 'fail', 'lose');
const hooksArb = (self: readonly string[], peer: readonly string[]): fc.Arbitrary<readonly Hook[]> => fc.array(
  fc.oneof(
    fc.record({ kind: kindArb, on: fc.constant('self' as const), method: fc.constantFrom(...self) }),
    ...(peer.length === 0 ? [] : [
      fc.record({ kind: kindArb, on: fc.constant('peer' as const), method: fc.constantFrom(...peer) }),
    ]),
  ),
  { maxLength: 2 },
);

const appArb = fc.nat(1);
const peerArb = fc.nat(2);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('register' as const), app: appArb,
    hooks: hooksArb(['extendApp', 'admitApp'], []) }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant('sponsor' as const), app: appArb, peer: peerArb,
    hooks: hooksArb(['reserve', 'cancel', 'commit'], ['addSponsor', 'dropSponsor']) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('renew' as const), app: appArb, servers: fc.subarray([0, 1, 2]),
    peer: peerArb, hooks: hooksArb(['renew', 'orphans'], ['addSponsor', 'dropSponsor']) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('forget' as const), app: appArb, peer: peerArb,
    hooks: hooksArb(['forget'], ['dropSponsor']) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('alarm' as const), who: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('advance' as const),
    by: fc.constantFrom(1, 59, 299, 300, 599, 600, 601, 3600, DAY) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('near' as const), who: fc.nat(3),
    delta: fc.constantFrom(-1, 0, 1) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('resume' as const), k: fc.nat(2) }) },
);

/** Obie apki zaczynają zarejestrowane: przebieg bez wpisu niczego nie sprawdza. */
const START: readonly Command[] = [{ t: 'register', app: 0, hooks: [] }, { t: 'register', app: 1, hooks: [] }];

/** Ścieżki, do których model musi dojść w każdym przebiegu testu (inaczej sprawdzał coś innego, niż mówi). */
const REQUIRED = [
  'register:200', 'sponsor:200', 'sponsor:409', 'renew:200', 'forget:200', 'alarm', 'pause:addSponsor',
  'pause:cancel', 'pause:commit', 'pause:admitApp', 'live:claimed', 'live:dropping',
];

/** Żądanie stojące na zatrzasku. `deadline`: ostatnia chwila, w której jego zapis u serwera wolno wpuścić. */
interface Flight {
  /** Żądanie dla przechwyceń: awarie po zatrzasku działają tylko na jego dalsze kroki. */
  readonly owner: object;
  readonly done: Promise<number>;
  readonly latch: Latch;
  readonly deadline: number;
  readonly gate: boolean;
}

interface Write {
  readonly server: string;
  readonly app: string;
  readonly epoch: string;
  readonly ticket: string;
}

/** Zdarzenia ze wszystkich przebiegów. */
const seen = new Map<string, number>();
const note = (event: string): void => { seen.set(event, (seen.get(event) ?? 0) + 1); };

/** Niezmiennik 1: roszczenie inkarnacji apki dla poręczenia u serwera, z tym samym `ticket` i terminem nie krótszym. */
const claims = (app: AppRecord, server: string, sponsor: Sponsor): boolean => {
  const same = (item: SponsorRef): boolean => item.server === server && item.ticket === sponsor.ticket;
  return app.reservations.some((item) => same(item) && item.term >= sponsor.expiresAt)
    || app.sponsored.some((item) => same(item) && item.expiresAt >= sponsor.expiresAt);
};

/** Niezmiennik 2 dla jednego EndpointId: rozliczenie → inkarnacje, które założyło; `null` = w porządku, inaczej opis. */
const chargeFault = (issued: ReadonlySet<string>, incarnations: ReadonlyMap<string, ReadonlySet<string>>):
  string | null => {
  for (const [charge, epochs] of incarnations) {
    if (epochs.size > 1) return `rozliczenie ${charge.slice(0, 8)} założyło inkarnacji ${String(epochs.size)}`;
    if (!issued.has(charge)) return `rozliczenie ${charge.slice(0, 8)} nie pochodzi z bramki`;
  }
  return null;
};

let keys: readonly AppKey[] = [];
const proofs = [deviceCheckProof('P'), deviceCheckProof('Q')] as const;

beforeAll(async () => {
  keys = await Promise.all([appKey(111), appKey(112)]);
});

class World {
  readonly h: Harness;
  readonly flights: Flight[] = [];
  readonly writes: Write[] = [];
  /** Chwila nowej rezerwacji każdego `ticket` (znacznik kwoty). */
  readonly started = new Map<string, number>();
  /** Rozliczenia, które bramka zapisała, per EndpointId. */
  readonly issued = new Map<string, Set<string>>();
  /** Inkarnacje z trwałych zapisów stanu apki: EndpointId → rozliczenie → inkarnacje. */
  readonly incarnations = new Map<string, Map<string, Set<string>>>();

  constructor(h: Harness) {
    this.h = h;
    h.registry.observe = (id, method, args, result) => {
      if (method === 'addSponsor' && (result as SponsorOutcome).ok) {
        this.writes.push({ server: id, app: String(args[0]), epoch: String(args[1]), ticket: String(args[2]) });
      }
      const reserved = result as ReserveOutcome;
      if (method === 'reserve' && reserved.ok && reserved.fresh) this.started.set(reserved.ticket, h.clock.sec);
    };
    h.registry.gateStore.onPut = (written) => {
      for (const key of written) {
        if (!key.startsWith('admission:')) continue;
        const id = key.slice('admission:'.length);
        const issued = this.issued.get(id) ?? new Set<string>();
        issued.add((h.registry.gateStore.data.get(key) as Admission).charge);
        this.issued.set(id, issued);
      }
    };
    h.registry.onStorePut = (id, written) => {
      const entry = written.includes('state') ? h.registry.entry(id) : undefined;
      if (entry?.kind !== 'app') return;
      const byCharge = this.incarnations.get(id) ?? new Map<string, Set<string>>();
      const epochs = byCharge.get(entry.charge.charge) ?? new Set<string>();
      epochs.add(entry.epoch);
      byCharge.set(entry.charge.charge, epochs);
      this.incarnations.set(id, byCharge);
    };
  }

  get ids(): readonly string[] {
    return [...keys.map((key) => key.endpointId), SERVER_A, SERVER_B];
  }

  peersOf(app: number): readonly string[] {
    return [SERVER_A, SERVER_B, (keys[1 - app] as AppKey).endpointId];
  }

  view(id: string): EndpointState {
    return settle(this.h.registry.state(id), this.h.clock.sec).state;
  }

  /** Zegar naprzód, ale nie dalej niż termin zapisu żądania stojącego przed `addSponsor`. */
  moveTo(target: number): void {
    const cap = Math.min(...this.flights.map((flight) => flight.deadline));
    const to = Math.min(target, cap);
    if (to > this.h.clock.sec) this.h.clock.sec = to;
  }

  async fire(id: string): Promise<void> {
    const store = this.h.registry.stores.get(id);
    if (store === undefined || store.alarm === null || store.alarm > this.h.clock.nowMs()) return;
    store.alarm = null;
    await this.h.registry.bookOf(id).alarm();
    note('alarm');
  }

  async run(command: Command): Promise<void> {
    switch (command.t) {
      case 'alarm': return this.fire(this.ids[command.who] as string);
      case 'advance': return this.moveTo(this.h.clock.sec + command.by);
      case 'near': {
        const alarm = this.h.registry.stores.get(this.ids[command.who] as string)?.alarm ?? null;
        if (alarm !== null) this.moveTo(Math.floor(alarm / 1000) + command.delta);
        return;
      }
      case 'resume': {
        if (this.flights.length === 0) return;
        const [flight] = this.flights.splice(command.k % this.flights.length, 1) as [Flight];
        flight.latch.release();
        await flight.done;
        this.h.registry.clearIntercepts(flight.owner);
        return;
      }
      default: return this.send(command);
    }
  }

  async send(command: AppCall): Promise<void> {
    const { registry, clock } = this.h;
    // Rejestracja na zatrzasku trzyma kolejkę bramki: następna czekałaby bez końca.
    if (command.t === 'register' && this.flights.some((flight) => flight.gate)) return;
    const key = keys[command.app] as AppKey;
    const peers = this.peersOf(command.app);
    const peer = command.t === 'register' ? key.endpointId : peers[command.peer] as string;
    const owner = {};
    const { latch, paused } = registry.within(owner, () => this.arm(command.hooks, key.endpointId, peer));
    const route: RelayAuthAppRoute = command.t;
    const fields = command.t === 'register' ? { proof: proofs[command.app] }
      : command.t === 'sponsor' ? { server: peer }
        : command.t === 'renew' ? { servers: command.servers.map((index) => peers[index] as string) }
          : {};
    const body = await key.sign(route, { issuedAt: clock.sec, ...fields });
    const done = registry.within(owner, async () => {
      const response = await this.h.call(request(route, body));
      note(`${route}:${String(response.status)}`);
      return response.status;
    });
    if (latch !== null && await Promise.race([latch.reached.then(() => true), done.then(() => false)])) {
      note(`pause:${paused}`);
      const deadline = paused === 'addSponsor' ? clock.sec + RESERVATION_TTL_SECONDS - 1 : Number.POSITIVE_INFINITY;
      this.flights.push({ owner, done, latch, deadline, gate: command.t === 'register' });
      return;
    }
    await done;
    registry.clearIntercepts(owner);
  }

  /** Przechwycenia żądania: awarie i najwyżej jeden zatrzask (gdy jest na niego miejsce). */
  arm(hooks: readonly Hook[], self: string, peer: string): { readonly latch: Latch | null; readonly paused: string } {
    const { registry } = this.h;
    let armed: { latch: Latch | null; paused: string } = { latch: null, paused: '' };
    for (const hook of hooks) {
      const on = hook.on === 'self' ? self : peer;
      if (hook.kind === 'fail') registry.failOnce(on, hook.method);
      else if (hook.kind === 'lose') registry.loseReply(on, hook.method);
      else if (armed.latch === null && this.flights.length < MAX_FLIGHTS) {
        armed = { latch: registry.pause(on, [hook.method]), paused: hook.method };
      }
    }
    return armed;
  }

  /** Niezmienniki 1–3 w tej chwili. */
  check(): void {
    const now = this.h.clock.sec;
    for (const server of this.ids) {
      const entry = this.view(server).entry;
      if (entry?.kind !== 'server') continue;
      for (const sponsor of entry.sponsors) {
        const owner = this.view(sponsor.app);
        const app = owner.entry?.kind === 'app' && owner.entry.epoch === sponsor.epoch ? owner.entry : null;
        const claimed = app !== null && claims(app, server, sponsor);
        const dropping = owner.drops.some((drop) => drop.server === server && drop.ticket === sponsor.ticket
          && drop.epoch === sponsor.epoch);
        note(claimed ? 'live:claimed' : 'live:dropping');
        if (!claimed && !dropping) {
          throw new Error(`I1: serwer ${server.slice(0, 4)} ma poręczenie ${JSON.stringify(sponsor)} bez roszczenia `
            + `apki ${JSON.stringify(owner)} (t=${String(now - T0)})`);
        }
      }
    }
    for (const id of keys.map((key) => key.endpointId)) {
      const fault = chargeFault(this.issued.get(id) ?? new Set(), this.incarnations.get(id) ?? new Map());
      if (fault !== null) throw new Error(`I2: ${id.slice(0, 4)}: ${fault} (t=${String(now - T0)})`);
      const entry = this.view(id).entry;
      if (entry?.kind !== 'app') continue;
      const written = new Set(this.writes
        .filter((item) => item.app === id && item.epoch === entry.epoch
          && (this.started.get(item.ticket) ?? Number.NEGATIVE_INFINITY) > now - QUOTA_WINDOW_SECONDS)
        .map((item) => item.ticket));
      if (written.size > entry.starts.length) {
        throw new Error(`I3: ${id.slice(0, 4)}: zapisanych poręczeń ${String(written.size)}, znaczników kwoty `
          + `${String(entry.starts.length)} (t=${String(now - T0)})`);
      }
    }
  }

  /** Wznowienie wszystkich żądań, potem alarmy po kolejnych terminach rezerwacji i ponowień; na końcu niezmiennik 4. */
  async quiesce(): Promise<void> {
    await this.release();
    this.check();
    for (let round = 0; round < 4; round += 1) {
      this.h.clock.advance(RESERVATION_TTL_SECONDS + 1);
      for (let pass = 0; pass < 5; pass += 1) await this.h.registry.fireAlarms();
      this.check();
    }
    for (const server of this.ids) {
      const entry = this.view(server).entry;
      if (entry?.kind !== 'server') continue;
      for (const sponsor of entry.sponsors) {
        const owner = this.view(sponsor.app).entry;
        const held = owner?.kind === 'app' && owner.epoch === sponsor.epoch && owner.sponsored.some((item) =>
          item.server === server && item.ticket === sponsor.ticket && item.expiresAt >= sponsor.expiresAt);
        if (!held) {
          throw new Error(`I4: serwer ${server.slice(0, 4)} ma poręczenie ${JSON.stringify(sponsor)} bez apki `
            + `${JSON.stringify(owner)}`);
        }
      }
    }
  }

  /** Wznowienie wszystkich żądań z ich dalszymi awariami, potem bez przechwyceń. */
  async release(): Promise<void> {
    const flights = this.flights.splice(0);
    for (const flight of flights) flight.latch.release();
    await Promise.allSettled(flights.map((flight) => flight.done));
    this.h.registry.clearIntercepts();
  }
}

/** Stan apki `id` w jednej inkarnacji, wpisany wprost (bez maszyny): do testów samych asercji. */
const appState = (id: string, epoch: string, charge: string, reservations: AppRecord['reservations'] = []):
  EndpointState => ({
  entry: {
    kind: 'app', id, epoch, charge: { charge, until: T0 + DAY }, expiresAt: T0 + ENTRY_TTL_SECONDS, sponsored: [],
    reservations, starts: reservations.map((item) => item.startedAt),
  },
  drops: [],
  spent: [],
});

describe('asercje modelu', () => {
  it('rezerwacja z tym ticketem i terminem roszczenia krótszym niż zapis u serwera nie jest roszczeniem', async () => {
    const term = T0 + ENTRY_TTL_SECONDS;
    // Rezerwacja T do `term`, u serwera T do `term + 100`, bez śladu zdjęcia.
    const world = async (written: number): Promise<World> => {
      const made = new World(await harness());
      const id = (keys[0] as AppKey).endpointId;
      const reservation = {
        server: SERVER_A, ticket: 'T', expiresAt: T0 + RESERVATION_TTL_SECONDS, startedAt: T0, term, attempts: 1,
      };
      made.h.registry.storeOf(id).data.set('state', appState(id, 'E', 'C', [reservation]));
      made.h.registry.storeOf(SERVER_A).data.set('state', {
        entry: { kind: 'server', sponsors: [{ app: id, epoch: 'E', ticket: 'T', expiresAt: written }] },
        drops: [],
        spent: [],
      } satisfies EndpointState);
      return made;
    };
    const longer = await world(term + 100);
    expect(() => { longer.check(); }).toThrow(/^I1: /);
    const equal = await world(term);
    expect(() => { equal.check(); }).not.toThrow();
  });

  it('rozliczenie z dwiema inkarnacjami, choć rozliczeń bramki tyle, co inkarnacji', async () => {
    // Pierwsze rozliczenie nie założyło wpisu, drugie założyło dwie inkarnacje: 2 rozliczenia i 2 inkarnacje.
    const world = new World(await harness());
    const id = (keys[0] as AppKey).endpointId;
    const { gateStore } = world.h.registry;
    const store = world.h.registry.storeOf(id);
    await gateStore.put(`admission:${id}`, { charge: 'C1', at: T0 } satisfies Admission);
    await gateStore.put(`admission:${id}`, { charge: 'C2', at: T0 } satisfies Admission);
    await store.put('state', appState(id, 'E1', 'C2'));
    await store.put('state', appState(id, 'E2', 'C2'));
    const epochs = [...(world.incarnations.get(id)?.values() ?? [])].reduce((sum, item) => sum + item.size, 0);
    expect([world.issued.get(id)?.size, epochs]).toEqual([2, 2]);
    expect(() => { world.check(); }).toThrow(/^I2: .*założyło inkarnacji 2/);
  });

  it('inkarnacja z rozliczenia, którego bramka temu EndpointId nie wydała', async () => {
    const world = new World(await harness());
    const id = (keys[0] as AppKey).endpointId;
    await world.h.registry.gateStore.put(`admission:${id}`, { charge: 'C1', at: T0 } satisfies Admission);
    await world.h.registry.storeOf(id).put('state', appState(id, 'E1', 'C1'));
    expect(() => { world.check(); }).not.toThrow();
    await world.h.registry.storeOf(id).put('state', appState(id, 'E2', 'C3'));
    expect(() => { world.check(); }).toThrow(/^I2: .*nie pochodzi z bramki/);
  });
});

describe('model rejestru', () => {
  it(`niezmiennik roszczeń po każdej komendzie i po wygaszeniu (${String(RUNS)} przebiegów)`, async () => {
    const commandsArb = fc.array(commandArb, { minLength: 1, maxLength: 40, size: 'max' });
    await fc.assert(fc.asyncProperty(commandsArb, async (commands) => {
      const world = new World(await harness({
        SPONSOR_QUOTA: '2', SPONSORED_LIVE_MAX: '5', QUOTA_GRACE_UNTIL: String(T0 + 3650 * DAY),
      }));
      try {
        for (const command of [...START, ...commands]) {
          await world.run(command);
          world.check();
        }
        await world.quiesce();
      } finally {
        await world.release();
      }
    }), { seed: SEED, numRuns: RUNS });
    expect(REQUIRED.filter((event) => !seen.has(event))).toEqual([]);
  }, Math.max(60_000, RUNS * 20));
});
