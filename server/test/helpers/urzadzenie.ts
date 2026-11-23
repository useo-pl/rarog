/**
 * Sparowane urządzenie testowe: magazyn kluczy z jednym aktywnym rekordem i gotowy nagłówek `Authorization`.
 *
 * Klucz urządzenia to jedyne poświadczenie serwera, więc każdy test, który idzie przez bramkę routera, SSE albo
 * upgrade terminala, niesie ten nagłówek i podaje routerowi {@link TestDevice.identity} (`RouterDeps['devices']`).
 * Rekord jest dopisany wprost (bez kodu parowania), z ostatnim użyciem „teraz”, więc nie wygasa jako sierota
 * i pierwsze żądania nie zapisują `lastSeenAt`. Zapis magazynu jest atrapą: na dysku powstaje najwyżej pusty
 * `dataDir` (zapis zakłada katalog), a plik `devices.json` nigdy.
 */
import {
  createDeviceStore, createPairing, deviceAuthorization, hashSecret, pushKeyId,
} from '../../src/auth/index.ts';
import type { DeviceStore } from '../../src/auth/index.ts';
import type { DeviceIdentity } from '../../src/router.ts';

/** Identyfikator urządzenia testowego (kształt `DEVICE_ID_RE`). */
export const TEST_DEVICE_ID = 'a1b2c3d4'.repeat(4);
/** Sekret urządzenia testowego: 32 B w base64url, jak z parowania. */
export const TEST_DEVICE_SECRET = Buffer.alloc(32, 7).toString('base64url');
const TEST_DEVICE_PUSH_KEY = Buffer.alloc(32, 3).toString('base64url');

export interface TestDevice {
  readonly id: string;
  /** Wartość nagłówka `Authorization` (`Rarog-Device <id>.<sekret>`). */
  readonly authorization: string;
  /** Nagłówki z kluczem, do rozwinięcia w `fetch`/`http.request`. */
  readonly headers: { readonly Authorization: string };
  readonly store: DeviceStore;
  /** Zależność `devices` routera: magazyn, parowanie i nazwa serwera. */
  readonly identity: DeviceIdentity;
}

export interface TestDeviceOptions {
  /** Epoka rekordu i magazynu; domyślnie `1` (`DEFAULT_AUTH_EPOCH`). */
  readonly epoch?: string;
  readonly label?: string;
  /** Zegar magazynu i parowania; domyślnie `Date.now`. */
  readonly now?: () => number;
}

/**
 * Dopisuje urządzenie testowe do magazynu, który test składa sam (np. z prawdziwym zapisem na dysk), i oddaje jego
 * nagłówek. Epoka rekordu musi być epoką magazynu.
 */
export function addTestDevice(
  store: DeviceStore, opts: TestDeviceOptions = {},
): Pick<TestDevice, 'id' | 'authorization' | 'headers'> {
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  store.add({
    id: TEST_DEVICE_ID, secretHash: hashSecret(TEST_DEVICE_SECRET), pushKey: TEST_DEVICE_PUSH_KEY,
    kid: pushKeyId(TEST_DEVICE_PUSH_KEY), label: opts.label ?? 'iPhone·test', build: null, createdAt: at,
    lastSeenAt: at, epoch: opts.epoch ?? '1', creator: 'admin',
  });
  const authorization = deviceAuthorization(TEST_DEVICE_ID, TEST_DEVICE_SECRET);
  return { id: TEST_DEVICE_ID, authorization, headers: { Authorization: authorization } };
}

/**
 * Magazyn z jednym urządzeniem w `dataDir` (katalog testu; demo bez `RAROG_DATA_DIR` ma swój katalog w tmp).
 */
export function createTestDevice(dataDir: string, opts: TestDeviceOptions = {}): TestDevice {
  const epoch = opts.epoch ?? '1';
  const now = opts.now ?? ((): number => Date.now());
  const store = createDeviceStore({ dataDir, epoch, now, log: () => {}, write: () => Promise.resolve() });
  return {
    ...addTestDevice(store, { ...opts, epoch, now }),
    store,
    identity: { store, pairing: createPairing({ store, epoch, now }), serverName: 'mac-test' },
  };
}
