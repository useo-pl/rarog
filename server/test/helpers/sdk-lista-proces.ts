/**
 * Proces potomny `listInChild` (`sdk-magazyn.ts`): ładuje SDK z workspace albo z katalogu wersji (`importSdkFrom`,
 * ta sama droga co serwer w trybie paczki), woła `listSessions` z opcjami serwera i pisze jedną linię JSON.
 *
 * argv: `workspace <dir>` albo `katalog <katalog wersji> <wersja> <dir>`.
 */
import { importSdkFrom } from '../../src/install/sdk.ts';
import type { ListSessionsFn } from '../../src/install/sdk.ts';

const [kind, ...rest] = process.argv.slice(2);

async function load(): Promise<{ fn: ListSessionsFn; dir: string }> {
  if (kind === 'workspace') {
    const loaded = await import('@anthropic-ai/claude-agent-sdk');
    return { fn: loaded.listSessions, dir: rest[0] ?? '' };
  }
  const [versionDir = '', version = '', dir = ''] = rest;
  return { fn: await importSdkFrom(versionDir, version), dir };
}

function finish(payload: unknown, code: number): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`, () => { process.exit(code); });
}

try {
  const { fn, dir } = await load();
  const sessions = await fn({ dir, limit: 3, includeProgrammatic: false, includeWorktrees: false });
  finish({ sessions }, 0);
} catch (failure) {
  finish({ error: failure instanceof Error ? failure.message : String(failure) }, 1);
}
