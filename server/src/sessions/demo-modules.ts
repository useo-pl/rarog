/**
 * The demo modules of the session manager: seeds, projects, resumable sessions, the fixed diff and the file tree of
 * demo mode, loaded with a dynamic import only when the manager starts in demo mode. The module holds no state and
 * reads no disk; the manager keeps the loaded modules and asks them in its demo branches.
 */
import type {
  Block, DiffFileList, DiffFilePatch, FileEntry, ResumableSession, SessionDiff,
} from '@rarog/shared';
import type { InternalBlock } from '../drivers/types.ts';
import type { DemoSeed } from '../demo/seeds.ts';
import type { DemoContent } from '../demo/content/types.ts';

/**
 * Ziarna trybu demo. Manager dostaje je z zewnątrz zamiast importować statycznie, żeby
 * scenariusze demo nie trafiały do procesu produkcyjnego — ani do jego pamięci, ani do grafu
 * zależności. Drivera dla nich daje mock NADZORCY (`demo/mock-herdr.ts`).
 */
export interface DemoModules {
  readonly demoSeeds: (now: number) => DemoSeed[];
  readonly demoBlocks: (blocks: readonly Block[]) => InternalBlock[];
  readonly demoProjects: () => { path: string; name: string }[];
  readonly demoResumable: (cwd: string, now: number) => ResumableSession[];
  readonly demoDiff: () => SessionDiff;
  readonly demoDiffFiles: () => DiffFileList;
  readonly demoDiffFile: (path: string) => DiffFilePatch | null;
  /** Entries of a directory of the demo file tree (`demo/files.ts`); `null` = no such directory. */
  readonly demoFileEntries: (dir: string) => FileEntry[] | null;
  /** Bytes of a file of the demo file tree (`demo/files.ts`); `null` = no such file. */
  readonly demoFileBytes: (file: string) => Buffer | null;
}

/** Dynamiczny import scenariuszy demo — wołany WYŁĄCZNIE przy `config.demo`; treść z podanego zestawu. */
export async function loadDemoModules(content: DemoContent): Promise<DemoModules> {
  const seeds = await import('../demo/seeds.ts');
  const files = await import('../demo/files.ts');
  return {
    demoSeeds: (now) => seeds.demoSeeds(content, now),
    demoBlocks: seeds.demoBlocks,
    demoProjects: () => seeds.demoProjects(content),
    demoResumable: (cwd, now) => seeds.demoResumable(content, cwd, now),
    demoDiff: () => seeds.demoDiff(content),
    demoDiffFiles: seeds.demoDiffFiles,
    demoDiffFile: (path) => seeds.demoDiffFile(content, path),
    demoFileEntries: files.demoFileEntries,
    demoFileBytes: files.demoFileBytes,
  };
}
