/**
 * Golden REST responses, producers of the session file routes: `rest-fixtures-producenci.test.ts` runs them next to
 * its other producers and checks each body against `shared/fixtures/rest/`. The listings come from the listing
 * function (`server/src/files/listing.ts`) over a real directory in the run's temporary directory; the refusals come
 * from the session gate and the path rule and go out through the router's `sendError`, as the routes send them.
 * The `ignored` label is fixed data on the listing: the listing function does not label entries. The index comes
 * from the index walk over the same directory, with fixed data in place of `git ls-files` (the files git would not
 * ignore).
 */
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ZodType } from 'zod';
import type { FileListing } from '@rarog/shared';
import { fileIndexSchema, fileListingSchema, fileTooLargeBodySchema } from '@rarog/shared/rest';
import { SessionFileIndex } from '../src/files/file-index.ts';
import { listSessionDir } from '../src/files/listing.ts';
import { openSessionFile } from '../src/files/path-rule.ts';
import type { Ruled } from '../src/files/path-rule.ts';
import { type FileTooLarge, type FilesRefusal, fileTooLarge } from '../src/files/refusals.ts';
import { filesArea, filesSession } from '../src/files/session-gate.ts';
import { sendError } from '../src/router.ts';
import { Session } from '../src/sessions/session.ts';

interface Captured {
  status: number;
  body: unknown;
}

/** Schema names of the file responses in the manifest (the same names as in `shared/test/rest-fixtures.test.ts`). */
export const FILES_REST_SCHEMAS: Record<string, ZodType> = {
  fileListing: fileListingSchema,
  fileIndex: fileIndexSchema,
  fileTooLargeBody: fileTooLargeBodySchema,
};

/** The limit the golden listings announce: the default of `RAROG_FILES_MAX_MB` (50) in bytes. */
const MAX_BYTES = 50 * 1024 * 1024;
const AT = '2026-10-04T10:00:00.000Z';

/** Entries git would ignore in the sample project (fixed data in place of `check-ignore`). */
const IGNORED: ReadonlySet<string> = new Set(['dist', 'coverage.json']);

/** What `git ls-files` would print for the sample project: every file outside `IGNORED`, hidden ones aside. */
const NOT_IGNORED = [
  'README.md', 'package.json', 'docs/brief.pdf', 'docs/recording.mov', 'src/index.ts', 'src/App.vue', 'src/util.go',
];

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

function valueOf<T>(result: Ruled<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  return result.value;
}

function refusalOf<T>(result: Ruled<T>): FilesRefusal {
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function labelled(listing: FileListing): FileListing {
  return {
    ...listing,
    entries: listing.entries.map((entry) => (IGNORED.has(entry.name) ? { ...entry, ignored: true as const } : entry)),
  };
}

/** One refusal through the router's `sendError`, read back from HTTP. */
async function sent(refusal: FilesRefusal | FileTooLarge): Promise<Captured> {
  const server = http.createServer((_req, res) => {
    if (refusal.status === 413) sendError(res, refusal.status, refusal.code, refusal.sentence, refusal.extra);
    else sendError(res, refusal.status, refusal.code, refusal.sentence);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`);
    return { status: res.status, body: await res.json() as unknown };
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
}

/**
 * The file responses: the listing of the session directory (directories first, ignored entries labelled, hidden
 * ones left out) and of a subdirectory cut short; the index of the session directory without the ignored files;
 * the 413 of a file one byte over the limit; the 400 of a bad path, of a Codex entry and of a pane out of scope; the
 * 404 of a path the server never shows.
 */
export async function produceFilesRest(produced: Map<string, Captured>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'rarog-rest-files-'));
  try {
    const root = path.join(base, 'Projects');
    const cwd = path.join(root, 'atlas');
    await put(path.join(cwd, 'README.md'), '# Atlas\n\nA sample project.\n');
    await put(path.join(cwd, 'package.json'), '{ "name": "atlas", "private": true }\n');
    await put(path.join(cwd, 'coverage.json'), '{}\n');
    await put(path.join(cwd, 'docs', 'brief.pdf'), '%PDF-1.7\n');
    await put(path.join(cwd, 'dist', 'index.js'), 'export {};\n');
    await put(path.join(cwd, 'src', 'index.ts'), 'export const atlas = 1;\n');
    await put(path.join(cwd, 'src', 'App.vue'), '<template><main /></template>\n');
    await put(path.join(cwd, 'src', 'util.go'), 'package util\n');
    await put(path.join(cwd, '.env'), 'TOKEN=synthetic\n');
    await put(path.join(cwd, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    const big = path.join(cwd, 'docs', 'recording.mov');
    await writeFile(big, '');
    await truncate(big, MAX_BYTES + 1);

    const area = valueOf(filesArea(cwd, { demo: false, herdrRoots: [root], home: base }));
    const listing = valueOf(await listSessionDir(area, '', { maxBytes: MAX_BYTES }));
    produced.set('files.list.json', { status: 200, body: labelled(listing) });
    const cut = valueOf(await listSessionDir(area, 'src', { maxBytes: MAX_BYTES, maxEntries: 2 }));
    produced.set('files.list.truncated.json', { status: 200, body: cut });

    const opened = valueOf(await openSessionFile(area, 'docs/recording.mov'));
    await opened.handle.close();
    produced.set('error.file-too-large.json', await sent(fileTooLarge(opened.size, MAX_BYTES)));
    produced.set('error.files-bad-path.json', await sent(refusalOf(await openSessionFile(area, '../atlas/README.md'))));
    produced.set('error.files-not-found.json', await sent(refusalOf(await listSessionDir(area, 'node_modules', {
      maxBytes: MAX_BYTES,
    }))));

    const port = (session: Session): Parameters<typeof filesSession>[1] => ({
      require: () => session, config: { demo: false, herdrRoots: [root], home: base },
    });
    const session = (extra: { engine?: 'codex'; outOfScope?: boolean }): Session => new Session({
      id: 'atlas', cwd, title: 'atlas', state: 'waiting-input', stateSince: AT, createdAt: AT, lastActivityAt: AT,
      herdrKey: 'atlas-1', ...extra,
    });
    const gateRefusal = (one: Session): FilesRefusal => {
      const gate = filesSession('atlas', port(one));
      if (gate.kind !== 'refused') throw new Error(`expected a refusal, got ${gate.kind}`);
      return gate.refusal;
    };
    const indexed = await new SessionFileIndex().index('atlas', MAX_BYTES, {
      ...port(session({})),
      run: () => Promise.resolve({ ok: true, stdout: `${NOT_IGNORED.join('\0')}\0`, exitCode: 0 }),
      demoEntries: () => null,
    });
    produced.set('files.index.json', { status: 200, body: valueOf(indexed) });
    produced.set('error.files-codex.json', await sent(gateRefusal(session({ engine: 'codex' }))));
    produced.set('error.files-out-of-scope.json', await sent(gateRefusal(session({ outOfScope: true }))));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
