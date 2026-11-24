/**
 * The line codec between the server and a folder helper (`server/src/folder-gate/wire.ts`): every value a disk
 * operation gives or takes comes back from one line equal to what went in, `Buffer`, `bigint`, a file system error,
 * a stats snapshot and a directory entry included, and a line never holds a newline.
 */
import { lstatSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskDirent, diskStats } from '../src/folder-gate/types.ts';
import {
  decodeRequest, decodeResponse, encodeRequest, encodeResponse, fromWire, toWire,
} from '../src/folder-gate/wire.ts';

const roundTrip = (value: unknown): unknown => fromWire(JSON.parse(JSON.stringify(toWire(value))));

function fsError(): NodeJS.ErrnoException {
  try {
    lstatSync(path.join(tmpdir(), 'folder-gate-wire-missing', 'x'));
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error('lstat of a missing path did not throw');
}

describe('folder gate wire: values', () => {
  it('a Buffer with every byte value comes back equal', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const back = roundTrip({ bytes, empty: Buffer.alloc(0) }) as { bytes: Buffer; empty: Buffer };
    expect(Buffer.isBuffer(back.bytes)).toBe(true);
    expect(back.bytes.equals(bytes)).toBe(true);
    expect(Buffer.isBuffer(back.empty) && back.empty.length === 0).toBe(true);
  });

  it('bigint dev and ino beyond 2^53 come back exact', () => {
    const value = { dev: 2n ** 63n - 1n, ino: 9007199254740993n, zero: 0n };
    expect(roundTrip(value)).toEqual(value);
  });

  it('a file system error comes back as an Error with code, errno, syscall and path', () => {
    const error = fsError();
    const back = roundTrip(error) as NodeJS.ErrnoException;
    expect(back).toBeInstanceOf(Error);
    expect(back.message).toBe(error.message);
    expect({ code: back.code, errno: back.errno, syscall: back.syscall, path: back.path })
      .toEqual({ code: error.code, errno: error.errno, syscall: error.syscall, path: error.path });
    expect(back.code).toBe('ENOENT');
  });

  it('a stats snapshot comes back with the same fields and the same file type', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fgw-'));
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'abc');
    const stats = diskStats(lstatSync(file, { bigint: true }));
    const back = roundTrip(stats) as typeof stats;
    expect(back.isFile()).toBe(true);
    expect(back.isDirectory() || back.isSymbolicLink()).toBe(false);
    expect([back.dev, back.ino, back.size, back.mode, back.mtimeNs])
      .toEqual([stats.dev, stats.ino, stats.size, stats.mode, stats.mtimeNs]);
    expect(back.mtime.getTime()).toBe(stats.mtime.getTime());
  });

  it('a directory entry with a byte name comes back with the same name and type', () => {
    const entry = diskDirent(Buffer.from([0x61, 0xff]), '/x', 'dir');
    const back = roundTrip([entry]) as (typeof entry)[];
    expect(Buffer.isBuffer(back[0]?.name) && back[0].name.equals(entry.name)).toBe(true);
    expect(back[0]?.parentPath).toBe('/x');
    expect(back[0]?.isDirectory()).toBe(true);
    expect(back[0]?.isFile()).toBe(false);
  });

  it('null, numbers, strings, booleans and nested arrays pass unchanged; undefined drops out', () => {
    const value = { a: null, b: -1.5, c: 'x\ny', d: [true, [false]], e: undefined };
    expect(roundTrip(value)).toEqual({ a: null, b: -1.5, c: 'x\ny', d: [true, [false]] });
  });

  it('a plain object key that starts with "$" is refused, so it cannot pose as a tag', () => {
    expect(() => toWire({ $b64: 'AA==' })).toThrow(/reserved/);
  });
});

describe('folder gate wire: lines', () => {
  it('a request is one line and decodes to the same id, op and args', () => {
    const line = encodeRequest(7, 'writeFile', { path: '/a\nb', data: Buffer.from('x\n'), mode: 0o600, flag: 'wx' });
    expect(line.includes('\n')).toBe(false);
    const back = decodeRequest(line);
    expect(back.id).toBe(7);
    expect(back.op).toBe('writeFile');
    const args = back.args as { path: string; data: Buffer };
    expect(args.path).toBe('/a\nb');
    expect(args.data.equals(Buffer.from('x\n'))).toBe(true);
  });

  it('an answer with a value and an answer with an error decode to the same answer', () => {
    const ok = decodeResponse(encodeResponse(3, { ok: true, value: { ino: 5n } }));
    expect(ok).toEqual({ id: 3, ok: true, value: { ino: 5n } });
    const error = fsError();
    const failed = decodeResponse(encodeResponse(4, { ok: false, error }));
    expect(failed.id).toBe(4);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('expected an error answer');
    expect(failed.error.code).toBe(error.code);
    expect(failed.error.path).toBe(error.path);
  });

  it('a line that is not a message is refused', () => {
    expect(() => decodeResponse('[]')).toThrow();
    expect(() => decodeResponse('{"id":"1","ok":true}')).toThrow();
    expect(() => decodeRequest('{"id":1,"op":7,"args":{}}')).toThrow();
    expect(() => decodeRequest('not json')).toThrow();
  });
});
