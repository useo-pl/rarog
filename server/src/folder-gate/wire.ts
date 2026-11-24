/**
 * The line codec between the server and a folder helper: one JSON object per line, a request `{id, op, args}` and an
 * answer `{id, ok: true, value}` or `{id, ok: false, error}`. Values JSON cannot carry travel as one-key tags:
 * `Buffer` as `{"$b64": …}`, `bigint` as `{"$big": "…"}`, a file system error as `{"$err": …}` with `code`,
 * `errno`, `syscall`, `path` and `dest`, and the port's `DiskStats` and `DiskDirent` snapshots. A plain object key
 * that starts with `$` is refused, so data cannot pose as a tag. The module never touches the disk or a process.
 */
import {
  DiskDirent, type DiskEntryType, type DiskOp, DiskStats, STATS_FIELDS, type StatsField,
} from './types.ts';

/** Every operation a request may name; the record keeps the list complete against `DiskOp`. */
const OPS: Readonly<Record<DiskOp, true>> = {
  lstat: true, stat: true, readlink: true, realpath: true, realpathNative: true, readdir: true, readdirNames: true,
  readHead: true, readdirByIdentity: true, openRead: true, read: true, close: true, mkdir: true, writeFile: true,
  appendRegular: true, chmod: true, unlink: true, check: true,
};

const ENTRY_TYPES: ReadonlySet<string> = new Set<DiskEntryType>(
  ['file', 'dir', 'link', 'fifo', 'socket', 'block', 'char', 'unknown'],
);

const ERROR_FIELDS = ['code', 'errno', 'syscall', 'path', 'dest'] as const;

type Tree = null | boolean | number | string | Tree[] | { [key: string]: Tree };

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** `value` as a JSON-safe tree; `undefined` drops out of objects. Throws on a value the wire cannot carry. */
export function toWire(value: unknown): Tree | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('folder gate wire: a number must be finite');
    return value;
  }
  if (typeof value === 'bigint') return { $big: value.toString() };
  if (typeof value !== 'object') throw new TypeError(`folder gate wire: cannot carry a ${typeof value}`);
  if (Buffer.isBuffer(value)) return { $b64: value.toString('base64') };
  if (value instanceof DiskStats) {
    const fields: Record<string, Tree> = {};
    for (const field of STATS_FIELDS) fields[field] = value[field].toString();
    return { $stats: fields };
  }
  if (value instanceof DiskDirent) {
    return { $dirent: { name: toWire(value.name) ?? null, parentPath: value.parentPath, type: value.type } };
  }
  if (value instanceof Error) {
    const error: Record<string, Tree> = { message: value.message };
    for (const field of ERROR_FIELDS) {
      const one = (value as unknown as Record<string, unknown>)[field];
      if (typeof one === 'string' || typeof one === 'number') error[field] = one;
    }
    return { $err: error };
  }
  if (Array.isArray(value)) return value.map((item) => toWire(item) ?? null);
  if (!isPlainObject(value)) throw new TypeError('folder gate wire: cannot carry a class instance');
  const out: Record<string, Tree> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$')) throw new TypeError(`folder gate wire: the key ${key} is reserved for tags`);
    const encoded = toWire(item);
    if (encoded !== undefined) out[key] = encoded;
  }
  return out;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`folder gate wire: ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`folder gate wire: ${what} must be a string`);
  return value;
}

function decodeTag(tag: string, body: unknown): unknown {
  switch (tag) {
    case '$b64':
      return Buffer.from(text(body, '$b64'), 'base64');
    case '$big':
      return BigInt(text(body, '$big'));
    case '$stats': {
      const fields = record(body, '$stats');
      const values = {} as Record<StatsField, bigint>;
      for (const field of STATS_FIELDS) values[field] = BigInt(text(fields[field], `$stats.${field}`));
      return new DiskStats(values);
    }
    case '$dirent': {
      const entry = record(body, '$dirent');
      const name = fromWire(entry.name);
      if (typeof name !== 'string' && !Buffer.isBuffer(name)) {
        throw new TypeError('folder gate wire: $dirent.name must be a string or bytes');
      }
      const type = text(entry.type, '$dirent.type');
      if (!ENTRY_TYPES.has(type)) throw new TypeError(`folder gate wire: unknown entry type ${type}`);
      return new DiskDirent(name, text(entry.parentPath, '$dirent.parentPath'), type as DiskEntryType);
    }
    case '$err': {
      const fields = record(body, '$err');
      const error = new Error(text(fields.message, '$err.message'));
      const target = error as unknown as Record<string, unknown>;
      for (const field of ERROR_FIELDS) {
        const one = fields[field];
        if (typeof one === 'string' || typeof one === 'number') target[field] = one;
      }
      return error;
    }
    default:
      throw new TypeError(`folder gate wire: unknown tag ${tag}`);
  }
}

/** The value a tree from {@link toWire} stands for. Throws on a malformed tree. */
export function fromWire(tree: unknown): unknown {
  if (tree === null || typeof tree !== 'object') return tree;
  if (Array.isArray(tree)) return tree.map(fromWire);
  const entries = Object.entries(tree);
  const [first] = entries;
  if (entries.length === 1 && first !== undefined && first[0].startsWith('$')) return decodeTag(first[0], first[1]);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (key.startsWith('$')) throw new TypeError(`folder gate wire: the key ${key} is reserved for tags`);
    out[key] = fromWire(item);
  }
  return out;
}

export interface WireRequest {
  readonly id: number;
  readonly op: DiskOp;
  readonly args: unknown;
}

export type WireResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: NodeJS.ErrnoException };

/** JSON never writes a raw newline, so the result is one line; the caller adds the `\n`. */
const line = (message: Record<string, unknown>): string => JSON.stringify(toWire(message));

function parsed(input: string): Record<string, unknown> {
  const message = record(JSON.parse(input), 'a message');
  if (!Number.isSafeInteger(message.id)) throw new TypeError('folder gate wire: id must be an integer');
  return message;
}

export function encodeRequest(id: number, op: DiskOp, args: unknown): string {
  return line({ id, op, args });
}

export function decodeRequest(input: string): WireRequest {
  const message = parsed(input);
  const op = message.op;
  if (typeof op !== 'string' || !Object.hasOwn(OPS, op)) throw new TypeError('folder gate wire: unknown op');
  return { id: message.id as number, op: op as DiskOp, args: fromWire(message.args) };
}

export function encodeResponse(
  id: number, answer: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error },
): string {
  return answer.ok ? line({ id, ok: true, value: answer.value }) : line({ id, ok: false, error: answer.error });
}

export function decodeResponse(input: string): WireResponse {
  const message = parsed(input);
  const id = message.id as number;
  if (message.ok === true) return { id, ok: true, value: fromWire(message.value) };
  if (message.ok !== false) throw new TypeError('folder gate wire: ok must be a boolean');
  const error = fromWire(message.error);
  if (!(error instanceof Error)) throw new TypeError('folder gate wire: an error answer must carry an error');
  return { id, ok: false, error: error as NodeJS.ErrnoException };
}
