/**
 * Karta zgody spoza kanału hooka (z pliku rozmowy albo z ekranu) nie daje „Zatwierdź”, gdy użytkownik nie widzi
 * całej komendy: tekst ucięty przez serwer (`truncation`) albo ze znakiem z listy „ukryte na karcie”
 * (`CARD_HIDDEN_RANGES`, `server/src/hidden-chars.ts`) → `canAllow: false` i `allow` odmawia.
 * Tekst wielowierszowy i emoji złożone łącznikiem U+200D zostają jak dotąd.
 *
 * Karty powstają prawdziwym budowniczym ścieżki pliku rozmowy (`decisionCard`) i ekranu (`screenPermissionCard`),
 * manager i nadzorca to atrapy z `helpers/manager-herdr-atrapy.ts`. Znaki ukryte powstają z kodów, nie z literałów.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest } from '@rarog/shared';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { decisionCard, screenPermissionCard } from '../src/herdr/dialogs/cards/build.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { MAX_DISPLAY_TEXT } from '../src/drivers/tool-text.ts';
import { visibleLine } from '../src/herdr/hook-config.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const char = (code: number): string => String.fromCodePoint(code);

const OPTIONS = [
  { label: 'Yes', digit: '1' },
  { label: "Yes, and don't ask again for echo commands", digit: '2' },
  { label: 'No', digit: '3' },
] as const;

/** Karta z pliku rozmowy: `tool_use` z pełnym inputem, cyfry z ekranu. */
function jsonlCard(reqId: string, toolName: string, input: unknown): DriverEvent {
  return decisionCard(reqId, { id: reqId, toolName, input, at: '' }, 'tool', OPTIONS, null).event;
}

describe('karta spoza kanału hooka bez „Zatwierdź” przy niepełnym tekście', () => {
  let dataDir: string;
  let manager: Manager | null = null;
  let supervisor: FakeSupervisor | null = null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-k2-'));
  });

  afterEach(async () => {
    await manager?.dispose();
    supervisor?.dispose();
    manager = null;
    supervisor = null;
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Jedna sesja herdr, na którą driver wystawia kartę; wraca karta, którą manager oddał telefonowi. */
  async function cardFor(event: DriverEvent): Promise<{ card: PermissionRequest; id: string; m: Manager }> {
    supervisor = new FakeSupervisor();
    manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
    });
    await manager.ready;
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    supervisor.driver('w9:p72').queue.push(event);
    await flush();
    const card = manager.transcript(id).pendingPermissions[0];
    if (card === undefined) throw new Error('brak karty zgody');
    return { card, id, m: manager };
  }

  async function allowRefused(m: Manager, id: string, permId: string): Promise<boolean> {
    const err = await Promise.resolve()
      .then(() => m.resolvePermission(id, permId, 'allow', 'iphone'))
      .then(() => null, (e: unknown) => e);
    return err instanceof Error;
  }

  it('`Bash` z pliku rozmowy, komenda 20 001 znaków → `canAllow: false`, `truncation`, `allow` odmowa', async () => {
    const command = `echo ${'a'.repeat(MAX_DISPLAY_TEXT + 1 - 5)}`;
    expect(command).toHaveLength(20_001);
    const { card, id, m } = await cardFor(jsonlCard('toolu_k2_1', 'Bash', { command }));
    expect(card.truncation).toBeDefined();
    expect(card.canAllow).toBe(false);
    expect(card.alwaysLabel).toBeUndefined();
    expect(await allowRefused(m, id, 'toolu_k2_1')).toBe(true);
    expect(supervisor?.log.sterowanie()).toEqual([]);
  });

  it('komenda 20 000 znaków → bez ucięcia, `canAllow` jak dotąd', async () => {
    const command = `echo ${'a'.repeat(MAX_DISPLAY_TEXT - 5)}`;
    expect(command).toHaveLength(20_000);
    const { card } = await cardFor(jsonlCard('toolu_k2_2', 'Bash', { command }));
    expect(card.truncation).toBeUndefined();
    expect(card.canAllow).toBe(true);
    expect(card.alwaysLabel).toBe("Yes, and don't ask again for echo commands");
  });

  it.each([
    ['U+202E (odwrócenie kierunku)', `echo ${char(0x202e)}gnp.exe`],
    ['U+200B (spacja zerowej szerokości)', `rm${char(0x200b)} -rf build`],
  ])('komenda ze znakiem %s → `canAllow: false`, `allow` odmawia', async (_name, command) => {
    const { card, id, m } = await cardFor(jsonlCard('toolu_k2_3', 'Bash', { command }));
    expect(card.truncation).toBeUndefined();
    expect(card.canAllow).toBe(false);
    expect(card.alwaysLabel).toBeUndefined();
    expect(await allowRefused(m, id, 'toolu_k2_3')).toBe(true);
  });

  it('karta z ekranu ze znakiem U+202E → `canAllow: false`', async () => {
    const event = screenPermissionCard({
      header: 'Bash command',
      question: `echo ${char(0x202e)}gnp.exe\nDo you want to proceed?`,
      options: OPTIONS,
      toolName: 'Bash',
      dialogIdentity: { kind: 'tool', identity: { kind: 'title', tool: 'Bash' } },
    }, 1).event;
    const { card } = await cardFor(event);
    expect(card.canAllow).toBe(false);
  });

  it.each([
    ['wielowierszowy `Bash` (heredok)', 'Bash', { command: "cat > notes.txt <<'EOF'\nlinia 1\nlinia 2\nEOF" }],
    ['`Write`', 'Write', { file_path: `${PROJECT}/a.ts`, content: 'export const a = 1;\nexport const b = 2;\n' }],
    ['`Edit`', 'Edit', { file_path: `${PROJECT}/a.ts`, old_string: 'a = 1', new_string: 'a = 2\nb = 3' }],
    ['narzędzie MCP z wielowierszowym JSON-em', 'mcp__docs__search',
      { query: 'hooks', filters: { lang: 'en', max: 5 } }],
    ['emoji złożone łącznikiem U+200D', 'Bash',
      { command: `echo ${char(0x1f468)}${char(0x200d)}${char(0x1f469)}${char(0x200d)}${char(0x1f467)}` }],
  ])('%s → `canAllow: true` jak dotąd', async (_name, toolName, input) => {
    const { card } = await cardFor(jsonlCard('toolu_k2_4', toolName, input));
    expect(card.truncation).toBeUndefined();
    expect(card.canAllow).toBe(true);
  });

  it('różnica plików w `rarog setup` pokazuje te same znaki co przed zmianą (nowa linia, U+200D, U+202E)', () => {
    expect(visibleLine(`a${char(0x0a)}b${char(0x200d)}c${char(0x202e)}d\te`))
      .toBe('a\\u{a}b\\u{200d}c\\u{202e}d\te');
  });
});
