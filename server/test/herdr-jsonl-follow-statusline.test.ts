/**
 * Odczyt zrzutu status line przy otwarciu pliku a `repoint()` (`herdr/jsonl-follow.ts`, `#readStatusline`).
 *
 * Osobny plik, bo test potrzebuje atrapy `readStatusline`, która WSTRZYMUJE odczyt jednej sesji silnika: tylko tak
 * da się postawić `repoint()` w chwili, gdy odczyt zrzutu poprzedniej sesji jeszcze trwa. Pozostałe sesje czyta
 * prawdziwa funkcja, z prawdziwego katalogu tymczasowego.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';

/** Sesja, której odczyt zrzutu atrapa wstrzymuje, i wyzwalacz, który go kończy (`null`). */
const gate = vi.hoisted(() => ({
  held: '' as string,
  release: null as (() => void) | null,
}));

vi.mock('../src/herdr/statusline.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/herdr/statusline.ts')>();
  return {
    ...actual,
    readStatusline: async (root: string, engineSessionId: string) => {
      if (engineSessionId === gate.held) {
        await new Promise<void>((resolve) => { gate.release = resolve; });
        return null;
      }
      return actual.readStatusline(root, engineSessionId);
    },
  };
});

vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';
/** Długi tik `stat`: limitu nie ma prawa poprawić tik, tylko odczyt przy otwarciu pliku. */
const TIMING = {
  batchMs: 15, statTickMs: 5_000, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16,
};

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-follow-statusline-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
  gate.held = '';
  gate.release = null;
});

afterEach(async () => {
  gate.release?.();
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

const filePath = (session: string): string => join(dir, `${session}.jsonl`);

/** Zapis obok i `rename`: follower widzi albo brak pliku, albo plik z pełną treścią. */
const createFile = async (path: string, content: string): Promise<void> => {
  await writeFile(`${path}.partial`, content);
  await rename(`${path}.partial`, path);
};

const userLine = (text: string, session: string): string => `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: text },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z',
  sessionId: session,
})}\n`;

/** Wypowiedź asystenta z sumą okna; `claude-opus-5` jest spoza `KNOWN_CONTEXT_LIMITS`. */
const usageLine = (sum: number, session: string): string => `${JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  timestamp: '2026-08-22T10:00:05.000Z',
  sessionId: session,
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: `tura ${String(sum)}` }],
    usage: { input_tokens: sum, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  },
})}\n`;

const dumpStatusline = async (size: number, session: string): Promise<void> => {
  const statusDir = join(root, 'statusline');
  await mkdir(statusDir, { recursive: true });
  await createFile(join(statusDir, `${session}.json`), JSON.stringify({
    session_id: session,
    model: { id: 'claude-opus-5' },
    context_window: { context_window_size: size, used_percentage: 5 },
  }));
};

const usages = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'usage' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'usage' }> => e.type === 'usage');

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

describe('zrzut status line przy otwarciu pliku', () => {
  /**
   * `/clear` w chwili, gdy odczyt zrzutu poprzedniej sesji jeszcze trwa: otwarcie pliku NOWEJ sesji czyta jej
   * własny zrzut, a nie wraca z pustymi rękami na blokadzie starego odczytu.
   */
  it('repoint w trakcie odczytu zrzutu starej sesji: pierwszy stan nowej ma limit z JEJ zrzutu', async () => {
    gate.held = SESSION;
    await createFile(filePath(SESSION), userLine('stara rozmowa', SESSION));
    await dumpStatusline(1_000_000, SESSION_B);
    await createFile(filePath(SESSION_B), userLine('nowa rozmowa', SESSION_B) + usageLine(340_000, SESSION_B));

    const follower = createJsonlFollower({
      cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING,
      statuslineRoot: join(root, 'statusline'),
    });
    followers.push(follower);
    const events: FollowEvent[] = [];
    void (async () => {
      for await (const event of follower.events) events.push(event);
    })();

    await waitFor(() => gate.release !== null, 'wstrzymany odczyt zrzutu starej sesji');
    follower.repoint(SESSION_B);
    await waitFor(() => usages(events).length > 0, 'stan okna nowej sesji');

    expect(usages(events)[0]?.context).toEqual({
      kind: 'known', tokens: 340_000, limit: 1_000_000, source: 'statusline',
    });
    // Koniec starego odczytu nie zdejmuje blokady nowego i nie dokłada stanu starej sesji.
    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(usages(events)).toHaveLength(1);
  });
});
