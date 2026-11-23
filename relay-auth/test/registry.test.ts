/**
 * Maszyny rejestru (`src/registry.ts`) na atrapie magazynu: kwoty, idempotencja, TTL i rezerwacje w jednym
 * harmonogramie alarmów, `renew` równolegle z rezerwacją, równoległe rezerwacje przy 2/3, rodzaj wpisu niezmienny,
 * rozliczenie bramki zakłada najwyżej jedną inkarnację, zdjęcia warunkowe na identyfikator poręczenia, odmowa żyjąca
 * dłużej niż wpis, bramka (hamulec, bity DeviceCheck, licznik APNs, porażki Apple, kolejka).
 */
import { describe, expect, it } from 'vitest';
import {
  ADMISSION_TTL_SECONDS, DENY_TTL_SECONDS, DROP_RETRY_SECONDS, ENTRY_TTL_SECONDS, EndpointBook, FORGET_REDROP_SECONDS,
  GATE_QUEUE_MAX, GateDesk, DenyBook, QUOTA_WINDOW_SECONDS, RESERVATION_TTL_SECONDS, SERVER_SPONSORS_MAX, Serial,
  bitsCount, settle,
} from '../src/registry.ts';
import type {
  AdmitOutcome, AppRecord, EndpointState, GateSettings, Ids, Peers, ServerRecord,
} from '../src/registry.ts';
import { sha256Hex } from '../src/wspolne.ts';
import {
  DAY, FakeApple, ManualClock, MemoryStore, SERVER_A, SERVER_B, T0, apnsProof, deviceCheckProof,
} from './helpers.ts';

const LIMITS = { windowMax: 3, liveMax: 5 } as const;
const server = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

/** EndpointId wpisu apki w testach maszyny wpisu. */
const SELF = 'cc'.repeat(32);
/** Pierwsza inkarnacja z generatora {@link ids}. */
const E1 = 'e1';

/** Identyfikatory po kolei: inkarnacje `e1`, `e2`, …, poręczenia `t1`, `t2`, … (zamiast losowego UUID). */
function ids(): Ids {
  const next = { epoch: 0, ticket: 0 };
  return (kind) => `${kind.charAt(0)}${String((next[kind] += 1))}`;
}

/** Wpisy po drugiej stronie alarmu: zapisane zdjęcia poręczeń; `fail` = ile następnych zdjęć ma paść. */
function peers(): { calls: string[]; fail: { count: number }; of: Peers } {
  const calls: string[] = [];
  const fail = { count: 0 };
  const of: Peers = (server) => ({
    dropSponsor: async (app, epoch, ticket) => {
      if (fail.count > 0) {
        fail.count -= 1;
        throw new Error('atrapa: wpis serwera nie odpowiada');
      }
      calls.push(`${server}:${app}:${epoch}:${ticket}`);
    },
  });
  return { calls, fail, of };
}

function book(start = T0) {
  const store = new MemoryStore();
  const clock = new ManualClock(start);
  const others = peers();
  const entry = new EndpointBook(store, clock, others.of, ids());
  let charges = 0;
  /** Wpis apki z nowego rozliczenia bramki `c1`, `c2`, … (chwila rozliczenia = teraz). */
  const admit = (): Promise<AdmitOutcome> =>
    entry.admitApp(SELF, { charge: `c${String((charges += 1))}`, at: clock.sec });
  return { store, clock, peers: others, entry, admit };
}

/** Alarm jak na platformie: zdjęty, potem handler. */
async function fire(store: MemoryStore, clock: ManualClock, alarm: () => Promise<void>): Promise<boolean> {
  if (store.alarm === null || store.alarm > clock.nowMs()) return false;
  store.alarm = null;
  await alarm();
  return true;
}

const stateOf = (store: MemoryStore): EndpointState => store.data.get('state') as EndpointState;
const appRecord = (store: MemoryStore): AppRecord => stateOf(store).entry as AppRecord;
const serverRecord = (store: MemoryStore): ServerRecord => stateOf(store).entry as ServerRecord;

describe('Serial', () => {
  it('operacje po kolei, porażka nie zatrzymuje kolejki, licznik czekających', async () => {
    const serial = new Serial();
    const order: string[] = [];
    const slow = serial.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('a');
      throw new Error('a');
    });
    const fast = serial.run(async () => { order.push('b'); return 'b'; });
    expect(serial.pending).toBe(2);
    await expect(slow).rejects.toThrow('a');
    await expect(fast).resolves.toBe('b');
    expect(order).toEqual(['a', 'b']);
    expect(serial.pending).toBe(0);
  });
});

describe('EndpointBook: wpis apki', () => {
  it('admitApp zakłada wpis z TTL 90 dni, powtórka przedłuża; alarm na termin wpisu', async () => {
    const { store, clock, entry, admit } = book();
    expect(await entry.status()).toBeNull();
    expect(await admit()).toEqual({ ok: true, expiresAt: T0 + ENTRY_TTL_SECONDS });
    expect(store.alarm).toBe((T0 + ENTRY_TTL_SECONDS) * 1000);
    clock.advance(DAY);
    expect(await admit()).toEqual({ ok: true, expiresAt: T0 + DAY + ENTRY_TTL_SECONDS });
    expect(await entry.status()).toEqual({ kind: 'app', expiresAt: T0 + DAY + ENTRY_TTL_SECONDS });
    expect(store.alarm).toBe((T0 + DAY + ENTRY_TTL_SECONDS) * 1000);
  });

  it('jedno rozliczenie bramki zakłada najwyżej jedną inkarnację; ślad zużycia przeżywa forget do końca terminu',
    async () => {
    const { store, clock, entry } = book();
    const admission = { charge: 'c1', at: T0 };
    expect(await entry.admitApp(SELF, admission)).toMatchObject({ ok: true });
    expect(appRecord(store)).toMatchObject({ epoch: E1, charge: { charge: 'c1', until: T0 + ADMISSION_TTL_SECONDS } });
    expect(await entry.admitApp(SELF, admission)).toMatchObject({ ok: true });
    expect(appRecord(store).epoch).toBe(E1);
    await entry.forget();
    expect(await entry.admitApp(SELF, admission)).toEqual({ ok: false, error: 'charge-spent' });
    expect(stateOf(store)).toEqual({ entry: null, drops: [], spent: [{ charge: 'c1', until: T0 + ADMISSION_TTL_SECONDS }] });
    expect(store.alarm).toBe((T0 + ADMISSION_TTL_SECONDS) * 1000);
    clock.advance(ADMISSION_TTL_SECONDS);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(store.data.size).toBe(0);
    // Ślad zniknął razem z terminem rozliczenia, a rozliczenie po terminie odpada samo.
    expect(await entry.admitApp(SELF, admission)).toEqual({ ok: false, error: 'charge-spent' });
    expect(await entry.admitApp(SELF, { charge: 'c2', at: clock.sec })).toMatchObject({ ok: true });
    expect(appRecord(store).epoch).toBe('e2');
    // Zegar bramki przed zegarem wpisu: ślad liczy się od późniejszej chwili.
    const ahead = book();
    await ahead.entry.admitApp(SELF, { charge: 'c9', at: T0 + 100 });
    expect(appRecord(ahead.store).charge.until).toBe(T0 + 100 + ADMISSION_TTL_SECONDS);
  });

  it('wpis po terminie nie żyje przed alarmem; alarm kasuje magazyn i sam siebie', async () => {
    const { store, clock, entry, admit } = book();
    await admit();
    clock.advance(ENTRY_TTL_SECONDS);
    expect(await entry.status()).toBeNull();
    expect(store.data.size).toBe(0);
    expect(store.alarm).toBeNull();

    await admit();
    clock.advance(ENTRY_TTL_SECONDS + 1);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(store.data.size).toBe(0);
    expect(store.alarm).toBeNull();
    expect(await entry.renew([])).toEqual({ ok: false, error: 'not-registered' });
  });

  it('renew bez wpisu = not-registered (apka idzie do register); renew przedłuża i zwraca unsponsored', async () => {
    const { entry, clock, admit } = book();
    expect(await entry.renew([SERVER_A])).toEqual({ ok: false, error: 'not-registered' });
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS);
    clock.advance(DAY);
    expect(await entry.renew([SERVER_A, SERVER_B])).toEqual({
      ok: true, epoch: E1, expiresAt: T0 + DAY + ENTRY_TTL_SECONDS,
      renewed: [{ server: SERVER_A, ticket: 't1', expiresAt: T0 + DAY + ENTRY_TTL_SECONDS }], unsponsored: [SERVER_B],
    });
  });

  it('poręczenie spoza listy renew wygasa samo w swoim terminie, wpis apki żyje dalej', async () => {
    const { store, clock, entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS);
    clock.advance(DAY);
    await entry.renew([]);
    // Najbliższy termin: poręczenie A (stare), nie wpis (przedłużony).
    expect(store.alarm).toBe((T0 + ENTRY_TTL_SECONDS) * 1000);
    clock.advance(ENTRY_TTL_SECONDS - DAY);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(appRecord(store).sponsored).toEqual([]);
    expect(store.alarm).toBe((T0 + DAY + ENTRY_TTL_SECONDS) * 1000);
  });
});

describe('EndpointBook: rezerwacje i kwota poręczeń', () => {
  it('rezerwacja: klucz idempotencji (apka, serwer) z identyfikatorem poręczenia, kwota liczona przy rezerwacji',
    async () => {
    const { store, entry, admit } = book();
    await admit();
    const term = T0 + ENTRY_TTL_SECONDS;
    expect(await entry.reserve(SERVER_A, LIMITS)).toEqual({ ok: true, epoch: E1, ticket: 't1', expiresAt: term, fresh: true });
    expect(await entry.reserve(SERVER_A, LIMITS)).toEqual({ ok: true, epoch: E1, ticket: 't1', expiresAt: term, fresh: false });
    expect(appRecord(store).starts).toEqual([T0]);
    await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS);
    expect(await entry.reserve(SERVER_A, LIMITS)).toMatchObject({ ok: true, ticket: 't1', fresh: false });
    expect(appRecord(store).starts).toEqual([T0]);
    expect(appRecord(store).reservations).toEqual([]);
  });

  it('kwota w oknie 30 dni: czwarty nowy serwer odpada, po oknie wraca', async () => {
    const { clock, entry, admit } = book();
    await admit();
    for (const n of [1, 2, 3]) {
      expect(await entry.reserve(server(n), LIMITS), String(n)).toMatchObject({ ok: true, fresh: true });
      await entry.commit(server(n), E1, `t${String(n)}`, T0 + ENTRY_TTL_SECONDS);
    }
    expect(await entry.reserve(server(4), LIMITS)).toEqual({ ok: false, error: 'quota-exceeded' });
    clock.advance(QUOTA_WINDOW_SECONDS);
    await entry.renew([server(1), server(2), server(3)]);
    expect(await entry.reserve(server(4), LIMITS)).toMatchObject({ ok: true, fresh: true });
  });

  it('żywe poręczenia i rezerwacje naraz: sufit liveMax', async () => {
    const { entry, admit } = book();
    await admit();
    const limits = { windowMax: 10, liveMax: 2 };
    await entry.reserve(server(1), limits);
    await entry.reserve(server(2), limits);
    expect(await entry.reserve(server(3), limits)).toEqual({ ok: false, error: 'quota-exceeded' });
  });

  it('rezerwacja bez dokończenia wygasa po 10 min w tym samym harmonogramie: zapis u serwera zdjęty, kwota zostaje',
    async () => {
    const { store, clock, entry, admit, peers: others } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    expect(store.alarm).toBe((T0 + RESERVATION_TTL_SECONDS) * 1000);
    clock.advance(RESERVATION_TTL_SECONDS);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(others.calls).toEqual([`${SERVER_A}:${SELF}:${E1}:t1`]);
    expect(appRecord(store).reservations).toEqual([]);
    expect(appRecord(store).starts).toEqual([T0]);
    expect(stateOf(store).drops).toEqual([]);
    expect(store.alarm).toBe((T0 + ENTRY_TTL_SECONDS) * 1000);
    // Powtórka po wygaśnięciu rezerwacji to nowe poręczenie: druga jednostka kwoty i nowy identyfikator.
    expect(await entry.reserve(SERVER_A, LIMITS)).toMatchObject({ ok: true, ticket: 't2', fresh: true });
    expect(appRecord(store).starts).toEqual([T0, T0 + RESERVATION_TTL_SECONDS]);
  });

  it('wygasła rezerwacja przechodzi do zdjęć przy pierwszym zapisie po terminie, także bez alarmu', async () => {
    const { store, clock, entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    clock.advance(RESERVATION_TTL_SECONDS);
    expect(await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS)).toEqual({ ok: false, error: 'not-registered' });
    expect(stateOf(store).drops).toEqual([
      { server: SERVER_A, ticket: 't1', app: SELF, epoch: E1, dueAt: T0 + RESERVATION_TTL_SECONDS },
    ]);
    expect(appRecord(store)).toMatchObject({ sponsored: [], reservations: [] });
    expect(store.alarm).toBe((T0 + RESERVATION_TTL_SECONDS) * 1000);
  });

  it('wpis wygasa z żywą rezerwacją: rezerwacja przechodzi do zdjęć z własnym terminem', async () => {
    const { store, clock, entry, admit, peers: others } = book();
    await admit();
    clock.advance(ENTRY_TTL_SECONDS - 60);
    await entry.reserve(SERVER_A, LIMITS);
    clock.advance(60);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    const dueAt = T0 + ENTRY_TTL_SECONDS - 60 + RESERVATION_TTL_SECONDS;
    expect(stateOf(store)).toMatchObject({ entry: null, drops: [{ server: SERVER_A, ticket: 't1', dueAt }] });
    expect(others.calls).toEqual([]);
    clock.advance(RESERVATION_TTL_SECONDS - 60);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(others.calls).toEqual([`${SERVER_A}:${SELF}:${E1}:t1`]);
    expect(store.data.size).toBe(0);
  });

  it('cancel zdejmuje rezerwację razem z jej jednostką kwoty; cancel bez tej rezerwacji nic nie zmienia', async () => {
    const { store, entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.cancel(SERVER_A, E1, 't9');
    expect(appRecord(store)).toMatchObject({ reservations: [{ server: SERVER_A }], starts: [T0] });
    await entry.cancel(SERVER_A, E1, 't1');
    expect(appRecord(store)).toMatchObject({ reservations: [], starts: [] });
    await entry.cancel(SERVER_B, E1, 't1');
    expect(appRecord(store)).toMatchObject({ reservations: [], starts: [] });
  });

  it('dwie próby z jedną rezerwacją: cancel jednej zdejmuje tylko próbę, zwrot kwoty dopiero po obu', async () => {
    const { store, entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.reserve(SERVER_A, LIMITS);
    expect(appRecord(store).reservations).toMatchObject([{ ticket: 't1', attempts: 2 }]);
    await entry.cancel(SERVER_A, E1, 't1');
    expect(appRecord(store)).toMatchObject({ reservations: [{ ticket: 't1', attempts: 1 }], starts: [T0] });
    await entry.cancel(SERVER_A, E1, 't1');
    expect(appRecord(store)).toMatchObject({ reservations: [], starts: [] });
  });

  it('powtórka rezerwacji: pełne 10 min od tej próby i termin roszczenia najdalszy z oddanych; commit go bierze',
    async () => {
    const { store, clock, entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    clock.advance(300);
    expect(await entry.reserve(SERVER_A, LIMITS)).toMatchObject({ ticket: 't1', expiresAt: T0 + 300 + ENTRY_TTL_SECONDS });
    expect(appRecord(store).reservations).toMatchObject([
      { expiresAt: T0 + 300 + RESERVATION_TTL_SECONDS, term: T0 + 300 + ENTRY_TTL_SECONDS, attempts: 2 },
    ]);
    // Pierwsza próba kończy ze swoim (wcześniejszym) terminem: poręczenie dostaje termin drugiej.
    expect(await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS))
      .toEqual({ ok: true, expiresAt: T0 + 300 + ENTRY_TTL_SECONDS });
    expect(appRecord(store)).toMatchObject({
      expiresAt: T0 + 300 + ENTRY_TTL_SECONDS,
      sponsored: [{ server: SERVER_A, ticket: 't1', expiresAt: T0 + 300 + ENTRY_TTL_SECONDS }],
    });
  });

  it('powtórka żywego poręczenia zapisuje przedłużenie u apki, zanim rdzeń zapisze je u serwera', async () => {
    const { store, clock, entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS);
    clock.advance(ENTRY_TTL_SECONDS - 1);
    const term = T0 + 2 * ENTRY_TTL_SECONDS - 1;
    expect(await entry.reserve(SERVER_A, LIMITS)).toEqual({ ok: true, epoch: E1, ticket: 't1', expiresAt: term, fresh: false });
    expect(appRecord(store)).toMatchObject({ expiresAt: term, sponsored: [{ ticket: 't1', expiresAt: term }] });
    expect(store.alarm).toBe(term * 1000);
  });

  it('wpis kończy się przed swoim poręczeniem: poręczenie przechodzi do zdjęć jak rezerwacja', () => {
    const record: AppRecord = {
      kind: 'app', id: SELF, epoch: E1, charge: { charge: 'c1', until: T0 }, expiresAt: T0 + 10,
      sponsored: [{ server: SERVER_A, ticket: 't1', expiresAt: T0 + 20 }, { server: SERVER_B, ticket: 't2', expiresAt: T0 + 5 }],
      reservations: [], starts: [],
    };
    expect(settle({ entry: record, drops: [], spent: [] }, T0 + 10)).toEqual({
      state: { entry: null, drops: [{ server: SERVER_A, ticket: 't1', app: SELF, epoch: E1, dueAt: T0 + 10 }], spent: [] },
      changed: true,
    });
  });

  it('renew równolegle z rezerwacją: żaden zapis nie ginie', async () => {
    const { store, entry, clock, admit } = book();
    await admit();
    clock.advance(DAY);
    const [renewed, reserved] = await Promise.all([entry.renew([SERVER_B]), entry.reserve(SERVER_A, LIMITS)]);
    expect(renewed).toMatchObject({ ok: true, expiresAt: T0 + DAY + ENTRY_TTL_SECONDS });
    expect(reserved).toMatchObject({ ok: true, fresh: true });
    expect(appRecord(store)).toMatchObject({
      expiresAt: T0 + DAY + ENTRY_TTL_SECONDS, reservations: [{ server: SERVER_A }], starts: [T0 + DAY],
    });
  });

  it('równoległe rezerwacje różnych serwerów przy kwocie 2/3: przechodzi dokładnie jedna', async () => {
    const { store, entry, admit } = book();
    await admit();
    for (const n of [1, 2]) {
      await entry.reserve(server(n), LIMITS);
      await entry.commit(server(n), E1, `t${String(n)}`, T0 + ENTRY_TTL_SECONDS);
    }
    const results = await Promise.all([3, 4, 5].map((n) => entry.reserve(server(n), LIMITS)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'quota-exceeded' }, { ok: false, error: 'quota-exceeded' },
    ]);
    expect(appRecord(store).starts).toHaveLength(3);
  });

  it('commit przedłuża wpis apki do terminu poręczenia; bez wpisu, w innej inkarnacji albo z cudzym poręczeniem nie',
    async () => {
    const { store, entry, clock, admit } = book();
    expect(await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS)).toEqual({ ok: false, error: 'not-registered' });
    await admit();
    expect(await entry.commit(SERVER_A, 'e9', 't1', T0 + ENTRY_TTL_SECONDS)).toEqual({ ok: false, error: 'not-registered' });
    clock.advance(DAY);
    await entry.reserve(SERVER_A, LIMITS);
    expect(await entry.commit(SERVER_A, E1, 't9', T0 + ENTRY_TTL_SECONDS)).toEqual({ ok: false, error: 'not-registered' });
    expect(await entry.commit(SERVER_A, E1, 't1', T0 + DAY + ENTRY_TTL_SECONDS)).toEqual({
      ok: true, expiresAt: T0 + DAY + ENTRY_TTL_SECONDS,
    });
    expect(appRecord(store).expiresAt).toBe(T0 + DAY + ENTRY_TTL_SECONDS);
    expect(appRecord(store).sponsored).toEqual([{ server: SERVER_A, ticket: 't1', expiresAt: T0 + DAY + ENTRY_TTL_SECONDS }]);
  });

  it('forget: ślad zdjęć jednym zapisem z usunięciem wpisu, ponowienie dostaje ten sam ślad; brak wpisu = sukces',
    async () => {
    const { store, clock, entry, admit, peers: others } = book();
    expect(await entry.forget()).toEqual({ ok: true, drops: [] });
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS);
    await entry.reserve(SERVER_B, LIMITS);
    const dueAt = T0 + FORGET_REDROP_SECONDS;
    const drops = [
      { server: SERVER_A, ticket: 't1', app: SELF, epoch: E1, dueAt },
      { server: SERVER_B, ticket: 't2', app: SELF, epoch: E1, dueAt },
    ];
    expect(await entry.forget()).toEqual({ ok: true, drops });
    expect(await entry.status()).toBeNull();
    expect(await entry.forget()).toEqual({ ok: true, drops });
    expect([...store.data.keys()]).toEqual(['state']);
    expect(stateOf(store)).toEqual({ entry: null, drops, spent: [{ charge: 'c1', until: T0 + ADMISSION_TTL_SECONDS }] });
    expect(store.alarm).toBe((T0 + FORGET_REDROP_SECONDS) * 1000);
    // Drugie zdjęcie w terminie: jedno pada, wraca po DROP_RETRY_SECONDS, potem ślad znika razem z magazynem.
    others.fail.count = 1;
    clock.advance(FORGET_REDROP_SECONDS);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(others.calls).toEqual([`${SERVER_B}:${SELF}:${E1}:t2`]);
    expect(store.alarm).toBe((T0 + FORGET_REDROP_SECONDS + DROP_RETRY_SECONDS) * 1000);
    clock.advance(DROP_RETRY_SECONDS);
    expect(await fire(store, clock, () => entry.alarm())).toBe(true);
    expect(others.calls).toEqual([`${SERVER_B}:${SELF}:${E1}:t2`, `${SERVER_A}:${SELF}:${E1}:t1`]);
    expect(store.data.size).toBe(0);
    expect(store.alarm).toBeNull();
  });

  it('nowa inkarnacja po forget: inny epoch, commit i orphans starej inkarnacji nie przechodzą', async () => {
    const { entry, admit } = book();
    await admit();
    await entry.reserve(SERVER_A, LIMITS);
    await entry.forget();
    await admit();
    expect(await entry.reserve(SERVER_B, LIMITS)).toMatchObject({ ok: true, epoch: 'e2', ticket: 't2' });
    expect(await entry.commit(SERVER_A, E1, 't1', T0 + ENTRY_TTL_SECONDS)).toEqual({ ok: false, error: 'not-registered' });
    const b = { server: SERVER_B, ticket: 't2' };
    expect(await entry.orphans(E1, [b])).toEqual([b]);
    const stale = [{ server: SERVER_A, ticket: 't1' }, b, { server: SERVER_B, ticket: 't9' }];
    expect(await entry.orphans('e2', stale)).toEqual([{ server: SERVER_A, ticket: 't1' }, { server: SERVER_B, ticket: 't9' }]);
  });

  it('extendApp przedłuża tylko żywy wpis apki: bez wpisu not-registered, wpis serwera kind-conflict', async () => {
    const { clock, entry, admit } = book();
    expect(await entry.extendApp()).toEqual({ ok: false, error: 'not-registered' });
    await admit();
    clock.advance(DAY);
    expect(await entry.extendApp()).toEqual({ ok: true, expiresAt: T0 + DAY + ENTRY_TTL_SECONDS });
    const srv = book();
    await srv.entry.addSponsor(SELF, E1, 't1', T0 + 100);
    expect(await srv.entry.extendApp()).toEqual({ ok: false, error: 'kind-conflict' });
  });
});

describe('EndpointBook: wpis serwera i rodzaj niezmienny', () => {
  it('addSponsor zakłada wpis serwera, ten sam ticket nie skraca; status = najdalszy termin; ostatni dropSponsor kasuje',
    async () => {
    const { store, entry } = book();
    expect(await entry.addSponsor('aa'.repeat(32), E1, 't1', T0 + 100)).toEqual({ ok: true });
    expect(await entry.addSponsor('bb'.repeat(32), E1, 't2', T0 + 200)).toEqual({ ok: true });
    // Ten sam `ticket` z krótszym terminem (spóźniony zapis wcześniejszej próby) nie skraca poręczenia.
    expect(await entry.addSponsor('aa'.repeat(32), E1, 't1', T0 + 50)).toEqual({ ok: true });
    expect(store.alarm).toBe((T0 + 100) * 1000);
    // Inne poręczenie tej samej inkarnacji zastępuje poprzednie, także z krótszym terminem.
    expect(await entry.addSponsor('aa'.repeat(32), E1, 't3', T0 + 50)).toEqual({ ok: true });
    expect(await entry.status()).toEqual({ kind: 'server', expiresAt: T0 + 200, sponsors: ['bb'.repeat(32), 'aa'.repeat(32)] });
    expect(store.alarm).toBe((T0 + 50) * 1000);
    await entry.dropSponsor('aa'.repeat(32), E1, 't3');
    expect(serverRecord(store).sponsors).toEqual([{ app: 'bb'.repeat(32), epoch: E1, ticket: 't2', expiresAt: T0 + 200 }]);
    await entry.dropSponsor('bb'.repeat(32), E1, 't2');
    expect(store.data.size).toBe(0);
    expect(store.alarm).toBeNull();
  });

  it('wpis serwera żyje, póki żyje choć jedno poręczenie; po ostatnim alarm go kasuje', async () => {
    const { store, clock, entry } = book();
    await entry.addSponsor('aa'.repeat(32), E1, 't1', T0 + 100);
    await entry.addSponsor('bb'.repeat(32), E1, 't2', T0 + 200);
    clock.advance(100);
    await fire(store, clock, () => entry.alarm());
    expect(await entry.status()).toEqual({ kind: 'server', expiresAt: T0 + 200, sponsors: ['bb'.repeat(32)] });
    clock.advance(100);
    await fire(store, clock, () => entry.alarm());
    expect(store.data.size).toBe(0);
  });

  it('rodzaj niezmienny, póki wpis żyje: serwer nie staje się apką i odwrotnie; po wygaśnięciu wolno', async () => {
    const app = book();
    await app.admit();
    expect(await app.entry.addSponsor('aa'.repeat(32), E1, 't1', T0 + 100)).toEqual({ ok: false, error: 'kind-conflict' });

    const srv = book();
    await srv.entry.addSponsor('aa'.repeat(32), E1, 't1', T0 + 100);
    expect(await srv.admit()).toEqual({ ok: false, error: 'kind-conflict' });
    expect(await srv.entry.renew([])).toEqual({ ok: false, error: 'kind-conflict' });
    expect(await srv.entry.reserve(SERVER_A, LIMITS)).toEqual({ ok: false, error: 'kind-conflict' });
    expect(await srv.entry.forget()).toEqual({ ok: false, error: 'kind-conflict' });
    srv.clock.advance(100);
    expect(await srv.admit()).toMatchObject({ ok: true });
  });

  it('zdjęcie warunkowe: tylko swoja inkarnacja i swoje poręczenie; nowsze poręczenie tej inkarnacji zostaje',
    async () => {
    const { store, entry } = book();
    await entry.addSponsor(SELF, E1, 't1', T0 + 100);
    await entry.addSponsor(SELF, 'e2', 't2', T0 + 200);
    await entry.dropSponsor(SELF, E1, 't9');
    await entry.dropSponsor(SELF, E1, 't1');
    expect(serverRecord(store).sponsors).toEqual([{ app: SELF, epoch: 'e2', ticket: 't2', expiresAt: T0 + 200 }]);
    // Nowsze poręczenie tej samej inkarnacji zastępuje starsze; spóźnione zdjęcie starszego go nie rusza.
    await entry.addSponsor(SELF, 'e2', 't3', T0 + 300);
    await entry.dropSponsor(SELF, 'e2', 't2');
    expect(serverRecord(store).sponsors).toEqual([{ app: SELF, epoch: 'e2', ticket: 't3', expiresAt: T0 + 300 }]);
  });

  it('sufit poręczeń jednego serwera', async () => {
    const { entry } = book();
    for (let n = 0; n < SERVER_SPONSORS_MAX; n += 1) await entry.addSponsor(server(n), E1, 't1', T0 + 100);
    expect(await entry.addSponsor(server(200), E1, 't1', T0 + 100)).toEqual({ ok: false, error: 'quota-exceeded' });
    expect(await entry.addSponsor(server(0), E1, 't1', T0 + 300)).toEqual({ ok: true });
  });
});

const GATE_SETTINGS: GateSettings = { gate: 'devicecheck', registerMonthly: 3, registerDailyBrake: 200, graceUntil: null };

function desk(settings: Partial<GateSettings> = {}, start = T0) {
  const clock = new ManualClock(start);
  const store = new MemoryStore();
  const apple = new FakeApple(clock);
  const books = new Map<string, EndpointBook>();
  const endpoint = (id: string): EndpointBook => {
    let entry = books.get(id);
    if (entry === undefined) {
      entry = new EndpointBook(new MemoryStore(), clock, endpoint);
      books.set(id, entry);
    }
    return entry;
  };
  const gate = new GateDesk({ store, clock, settings: { ...GATE_SETTINGS, ...settings }, apple, endpoint, sha256Hex });
  return { clock, store, apple, endpoint, gate };
}

const id = (n: number): string => server(n);

describe('GateDesk: rejestracja przez DeviceCheck', () => {
  it('nowy EndpointId: query, update bitów 0→1, wpis apki; powtórka bez Apple i bez kwoty', async () => {
    const { apple, gate, endpoint } = desk();
    const proof = deviceCheckProof('A');
    expect(await gate.register(id(1), proof)).toEqual({ ok: true, expiresAt: T0 + ENTRY_TTL_SECONDS, fresh: true });
    expect(apple.calls.map((call) => call.call)).toEqual(['query', 'update']);
    expect(apple.bits.get(proof.token)).toEqual({ bit0: true, bit1: false, lastUpdate: '2026-11' });
    expect(await endpoint(id(1)).status()).toMatchObject({ kind: 'app' });
    expect(await gate.register(id(1), proof)).toEqual({ ok: true, expiresAt: T0 + ENTRY_TTL_SECONDS, fresh: false });
    expect(apple.calls).toHaveLength(2);
  });

  it('równoległe rejestracje tego samego EndpointId: jedna rozmowa z Apple, jedna jednostka kwoty', async () => {
    const { apple, gate } = desk();
    const proof = deviceCheckProof('A');
    const results = await Promise.all(Array.from({ length: 5 }, () => gate.register(id(1), proof)));
    expect(results.filter((result) => result.ok && result.fresh)).toHaveLength(1);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(apple.count('update')).toBe(1);
  });

  it('kwota urządzenia w miesiącu: licznik w dwóch bitach do 3, czwarty EndpointId odpada', async () => {
    const { apple, gate } = desk();
    const proof = deviceCheckProof('A');
    for (const n of [1, 2, 3]) expect(await gate.register(id(n), proof), String(n)).toMatchObject({ ok: true, fresh: true });
    expect(apple.bits.get(proof.token)).toMatchObject({ bit0: true, bit1: true });
    expect(await gate.register(id(4), proof)).toEqual({ ok: false, error: 'quota-exceeded' });
    expect(apple.count('update')).toBe(3);
  });

  it('bity z poprzedniego miesiąca liczą się jak zero; okres łaski ignoruje wyczerpane bity', async () => {
    expect(bitsCount({ bit0: true, bit1: true, lastUpdate: '2026-10' }, T0)).toBe(0);
    expect(bitsCount({ bit0: false, bit1: true, lastUpdate: '2026-11' }, T0)).toBe(2);
    expect(bitsCount(null, T0)).toBe(0);

    const grace = desk({ graceUntil: T0 + 1 });
    const proof = deviceCheckProof('B');
    grace.apple.bits.set(proof.token, { bit0: true, bit1: true, lastUpdate: '2026-11' });
    expect(await grace.gate.register(id(1), proof)).toMatchObject({ ok: true, fresh: true });
    grace.clock.advance(1);
    expect(await grace.gate.register(id(2), proof)).toEqual({ ok: false, error: 'quota-exceeded' });
  });

  it('kwota 1 z REGISTER_MONTHLY_QUOTA', async () => {
    const { gate } = desk({ registerMonthly: 1 });
    expect(await gate.register(id(1), deviceCheckProof('A'))).toMatchObject({ ok: true });
    expect(await gate.register(id(2), deviceCheckProof('A'))).toEqual({ ok: false, error: 'quota-exceeded' });
  });

  it('porażki Apple: odrzucony dowód, Apple niedostępny, Apple odmawia kluczowi; wpis nie powstaje', async () => {
    const { apple, gate, endpoint } = desk();
    const proof = deviceCheckProof('A');
    apple.failNext.set('query', { kind: 'rejected', status: 400 });
    expect(await gate.register(id(1), proof)).toEqual({
      ok: false, error: 'proof-rejected', apple: { kind: 'rejected', status: 400 },
    });
    apple.failNext.set('query', { kind: 'unreachable', cause: 'timeout' });
    expect(await gate.register(id(1), proof)).toMatchObject({ ok: false, error: 'gate-unreachable' });
    apple.failNext.set('update', { kind: 'refused', status: 401 });
    expect(await gate.register(id(1), proof)).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await endpoint(id(1)).status()).toBeNull();
  });

  it('hamulec dobowy bramki; nowa doba UTC zaczyna od zera; alarm porządków kasuje stare dni', async () => {
    const { clock, store, gate } = desk({ registerDailyBrake: 2 });
    expect(await gate.register(id(1), deviceCheckProof('A'))).toMatchObject({ ok: true });
    expect(await gate.register(id(2), deviceCheckProof('B'))).toMatchObject({ ok: true });
    expect(await gate.register(id(3), deviceCheckProof('C'))).toEqual({ ok: false, error: 'limited' });
    expect(store.alarm).toBe((T0 + DAY) * 1000);
    clock.advance(DAY);
    expect(await gate.register(id(3), deviceCheckProof('C'))).toMatchObject({ ok: true });
    clock.advance(2 * DAY);
    expect(await fire(store, clock, () => gate.alarm())).toBe(true);
    expect([...store.data.keys()]).toEqual([]);
    expect(store.alarm).toBeNull();
  });

  it('bramka nie wybrana albo bez klucza = unavailable; dowód innego rodzaju = gate-mismatch', async () => {
    expect(await desk({ gate: null }).gate.register(id(1), deviceCheckProof('A')))
      .toEqual({ ok: false, error: 'unavailable' });
    expect(await desk().gate.register(id(1), apnsProof('ab'))).toEqual({ ok: false, error: 'gate-mismatch' });
    const clock = new ManualClock(T0);
    const keyless = new GateDesk({
      store: new MemoryStore(), clock, settings: GATE_SETTINGS, apple: null,
      endpoint: () => new EndpointBook(new MemoryStore(), clock, peers().of), sha256Hex,
    });
    expect(await keyless.register(id(1), deviceCheckProof('A'))).toEqual({ ok: false, error: 'unavailable' });
  });

  it('EndpointId z żywym wpisem serwera = kind-conflict, bez Apple', async () => {
    const { apple, gate, endpoint } = desk();
    await endpoint(id(1)).addSponsor(id(9), E1, 't1', T0 + 100);
    expect(await gate.register(id(1), deviceCheckProof('A'))).toEqual({ ok: false, error: 'kind-conflict' });
    expect(apple.calls).toEqual([]);
  });

  it('kolejka bramki ma sufit: nadmiar dostaje unavailable od razu', async () => {
    const { gate } = desk({ registerDailyBrake: 1000 });
    const results = await Promise.all(Array.from({ length: GATE_QUEUE_MAX + 3 }, (_unused, n) =>
      gate.register(id(n + 1), deviceCheckProof(String.fromCharCode(65 + (n % 26))))));
    expect(results.filter((result) => !result.ok && result.error === 'unavailable')).toHaveLength(3);
  });
});

describe('GateDesk: rejestracja przez próbny push APNs', () => {
  it('kwota per skrót tokenu w 30 dniach, wielkość liter tokenu bez znaczenia; skrót, nie token, w kluczu', async () => {
    const { clock, store, apple, gate } = desk({ gate: 'apns' });
    const proof = apnsProof('ab');
    expect(await gate.register(id(1), proof)).toMatchObject({ ok: true, fresh: true });
    expect(await gate.register(id(2), { ...proof, token: proof.token.toUpperCase() })).toMatchObject({ ok: true });
    expect(await gate.register(id(3), proof)).toMatchObject({ ok: true });
    expect(await gate.register(id(4), proof)).toEqual({ ok: false, error: 'quota-exceeded' });
    expect(apple.calls.map((call) => [call.call, call.token])).toEqual(Array(3).fill(['probe', proof.token]));
    const keys = [...store.data.keys()];
    expect(keys).toContain(`apns:${await sha256Hex(proof.token)}`);
    expect(keys.join()).not.toContain(proof.token);
    clock.advance(QUOTA_WINDOW_SECONDS);
    expect(await gate.register(id(4), proof)).toMatchObject({ ok: true });
  });

  it('martwy token = proof-rejected i bez jednostki kwoty', async () => {
    const { store, apple, gate } = desk({ gate: 'apns' });
    apple.failNext.set('probe', { kind: 'rejected', status: 410, reason: 'Unregistered' });
    expect(await gate.register(id(1), apnsProof('cd'))).toMatchObject({ ok: false, error: 'proof-rejected' });
    expect([...store.data.keys()]).toEqual([]);
  });

  it('alarm porządków: liczniki starsze niż okno znikają, żywe zostają', async () => {
    const { clock, store, gate } = desk({ gate: 'apns' });
    await gate.register(id(1), apnsProof('ab'));
    clock.advance(QUOTA_WINDOW_SECONDS - DAY);
    await gate.register(id(2), apnsProof('cd'));
    clock.advance(DAY + 1);
    expect(await fire(store, clock, () => gate.alarm())).toBe(true);
    expect([...store.data.keys()].filter((key) => key.startsWith('apns:'))).toEqual([
      `apns:${await sha256Hex(apnsProof('cd').token)}`,
    ]);
    expect(store.alarm).not.toBeNull();
  });
});

describe('DenyBook: lista odmów', () => {
  function denyBook() {
    const clock = new ManualClock(T0);
    const store = new MemoryStore();
    const mirror = new Map<string, number>();
    const calls: string[] = [];
    const deny = new DenyBook(store, clock, {
      put: async (endpointId, until) => { calls.push('mirror.put'); mirror.set(endpointId, until); },
      delete: async (endpointId) => { calls.push('mirror.delete'); mirror.delete(endpointId); },
    });
    return { clock, store, mirror, calls, deny };
  }

  it('odmowa na rok: najpierw lustro, potem stan; powtórka przesuwa termin', async () => {
    const { clock, store, mirror, calls, deny } = denyBook();
    expect(await deny.deny(SERVER_B)).toEqual({ denied: true, until: T0 + DENY_TTL_SECONDS });
    expect(calls).toEqual(['mirror.put']);
    expect(mirror.get(SERVER_B)).toBe(T0 + DENY_TTL_SECONDS);
    expect(store.data.get(`deny:${SERVER_B}`)).toEqual({ at: T0, until: T0 + DENY_TTL_SECONDS });
    clock.advance(DAY);
    expect(await deny.deny(SERVER_B)).toEqual({ denied: true, until: T0 + DAY + DENY_TTL_SECONDS });
  });

  it('odmowa żyje dłużej niż wpis (90 dni): alarm dobowy zostawia ją do końca roku', async () => {
    const { clock, store, deny } = denyBook();
    await deny.deny(SERVER_B);
    for (let day = 0; day < 100; day += 1) {
      clock.advance(DAY);
      await fire(store, clock, () => deny.alarm());
    }
    expect(store.data.has(`deny:${SERVER_B}`)).toBe(true);
    clock.advance(DENY_TTL_SECONDS);
    await fire(store, clock, () => deny.alarm());
    expect(store.data.size).toBe(0);
    expect(store.alarm).toBeNull();
  });

  it('allow zdejmuje odmowę z lustra i stanu; nieistniejąca odmowa to też sukces', async () => {
    const { store, mirror, deny } = denyBook();
    await deny.deny(SERVER_B);
    expect(await deny.allow(SERVER_B)).toEqual({ denied: false });
    expect(mirror.size).toBe(0);
    expect(store.data.size).toBe(0);
    expect(await deny.allow(SERVER_A)).toEqual({ denied: false });
  });
});
