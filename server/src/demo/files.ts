/**
 * The file tree of the demo sessions: one fixed project that every demo session lists through
 * `GET /api/sessions/:id/files` and downloads a file of through `GET /api/sessions/:id/files/raw`, with no disk and
 * no git. It agrees with the demo diff (`DEMO_DIFF_FILES` of the mock driver): the added and the modified file stand
 * in `src`, the deleted one does not.
 */
import { compareFileEntries } from '@rarog/shared';
import type { FileEntry } from '@rarog/shared';

/** Path of every file of the demo project → its text; a directory is every leading part of a path. */
export const DEMO_FILES: Readonly<Record<string, string>> = {
  'README.md': '# notes\n\nA small notes service: write, list and remove notes.\n',
  'package.json': '{\n  "name": "notes",\n  "private": true,\n  "type": "module"\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true,\n    "outDir": "dist"\n  }\n}\n',
  'docs/guide.md': '# Guide\n\nRun the tests before every release.\n',
  'src/index.ts': "export { addNote, listNotes } from './notes.ts';\n",
  'src/notes.ts': 'export const listNotes = (): string[] => [];\nexport const addNote = (text: string): string => text;\n',
  'src/notes.test.ts': "import { listNotes } from './notes.ts';\n\nconsole.assert(listNotes().length === 0);\n",
  'dist/index.js': "export { addNote, listNotes } from './notes.js';\n",
  'dist/notes.js': 'export const listNotes = () => [];\nexport const addNote = (text) => text;\n',
};

/** Directories git ignores in the demo project (its `.gitignore` names `dist/`), with everything under them. */
const IGNORED_DIRS: readonly string[] = ['dist'];

const isIgnored = (rel: string): boolean => IGNORED_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));

/**
 * The entries of the directory `dir` of the demo project (`''` = the session directory), in the order of a listing;
 * `null` when the project has no such directory.
 */
export function demoFileEntries(dir: string): FileEntry[] | null {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, FileEntry>();
  for (const [file, text] of Object.entries(DEMO_FILES)) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const label = isIgnored(`${prefix}${name}`) ? { ignored: true as const } : {};
    entries.set(name, slash === -1
      ? { name, kind: 'file', size: Buffer.byteLength(text, 'utf8'), ...label }
      : { name, kind: 'dir', ...label });
  }
  if (entries.size === 0) return dir === '' ? [] : null;
  return [...entries.values()].sort(compareFileEntries);
}

/** The bytes of the file `rel` of the demo project (its UTF-8 text); `null` when the project has no such file. */
export function demoFileBytes(rel: string): Buffer | null {
  const text = Object.hasOwn(DEMO_FILES, rel) ? DEMO_FILES[rel] : undefined;
  return text === undefined ? null : Buffer.from(text, 'utf8');
}
