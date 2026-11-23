/**
 * Niepusty, kontrolowany magazyn sesji Claude Code dla kontraktu `listSessions` (`sdk-boundary.test.ts`,
 * `sdk-install-live.test.ts`): `<katalog konfiguracji>/projects/<zakodowany cwd>/<uuid>.jsonl` z jedną wymianą
 * w kształcie plików Claude Code. Lista biegnie w osobnym procesie ({@link listInChild}), bo SDK bierze katalog magazynu
 * z `CLAUDE_CONFIG_DIR` w środowisku procesu, a proces testów ma prawdziwy magazyn właściciela.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const CHILD = path.join(import.meta.dirname, 'sdk-lista-proces.ts');

/** Sesja z magazynu kontrolnego. */
export const STORE_SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const STORE_FIRST_PROMPT = 'Pierwszy prompt kontrolny';

/** Pisze magazyn z jedną sesją w katalogu `cwd`; zwraca `cwd` po `realpath` (SDK koduje ścieżkę rzeczywistą). */
export function writeSessionStore(configDir: string, cwd: string): string {
  const real = realpathSync(cwd);
  const dir = path.join(configDir, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const timestamp = '2026-11-01T10:00:00.000Z';
  const common = { sessionId: STORE_SESSION_ID, cwd: real, timestamp, isSidechain: false, userType: 'external' };
  const lines = [
    {
      ...common, type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', parentUuid: null, gitBranch: 'main',
      message: { role: 'user', content: STORE_FIRST_PROMPT },
    },
    {
      ...common, type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
      parentUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Odpowiedź' }] },
    },
  ];
  writeFileSync(path.join(dir, `${STORE_SESSION_ID}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return real;
}

/** Skąd proces potomny bierze SDK: pakiet workspace albo katalog wersji trybu paczki (`importSdkFrom`). */
export type SdkSource = { readonly workspace: true } | { readonly versionDir: string; readonly version: string };

/** Wynik listy z procesu potomnego: tablica wpisów albo opis porażki. */
export type ChildList = { readonly ok: true; readonly sessions: unknown[] } | { readonly ok: false; readonly reason: string };

/**
 * `listSessions({ dir, limit: 3, includeProgrammatic: false, includeWorktrees: false })` w osobnym procesie
 * z `CLAUDE_CONFIG_DIR` i `HOME` w katalogu tymczasowym testu.
 */
export function listInChild(source: SdkSource, configDir: string, home: string, dir: string): ChildList {
  const args = 'workspace' in source ? ['workspace', dir] : ['katalog', source.versionDir, source.version, dir];
  const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: configDir,
      ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
    },
  });
  const line = (run.stdout ?? '').split('\n').find((text) => text.startsWith('{'));
  const parsed = line === undefined ? {} : JSON.parse(line) as { sessions?: unknown; error?: string };
  if (run.status === 0 && Array.isArray(parsed.sessions)) return { ok: true, sessions: parsed.sessions };
  return {
    ok: false,
    reason: `kod ${String(run.status)}: ${parsed.error ?? run.error?.message ?? ''} ${run.stderr ?? ''}`.trim(),
  };
}
