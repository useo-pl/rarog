/**
 * Device key store: `<dataDir>/devices.json`. The plain demo keeps its own file,
 * `<dataDir>/devices.demo.json` ({@link devicesFileName}), in the same format and with the same rules.
 *
 * A record is created at pairing (`pairing.ts`): `id` (16 B hex, not secret), the secret digest, the push key
 * (stored as is, because the server encrypts with it, but still a secret), `kid`, label, build, dates, the epoch at
 * the moment of issue and the
 * code's creator (`admin` or `deviceId`). The secret itself never reaches the disk: it has full entropy (32 B), so
 * an unsalted `sha256` is enough.
 *
 * **Active device = not revoked and not expired.** A record expires after 30 days without use (`lastSeenAt`)
 * and a record without A SINGLE request for 10 min after pairing (an orphan after a `/api/pair` response that
 * got lost on the way). A record with an epoch other than the current `RAROG_AUTH_EPOCH` drops out as if revoked by
 * the administrator: the epoch is a switch for all devices at once. Every deactivation (revoke,
 * "Forget server", expiry) turns the record into a TOMBSTONE with `revokedAt` and `revokedBy` and calls the
 * `onDeactivate` listeners: they close open connections, delete APNs tokens and pairing codes.
 *
 * Revocation by the owner (`rarog devices revoke <id>`, {@link DeviceStore.revokeWithDescendants}) also revokes every
 * active device whose `creator` chain leads to the id, through active records and tombstones; `forget` and
 * expiry touch one device only. Trimming keeps the tombstones on the chain of an active device, so the cascade
 * reaches it however many devices were revoked in between.
 *
 * Writing: tmp+rename, `0o600` (directory `0o700`), a chain of writes. The state to write is taken at the moment
 * the write RUNS, not when it is requested: a rolled-back record (write error at pairing) does not come back to the
 * file with the next write. A different corruption policy than `apns-devices.json`, because the file carries
 * credentials:
 * - a write keeps the previous version as `devices.json.bak`, limited to devices active in the CURRENT
 *   state and with its tombstones (a device revoked by the last write does not rise from the copy, also when its
 *   tombstone fell out of the trimmed list);
 * - unreadable main file → read `.bak` (a log line);
 * - both unreadable → empty store (everyone pairs again), a log line and `status: 'broken'`
 *   (`authStore` in `/health`) until the process ends. The store does not overwrite corrupted files at
 *   start, only at the first change. A corrupted file is never an exception;
 * - a main file or `.bak` with a format version HIGHER than known (written by a newer server, then a rollback to an
 *   older version) is a start refusal: {@link DevicesFormatError} before any write, and before that a refusal of
 *   `rarog serve` and `--check` ({@link newerDevicesFormat}). Both files stay untouched, also next to a readable copy.
 *
 * The module does not log secrets, digests, push keys or labels: only numbers and identifiers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEVICE_ID_RE, deviceRevokedBySchema } from '@rarog/shared/rest';
import type { DeviceRevokedBy } from '@rarog/shared/rest';

/** File name in `dataDir`. The guard `docs-zgodnosc.test.ts` derives the docs entry from it. */
export const DEVICES_FILENAME = 'devices.json';

/**
 * Store file of the plain demo (`RAROG_DEMO=1` without the review code), next to {@link DEVICES_FILENAME}: the
 * unauthenticated `POST /api/demo/pairing` revokes and issues only here, so a key from it never opens a server without
 * demo on the same data directory, and the demo never revokes that server's devices.
 */
export const DEMO_DEVICES_FILENAME = 'devices.demo.json';

/** The server mode that picks the store file: the `demo` and `demoReview` fields of the config. */
export interface DeviceStoreMode {
  readonly demo: boolean;
  readonly demoReview: object | null;
}

/**
 * Store file name for this mode: {@link DEMO_DEVICES_FILENAME} in the plain demo, {@link DEVICES_FILENAME} on a server
 * without demo and in review mode (reviewer devices stay on the persistent `devices.json`).
 */
export function devicesFileName(mode: DeviceStoreMode): string {
  return mode.demo && mode.demoReview === null ? DEMO_DEVICES_FILENAME : DEVICES_FILENAME;
}

/** File format version. Another value = a file this server cannot read. */
export const DEVICES_FORMAT_VERSION = 1;

/** A key unused for this long expires (a daily user will not notice). */
export const DEVICE_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** A new record without a single authenticated request for this long = an orphan, it expires. */
export const DEVICE_ORPHAN_MS = 10 * 60 * 1000;

/** `lastSeenAt` moves at most once per this interval: otherwise every request would write the file. */
export const DEVICE_SEEN_RESOLUTION_MS = 60_000;

/**
 * Cap on tombstones in the file; above it the oldest drop out. Tombstones on the `creator` chain of an active device
 * stay above the cap.
 */
export const DEVICE_TOMBSTONES_MAX = 200;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Creator of the code the device paired with: the CLI on the Mac or another device. */
export type DeviceCreator = 'admin' | (string & {});

/** Active device record, as it lies in the file. */
export interface DeviceRecord {
  readonly id: string;
  /** `sha256` of the secret (hex). */
  readonly secretHash: string;
  /** Push key, 32 B base64url: stored as is, because the server encrypts the banner content with it; a secret. */
  readonly pushKey: string;
  /** First 8 hex characters of `sha256(raw pushKey bytes)`. */
  readonly kid: string;
  /** Label from the app after sanitizing: never to the log. */
  readonly label: string;
  readonly build: string | null;
  readonly createdAt: string;
  /** Last authenticated request; `null` = paired, without any request. */
  readonly lastSeenAt: string | null;
  /** `RAROG_AUTH_EPOCH` at the moment of issue. */
  readonly epoch: string;
  readonly creator: DeviceCreator;
}

/**
 * Tombstone of a revoked device. It keeps the secret digest so that only the owner of that secret gets 401
 * `device-revoked` with a date; the rest of the world sees `device-unknown`.
 */
export interface DeviceTombstone {
  readonly id: string;
  readonly secretHash: string;
  readonly label: string;
  readonly createdAt: string;
  readonly creator: DeviceCreator;
  readonly revokedAt: string;
  readonly revokedBy: DeviceRevokedBy;
}

/** Device deactivation: one event per operation (revoke, `--all`, expiry sweep). */
export interface DeviceDeactivation {
  readonly ids: readonly string[];
  readonly by: DeviceRevokedBy;
}

/** Revocation of a device together with the devices paired through it. */
export interface DeviceTreeRevocation {
  /** Tombstone of the device itself; `undefined` = it was no longer active (a tombstone, expired, or unknown). */
  readonly device: DeviceTombstone | undefined;
  /** Active devices whose `creator` chain leads to the device, in store order (oldest pairing first). */
  readonly descendants: readonly DeviceTombstone[];
}

export type DeviceStoreStatus = 'ok' | 'broken';

export interface DeviceStore {
  /** Lasting server identifier (random, assigned at first start). */
  readonly serverId: string;
  /** `broken` = both files unreadable at start (empty store). */
  readonly status: DeviceStoreStatus;
  /** Active record or `undefined` (after the expiry sweep). */
  get(id: string, nowMs?: number): DeviceRecord | undefined;
  /** Tombstone or `undefined`. */
  tombstone(id: string): DeviceTombstone | undefined;
  /** All tombstones, from the oldest revocation. */
  tombstones(): readonly DeviceTombstone[];
  /** Active records from the oldest (after the expiry sweep). */
  active(nowMs?: number): readonly DeviceRecord[];
  /**
   * Adds a record to the IN-MEMORY state: from this moment it counts as active. Writing is separate: {@link persist}.
   */
  add(record: DeviceRecord): void;
  /** Rolls back a record added by {@link add} without a tombstone (write error at pairing). */
  discard(id: string): void;
  /** Revokes a device (tombstone, listeners). `undefined` = there was no active record with this id. */
  revoke(id: string, by: DeviceRevokedBy, nowMs?: number): DeviceTombstone | undefined;
  /**
   * Revokes `id` when active and every active device whose `creator` chain (active records and tombstones) leads to
   * `id`, with one listener event. `id` may be inactive: then only its descendants go. `undefined` = nothing
   * active to revoke. The `forget` path uses {@link revoke}, which leaves descendants alone.
   */
  revokeWithDescendants(id: string, by: DeviceRevokedBy, nowMs?: number): DeviceTreeRevocation | undefined;
  /** Revokes all active devices in one operation. */
  revokeAll(by: DeviceRevokedBy, nowMs?: number): readonly DeviceTombstone[];
  /** Authenticated request of a device: `lastSeenAt` in memory (at most once a minute) and a background write. */
  touch(id: string, nowMs?: number): void;
  /** Expiry sweep (orphans, 30 days without use, an old epoch). Calls listeners, writes in the background. */
  sweep(nowMs?: number): void;
  /** Writes the CURRENT state. Rejects on a write error (pairing then rolls back the record). */
  persist(): Promise<void>;
  /**
   * Deactivation listener; returns an unsubscribe function. The listener must not throw (an exception goes to the log).
   */
  onDeactivate(listener: (event: DeviceDeactivation) => void): () => void;
  /** Waits for the requested writes to finish (tests, shutdown). */
  flush(): Promise<void>;
}

/** File write: injected in tests (stop in the middle of a write, disk error). */
export type DeviceStoreWrite = (file: string, contents: string) => Promise<void>;

export interface DeviceStoreOptions {
  readonly dataDir: string;
  /** File name in `dataDir` ({@link devicesFileName}); default {@link DEVICES_FILENAME}. The backup is `<name>.bak`. */
  readonly fileName?: string;
  /** The current `RAROG_AUTH_EPOCH`: a record with another epoch drops out. */
  readonly epoch: string;
  readonly now?: () => number;
  /** Source of randomness for `serverId` (golden response tests). */
  readonly random?: (bytes: number) => Buffer;
  /** A line to `server.log`: numbers and identifiers, never secrets or labels. */
  readonly log?: (line: string) => void;
  /** Atomic write of one file; by default tmp+rename with `0o600`. */
  readonly write?: DeviceStoreWrite;
}

export function devicesPath(dataDir: string, fileName: string = DEVICES_FILENAME): string {
  return path.join(dataDir, fileName);
}

/** Digest of a device secret (or a pairing code): hex `sha256` of the base64url string. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Push key `kid`: 8 hex characters of `sha256` of the key's RAW bytes (base64url → bytes). */
export function pushKeyId(pushKey: string): string {
  return createHash('sha256').update(Buffer.from(pushKey, 'base64url')).digest('hex').slice(0, 8);
}

interface StoreState {
  readonly serverId: string;
  readonly devices: Map<string, DeviceRecord>;
  readonly revoked: Map<string, DeviceTombstone>;
}

interface FileShape {
  version: number;
  serverId: string;
  devices: DeviceRecord[];
  revoked: DeviceTombstone[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const B64URL32 = /^[A-Za-z0-9_-]{43}$/;
const HEX8 = /^[0-9a-f]{8}$/;

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCreator = (value: unknown): value is DeviceCreator =>
  value === 'admin' || (typeof value === 'string' && DEVICE_ID_RE.test(value));

function parseRecord(raw: unknown): DeviceRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (!isString(e['id']) || !DEVICE_ID_RE.test(e['id'])) return null;
  if (!isString(e['secretHash']) || !HEX64.test(e['secretHash'])) return null;
  if (!isString(e['pushKey']) || !B64URL32.test(e['pushKey'])) return null;
  if (!isString(e['kid']) || !HEX8.test(e['kid'])) return null;
  if (!isString(e['label']) || !isNonEmpty(e['createdAt']) || !isNonEmpty(e['epoch'])) return null;
  if (!isCreator(e['creator'])) return null;
  const lastSeenAt = e['lastSeenAt'];
  if (lastSeenAt !== null && !isNonEmpty(lastSeenAt)) return null;
  const build = e['build'];
  if (build !== null && !isString(build)) return null;
  return {
    id: e['id'], secretHash: e['secretHash'], pushKey: e['pushKey'], kid: e['kid'], label: e['label'],
    build, createdAt: e['createdAt'], lastSeenAt, epoch: e['epoch'], creator: e['creator'],
  };
}

function parseTombstone(raw: unknown): DeviceTombstone | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (!isString(e['id']) || !DEVICE_ID_RE.test(e['id'])) return null;
  if (!isString(e['secretHash']) || !HEX64.test(e['secretHash'])) return null;
  if (!isString(e['label']) || !isNonEmpty(e['createdAt']) || !isNonEmpty(e['revokedAt'])) return null;
  if (!isCreator(e['creator'])) return null;
  const by = deviceRevokedBySchema.safeParse(e['revokedBy']);
  if (!by.success) return null;
  return {
    id: e['id'], secretHash: e['secretHash'], label: e['label'], createdAt: e['createdAt'],
    creator: e['creator'], revokedAt: e['revokedAt'], revokedBy: by.data,
  };
}

/**
 * Result of reading one store file: `missing` = does not exist; `unreadable` = exists but cannot be used
 * (bad JSON, bad shape, a lower or non-numeric version, no `serverId`); `newer` = a JSON object with a numeric
 * version higher than {@link DEVICES_FORMAT_VERSION}: written by a newer server, which this server does not touch.
 */
type FileRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'ok'; readonly state: StoreState };

const MISSING: FileRead = { kind: 'missing' };
const UNREADABLE: FileRead = { kind: 'unreadable' };

/** Store file in a format newer than known: the main one or its `.bak`. */
export interface DevicesNewerFormat {
  readonly file: string;
  readonly version: number;
}

/**
 * Start refusal on a file of a newer format: {@link createDeviceStore} throws it before writing anything.
 * `rarog serve` (start and `--check`) refuses before that with the same sentence ({@link devicesFormatMessage}).
 */
export class DevicesFormatError extends Error {
  constructor(readonly found: DevicesNewerFormat) {
    super(devicesFormatMessage(found));
    this.name = 'DevicesFormatError';
  }
}

/** Refusal sentence: the file, its version and the known version; no file content. */
export function devicesFormatMessage(found: DevicesNewerFormat): string {
  return `${found.file}: format version ${String(found.version)}; this rarog version knows only`
    + ` ${String(DEVICES_FORMAT_VERSION)}. The file holds the device pairings and stays as it is: install the rarog`
    + ' version that wrote it (or a newer one).';
}

/**
 * Reads one file ({@link FileRead}). A single faulty record drops out by itself: the device pairs again.
 */
function readFile(file: string): FileRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    return (err as { code?: unknown }).code === 'ENOENT' ? MISSING : UNREADABLE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return UNREADABLE;
  const body = parsed as Record<string, unknown>;
  const version = body['version'];
  if (typeof version === 'number' && Number.isFinite(version) && version > DEVICES_FORMAT_VERSION) {
    return { kind: 'newer', version };
  }
  if (version !== DEVICES_FORMAT_VERSION || !isNonEmpty(body['serverId'])) return UNREADABLE;
  if (!Array.isArray(body['devices']) || !Array.isArray(body['revoked'])) return UNREADABLE;
  const devices = new Map<string, DeviceRecord>();
  for (const raw of body['devices']) {
    const record = parseRecord(raw);
    if (record !== null) devices.set(record.id, record);
  }
  const revoked = new Map<string, DeviceTombstone>();
  for (const raw of body['revoked']) {
    const tomb = parseTombstone(raw);
    if (tomb !== null) revoked.set(tomb.id, tomb);
  }
  // A tombstone wins over a record with the same id (manual edit, an old copy): fail-closed.
  for (const id of revoked.keys()) devices.delete(id);
  return { kind: 'ok', state: { serverId: body['serverId'], devices, revoked } };
}

/** Both store files: the main one and `.bak`. */
function readBoth(
  dataDir: string, fileName: string = DEVICES_FILENAME,
): { readonly main: FileRead; readonly bak: FileRead; readonly file: string } {
  const file = devicesPath(dataDir, fileName);
  return { main: readFile(file), bak: readFile(`${file}.bak`), file };
}

/** First file of a newer format: the main one, then `.bak`; `null` = none. */
function newerOf(read: ReturnType<typeof readBoth>): DevicesNewerFormat | null {
  if (read.main.kind === 'newer') return { file: read.file, version: read.main.version };
  if (read.bak.kind === 'newer') return { file: `${read.file}.bak`, version: read.bak.version };
  return null;
}

/**
 * Store file in `dataDir` (main or `.bak`) with a format version higher than known, or `null`. Each such
 * file blocks start, also next to a readable copy: the state from the older copy would overwrite the newer main file.
 * `fileName` is the file the server reads ({@link devicesFileName}), so the check before start looks at the same one.
 */
export function newerDevicesFormat(dataDir: string, fileName: string = DEVICES_FILENAME): DevicesNewerFormat | null {
  return newerOf(readBoth(dataDir, fileName));
}

/** Moment after which a record stops being active (orphan or 30 days without use); NaN for a broken date. */
function expiresAtOf(record: DeviceRecord): number {
  return record.lastSeenAt === null
    ? Date.parse(record.createdAt) + DEVICE_ORPHAN_MS
    : Date.parse(record.lastSeenAt) + DEVICE_IDLE_EXPIRY_MS;
}

/**
 * Epochs of the active (unexpired) devices from disk, without writing: for the epoch guard in `loadConfig`. The file
 * is chosen the same way as at store start ({@link createDeviceStore}): the main one, and when unreadable → `.bak`;
 * neither, or both unreadable = an empty list. A file of a newer format also gives an empty list: start refuses
 * anyway ({@link newerDevicesFormat}), and the refusal should speak about the format, not the epoch. No log and no
 * secrets: the result is only the epoch strings. Reads {@link DEVICES_FILENAME} only: the epoch guard skips the plain
 * demo, and `rarog setup` checks an installation, not a demo.
 */
export function activeDeviceEpochs(dataDir: string, nowMs: number = Date.now()): string[] {
  const read = readBoth(dataDir);
  if (newerOf(read) !== null) return [];
  const chosen = read.main.kind === 'ok' ? read.main : read.bak;
  if (chosen.kind !== 'ok') return [];
  return [...chosen.state.devices.values()]
    .filter((record) => nowMs < expiresAtOf(record)).map((record) => record.epoch);
}

function serialize(state: StoreState): string {
  const shape: FileShape = {
    version: DEVICES_FORMAT_VERSION,
    serverId: state.serverId,
    devices: [...state.devices.values()],
    revoked: [...state.revoked.values()],
  };
  return `${JSON.stringify(shape, null, 2)}\n`;
}

/** A copy of the state: the write and `.bak` must not see later changes of the map. */
function cloneState(state: StoreState): StoreState {
  return { serverId: state.serverId, devices: new Map(state.devices), revoked: new Map(state.revoked) };
}

/** Default atomic write: tmp, permissions `0o600` (also when tmp was left after a crash), rename. */
async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, contents, { encoding: 'utf8', mode: FILE_MODE });
  await chmod(tmp, FILE_MODE);
  await rename(tmp, file);
}

/**
 * Store from `<dataDir>/devices.json` (or from the file `opts.fileName`, {@link devicesFileName}).
 *
 * @throws {DevicesFormatError} when the main file or `.bak` has a format version higher than known; nothing is
 *   written then.
 */
export function createDeviceStore(opts: DeviceStoreOptions): DeviceStore {
  const name = opts.fileName ?? DEVICES_FILENAME;
  const read = readBoth(opts.dataDir, name);
  const newer = newerOf(read);
  if (newer !== null) throw new DevicesFormatError(newer);
  const { file } = read;
  const bak = `${file}.bak`;
  const now = opts.now ?? ((): number => Date.now());
  const random = opts.random ?? ((bytes: number): Buffer => randomBytes(bytes));
  const log = opts.log ?? ((): void => {});
  const write = opts.write ?? atomicWrite;
  const listeners = new Set<(event: DeviceDeactivation) => void>();

  let status: DeviceStoreStatus = 'ok';
  let state: StoreState;
  /** The last state that IS on disk as the main file: `.bak` is made from it. */
  let onDisk: StoreState | null;
  let writeFresh = false;

  const { main, bak: backup } = read;
  if (main.kind === 'ok') {
    state = main.state;
    onDisk = cloneState(main.state);
  } else {
    if (backup.kind === 'ok') {
      log(`devices: ${name} unreadable — state from ${name}.bak`
        + ` (${String(backup.state.devices.size)} devices)`);
      state = backup.state;
      onDisk = cloneState(backup.state);
    } else {
      state = { serverId: random(16).toString('hex'), devices: new Map(), revoked: new Map() };
      onDisk = null;
      if (main.kind === 'missing' && backup.kind === 'missing') {
        // First start: `serverId` must be lasting from the first second, so the file is created at once.
        writeFresh = true;
      } else {
        status = 'broken';
        log(`devices: ${name} and its backup unreadable — empty store, every device`
          + ' pairs again (authStore: broken)');
      }
    }
  }

  let chain: Promise<void> = Promise.resolve();

  const writeNow = async (): Promise<void> => {
    const current = cloneState(state);
    await mkdir(opts.dataDir, { recursive: true, mode: DIR_MODE });
    if (onDisk !== null) {
      /*
       * `.bak` = the previous version, but only with devices that are active NOW, and with the tombstones
       * of the current state: a revoked, expired or rolled-back device does not rise from it. The filter goes over
       * `current.devices`, not over the tombstones: tombstones are trimmed to `DEVICE_TOMBSTONES_MAX`,
       * so when more devices are revoked the oldest tombstone drops out.
       */
      const previous = cloneState(onDisk);
      for (const id of [...previous.devices.keys()]) if (!current.devices.has(id)) previous.devices.delete(id);
      for (const [id, tomb] of current.revoked) previous.revoked.set(id, tomb);
      await write(bak, serialize(previous));
    }
    await write(file, serialize(current));
    onDisk = current;
  };

  const persist = (): Promise<void> => {
    const run = chain.then(writeNow);
    chain = run.catch(() => {});
    return run;
  };

  /** Background write: an error goes to the log (a code, not a path), the state stays in memory. */
  const persistQuietly = (): void => {
    persist().catch((err: unknown) => {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      log(`devices: write failed (${typeof code === 'string' ? code : 'no code'})`
        + ` — ${String(state.devices.size)} devices stay in memory`);
    });
  };

  if (writeFresh) persistQuietly();

  const iso = (ms: number): string => new Date(ms).toISOString();

  /** Tombstones on the `creator` chain of some active device: the cascade walks through them. */
  const chainTombstones = (): Set<string> => {
    const kept = new Set<string>();
    const seen = new Set<string>();
    for (const record of state.devices.values()) {
      let creator: DeviceCreator = record.creator;
      // `seen` also stops a cycle (a hand-edited file): every id is walked up from at most once.
      while (creator !== 'admin' && !seen.has(creator)) {
        seen.add(creator);
        const tomb = state.revoked.get(creator);
        if (tomb !== undefined) kept.add(creator);
        const parent = tomb ?? state.devices.get(creator);
        if (parent === undefined) break;
        creator = parent.creator;
      }
    }
    return kept;
  };

  /** Oldest tombstones go first, except those on the chain of an active device. */
  const trimTombstones = (): void => {
    if (state.revoked.size <= DEVICE_TOMBSTONES_MAX) return;
    const kept = chainTombstones();
    for (const id of [...state.revoked.keys()]) {
      if (state.revoked.size <= DEVICE_TOMBSTONES_MAX) return;
      if (!kept.has(id)) state.revoked.delete(id);
    }
  };

  /** Active devices whose `creator` chain leads to `id`, through active records and tombstones. */
  const descendantsOf = (id: string): DeviceRecord[] => {
    const children = new Map<string, string[]>();
    for (const entry of [...state.devices.values(), ...state.revoked.values()]) {
      if (entry.creator === 'admin') continue;
      const list = children.get(entry.creator);
      if (list === undefined) children.set(entry.creator, [entry.id]);
      else list.push(entry.id);
    }
    const reached = new Set<string>([id]);
    const queue = [id];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const child of children.get(next) ?? []) {
        if (reached.has(child)) continue;
        reached.add(child);
        queue.push(child);
      }
    }
    return [...state.devices.values()].filter((record) => record.id !== id && reached.has(record.id));
  };

  const emit = (event: DeviceDeactivation): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        log(`devices: revocation listener threw (${err instanceof Error ? err.name : 'no name'})`);
      }
    }
  };

  /** Record → tombstone, without listeners and writing (the caller adds them). */
  const bury = (record: DeviceRecord, by: DeviceRevokedBy, atMs: number): DeviceTombstone => {
    const tomb: DeviceTombstone = {
      id: record.id, secretHash: record.secretHash, label: record.label, createdAt: record.createdAt,
      creator: record.creator, revokedAt: iso(atMs), revokedBy: by,
    };
    state.devices.delete(record.id);
    state.revoked.delete(record.id);
    state.revoked.set(record.id, tomb);
    return tomb;
  };

  const expiresAt = expiresAtOf;

  const sweep = (nowMs: number = now()): void => {
    const expired: string[] = [];
    const staleEpoch: string[] = [];
    for (const record of [...state.devices.values()]) {
      if (record.epoch !== opts.epoch) {
        bury(record, 'admin', nowMs);
        staleEpoch.push(record.id);
        continue;
      }
      // NaN (a broken date in the file) expires too: `!(now < NaN)`.
      if (!(nowMs < expiresAt(record))) {
        bury(record, 'expired', Math.min(nowMs, expiresAt(record) || nowMs));
        expired.push(record.id);
      }
    }
    if (expired.length + staleEpoch.length === 0) return;
    trimTombstones();
    if (staleEpoch.length > 0) {
      log(`devices: ${String(staleEpoch.length)} from the previous RAROG_AUTH_EPOCH epoch — revoked`);
      emit({ ids: staleEpoch, by: 'admin' });
    }
    if (expired.length > 0) {
      log(`devices: ${String(expired.length)} expired (${expired.join(', ')})`);
      emit({ ids: expired, by: 'expired' });
    }
    persistQuietly();
  };

  return {
    serverId: state.serverId,
    get status(): DeviceStoreStatus {
      return status;
    },
    get(id, nowMs) {
      sweep(nowMs);
      return state.devices.get(id);
    },
    tombstone(id) {
      return state.revoked.get(id);
    },
    tombstones() {
      return [...state.revoked.values()];
    },
    active(nowMs) {
      sweep(nowMs);
      return [...state.devices.values()];
    },
    add(record) {
      state.revoked.delete(record.id);
      state.devices.set(record.id, record);
    },
    discard(id) {
      state.devices.delete(id);
    },
    revoke(id, by, nowMs = now()) {
      sweep(nowMs);
      const record = state.devices.get(id);
      if (record === undefined) return undefined;
      const tomb = bury(record, by, nowMs);
      trimTombstones();
      emit({ ids: [id], by });
      return tomb;
    },
    revokeWithDescendants(id, by, nowMs = now()) {
      sweep(nowMs);
      // `admin` is a creator, not a device: without this check it would take every device paired from the Mac.
      if (!DEVICE_ID_RE.test(id)) return undefined;
      const descendants = descendantsOf(id);
      const record = state.devices.get(id);
      if (record === undefined && descendants.length === 0) return undefined;
      const device = record === undefined ? undefined : bury(record, by, nowMs);
      const buried = descendants.map((descendant) => bury(descendant, by, nowMs));
      trimTombstones();
      emit({ ids: [...(device === undefined ? [] : [device.id]), ...buried.map((tomb) => tomb.id)], by });
      return { device, descendants: buried };
    },
    revokeAll(by, nowMs = now()) {
      sweep(nowMs);
      const tombs = [...state.devices.values()].map((record) => bury(record, by, nowMs));
      if (tombs.length === 0) return tombs;
      trimTombstones();
      emit({ ids: tombs.map((tomb) => tomb.id), by });
      return tombs;
    },
    touch(id, nowMs = now()) {
      const record = state.devices.get(id);
      if (record === undefined) return;
      const last = record.lastSeenAt === null ? Number.NEGATIVE_INFINITY : Date.parse(record.lastSeenAt);
      if (nowMs - last < DEVICE_SEEN_RESOLUTION_MS) return;
      state.devices.set(id, { ...record, lastSeenAt: iso(nowMs) });
      persistQuietly();
    },
    sweep,
    persist,
    onDeactivate(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    flush() {
      return chain;
    },
  };
}
