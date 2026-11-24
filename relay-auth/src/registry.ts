/**
 * Registry state without the platform: three machines over an abstract store ({@link Store}, in the Worker
 * `DurableObjectStorage`, in tests a fake) and a clock ({@link Clock}). The Durable Objects classes in `objects.ts`
 * only wrap them, so a test on the fake store checks the same rules.
 *
 * - {@link EndpointBook}: the entry of one EndpointId (`Endpoint`, `idFromName(endpointId)`), an app or a server.
 *   The first write sets the kind and it does not change while the entry lives. An app entry has an incarnation
 *   (`epoch`, new for each new entry) with the gate admission that created it, an expiry (TTL from the last
 *   activity), sponsored servers, sponsorship reservations and markers of new sponsorships (quota in 30 days). Each
 *   sponsorship has its own identifier (`ticket`, assigned at reservation). A server entry has a list of
 *   sponsorships `(app, incarnation, ticket)` and lives while at least one sponsorship lives.
 * - {@link GateDesk}: one object (`Gate`) every new registration goes through, one request per client bucket at a
 *   time: daily brake per gate, device quota (DeviceCheck bits or a counter per APNs token digest), the Apple call,
 *   a durable admission, and only then the entry write.
 * - {@link DenyBook}: one object (`Admin`), the denial list with one-year retention, independent of entry TTLs,
 *   mirrored in KV.
 *
 * Each machine runs its operations one at a time ({@link Serial}): an operation reads the state, computes the new one
 * and writes it whole before the next starts, also while it waits for Apple. In a Durable Object the platform input
 * gate gives part of this guarantee, but not across `fetch` calls; the queue in code works the same in the Worker
 * and in the test.
 *
 * Consistency between entries (the app on one side, the server on the other) has no shared transaction. The app
 * entry is the truth, and the claim invariant holds it. A claim is a durable record in the app object that its
 * incarnation may have sponsorship `ticket` at a server with an expiry no later than the claim's term: a reservation
 * (`term`) or a sponsorship (`expiresAt`), at most one per server.
 *
 * 1. Every write at a server (`addSponsor` with sponsorship T and expiry E) is preceded by a durable claim with the
 *    same T and a term no shorter than E: a reservation or its extension and the sponsorship extension in `reserve`,
 *    the sponsorship extension in `renew`. The claim's term does not decrease, and the server does not shorten a
 *    sponsorship with the same T.
 * 2. A claim leaves the app only through `commit` (the reservation becomes a sponsorship with an expiry no shorter
 *    than any it handed out), through a drop record of T at the server ({@link Drop}: `forget`, reservation expiry,
 *    end of the entry), or when its own term passes, which no server write with this T exceeds.
 * 3. Quota refund (`cancel`) only when no attempt with this T could write at the server: every attempt that got T
 *   reported a server refusal. Otherwise the claim stays, expires into drops, and the quota marker stays in the window.
 * 4. One gate admission creates at most one incarnation: the entry object remembers a spent admission at least
 *    as long as the gate can retry it.
 *
 * The app entry's alarm retries a drop record until it succeeds. The drop at a server is conditional: it removes only
 * the sponsorship with its identifier, so a late retry does not touch a newer sponsorship of that server. The core
 * also removes a write that reached the server after `forget` or after a new registration right after it (`commit` and
 * `orphans` check the incarnation and the sponsorship). Outside the invariant stays a server write that arrives more
 * than 10 min after the app step that preceded it, when the claim has meanwhile gone to drops and already performed
 * them, and the core dies before its check after the write. The entry queue never waits for another entry: an entry
 * calls other entries only from the alarm, outside the queue.
 *
 * The entry object state ({@link EndpointState}: entry, pending drops, spent admissions) lives in one store key,
 * so every operation writes it atomically. Before an operation changes it, a reservation that expired without a
 * commit (or expired together with the entry) moves to drops ({@link settle}): it does not vanish without a trace
 * even when another write arrives before the alarm.
 *
 * Alarm schedule: the store has one alarm, and `setAlarm` overwrites the previous one, so after every write the entry
 * sets the alarm to the nearest deadline from its state (entry expiry, sponsorships, reservations, drops, spent
 * admissions). The alarm removes everything that has expired and schedules the next deadline. Reads skip past
 * deadlines also before the alarm.
 */
import type { RelayAuthEnvironment, RelayAuthGate } from '../../shared/src/relay-auth.ts';

/** TTL of an app entry and a sponsorship from the app's last activity (seconds). */
export const ENTRY_TTL_SECONDS = 90 * 24 * 3600;
/** Term of a sponsorship reservation that was not committed (seconds). */
export const RESERVATION_TTL_SECONDS = 10 * 60;
/** Quota window for an app's new sponsorships and for registrations per APNs token digest (seconds). */
export const QUOTA_WINDOW_SECONDS = 30 * 24 * 3600;
/** Retention of an admin denial (seconds). */
export const DENY_TTL_SECONDS = 365 * 24 * 3600;
/** Cap on one server's sponsorships at once (store protection; the app limit gives the traffic quota). */
export const SERVER_SPONSORS_MAX = 32;
/**
 * Most registrations waiting in the gate queue; further ones get `unavailable`. One client bucket holds at most one
 * place ({@link GateDesk.register}).
 */
export const GATE_QUEUE_MAX = 32;
/**
 * How long after `forget` the second drop of the forgotten incarnation's sponsorships waits (late in-flight write,
 * seconds).
 */
export const FORGET_REDROP_SECONDS = 10 * 60;
/** Retry interval of a sponsorship drop that failed (seconds). */
export const DROP_RETRY_SECONDS = 10 * 60;
/**
 * How long a gate admission without an entry lives: a retry within it finishes registration without a second charge.
 * The entry object accepts an admission only within this term and remembers spent ones at least until its end.
 */
export const ADMISSION_TTL_SECONDS = 10 * 60;
/** Cleanup interval of the gate and the denial list (ms). */
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

/** Durable Object store, to the extent the registry uses it (`DurableObjectStorage` has this shape). */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /** Several keys at once, atomically: everything is written or nothing. */
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  list<T>(options: { readonly prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Registry clock (with the `CLOCK_OFFSET` shift outside production) and conversion to platform alarm time. */
export interface Clock {
  /** Epoch ms by the registry clock. */
  nowMs(): number;
  /** Registry moment (ms) → platform alarm moment (ms). */
  alarmAt(ms: number): number;
}

/** Operations one at a time: the next starts after the previous one ends (also on failure). */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;

  /** How many operations wait or run. */
  get pending(): number {
    return this.#waiting;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#waiting += 1;
    const next = this.#tail.then(task).finally(() => { this.#waiting -= 1; });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

const nowSec = (clock: Clock): number => Math.floor(clock.nowMs() / 1000);

// ---------------------------------------------------------------------------------------------------------------
// EndpointId entry

/** One sponsorship of a server by an app incarnation: the server and the sponsorship identifier. */
export interface SponsorRef {
  readonly server: string;
  /** Sponsorship identifier (assigned at reservation): a drop at the server applies only to this sponsorship. */
  readonly ticket: string;
}

export interface Sponsorship extends SponsorRef {
  readonly expiresAt: number;
}

export interface Reservation extends SponsorRef {
  /** Term of the reservation itself: 10 min from the last attempt that got it. */
  readonly expiresAt: number;
  /** The marker in `starts` that the reservation added (refunded on cancel). */
  readonly startedAt: number;
  /**
   * Claim term: the latest sponsorship expiry the reservation handed to an attempt (the server write does not go
   * further).
   */
  readonly term: number;
  /** Attempts that got this reservation and did not report a server refusal (`cancel`). */
  readonly attempts: number;
}

/** Gate admission (`admission:<EndpointId>` in the gate store), which creates at most one incarnation. */
export interface Admission {
  /** Admission identifier (random). */
  readonly charge: string;
  /** Moment of the admission by the gate clock (seconds). */
  readonly at: number;
}

/** Admission spent by an incarnation: until `until` it does not create another one. */
export interface SpentCharge {
  readonly charge: string;
  readonly until: number;
}

export interface AppRecord {
  readonly kind: 'app';
  /** EndpointId of this app (the alarm drops its sponsorships at the servers with it). */
  readonly id: string;
  /** Entry incarnation: new for each new entry, the same on renewal. */
  readonly epoch: string;
  /** The admission that created this incarnation; after the entry ends it moves to the spent ones. */
  readonly charge: SpentCharge;
  readonly expiresAt: number;
  readonly sponsored: readonly Sponsorship[];
  readonly reservations: readonly Reservation[];
  /** Moments of new sponsorships from the last 30 days (quota `SPONSOR_QUOTA`). */
  readonly starts: readonly number[];
}

/** Server-side sponsorship: the app, its incarnation and the sponsorship identifier. One per `(app, incarnation)`. */
export interface Sponsor {
  readonly app: string;
  readonly epoch: string;
  readonly ticket: string;
  readonly expiresAt: number;
}

export interface ServerRecord {
  readonly kind: 'server';
  readonly sponsors: readonly Sponsor[];
}

export type EndpointRecord = AppRecord | ServerRecord;

export type EndpointKind = EndpointRecord['kind'];

/**
 * Pending drop of one sponsorship at a server, kept in the app object until it succeeds: after `forget` (with the
 * term of the second drop, which catches a late in-flight write) and after an uncommitted reservation expires.
 */
export interface Drop extends SponsorRef {
  readonly app: string;
  readonly epoch: string;
  readonly dueAt: number;
}

/** The whole entry object state, in one store key: entry, pending drops and spent admissions. */
export interface EndpointState {
  readonly entry: EndpointRecord | null;
  readonly drops: readonly Drop[];
  readonly spent: readonly SpentCharge[];
}

/** Entry state for the hook and the gate: kind and expiry (server: the latest sponsorship expiry). */
export interface EndpointStatus {
  readonly kind: EndpointKind;
  readonly expiresAt: number;
  /** Server entry only: the apps whose live sponsorships keep it, each once (the hook checks their denials). */
  readonly sponsors?: readonly string[];
}

export type Failure<E extends string> = { readonly ok: false; readonly error: E };

export type ExtendOutcome =
  | { readonly ok: true; readonly expiresAt: number }
  | Failure<'not-registered' | 'kind-conflict'>;
/** `charge-spent`: the admission has already created an incarnation or its term has passed; the gate charges anew. */
export type AdmitOutcome =
  | { readonly ok: true; readonly expiresAt: number }
  | Failure<'kind-conflict' | 'charge-spent'>;
export type RenewOutcome =
  | { readonly ok: true; readonly epoch: string; readonly expiresAt: number; readonly renewed: readonly Sponsorship[];
    readonly unsponsored: readonly string[] }
  | Failure<'not-registered' | 'kind-conflict'>;
export type ReserveOutcome =
  | { readonly ok: true; readonly epoch: string; readonly ticket: string; readonly expiresAt: number;
    readonly fresh: boolean }
  | Failure<'not-registered' | 'kind-conflict' | 'quota-exceeded'>;
export type CommitOutcome = { readonly ok: true; readonly expiresAt: number } | Failure<'not-registered'>;
export type SponsorOutcome = { readonly ok: true } | Failure<'kind-conflict' | 'quota-exceeded'>;
export type ForgetOutcome = { readonly ok: true; readonly drops: readonly Drop[] } | Failure<'kind-conflict'>;

export interface SponsorLimits {
  /** New sponsorships in {@link QUOTA_WINDOW_SECONDS}. */
  readonly windowMax: number;
  /** Live sponsorships and reservations at once. */
  readonly liveMax: number;
}

/** Entry operations called by the Worker core, the gate and another entry's alarm (RPC to `Endpoint`). */
export interface EndpointApi {
  status(): Promise<EndpointStatus | null>;
  extendApp(): Promise<ExtendOutcome>;
  admitApp(id: string, admission: Admission): Promise<AdmitOutcome>;
  renew(servers: readonly string[]): Promise<RenewOutcome>;
  reserve(server: string, limits: SponsorLimits): Promise<ReserveOutcome>;
  commit(server: string, epoch: string, ticket: string, expiresAt: number): Promise<CommitOutcome>;
  cancel(server: string, epoch: string, ticket: string): Promise<void>;
  orphans(epoch: string, items: readonly SponsorRef[]): Promise<readonly SponsorRef[]>;
  addSponsor(app: string, epoch: string, ticket: string, expiresAt: number): Promise<SponsorOutcome>;
  dropSponsor(app: string, epoch: string, ticket: string): Promise<void>;
  forget(): Promise<ForgetOutcome>;
}

/** Entries where the app entry's alarm drops its sponsorships (in the Worker the `ENDPOINT` stub). */
export type Peers = (id: string) => Pick<EndpointApi, 'dropSponsor'>;

/** Generator of entry identifiers: incarnations and sponsorships. */
export type Ids = (kind: 'epoch' | 'ticket') => string;

const STATE_KEY = 'state';
const EMPTY: EndpointState = { entry: null, drops: [], spent: [] };

/** Nearest deadline of the entry (seconds): entry, sponsorships, reservations. */
export function nextDue(record: EndpointRecord): number {
  const terms = record.kind === 'server'
    ? record.sponsors.map((sponsor) => sponsor.expiresAt)
    : [record.expiresAt, ...record.sponsored.map((item) => item.expiresAt),
      ...record.reservations.map((item) => item.expiresAt)];
  return Math.min(...terms);
}

export const statusOf = (record: EndpointRecord): EndpointStatus => (record.kind === 'app'
  ? { kind: 'app', expiresAt: record.expiresAt }
  : {
    kind: 'server',
    expiresAt: Math.max(...record.sponsors.map((sponsor) => sponsor.expiresAt)),
    sponsors: [...new Set(record.sponsors.map((sponsor) => sponsor.app))],
  });

/** Sponsorships and reservations of the incarnation (at most one per server). */
const heldOf = (record: AppRecord): readonly (Sponsorship | Reservation)[] =>
  [...record.sponsored, ...record.reservations];

const holds = (record: AppRecord, server: string, ticket: string): boolean =>
  heldOf(record).some((item) => item.server === server && item.ticket === ticket);

const dropOf = (record: AppRecord, item: SponsorRef, dueAt: number): Drop =>
  ({ server: item.server, ticket: item.ticket, app: record.id, epoch: record.epoch, dueAt });

const dropKey = (drop: Drop): string => `${drop.epoch}|${drop.server}|${drop.ticket}`;

const termsOf = (state: EndpointState): number[] => [
  ...(state.entry === null ? [] : [nextDue(state.entry)]),
  ...state.drops.map((drop) => drop.dueAt),
  ...state.spent.map((item) => item.until),
];

export interface Settled {
  readonly state: EndpointState;
  /** Durable state changed by more than filtering out deadlines: a reservation to drops or the end of the entry. */
  readonly changed: boolean;
}

/**
 * State after past deadlines, computed from the RAW record before every operation. A reservation that expired without
 * a commit, and every reservation of an entry that expired, moves to drops (its server write could have arrived; a
 * live reservation of an expired entry with the term of the reservation itself), and so does a sponsorship that would
 * outlive its entry. The admission of an expired entry moves to the spent ones.
 */
export function settle(stored: EndpointState | undefined, now: number): Settled {
  if (stored === undefined) return { state: EMPTY, changed: false };
  const spent = stored.spent.filter((item) => item.until > now);
  const record = stored.entry;
  if (record === null) return { state: { ...stored, spent }, changed: false };
  if (record.kind === 'server') {
    const sponsors = record.sponsors.filter((sponsor) => sponsor.expiresAt > now);
    const entry: ServerRecord | null = sponsors.length === 0 ? null : { kind: 'server', sponsors };
    return { state: { entry, drops: stored.drops, spent }, changed: entry === null };
  }
  const ended = record.expiresAt <= now;
  const lapsed = record.reservations.filter((item) => ended || item.expiresAt <= now);
  const outlived = ended ? record.sponsored.filter((item) => item.expiresAt > now) : [];
  const drops = [
    ...stored.drops,
    ...lapsed.map((item) => dropOf(record, item, Math.max(now, item.expiresAt))),
    ...outlived.map((item) => dropOf(record, item, now)),
  ];
  if (ended) {
    const charge = record.charge.until > now ? [record.charge] : [];
    return { state: { entry: null, drops, spent: [...spent, ...charge] }, changed: true };
  }
  const entry: AppRecord = {
    ...record,
    sponsored: record.sponsored.filter((item) => item.expiresAt > now),
    reservations: record.reservations.filter((item) => item.expiresAt > now),
    starts: record.starts.filter((at) => at > now - QUOTA_WINDOW_SECONDS),
  };
  return { state: { entry, drops, spent }, changed: lapsed.length > 0 };
}

export class EndpointBook implements EndpointApi {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #peers: Peers;
  readonly #ids: Ids;
  readonly #serial = new Serial();

  /** `ids`: generator of incarnations and sponsorship identifiers, a random WebCrypto UUID by default. */
  constructor(store: Store, clock: Clock, peers: Peers, ids: Ids = () => crypto.randomUUID()) {
    this.#store = store;
    this.#clock = clock;
    this.#peers = peers;
    this.#ids = ids;
  }

  /**
   * Operation on the state after past deadlines ({@link settle}); `update` returns the result and the new state
   * (`undefined` = no change). State changed by {@link settle} alone is written also on an operation with no change.
   */
  #run<T>(update: (state: EndpointState, now: number) => { result: T; state?: EndpointState }): Promise<T> {
    return this.#serial.run(async () => {
      const now = nowSec(this.#clock);
      const settled = settle(await this.#store.get<EndpointState>(STATE_KEY), now);
      const { result, state } = update(settled.state, now);
      if (state !== undefined) await this.#write(state);
      else if (settled.changed) await this.#write(settled.state);
      return result;
    });
  }

  /** {@link #run} on the entry alone: `next` = new entry (`null` = deletion), `undefined` = no change. */
  #apply<T>(update: (record: EndpointRecord | null, now: number) => { result: T; next?: EndpointRecord | null }):
    Promise<T> {
    return this.#run((state, now) => {
      const { result, next } = update(state.entry, now);
      return next === undefined ? { result } : { result, state: { ...state, entry: next } };
    });
  }

  /**
   * Writes the state under one key and sets the alarm to its nearest deadline; an empty state = an empty store with no
   * alarm. An alarm earlier than needed breaks nothing (the handler recomputes the deadline), a later one would delay
   * a drop, so a deadline earlier than the current one goes before the state write, and a later one after it.
   */
  async #write(state: EndpointState): Promise<void> {
    const terms = termsOf(state);
    if (terms.length === 0) {
      await this.#store.deleteAll();
      await this.#store.deleteAlarm();
      return;
    }
    const at = this.#clock.alarmAt(Math.min(...terms) * 1000);
    const current = await this.#store.getAlarm();
    if (current === null || at < current) await this.#store.setAlarm(at);
    await this.#store.put(STATE_KEY, state);
    if (current !== null && at > current) await this.#store.setAlarm(at);
  }

  status(): Promise<EndpointStatus | null> {
    return this.#apply((record) => ({ result: record === null ? null : statusOf(record) }));
  }

  /**
   * Renewal of a live app entry (registering an existing EndpointId costs no quota). Without a live entry
   * `not-registered`: the gate then goes the new-registration path with an admission.
   */
  extendApp(): Promise<ExtendOutcome> {
    return this.#apply<ExtendOutcome>((record, now) => {
      if (record === null) return { result: { ok: false, error: 'not-registered' } };
      if (record.kind === 'server') return { result: { ok: false, error: 'kind-conflict' } };
      const expiresAt = now + ENTRY_TTL_SECONDS;
      return { result: { ok: true, expiresAt }, next: { ...record, expiresAt } };
    });
  }

  /**
   * New app entry (new incarnation) from a gate admission; a live app entry is only renewed. A spent or expired
   * admission (entry clock) = `charge-spent`. The entry remembers a spent admission until the later of two ends: the
   * admission term counted from its moment and from the moment of the entry, so no gate clock retries it.
   */
  admitApp(id: string, admission: Admission): Promise<AdmitOutcome> {
    return this.#run<AdmitOutcome>((state, now) => {
      const record = state.entry;
      if (record?.kind === 'server') return { result: { ok: false, error: 'kind-conflict' } };
      const expiresAt = now + ENTRY_TTL_SECONDS;
      if (record !== null) return { result: { ok: true, expiresAt }, state: { ...state, entry: { ...record, expiresAt } } };
      const spent = admission.at <= now - ADMISSION_TTL_SECONDS
        || state.spent.some((item) => item.charge === admission.charge);
      if (spent) return { result: { ok: false, error: 'charge-spent' } };
      const charge: SpentCharge = { charge: admission.charge, until: Math.max(admission.at, now) + ADMISSION_TTL_SECONDS };
      const entry: AppRecord = {
        kind: 'app', id, epoch: this.#ids('epoch'), charge, expiresAt, sponsored: [], reservations: [], starts: [],
      };
      return { result: { ok: true, expiresAt }, state: { ...state, entry } };
    });
  }

  /**
   * Renewal of the app entry and of its live sponsorships of the listed servers, written before the server writes
   * (the claim term does not decrease). A sponsorship outside the list expires by itself (the app forgot the server).
   * `unsponsored`: listed servers without a live sponsorship (a reservation does not count).
   */
  renew(servers: readonly string[]): Promise<RenewOutcome> {
    return this.#apply<RenewOutcome>((record, now) => {
      if (record === null) return { result: { ok: false, error: 'not-registered' } };
      if (record.kind === 'server') return { result: { ok: false, error: 'kind-conflict' } };
      const expiresAt = now + ENTRY_TTL_SECONDS;
      const listed = new Set(servers);
      const sponsored = record.sponsored.map((item) =>
        (listed.has(item.server) ? { ...item, expiresAt: Math.max(item.expiresAt, expiresAt) } : item));
      const renewed = sponsored.filter((item) => listed.has(item.server));
      const have = new Set(renewed.map((item) => item.server));
      const unsponsored = servers.filter((server) => !have.has(server));
      return {
        result: { ok: true, epoch: record.epoch, expiresAt, renewed, unsponsored },
        next: { ...record, expiresAt, sponsored },
      };
    });
  }

  /**
   * First sponsorship step: a claim at the app, written before the server write, with the idempotency key
   * `(app, server)`. A live sponsorship or live reservation of this server costs no quota (`fresh: false`), hands out
   * its identifier and gets the term handed to this attempt: the sponsorship extended, the reservation with a later
   * claim term, a full 10 min and one more attempt. A new reservation gets a new identifier, counts toward the quota
   * in the window at once and stays in it also after expiry (a failure halfway costs one sponsorship, never gives a
   * free one). `expiresAt`: the expiry of the sponsorship the server writes and {@link commit} completes; `epoch` and
   * `ticket`: the incarnation and the sponsorship it reserves.
   */
  reserve(server: string, limits: SponsorLimits): Promise<ReserveOutcome> {
    return this.#apply<ReserveOutcome>((record, now) => {
      if (record === null) return { result: { ok: false, error: 'not-registered' } };
      if (record.kind === 'server') return { result: { ok: false, error: 'kind-conflict' } };
      const term = now + ENTRY_TTL_SECONDS;
      const window = now + RESERVATION_TTL_SECONDS;
      const granted = (ticket: string, expiresAt: number, fresh: boolean): ReserveOutcome =>
        ({ ok: true, epoch: record.epoch, ticket, expiresAt, fresh });
      const sponsorship = record.sponsored.find((item) => item.server === server);
      if (sponsorship !== undefined) {
        const expiresAt = Math.max(sponsorship.expiresAt, term);
        const sponsored = record.sponsored.map((item) => (item === sponsorship ? { ...item, expiresAt } : item));
        return {
          result: granted(sponsorship.ticket, expiresAt, false),
          next: { ...record, expiresAt: Math.max(record.expiresAt, expiresAt), sponsored },
        };
      }
      const known = record.reservations.find((item) => item.server === server);
      if (known !== undefined) {
        const extended: Reservation = {
          ...known, expiresAt: Math.max(known.expiresAt, window), term: Math.max(known.term, term),
          attempts: known.attempts + 1,
        };
        const reservations = record.reservations.map((item) => (item === known ? extended : item));
        return { result: granted(known.ticket, extended.term, false), next: { ...record, reservations } };
      }
      const live = new Set(heldOf(record).map((item) => item.server)).size;
      if (live >= limits.liveMax || record.starts.length >= limits.windowMax) {
        return { result: { ok: false, error: 'quota-exceeded' } };
      }
      const ticket = this.#ids('ticket');
      const reservation: Reservation = { server, ticket, expiresAt: window, startedAt: now, term, attempts: 1 };
      return {
        result: granted(ticket, term, true),
        next: { ...record, reservations: [...record.reservations, reservation], starts: [...record.starts, now] },
      };
    });
  }

  /**
   * Last sponsorship step: reservation → sponsorship with an expiry no shorter than any the claim handed to attempts
   * (the server write does not outlive it); the app's activity renews its entry. Idempotent. Only in the incarnation
   * that reserved, and only for a sponsorship this incarnation holds: an entry forgotten or created anew, or a
   * reservation expired or overwritten by a newer one, gives `not-registered`.
   */
  commit(server: string, epoch: string, ticket: string, expiresAt: number): Promise<CommitOutcome> {
    return this.#apply<CommitOutcome>((record) => {
      if (record?.kind !== 'app' || record.epoch !== epoch || !holds(record, server, ticket)) {
        return { result: { ok: false, error: 'not-registered' } };
      }
      const same = (item: SponsorRef): boolean => item.server === server && item.ticket === ticket;
      const term = Math.max(expiresAt, record.sponsored.find(same)?.expiresAt ?? 0,
        record.reservations.find(same)?.term ?? 0);
      const sponsored = [...record.sponsored.filter((item) => item.server !== server), { server, ticket, expiresAt: term }];
      const reservations = record.reservations.filter((item) => item.server !== server);
      const appExpires = Math.max(record.expiresAt, term);
      return { result: { ok: true, expiresAt: term }, next: { ...record, expiresAt: appExpires, sponsored, reservations } };
    });
  }

  /**
   * An attempt whose write the server refused (other kind, sponsorship cap). The reservation disappears together with
   * its quota marker only when every attempt that got it reported a refusal: another attempt with the same `ticket`
   * could have written at the server, so then the reservation loses only one attempt, expires into drops, and the
   * quota stays spent.
   */
  cancel(server: string, epoch: string, ticket: string): Promise<void> {
    return this.#apply<undefined>((record) => {
      if (record?.kind !== 'app' || record.epoch !== epoch) return { result: undefined };
      const reservation = record.reservations.find((item) => item.server === server && item.ticket === ticket);
      if (reservation === undefined) return { result: undefined };
      if (reservation.attempts > 1) {
        const left: Reservation = { ...reservation, attempts: reservation.attempts - 1 };
        const reservations = record.reservations.map((item) => (item === reservation ? left : item));
        return { result: undefined, next: { ...record, reservations } };
      }
      const index = record.starts.indexOf(reservation.startedAt);
      const starts = index < 0 ? record.starts : [...record.starts.slice(0, index), ...record.starts.slice(index + 1)];
      const reservations = record.reservations.filter((item) => item !== reservation);
      return { result: undefined, next: { ...record, reservations, starts } };
    });
  }

  /**
   * Sponsorships from the list that the live incarnation `epoch` does not hold (neither as a sponsorship nor as a
   * reservation): a write at their servers that arrived after `forget` or after a new registration has no app.
   */
  orphans(epoch: string, items: readonly SponsorRef[]): Promise<readonly SponsorRef[]> {
    return this.#apply<readonly SponsorRef[]>((record) => {
      if (record?.kind !== 'app' || record.epoch !== epoch) return { result: [...items] };
      return { result: items.filter((item) => !holds(record, item.server, item.ticket)) };
    });
  }

  /**
   * Server-side sponsorship of an app incarnation (write or extension); overwrites the previous sponsorship of the
   * same incarnation, but does not shorten the same `ticket` (the writes of two attempts can arrive in reverse order).
   * An entry without state becomes a server entry.
   */
  addSponsor(app: string, epoch: string, ticket: string, expiresAt: number): Promise<SponsorOutcome> {
    return this.#apply<SponsorOutcome>((record) => {
      if (record?.kind === 'app') return { result: { ok: false, error: 'kind-conflict' } };
      const mine = (sponsor: Sponsor): boolean => sponsor.app === app && sponsor.epoch === epoch;
      const others = (record?.sponsors ?? []).filter((sponsor) => !mine(sponsor));
      if (others.length >= SERVER_SPONSORS_MAX) return { result: { ok: false, error: 'quota-exceeded' } };
      const same = record?.sponsors.find((sponsor) => mine(sponsor) && sponsor.ticket === ticket);
      const term = Math.max(expiresAt, same?.expiresAt ?? 0);
      return {
        result: { ok: true }, next: { kind: 'server', sponsors: [...others, { app, epoch, ticket, expiresAt: term }] },
      };
    });
  }

  /**
   * Drop of one sponsorship: only when the server holds exactly this `(app, incarnation, ticket)`. A newer
   * sponsorship of this incarnation and a sponsorship of another incarnation stay. Idempotent.
   */
  dropSponsor(app: string, epoch: string, ticket: string): Promise<void> {
    return this.#apply<undefined>((record) => {
      const match = (sponsor: Sponsor): boolean => sponsor.app === app && sponsor.epoch === epoch
        && sponsor.ticket === ticket;
      if (record?.kind !== 'server' || !record.sponsors.some(match)) return { result: undefined };
      const sponsors = record.sponsors.filter((sponsor) => !match(sponsor));
      return { result: undefined, next: sponsors.length === 0 ? null : { kind: 'server', sponsors } };
    });
  }

  /**
   * Deletes the app entry with one state write: a drop record of the incarnation's sponsorships and reservations at the
   * servers with the second-drop term, the incarnation's admission to the spent ones, the entry removed. Result: all
   * drops still pending (also from a prior attempt and from expired reservations), so retrying `forget` after a server
   * failure finishes the drops. No entry = success.
   */
  forget(): Promise<ForgetOutcome> {
    return this.#run<ForgetOutcome>((state, now) => {
      const record = state.entry;
      if (record?.kind === 'server') return { result: { ok: false, error: 'kind-conflict' } };
      if (record === null) return { result: { ok: true, drops: state.drops } };
      const drops = [...state.drops, ...heldOf(record).map((item) => dropOf(record, item, now + FORGET_REDROP_SECONDS))];
      const spent = record.charge.until > now ? [...state.spent, record.charge] : state.spent;
      return { result: { ok: true, drops }, state: { entry: null, drops, spent } };
    });
  }

  /**
   * Alarm: removes past deadlines, and performs the sponsorship drops at the servers (after `forget` and after an
   * uncommitted reservation expires) outside the entry queue, so two entries never wait for each other. Before the
   * attempt each drop gets a retry deadline (an object failure meanwhile does not lose the record); on success the
   * record disappears.
   */
  async alarm(): Promise<void> {
    const lease = await this.#run((state, now) => {
      const retryAt = now + DROP_RETRY_SECONDS;
      const ready = state.drops.filter((drop) => drop.dueAt <= now);
      const drops = state.drops.map((drop) => (drop.dueAt <= now ? { ...drop, dueAt: retryAt } : drop));
      return { result: { ready, retryAt }, state: { ...state, drops } };
    });
    if (lease.ready.length === 0) return;

    const done = new Set<string>();
    await Promise.all(lease.ready.map(async (drop) => {
      try {
        await this.#peers(drop.server).dropSponsor(drop.app, drop.epoch, drop.ticket);
        done.add(dropKey(drop));
      } catch {
        // Stays in the record with the retry deadline set before the attempt.
      }
    }));
    if (done.size === 0) return;

    await this.#run((state) => ({
      result: undefined,
      state: { ...state, drops: state.drops.filter((drop) => !done.has(dropKey(drop)) || drop.dueAt !== lease.retryAt) },
    }));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registration gate

/** Gate proof after shape validation (`proof` from `register`). */
export interface GateProof {
  readonly kind: RelayAuthGate;
  readonly environment: RelayAuthEnvironment;
  readonly token: string;
}

/** Apple call failure: proof rejected, Apple unreachable, Apple refuses our key or configuration. */
export interface AppleFailure {
  readonly kind: 'rejected' | 'unreachable' | 'refused';
  readonly status?: number;
  readonly reason?: string;
  readonly cause?: 'timeout' | 'network';
}

export interface DeviceBits {
  readonly bit0: boolean;
  readonly bit1: boolean;
  /** `YYYY-MM` of the last change (Apple). */
  readonly lastUpdate: string;
}

export type AppleResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: AppleFailure };

/** The gate's Apple calls. The real ones in `apple.ts`, a fake in tests. */
export interface AppleGate {
  /** DeviceCheck `query_two_bits`; `null` = no bits set. */
  queryBits(environment: RelayAuthEnvironment, token: string): Promise<AppleResult<DeviceBits | null>>;
  /** DeviceCheck `update_two_bits`. */
  updateBits(environment: RelayAuthEnvironment, token: string, bit0: boolean, bit1: boolean):
    Promise<AppleResult<null>>;
  /** Test silent APNs push to the device token. */
  probe(environment: RelayAuthEnvironment, token: string): Promise<AppleResult<null>>;
}

export interface GateSettings {
  readonly gate: RelayAuthGate | null;
  readonly registerMonthly: number;
  readonly registerDailyBrake: number;
  /** Epoch seconds or `null`. */
  readonly graceUntil: number | null;
}

export type RegisterError =
  | 'unavailable' | 'gate-mismatch' | 'kind-conflict' | 'limited' | 'quota-exceeded' | 'proof-rejected'
  | 'gate-unreachable';

export type RegisterOutcome =
  | { readonly ok: true; readonly expiresAt: number; readonly fresh: boolean }
  | { readonly ok: false; readonly error: RegisterError; readonly apple?: AppleFailure };

export interface GateApi {
  /** `bucket`: the client's address bucket at the gate (`gateBucket` in `core.ts`). */
  register(endpointId: string, proof: GateProof, bucket: string): Promise<RegisterOutcome>;
}

export interface GateDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly settings: GateSettings;
  /** `null`: gate without a working key. */
  readonly apple: AppleGate | null;
  readonly endpoint: (id: string) => Pick<EndpointApi, 'extendApp' | 'admitApp'>;
  readonly sha256Hex: (text: string) => Promise<string>;
}

/** UTC day `YYYY-MM-DD` and month `YYYY-MM` of a moment (seconds). */
const dayOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
const monthOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7);

/** Counter 0–3 from two DeviceCheck bits; bits from the previous month count as zero. */
export function bitsCount(bits: DeviceBits | null, now: number): number {
  if (bits === null || bits.lastUpdate !== monthOf(now)) return 0;
  return (bits.bit0 ? 1 : 0) + (bits.bit1 ? 2 : 0);
}

const appleError = (failure: AppleFailure): RegisterError =>
  (failure.kind === 'rejected' ? 'proof-rejected' : failure.kind === 'unreachable' ? 'gate-unreachable' : 'unavailable');

/** Admission result: a written admission or a registration failure. */
type Charged = { readonly ok: true; readonly admission: Admission } | Extract<RegisterOutcome, { readonly ok: false }>;

export class GateDesk implements GateApi {
  readonly #deps: GateDeps;
  readonly #serial = new Serial();
  /** Client buckets with a registration waiting in the queue or running. */
  readonly #inFlight = new Set<string>();

  constructor(deps: GateDeps) {
    this.#deps = deps;
  }

  /**
   * Registration of an app EndpointId: one at a time. A live app entry = renewal without quota and without Apple; a
   * server entry = `kind-conflict`; no live entry = admission (the gate's daily brake, device quota, Apple) written
   * durably, and only then a new entry from that admission.
   *
   * One request per client bucket waits or runs at a time; another one from that bucket gets `limited` at once, so
   * one client holds at most one place in the queue and cannot block the others' registrations. The Apple call stays
   * inside the queue: the DeviceCheck bits are read and written in one step per registration.
   */
  register(endpointId: string, proof: GateProof, bucket: string): Promise<RegisterOutcome> {
    if (this.#inFlight.has(bucket)) return Promise.resolve({ ok: false, error: 'limited' });
    if (this.#serial.pending >= GATE_QUEUE_MAX) return Promise.resolve({ ok: false, error: 'unavailable' });
    this.#inFlight.add(bucket);
    return this.#serial.run(() => this.#register(endpointId, proof))
      .finally(() => { this.#inFlight.delete(bucket); });
  }

  async #register(endpointId: string, proof: GateProof): Promise<RegisterOutcome> {
    const { settings, apple, store } = this.#deps;
    const { gate } = settings;
    if (gate === null || apple === null) return { ok: false, error: 'unavailable' };
    if (proof.kind !== gate) return { ok: false, error: 'gate-mismatch' };
    const endpoint = this.#deps.endpoint(endpointId);
    // Renewal in one entry operation: a `forget` next to it does not turn it into a free new entry.
    const extended = await endpoint.extendApp();
    if (extended.ok) return { ok: true, expiresAt: extended.expiresAt, fresh: false };
    if (extended.error === 'kind-conflict') return { ok: false, error: 'kind-conflict' };

    const now = nowSec(this.#deps.clock);
    const admissionKey = `admission:${endpointId}`;
    const charge = (): Promise<Charged> => this.#charge(admissionKey, proof, gate, apple, now);
    // The admission lies in the gate store: an entry failure below and a retry finish registration without a second
    // charge.
    const stored = await store.get<Admission>(admissionKey);
    let charged: Charged = stored !== undefined && stored.at > now - ADMISSION_TTL_SECONDS
      ? { ok: true, admission: stored }
      : await charge();
    if (!charged.ok) return charged;
    let admitted = await endpoint.admitApp(endpointId, charged.admission);
    if (!admitted.ok && admitted.error === 'charge-spent') {
      // This admission already created an incarnation (its response was lost) that is gone since: a new registration.
      charged = await charge();
      if (!charged.ok) return charged;
      admitted = await endpoint.admitApp(endpointId, charged.admission);
    }
    await store.delete(admissionKey);
    if (admitted.ok) return { ok: true, expiresAt: admitted.expiresAt, fresh: true };
    return { ok: false, error: admitted.error === 'kind-conflict' ? 'kind-conflict' : 'unavailable' };
  }

  /**
   * Daily brake, device quota and Apple, then one atomic write: the brake, the APNs counter and the EndpointId
   * admission with a new identifier. Apple writes the DeviceCheck bits before this write, so its failure costs a unit
   * of device quota, but never gives an entry without an admission.
   */
  async #charge(admissionKey: string, proof: GateProof, gate: RelayAuthGate, apple: AppleGate, now: number):
    Promise<Charged> {
    const { settings, store } = this.#deps;
    const brakeKey = `brake:${gate}:${dayOf(now)}`;
    const brake = (await store.get<number>(brakeKey)) ?? 0;
    if (brake >= settings.registerDailyBrake) return { ok: false, error: 'limited' };

    const admission: Admission = { charge: crypto.randomUUID(), at: now };
    const writes: Record<string, unknown> = { [brakeKey]: brake + 1, [admissionKey]: admission };
    if (proof.kind === 'devicecheck') {
      const query = await apple.queryBits(proof.environment, proof.token);
      if (!query.ok) return { ok: false, error: appleError(query.failure), apple: query.failure };
      const count = bitsCount(query.value, now);
      const grace = settings.graceUntil !== null && now < settings.graceUntil;
      if (count >= settings.registerMonthly && !grace) return { ok: false, error: 'quota-exceeded' };
      const next = Math.min(count + 1, 3);
      const update = await apple.updateBits(proof.environment, proof.token, (next & 1) === 1, (next & 2) === 2);
      if (!update.ok) return { ok: false, error: appleError(update.failure), apple: update.failure };
    } else {
      const apnsKey = `apns:${await this.#deps.sha256Hex(proof.token.toLowerCase())}`;
      const times = ((await store.get<number[]>(apnsKey)) ?? []).filter((at) => at > now - QUOTA_WINDOW_SECONDS);
      if (times.length >= settings.registerMonthly) return { ok: false, error: 'quota-exceeded' };
      const probe = await apple.probe(proof.environment, proof.token.toLowerCase());
      if (!probe.ok) return { ok: false, error: appleError(probe.failure), apple: probe.failure };
      writes[apnsKey] = [...times, now];
    }
    await store.put(writes);
    if (await store.getAlarm() === null) {
      await store.setAlarm(this.#deps.clock.alarmAt(this.#deps.clock.nowMs() + PRUNE_INTERVAL_MS));
    }
    return { ok: true, admission };
  }

  /**
   * Cleanup once a day: APNs counters older than the quota window, brakes from days before yesterday and admissions
   * without an entry past their term.
   */
  alarm(): Promise<void> {
    return this.#serial.run(async () => {
      const { store, clock } = this.#deps;
      const now = Math.floor(clock.nowMs() / 1000);
      let left = 0;
      for (const [key, times] of await store.list<number[]>({ prefix: 'apns:' })) {
        const live = times.filter((at) => at > now - QUOTA_WINDOW_SECONDS);
        if (live.length === 0) await store.delete(key);
        else {
          left += 1;
          if (live.length !== times.length) await store.put(key, live);
        }
      }
      const keep = new Set([dayOf(now), dayOf(now - 24 * 3600)]);
      for (const key of (await store.list<number>({ prefix: 'brake:' })).keys()) {
        if (!keep.has(key.slice(key.lastIndexOf(':') + 1))) await store.delete(key);
        else left += 1;
      }
      for (const [key, admission] of await store.list<Admission>({ prefix: 'admission:' })) {
        if (admission.at <= now - ADMISSION_TTL_SECONDS) await store.delete(key);
        else left += 1;
      }
      if (left > 0) await store.setAlarm(clock.alarmAt(clock.nowMs() + PRUNE_INTERVAL_MS));
      else await store.deleteAlarm();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Denial list

export interface DenyEntry {
  readonly at: number;
  readonly until: number;
}

export interface DenyMirror {
  /** Denial in the KV mirror until `until` (epoch seconds). */
  put(endpointId: string, until: number, now: number): Promise<void>;
  delete(endpointId: string): Promise<void>;
}

export interface AdminApi {
  deny(endpointId: string): Promise<{ readonly denied: true; readonly until: number }>;
  allow(endpointId: string): Promise<{ readonly denied: false }>;
}

export class DenyBook implements AdminApi {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #mirror: DenyMirror;
  readonly #serial = new Serial();

  constructor(store: Store, clock: Clock, mirror: DenyMirror) {
    this.#store = store;
    this.#clock = clock;
    this.#mirror = mirror;
  }

  /**
   * Denial for a year from now (a repeat moves the term); the mirror first, then the state, so the hook sees it at
   * once.
   */
  deny(endpointId: string): Promise<{ readonly denied: true; readonly until: number }> {
    return this.#serial.run(async () => {
      const now = nowSec(this.#clock);
      const until = now + DENY_TTL_SECONDS;
      await this.#mirror.put(endpointId, until, now);
      await this.#store.put(`deny:${endpointId}`, { at: now, until } satisfies DenyEntry);
      if (await this.#store.getAlarm() === null) {
        await this.#store.setAlarm(this.#clock.alarmAt(this.#clock.nowMs() + PRUNE_INTERVAL_MS));
      }
      return { denied: true, until };
    });
  }

  /** Removes a denial (also a nonexistent one). */
  allow(endpointId: string): Promise<{ readonly denied: false }> {
    return this.#serial.run(async () => {
      await this.#mirror.delete(endpointId);
      await this.#store.delete(`deny:${endpointId}`);
      return { denied: false };
    });
  }

  /** Cleanup once a day: denials past their term disappear (the KV mirror expires by itself, `expirationTtl`). */
  alarm(): Promise<void> {
    return this.#serial.run(async () => {
      const now = nowSec(this.#clock);
      let left = 0;
      for (const [key, entry] of await this.#store.list<DenyEntry>({ prefix: 'deny:' })) {
        if (entry.until <= now) await this.#store.delete(key);
        else left += 1;
      }
      if (left > 0) await this.#store.setAlarm(this.#clock.alarmAt(this.#clock.nowMs() + PRUNE_INTERVAL_MS));
      else await this.#store.deleteAlarm();
    });
  }
}
