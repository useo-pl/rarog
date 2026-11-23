/**
 * After a Rarog decision the `Bash` dump of ANOTHER dialog stays (`otherDialogDump`).
 *
 * A subagent consent waits in the CLI queue (“2 of 2”) behind a main-thread dialog, and the `PermissionRequest` hook
 * fires once, when the CLI decides to ask (CLI 2.1.318, `docs/dialogs.md`, “When the hook gets a request”). A digit
 * or `escape` on the top dialog that deleted the session file unconditionally would bring the subagent consent to the
 * top without content and without buttons. Rule: the dump stays only when the screen before the key shows the whole
 * `Bash` frame with the command of the settled card, and the dump is a `Bash` `PermissionRequest` with another
 * command that does not match this frame. Every other case deletes the dump. Driver runs: `herdr-driver.test.ts`,
 * „zrzut zgody subagenta w kolejce przeżywa decyzję Raroga”.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { otherDialogDump } from '../src/herdr/dialogs/decide/sources.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, `${name}.txt`), 'utf8');
const command = (name: string): string => (
  JSON.parse(readFileSync(join(DIR, `${name}.command.json`), 'utf8')) as { command: string }).command;
const queued = (text: string, title: string, counter: string): string => (
  text.replace(title, `${title}${' '.repeat(30)}${counter}`));

/** Rozstrzygnięty dialog wątku głównego „1 of 2”: cała ramka komendy `M`. */
const M = command('dialog-bash-ask-rule-2.1.295');
const MAIN = queued(screen('dialog-bash-ask-rule-2.1.295'), 'Bash command (unsandboxed)', '1 of 2');
/** Zgoda subagenta w kolejce za nim: komenda `S`. */
const S = command('dialog-bash-subagent-naglowek-2.1.302');
const SUB = screen('dialog-bash-subagent-naglowek-2.1.302');

function dump(cmd: string, extra: Partial<PendingHookTool> = {}): PendingHookTool {
  return {
    toolName: 'Bash', toolInput: { command: cmd }, at: Date.parse('2026-11-04T18:40:37.000Z'),
    hookEventName: 'PermissionRequest', ...extra,
  };
}

describe('otherDialogDump: zrzut innego dialogu zostaje po decyzji', () => {
  it('cała ramka komendy karty, zrzut `Bash` innej komendy: zostaje (także `stale`, także bez licznika)', () => {
    expect(otherDialogDump(dump(S), MAIN, M)).toBe(true);
    expect(otherDialogDump(dump(S, { stale: true }), MAIN, M)).toBe(true);
    expect(otherDialogDump(dump(S), screen('dialog-bash-ask-rule-2.1.295'), M)).toBe(true);
  });

  it('ta sama komenda albo komenda, która pasuje do tej samej ramki: kasowany', () => {
    expect(otherDialogDump(dump(M), MAIN, M)).toBe(false);
    // Inny napis, ta sama ramka (biały znak na końcu): ekran nie odróżnia dialogów, więc zrzut znika.
    expect(otherDialogDump(dump(`${M} `), MAIN, M)).toBe(false);
  });

  it('ekran sprzed klawisza nie dowodzi komendy karty: kasowany', () => {
    const lines = MAIN.split('\n');
    const clipped = lines.slice(lines.findIndex((l) => l.includes('│ P+=("$B"/build'))).join('\n');
    expect(otherDialogDump(dump(S), clipped, M)).toBe(false);
    // Na ekranie stoi już dialog zrzutu (karta nieaktualna, `escape` zamknął właśnie jego).
    expect(otherDialogDump(dump(S), SUB, M)).toBe(false);
    // Tytuł spoza mapy: blok bez tytułu `Bash`.
    expect(otherDialogDump(dump(S), MAIN.replace('Bash command (unsandboxed)', 'Shell command'), M)).toBe(false);
    expect(otherDialogDump(dump(S), null, M)).toBe(false);
  });

  it('karta bez komendy `Bash` (dialog `Edit`, karta z samego ekranu): kasowany', () => {
    expect(otherDialogDump(dump(S), MAIN, null)).toBe(false);
    expect(otherDialogDump(dump(S), readFileSync(join(DIR, 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8'), null))
      .toBe(false);
  });

  it('zrzut inny niż `PermissionRequest` `Bash` albo nieczytelny: kasowany', () => {
    expect(otherDialogDump(dump(S, { hookEventName: 'PreToolUse' }), MAIN, M)).toBe(false);
    expect(otherDialogDump(dump(S, { hookEventName: undefined }), MAIN, M)).toBe(false);
    expect(otherDialogDump(dump(S, { toolName: 'Edit', toolInput: { file_path: '/repo/a.ts' } }), MAIN, M)).toBe(false);
    expect(otherDialogDump(dump(S, { toolInput: { rarogTruncated: true } }), MAIN, M)).toBe(false);
    expect(otherDialogDump(null, MAIN, M)).toBe(false);
  });
});
