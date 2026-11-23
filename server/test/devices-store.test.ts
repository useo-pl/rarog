/**
 * Magazyn kluczy urządzeń — `server/src/auth/devices-store.ts` na prawdziwym
 * dysku w katalogu tymczasowym (nigdy `~/.local/share/rarog`).
 *
 * Sprawdza politykę pliku z poświadczeniami: `0o600`, tmp+rename, `version: 1`, trwały `serverId`, kopia
 * `.bak` z poprzednią wersją, nagrobki z `revokedAt`/`revokedBy` (odpięte urządzenie nie wstaje z kopii),
 * oba pliki nieczytelne = pusty magazyn ze stanem `broken` i bez nadpisania przy starcie, `creator` po
 * restarcie, wygasanie sierot (10 min) i nieużywanych kluczy (30 dni), `lastSeenAt` najwyżej raz na minutę
 * i epokę `RAROG_AUTH_EPOCH` jako wyłącznik wszystkich urządzeń. Plik nowszego formatu: magazyn,
 * `rarog serve --check` i start `rarog serve` odmawiają, oba pliki zostają bajt w bajt te same. Odpięcie
 * z potomkami: łańcuch `creator` przez rekordy aktywne i nagrobki, nagrobki na łańcuchu do aktywnego
 * urządzenia przeżywają przycinanie.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_DEVICES_FILENAME, DEVICES_FILENAME, DEVICE_IDLE_EXPIRY_MS, DEVICE_ORPHAN_MS, DEVICE_TOMBSTONES_MAX, DevicesFormatError, checkDevice,
  createDeviceStore, createPairing, deviceAuthorization, pushKeyId,
} from '../src/auth/index.ts';
import type { DeviceDeactivation, DeviceRecord, DeviceStore, DeviceStoreOptions } from '../src/auth/index.ts';
import type { CliIo } from '../src/cli/io.ts';
import { main } from '../src/cli/main.ts';

const T0 = Date.parse('2026-10-21T08:00:00.000Z');
const EPOCH = '1';

let dir = '';
let clock = T0;
let logs: string[] = [];
/** Otwarte magazyny — ich zapisy w tle kończą się PRZED sprzątnięciem katalogu (inaczej `mkdir` go odtworzy). */
let opened: DeviceStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'p2-mag-'));
  clock = T0;
  logs = [];
  opened = [];
});
afterEach(async () => {
  await Promise.all(opened.map((store) => store.flush()));
  rmSync(dir, { recursive: true, force: true });
});

const open = (extra: Partial<DeviceStoreOptions> = {}): DeviceStore => {
  const store = createDeviceStore({
    dataDir: dir, epoch: EPOCH, now: () => clock, log: (line) => { logs.push(line); }, ...extra,
  });
  opened.push(store);
  return store;
};
const file = (): string => path.join(dir, DEVICES_FILENAME);
const read = (name = DEVICES_FILENAME): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;

/** Paruje jedno urządzenie kodem `admin` (albo od twórcy) i zapisuje; oddaje id i nagłówek. */
async function pairOne(store: DeviceStore, label = 'iPhone·Rarog', creator = 'admin'):
  Promise<{ id: string; header: string }> {
  const pairing = createPairing({ store, epoch: EPOCH, now: () => clock });
  const issued = pairing.issue(creator);
  const result = pairing.redeem({ code: issued.code, label });
  if (!result.ok) throw new Error('parowanie nie przeszło');
  await store.persist();
  return { id: result.record.id, header: deviceAuthorization(result.record.id, result.secret) };
}

describe('plik: prawa, format, serverId', () => {
  it('pierwszy start zakłada plik od razu: version 1, trwały serverId, 0o600, bez śmieci po tmp', async () => {
    const store = open();
    await store.flush();
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const body = read();
    expect(body).toEqual({ version: 1, serverId: store.serverId, devices: [], revoked: [] });
    expect(store.serverId).toMatch(/^[0-9a-f]{32}$/);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Restart: ten sam serverId (apka kluczuje nim Keychain i dane).
    expect(open().serverId).toBe(store.serverId);
  });

  it('rekord na dysku ma skrót sekretu i klucz push, NIGDY sam sekret; `kid` = sha256 bajtów klucza', async () => {
    const store = open();
    const pairing = createPairing({ store, epoch: EPOCH, now: () => clock });
    const issued = pairing.issue('admin');
    const result = pairing.redeem({ code: issued.code, label: 'iPhone·Rarog', build: '1700' });
    if (!result.ok) throw new Error('parowanie');
    await store.persist();
    const text = readFileSync(file(), 'utf8');
    expect(text).not.toContain(result.secret);
    expect(text).not.toContain(issued.code);
    const [record] = read()['devices'] as Record<string, unknown>[];
    expect(record).toMatchObject({
      id: result.record.id, label: 'iPhone·Rarog', build: '1700', lastSeenAt: null, epoch: EPOCH, creator: 'admin',
      kid: pushKeyId(result.record.pushKey),
    });
    expect(record?.['secretHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('plik z inną wersją formatu jest nieczytelny dla tego serwera; wadliwy pojedynczy rekord odpada', async () => {
    const store = open();
    const good = await pairOne(store);
    const body = read();
    const devices = body['devices'] as Record<string, unknown>[];
    writeFileSync(file(), JSON.stringify({ ...body, devices: [...devices, { id: 'zly', label: 'x' }] }));
    const reloaded = open();
    expect(reloaded.active().map((r) => r.id)).toEqual([good.id]);
    // Wersja niższa albo nie-liczba to plik uszkodzony; wyższą (nowszy serwer) obsługuje opis niżej.
    for (const version of [0, '1', null]) {
      writeFileSync(file(), JSON.stringify({ ...body, version }));
      rmSync(`${file()}.bak`, { force: true });
      const other = open();
      expect(other.status, String(version)).toBe('broken');
      expect(other.active()).toEqual([]);
      await other.flush();
    }
  });
});

describe('plik nowszego formatu: ani start, ani `serve --check` go nie nadpisują', () => {
  // `serve` below runs the plain demo (it needs no owner config), and the plain demo reads `devices.demo.json`.
  const demoFile = (): string => path.join(dir, DEMO_DEVICES_FILENAME);
  const openDemo = (): DeviceStore => open({ fileName: DEMO_DEVICES_FILENAME });
  const bak = (): string => `${demoFile()}.bak`;
  const bytes = (target: string): Buffer => readFileSync(target);

  /** Plik główny z jednym urządzeniem; oddaje jego treść w formacie `version`. */
  async function oneDevice(version: number): Promise<string> {
    const store = openDemo();
    await pairOne(store);
    await store.flush();
    return JSON.stringify({ ...read(DEMO_DEVICES_FILENAME), version }, null, 2);
  }

  /**
   * `rarog serve --check` albo start w trybie demo na katalogu danych testu; dom tymczasowy, więc bez
   * `config.json` właściciela. Start: `process.execve` podmieniony, liczy wywołania zamiast zamieniać proces.
   */
  async function serve(mode: 'check' | 'start'): Promise<{ code: number; stderr: string; execs: number }> {
    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    let stderr = '';
    const io: CliIo = {
      stdout: () => {}, stderr: (text) => { stderr += text; }, cwd: home,
      env: { PATH: process.env['PATH'], HOME: home, XDG_DATA_HOME: path.join(home, 'xdg') },
    };
    const argv = ['serve', ...(mode === 'check' ? ['--check'] : []), '--data-dir', dir, '--env', 'RAROG_DEMO=1'];
    let execs = 0;
    const saved = Object.getOwnPropertyDescriptor(process, 'execve');
    const cwd = process.cwd();
    Object.defineProperty(process, 'execve', {
      value: () => { execs += 1; }, configurable: true, writable: true,
    });
    try {
      const code = await main(argv, io);
      return { code, stderr, execs };
    } finally {
      if (saved !== undefined) Object.defineProperty(process, 'execve', saved);
      process.chdir(cwd);
    }
  }

  /** Odmowa startu magazynu, `--check` i startu `rarog serve`; zdanie podaje plik, jego wersję i wersję znaną. */
  async function refusedEverywhere(newer: string): Promise<void> {
    expect(() => openDemo()).toThrow(DevicesFormatError);
    expect(() => openDemo()).toThrow(`${newer}: format version 2; this rarog version knows only 1`);
    for (const mode of ['check', 'start'] as const) {
      const result = await serve(mode);
      expect(result.code, mode).toBe(1);
      expect(result.stderr, mode).toContain(`${newer}: format version 2; this rarog version knows only 1`);
      expect(result.execs, mode).toBe(0);
    }
  }

  it('`devices.json` z `version: 2` i jednym urządzeniem → odmowa, plik bajt w bajt ten sam, bez `.bak`', async () => {
    writeFileSync(demoFile(), await oneDevice(2));
    rmSync(bak(), { force: true });
    const before = bytes(demoFile());
    await refusedEverywhere(demoFile());
    expect(bytes(demoFile())).toEqual(before);
    expect(existsSync(bak())).toBe(false);
  });

  it('plik główny `version: 2`, kopia `version: 1` → odmowa, oba pliki nietknięte', async () => {
    const newer = await oneDevice(2);
    writeFileSync(bak(), JSON.stringify(read(DEMO_DEVICES_FILENAME)));
    writeFileSync(demoFile(), newer);
    const [main0, bak0] = [bytes(demoFile()), bytes(bak())];
    await refusedEverywhere(demoFile());
    expect(bytes(demoFile())).toEqual(main0);
    expect(bytes(bak())).toEqual(bak0);
  });

  it('plik główny uszkodzony, kopia `version: 2` → odmowa, oba pliki nietknięte', async () => {
    writeFileSync(bak(), await oneDevice(2));
    writeFileSync(demoFile(), '{zepsuty');
    const [main0, bak0] = [bytes(demoFile()), bytes(bak())];
    await refusedEverywhere(bak());
    expect(bytes(demoFile())).toEqual(main0);
    expect(bytes(bak())).toEqual(bak0);
  });

  it('plik główny dobry, kopia `version: 2` → odmowa, oba pliki nietknięte', async () => {
    writeFileSync(bak(), await oneDevice(2));
    const [main0, bak0] = [bytes(demoFile()), bytes(bak())];
    await refusedEverywhere(bak());
    expect(bytes(demoFile())).toEqual(main0);
    expect(bytes(bak())).toEqual(bak0);
  });

  it('plik główny uszkodzony, kopia dobra → stan z kopii, `serve --check` przechodzi', async () => {
    const store = openDemo();
    const phone = await pairOne(store);
    await pairOne(store, 'iPad·Rarog', phone.id);
    writeFileSync(demoFile(), '{zepsuty');
    const restored = openDemo();
    expect(restored.status).toBe('ok');
    expect(restored.active().map((r) => r.id)).toEqual([phone.id]);
    expect((await serve('check')).code).toBe(0);
  });

  it('oba pliki uszkodzone (zły JSON) → pusty magazyn `broken`, `serve --check` przechodzi', async () => {
    writeFileSync(demoFile(), '{zepsuty');
    writeFileSync(bak(), 'nie-json');
    const broken = openDemo();
    expect(broken.status).toBe('broken');
    expect(broken.active()).toEqual([]);
    expect((await serve('check')).code).toBe(0);
  });
});

describe('kopia `.bak` i nagrobki', () => {
  it('zapis trzyma poprzednią wersję w `.bak`; nieczytelny plik główny → stan z kopii i linia w logu', async () => {
    const store = open();
    const first = await pairOne(store, 'iPhone·Rarog');
    const second = await pairOne(store, 'iPad·Rarog', first.id);
    // `.bak` = wersja sprzed ostatniego zapisu (pierwsze urządzenie, bez drugiego).
    expect((read(`${DEVICES_FILENAME}.bak`)['devices'] as { id: string }[]).map((d) => d.id)).toEqual([first.id]);
    writeFileSync(file(), '{zepsute');
    const restored = open();
    expect(restored.status).toBe('ok');
    expect(restored.active().map((r) => r.id)).toEqual([first.id]);
    expect(restored.serverId).toBe(store.serverId);
    expect(logs.some((line) => line.includes('unreadable') && line.includes('.bak'))).toBe(true);
    expect(restored.get(second.id)).toBeUndefined();
  });

  it('odpięte urządzenie NIE wstaje z `.bak`: kopia niesie nagrobki bieżącego stanu', async () => {
    const store = open();
    const phone = await pairOne(store);
    clock += 1_000;
    const tomb = store.revoke(phone.id, 'admin');
    await store.persist();
    expect(tomb).toMatchObject({ id: phone.id, revokedBy: 'admin', revokedAt: new Date(clock).toISOString() });
    writeFileSync(file(), 'nie-json');
    const restored = open();
    expect(restored.get(phone.id)).toBeUndefined();
    expect(restored.tombstone(phone.id)?.revokedBy).toBe('admin');
    expect(checkDevice(restored, phone.header)).toMatchObject({ ok: false, reason: 'device-revoked' });
  });

  it('ponad sufit nagrobków: 201 urządzeń → `revokeAll` → zepsuty plik główny → z kopii nie wstaje żadne', async () => {
    const store = open();
    const pairing = createPairing({ store, epoch: EPOCH, now: () => clock });
    const first = pairing.redeem({ code: pairing.issue('admin').code, label: 'pierwsze' });
    if (!first.ok) throw new Error('parowanie');
    const headers = [deviceAuthorization(first.record.id, first.secret)];
    for (let i = 1; i < DEVICE_TOMBSTONES_MAX + 1; i += 1) {
      const next = pairing.redeem({ code: pairing.issue(first.record.id).code, label: `u${String(i)}` });
      if (!next.ok) throw new Error('parowanie');
      headers.push(deviceAuthorization(next.record.id, next.secret));
    }
    await store.persist();
    expect(store.active()).toHaveLength(DEVICE_TOMBSTONES_MAX + 1);
    store.revokeAll('admin');
    await store.persist();
    // Najstarszy nagrobek wypadł z przyciętej listy — kopia i tak nie może trzymać jego rekordu.
    expect(store.tombstones()).toHaveLength(DEVICE_TOMBSTONES_MAX);
    expect(read(`${DEVICES_FILENAME}.bak`)['devices']).toEqual([]);
    writeFileSync(file(), 'zepsuty');
    const restored = open();
    expect(restored.active()).toEqual([]);
    for (const header of headers) expect(checkDevice(restored, header).ok).toBe(false);
  });

  it('nagrobek i `creator` przeżywają restart; nagrobek wygrywa z rekordem o tym samym id', async () => {
    const store = open();
    const phone = await pairOne(store);
    const pad = await pairOne(store, 'iPad·Rarog', phone.id);
    store.revoke(pad.id, 'forget');
    await store.persist();
    const reloaded = open();
    expect(reloaded.get(phone.id)?.creator).toBe('admin');
    expect(reloaded.tombstone(pad.id)).toMatchObject({ creator: phone.id, revokedBy: 'forget', label: 'iPad·Rarog' });
    // Ręczna edycja wstawia rekord z powrotem obok nagrobka — fail-closed: liczy się nagrobek.
    const body = read();
    const tombs = body['revoked'] as Record<string, unknown>[];
    writeFileSync(file(), JSON.stringify({
      ...body,
      devices: [...(body['devices'] as unknown[]), { ...(read()['devices'] as Record<string, unknown>[])[0], id: pad.id }],
      revoked: tombs,
    }));
    expect(open().get(pad.id)).toBeUndefined();
  });

  it('oba pliki nieczytelne → pusty magazyn, `broken`, linia w logu; start NIE nadpisuje uszkodzonych plików', async () => {
    const store = open();
    await pairOne(store);
    await pairOne(store, 'iPad·Rarog', store.active()[0]?.id);
    writeFileSync(file(), 'zepsuty-główny');
    writeFileSync(`${file()}.bak`, 'zepsuta-kopia');
    const broken = open();
    await broken.flush();
    expect(broken.status).toBe('broken');
    expect(broken.active()).toEqual([]);
    expect(broken.serverId).not.toBe(store.serverId);
    expect(logs.some((line) => line.includes('authStore: broken'))).toBe(true);
    expect(readFileSync(file(), 'utf8')).toBe('zepsuty-główny');
    // Pierwsza zmiana zapisuje czysty plik; stan `broken` zostaje do końca życia procesu.
    await pairOne(broken);
    expect(read()['version']).toBe(1);
    expect(broken.status).toBe('broken');
    expect(open().status).toBe('ok');
  });
});

describe('revoking a device revokes the devices paired through it', () => {
  let seq = 0;
  /** A record straight into the store: any creator, also `admin` next to active devices (pairing refuses that). */
  const record = (creator: string, label: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => {
    seq += 1;
    return {
      id: seq.toString(16).padStart(32, '0'), secretHash: 'a'.repeat(64), pushKey: 'A'.repeat(43), kid: 'abcdef01',
      label, build: null, createdAt: new Date(clock).toISOString(), lastSeenAt: new Date(clock).toISOString(),
      epoch: EPOCH, creator, ...extra,
    };
  };
  /** A from the Mac, B from A, C from B; D from the Mac, unrelated. */
  const chain = (store: DeviceStore): { a: DeviceRecord; b: DeviceRecord; c: DeviceRecord; d: DeviceRecord } => {
    const a = record('admin', 'A');
    const b = record(a.id, 'B');
    const c = record(b.id, 'C');
    const d = record('admin', 'D');
    for (const r of [a, b, c, d]) store.add(r);
    return { a, b, c, d };
  };
  const activeIds = (store: DeviceStore): string[] => store.active().map((r) => r.id);

  it('revoke A → A, B and C revoked in one event, each with a tombstone; D untouched', async () => {
    const store = open();
    const { a, b, c, d } = chain(store);
    const events: DeviceDeactivation[] = [];
    store.onDeactivate((event) => { events.push(event); });
    clock += 1_000;
    const result = store.revokeWithDescendants(a.id, 'admin');
    expect(result?.device?.id).toBe(a.id);
    expect(result?.descendants.map((t) => t.id)).toEqual([b.id, c.id]);
    expect(events).toEqual([{ ids: [a.id, b.id, c.id], by: 'admin' }]);
    expect(activeIds(store)).toEqual([d.id]);
    for (const r of [a, b, c]) {
      expect(store.tombstone(r.id)).toMatchObject({
        revokedBy: 'admin', revokedAt: new Date(clock).toISOString(), createdAt: r.createdAt, creator: r.creator,
      });
    }
    await store.persist();
    expect(open().active().map((r) => r.id)).toEqual([d.id]);
  });

  it('B did `forget`, then revoke A → C revoked through the tombstone of B', () => {
    const store = open();
    const { a, b, c, d } = chain(store);
    store.revoke(b.id, 'forget');
    expect(activeIds(store)).toEqual([a.id, c.id, d.id]);
    const result = store.revokeWithDescendants(a.id, 'admin');
    expect(result?.descendants.map((t) => t.id)).toEqual([c.id]);
    expect(activeIds(store)).toEqual([d.id]);
    expect(store.tombstone(b.id)?.revokedBy).toBe('forget');
  });

  it.each(['forget', 'expired'] as const)('A no longer active (%s), then revoke A → B and C revoked', (how) => {
    const store = open();
    const idle = new Date(clock - DEVICE_IDLE_EXPIRY_MS).toISOString();
    const a = record('admin', 'A', how === 'expired' ? { lastSeenAt: idle } : {});
    const b = record(a.id, 'B');
    const c = record(b.id, 'C');
    for (const r of [a, b, c]) store.add(r);
    if (how === 'forget') store.revoke(a.id, 'forget');
    expect(activeIds(store)).toEqual([b.id, c.id]);
    expect(store.tombstone(a.id)?.revokedBy).toBe(how);
    const events: DeviceDeactivation[] = [];
    store.onDeactivate((event) => { events.push(event); });
    const result = store.revokeWithDescendants(a.id, 'admin');
    expect(result?.device).toBeUndefined();
    expect(result?.descendants.map((t) => t.id)).toEqual([b.id, c.id]);
    expect(events).toEqual([{ ids: [b.id, c.id], by: 'admin' }]);
    expect(activeIds(store)).toEqual([]);
    // The tombstone of A keeps its own cause.
    expect(store.tombstone(a.id)?.revokedBy).toBe(how);
  });

  it.each(['active', 'forgotten'] as const)(
    '250 revocations on the way: tombstones on the chain to an active device survive trimming (A %s)',
    async (stateOfA) => {
      const store = open();
      const a = record('admin', 'A');
      const b = record(a.id, 'B');
      const c = record(b.id, 'C');
      for (const r of [a, b, c]) store.add(r);
      store.revoke(b.id, 'forget');
      if (stateOfA === 'forgotten') store.revoke(a.id, 'forget');
      const others = Array.from({ length: 250 }, (_, i) => record('admin', `other ${String(i)}`));
      for (const r of others) store.add(r);
      for (const r of others) store.revoke(r.id, 'admin');
      expect(store.tombstone(b.id)).toBeDefined();
      if (stateOfA === 'forgotten') expect(store.tombstone(a.id)).toBeDefined();
      expect(store.tombstones()).toHaveLength(DEVICE_TOMBSTONES_MAX);
      // The oldest tombstones off the chain fell off the list.
      expect(store.tombstone(others[0]?.id ?? '')).toBeUndefined();
      await store.persist();
      const reloaded = open();
      expect(reloaded.revokeWithDescendants(a.id, 'admin')?.descendants.map((t) => t.id)).toEqual([c.id]);
      expect(reloaded.active()).toEqual([]);
    },
  );

  it('without an active device on the chain its tombstones are trimmed like any other', () => {
    const store = open();
    const a = record('admin', 'A');
    const b = record(a.id, 'B');
    for (const r of [a, b]) store.add(r);
    store.revoke(b.id, 'forget');
    store.revoke(a.id, 'forget');
    const others = Array.from({ length: DEVICE_TOMBSTONES_MAX }, (_, i) => record('admin', `other ${String(i)}`));
    for (const r of others) store.add(r);
    for (const r of others) store.revoke(r.id, 'admin');
    expect(store.tombstone(a.id)).toBeUndefined();
    expect(store.tombstone(b.id)).toBeUndefined();
  });

  it('`revoke` (the `forget` path) leaves the descendants alone', () => {
    const store = open();
    const { a, b, c, d } = chain(store);
    expect(store.revoke(a.id, 'forget')?.id).toBe(a.id);
    expect(activeIds(store)).toEqual([b.id, c.id, d.id]);
  });

  it('nothing active to revoke → `undefined`, no event; `admin` is not a device id', () => {
    const store = open();
    const { a, b, c, d } = chain(store);
    const events: DeviceDeactivation[] = [];
    store.onDeactivate((event) => { events.push(event); });
    expect(store.revokeWithDescendants('f'.repeat(32), 'admin')).toBeUndefined();
    expect(store.revokeWithDescendants('admin', 'admin')).toBeUndefined();
    expect(store.revokeWithDescendants(c.id, 'admin')?.descendants).toEqual([]);
    expect(store.revokeWithDescendants(c.id, 'admin')).toBeUndefined();
    expect(events).toEqual([{ ids: [c.id], by: 'admin' }]);
    expect(activeIds(store)).toEqual([a.id, b.id, d.id]);
  });
});

describe('aktywność: wygasanie, `lastSeenAt`, epoka', () => {
  it('sierota po zgubionej odpowiedzi (zero żądań) wygasa po 10 min jako nagrobek `expired`', async () => {
    const store = open();
    const events: DeviceDeactivation[] = [];
    store.onDeactivate((event) => { events.push(event); });
    const orphan = await pairOne(store);
    clock += DEVICE_ORPHAN_MS - 1;
    expect(store.active().map((r) => r.id)).toEqual([orphan.id]);
    clock += 1;
    expect(store.active()).toEqual([]);
    expect(events).toEqual([{ ids: [orphan.id], by: 'expired' }]);
    expect(store.tombstone(orphan.id)?.revokedAt).toBe(new Date(T0 + DEVICE_ORPHAN_MS).toISOString());
    await store.flush();
    expect(open().tombstone(orphan.id)?.revokedBy).toBe('expired');
  });

  it('pierwsze żądanie potwierdza urządzenie; 30 dni bez użycia = wygasłe; `lastSeenAt` co najwyżej raz na minutę', async () => {
    const store = open();
    const phone = await pairOne(store);
    clock += 5_000;
    expect(checkDevice(store, phone.header).ok).toBe(true);
    const seen = store.get(phone.id)?.lastSeenAt;
    expect(seen).toBe(new Date(clock).toISOString());
    clock += 30_000;
    checkDevice(store, phone.header);
    expect(store.get(phone.id)?.lastSeenAt).toBe(seen);
    clock += 30_000;
    checkDevice(store, phone.header);
    expect(store.get(phone.id)?.lastSeenAt).toBe(new Date(clock).toISOString());
    const lastUse = clock;
    clock = lastUse + DEVICE_IDLE_EXPIRY_MS - 1;
    expect(store.get(phone.id)).toBeDefined();
    clock = lastUse + DEVICE_IDLE_EXPIRY_MS;
    expect(checkDevice(store, phone.header)).toMatchObject({ ok: false, reason: 'device-revoked' });
    expect(store.tombstone(phone.id)?.revokedBy).toBe('expired');
  });

  it('rekord z poprzedniej epoki `RAROG_AUTH_EPOCH` odpada jak odpięty przez administratora', async () => {
    const store = open();
    const phone = await pairOne(store);
    await store.flush();
    const next = createDeviceStore({ dataDir: dir, epoch: '2', now: () => clock, log: (line) => { logs.push(line); } });
    opened.push(next);
    const events: DeviceDeactivation[] = [];
    next.onDeactivate((event) => { events.push(event); });
    next.sweep();
    expect(events).toEqual([{ ids: [phone.id], by: 'admin' }]);
    expect(next.get(phone.id)).toBeUndefined();
    expect(logs.some((line) => line.includes('previous RAROG_AUTH_EPOCH epoch'))).toBe(true);
  });

  it('`revokeAll` jedną operacją, słuchacz dostaje wszystkie id; słuchacz rzucający nie psuje odpięcia', async () => {
    const store = open();
    const a = await pairOne(store);
    const b = await pairOne(store, 'iPad·Rarog', a.id);
    const events: DeviceDeactivation[] = [];
    store.onDeactivate(() => { throw new Error('słuchacz'); });
    store.onDeactivate((event) => { events.push(event); });
    expect(store.revokeAll('admin').map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(events).toEqual([{ ids: expect.arrayContaining([a.id, b.id]) as unknown as string[], by: 'admin' }]);
    expect(store.active()).toEqual([]);
    expect(logs.some((line) => line.includes('revocation listener threw'))).toBe(true);
  });
});

describe('zapis: błąd nie zostawia rekordu w pliku', () => {
  it('stan do zapisu jest brany przy WYKONANIU zapisu: cofnięty rekord nie wraca następnym zapisem', async () => {
    let fail = true;
    const writes: string[] = [];
    const store = open({
      write: (target, contents) => {
        if (fail && target.endsWith(DEVICES_FILENAME)) return Promise.reject(Object.assign(new Error('dysk'), { code: 'EIO' }));
        writes.push(target);
        writeFileSync(target, contents, { mode: 0o600 });
        return Promise.resolve();
      },
    });
    await store.flush().catch(() => {});
    const pairing = createPairing({ store, epoch: EPOCH, now: () => clock });
    const result = pairing.redeem({ code: pairing.issue('admin').code, label: 'x' });
    if (!result.ok) throw new Error('parowanie');
    await expect(store.persist()).rejects.toThrow('dysk');
    store.discard(result.record.id);
    fail = false;
    await store.persist();
    expect(read()['devices']).toEqual([]);
    expect(existsSync(file())).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
  });
});
