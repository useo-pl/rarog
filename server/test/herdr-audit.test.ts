/**
 * Audit log wysyłek do cudzych paneli.
 *
 * Dwie własności są tu ważniejsze niż sam format: dziennik NIE zawiera pełnej treści
 * wiadomości (tylko sha256 + 200 znaków) i NIE blokuje wysyłki, gdy zapis padnie. Log jest do
 * śledztwa, nie do autoryzacji — odwrotna decyzja zamieniłaby brak miejsca na dysku w awarię
 * całej integracji.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFUSE_MESSAGES, REFUSE_REASONS, refuseReasonSchema } from '@rarog/shared';
import {
  HERDR_AUDIT_TEXT_HEAD, HERDR_REFUSE_REASONS, NON_DRIVER_REFUSE_REASONS, REFUSALS_WINDOW_DAYS, SHADOW_DETAILS,
  createHerdrAuditLog,
  herdrAuditPath, redactAuditText, shadowAuditFields, summarizeCommandRefusals, summarizeDegradeShapes,
  summarizeRefusals,
} from '../src/herdr/audit.ts';
import { NO_PROOF_REASONS } from '../src/herdr/dialogs/shadow/evidence.ts';
import { BLOCK_CARD_VERDICTS, blockCardRecord } from '../src/herdr/dialogs/cards/build.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { LAYER2_WHYS } from '../src/herdr/dialogs/layer2/card.ts';

let dataDir = '';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-audit-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const baseEvent = {
  sessionId: '11111111-2222-5333-8444-555555555555',
  key: 'w9:p72',
  paneId: 'w9:p72',
  cwd: '/Users/u/Projects/atlas',
  mode: 'auto' as const,
};

/** Wszystkie wpisy dziennika jako obiekty. */
async function readEntries(dir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(herdrAuditPath(dir), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createHerdrAuditLog', () => {
  it('zapisuje wpis dla `prompt` i dla `send_keys`', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'prompt', text: 'napraw testy' });
    audit.log({ ...baseEvent, method: 'send_keys', keys: ['ctrl+c'] });
    await audit.flush();

    const entries = await readEntries(dataDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      sessionId: baseEvent.sessionId,
      key: 'w9:p72',
      paneId: 'w9:p72',
      cwd: '/Users/u/Projects/atlas',
      method: 'prompt',
      mode: 'auto',
      textHead: 'napraw testy',
    });
    expect(entries[0]?.['textSha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[1]).toMatchObject({ method: 'send_keys', keys: ['ctrl+c'] });
    expect(entries[1]?.['textHead']).toBeUndefined();
  });

  it('zapisuje wyłącznie 200 znaków tekstu — pełna treść NIE trafia do pliku', async () => {
    const secretTail = 'TAJNE-HASLO-NA-KONCU';
    const text = `${'a'.repeat(HERDR_AUDIT_TEXT_HEAD)}${secretTail}`;
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'prompt', text });
    await audit.flush();

    const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
    expect(raw).not.toContain(secretTail);
    const entries = await readEntries(dataDir);
    expect(entries[0]?.['textHead']).toHaveLength(HERDR_AUDIT_TEXT_HEAD);
  });

  it('plik powstaje z prawami 0600', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'prompt', text: 'x' });
    await audit.flush();
    const info = await stat(herdrAuditPath(dataDir));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('rotuje plik po przekroczeniu progu (jedna generacja wstecz)', async () => {
    const audit = createHerdrAuditLog({ dataDir, maxBytes: 300 });
    for (let i = 0; i < 6; i += 1) {
      audit.log({ ...baseEvent, method: 'prompt', text: `wiadomość ${i}` });
    }
    await audit.flush();

    const rotated = await stat(`${herdrAuditPath(dataDir)}.1`);
    expect(rotated.size).toBeGreaterThan(0);
    const current = await readEntries(dataDir);
    // Po rotacji bieżący plik ma tylko ogon — reszta jest w `.log.1`.
    expect(current.length).toBeLessThan(6);
  });

  it('błąd zapisu nie propaguje się do wywołującego (wysyłka ma iść dalej)', async () => {
    // `dataDir` wskazuje ŚCIEŻKĘ POD PLIKIEM — `mkdir` musi paść.
    const blocker = join(dataDir, 'blocker');
    await writeFile(blocker, 'nie katalog', 'utf8');
    const audit = createHerdrAuditLog({ dataDir: join(blocker, 'nested') });

    expect(() => audit.log({ ...baseEvent, method: 'prompt', text: 'x' })).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
  });

  it('przyjmuje wpis bez `sessionId` i z własnym czasem (driver loguje sam z siebie)', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      at: '2026-08-22T20:00:00.000Z',
      key: 'w9:p72',
      paneId: 'w9:p72',
      cwd: '/Users/u/Projects/atlas',
      method: 'send_keys',
      mode: 'manual',
      keys: ['escape'],
    });
    await audit.flush();

    const entries = await readEntries(dataDir);
    expect(entries[0]).toMatchObject({ ts: '2026-08-22T20:00:00.000Z', sessionId: null });
  });

  it('wpis `approve` odpowiada na pytanie „CO zatwierdzono", nie tylko „jaką cyfrę"', async () => {
    /*
     * To jest cały powód istnienia osobnej metody. Numeracja opcji bywa przetasowana,
     * więc `keys: ['1']` po kradzieży telefonu nie znaczy nic. Dopiero nazwa narzędzia
     * i etykieta WYBRANEJ opcji dają się przeczytać po fakcie.
     */
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent,
      method: 'approve',
      keys: ['3'],
      reqId: 'toolu_01ABCdefGHIjklMNOpqrs',
      toolName: 'Bash',
      optionLabel: 'No, and tell Claude what to do differently (esc)',
      digit: '3',
    });
    await audit.flush();

    const entries = await readEntries(dataDir);
    expect(entries[0]).toMatchObject({
      method: 'approve',
      keys: ['3'],
      reqId: 'toolu_01ABCdefGHIjklMNOpqrs',
      toolName: 'Bash',
      optionLabel: 'No, and tell Claude what to do differently (esc)',
      digit: '3',
    });
  });

  it('wpis `launch` niesie argv i tabId, ale NIGDY treści promptu', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent,
      method: 'launch',
      tabId: 'w9:t3',
      argv: ['--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'sonnet'],
    });
    await audit.flush();

    const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
    const entries = await readEntries(dataDir);
    expect(entries[0]).toMatchObject({
      method: 'launch',
      tabId: 'w9:t3',
      argv: ['--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'sonnet'],
    });
    /*
     * Prompt nie ma jak się tu znaleźć — nie wchodzi do argv, tylko jedzie
     * `agent.prompt`. Ten test pilnuje, że tak zostanie także wtedy, gdy ktoś kiedyś
     * zechce „dla wygody" dopisać zdanie użytkownika do wpisu uruchomienia.
     */
    expect(raw).not.toContain('textHead');
  });

  it('wpis `close_tab` mówi, KTÓRY tab zamknięto', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'close_tab', tabId: 'w9:t3' });
    await audit.flush();

    expect((await readEntries(dataDir))[0]).toMatchObject({ method: 'close_tab', tabId: 'w9:t3' });
  });

  it('pola decyzji nie pojawiają się we wpisach, które ich nie mają', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'send_keys', keys: ['escape'] });
    await audit.flush();

    const entry = (await readEntries(dataDir))[0] ?? {};
    for (const field of ['reqId', 'toolName', 'optionLabel', 'digit', 'tabId', 'argv', 'chars']) {
      expect(entry[field]).toBeUndefined();
    }
  });

  it('etykieta opcji jest przycięta jak tekst promptu (niesie ścieżkę projektu)', async () => {
    const tail = 'OGON-KTOREGO-NIE-MA-W-PLIKU';
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent,
      method: 'approve',
      optionLabel: `${'b'.repeat(HERDR_AUDIT_TEXT_HEAD)}${tail}`,
      digit: '1',
    });
    await audit.flush();

    const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
    expect(raw).not.toContain(tail);
  });

  /*
   * A cut to 200 characters takes from the END, so it alone would let the very shape it guards against
   * ("a command line can carry a token in an environment variable") through whole: the secret stands at the START of
   * the line. The log is the file the "phone theft" runbook says to review — it must not be a leak itself.
   */
  describe('redakcja tekstu na drodze do pliku', () => {
    it('prefiks zmiennej środowiskowej gubi WARTOŚĆ, zachowuje NAZWĘ', async () => {
      const secret = 'fikcyjny-token-audytu-0123456789';
      const command = `SONIOX_API_KEY=${secret} pnpm run restart`;
      // Kontrola założenia: przycięcie nie ma tu czego uciąć — ochroną jest sama redakcja.
      expect(command.length).toBeLessThan(HERDR_AUDIT_TEXT_HEAD);

      const audit = createHerdrAuditLog({ dataDir });
      audit.log({
        key: 'w9:t7', paneId: 'w9:p9', cwd: '/Users/u/Projects/atlas',
        method: 'prompt', mode: 'unknown', tabId: 'w9:t7', text: command,
      });
      await audit.flush();

      const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
      expect(raw).not.toContain(secret);
      const entries = await readEntries(dataDir);
      // Śledztwo nadal widzi, KTÓRA zmienna została podstawiona i do jakiej komendy.
      expect(entries[0]?.['textHead']).toBe('SONIOX_API_KEY=[ukryte] pnpm run restart');
    });

    it('hash liczy się z ORYGINAŁU — dwa te same wpisy dalej się zgadzają', async () => {
      const command = 'AWS_SECRET_ACCESS_KEY=abcdefghijkl aws s3 ls';
      const audit = createHerdrAuditLog({ dataDir, secrets: ['abcdefghijkl'] });
      audit.log({ ...baseEvent, method: 'prompt', text: command });
      audit.log({ ...baseEvent, method: 'prompt', text: command });
      await audit.flush();

      const entries = await readEntries(dataDir);
      const expected = createHash('sha256').update(command, 'utf8').digest('hex');
      expect(entries[0]?.['textSha256']).toBe(expected);
      expect(entries[1]?.['textSha256']).toBe(expected);
    });

    it('sekret procesu ginie także POZA kształtem przypisania', async () => {
      const token = 'sekret-procesu-9876543210';
      const audit = createHerdrAuditLog({ dataDir, secrets: [token] });
      audit.log({
        ...baseEvent,
        method: 'prompt',
        text: `curl -H "Authorization: Bearer ${token}" https://example.test`,
      });
      await audit.flush();

      const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
      expect(raw).not.toContain(token);
      expect(raw).toContain('[ukryte]');
    });

    it('sekret na granicy 200 znaków ginie w CAŁOŚCI (redakcja przed przycięciem)', async () => {
      // Gdyby redakcja szła po przycięciu, w pliku zostałby początek sekretu — dokładnie ten
      // fragment, który wystarcza do rozpoznania go w innym miejscu.
      const token = 'granica-sekretu-abcdefghij';
      const audit = createHerdrAuditLog({ dataDir, secrets: [token] });
      audit.log({
        ...baseEvent,
        method: 'prompt',
        text: `${'z'.repeat(HERDR_AUDIT_TEXT_HEAD - 10)}${token} reszta`,
      });
      await audit.flush();

      const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
      expect(raw).not.toContain('granica');
    });

    it('etykieta opcji przechodzi tę samą redakcję co tekst', async () => {
      const secret = 'etykieta-token-2468';
      const audit = createHerdrAuditLog({ dataDir, secrets: [secret] });
      audit.log({
        ...baseEvent,
        method: 'approve',
        toolName: 'Bash',
        optionLabel: `Yes, run Bash(DEPLOY_KEY=${secret} ./deploy.sh)`,
        digit: '1',
      });
      await audit.flush();

      const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
      expect(raw).not.toContain(secret);
      expect((await readEntries(dataDir))[0]?.['optionLabel'])
        .toBe('Yes, run Bash(DEPLOY_KEY=[ukryte] ./deploy.sh)');
    });

    it('bez listy sekretów dziennik dalej maskuje kształt przypisania', async () => {
      // Fabryka bywa wołana samą ścieżką (testy, driver składany osobno) — warstwa kształtu
      // nie ma prawa od tego zależeć.
      const audit = createHerdrAuditLog({ dataDir });
      audit.log({ ...baseEvent, method: 'prompt', text: 'GH_TOKEN=ghp_zmyslony gh pr list' });
      await audit.flush();

      expect(await readFile(herdrAuditPath(dataDir), 'utf8')).not.toContain('ghp_zmyslony');
    });

    it('zwykła treść przechodzi nietknięta — dziennik ma zostać czytelny', () => {
      expect(redactAuditText('napraw testy w server/test i uruchom pnpm test'))
        .toBe('napraw testy w server/test i uruchom pnpm test');
      // Przypisanie w środku ścieżki/URL-a nie stoi po białym znaku, więc nie jest kształtem
      // prefiksu komendy i nie ma powodu, żeby zjadało pół zdania.
      expect(redactAuditText('sprawdź https://x.test/a?b=c'))
        .toBe('sprawdź https://x.test/a?b=c');
    });

    it('maskuje też długą flagę z wartością (ta sama klasa co zmienna)', () => {
      expect(redactAuditText('deploy --api-key=zmyslony-klucz --dry-run'))
        .toBe('deploy --api-key=[ukryte] --dry-run');
    });

    it('wartość w cudzysłowie ginie w całości, nie do pierwszej spacji', () => {
      expect(redactAuditText('FOO="tajne z spacją" cmd')).toBe('FOO=[ukryte] cmd');
    });
  });

  it('zapisy z jednej sesji nie przeplatają się (szeregowany łańcuch)', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    for (let i = 0; i < 20; i += 1) {
      audit.log({ ...baseEvent, method: 'prompt', text: `nr ${i}` });
    }
    await audit.flush();
    const entries = await readEntries(dataDir);
    expect(entries.map((e) => e['textHead'])).toEqual(
      Array.from({ length: 20 }, (_, i) => `nr ${i}`),
    );
  });
});

describe('odmowy (`method: "refuse"`)', () => {
  it('wpis odmowy niesie POWÓD i ani jednego klawisza', async () => {
    /*
     * `refuse` jest jedyną metodą, przy której do panelu nie poszedł ani jeden bajt. Dziennik
     * miał setki wysyłek i ZERO danych o porażkach, więc „ścieżka cyfrowa bywa zawodna" nie
     * miało po swojej stronie ani jednej liczby.
     */
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'refuse', reason: 'mismatch', toolName: 'Bash' });
    await audit.flush();

    const entry = (await readEntries(dataDir))[0];
    expect(entry).toMatchObject({ method: 'refuse', reason: 'mismatch', toolName: 'Bash' });
    expect(entry?.['keys']).toBeUndefined();
  });

  it('nazwa narzędzia jedzie przez redakcję i sufit znaków (wejście NIEZAUFANE)', async () => {
    /*
     * Przy karcie z hooka nazwa pochodzi z pliku pisanego przez proces spoza Raroga.
     * Czytnik zrzutu odsiewa kształt niebędący identyfikatorem, ale dziennik jest ostatnią
     * bramką przed plikiem, który runbook „kradzież telefonu" każe czytać.
     */
    const audit = createHerdrAuditLog({ dataDir, secrets: ['sekret-procesu'] });
    audit.log({ ...baseEvent, method: 'refuse', reason: 'no-digit', toolName: 'X'.repeat(500) });
    audit.log({ ...baseEvent, method: 'approve', toolName: 'TOKEN=sekret-procesu' });
    await audit.flush();

    const entries = await readEntries(dataDir);
    expect((entries[0]?.['toolName'] as string).length).toBe(HERDR_AUDIT_TEXT_HEAD);
    expect(entries[1]?.['toolName']).not.toContain('sekret-procesu');
  });

  it('`summarizeRefusals` liczy `degrade` osobno od `refuse`', () => {
    const lines = [
      JSON.stringify({ ts: '2026-10-07T10:00:00.000Z', method: 'refuse', reason: 'no-digit' }),
      JSON.stringify({ ts: '2026-10-07T10:00:01.000Z', method: 'degrade', reason: 'no-jsonl' }),
      JSON.stringify({ ts: '2026-10-07T10:00:02.000Z', method: 'degrade', reason: 'no-jsonl' }),
    ];
    const since = Date.parse('2026-10-01T00:00:00.000Z');
    expect(summarizeRefusals(lines, since).byReason).toEqual({ 'no-digit': 1 });
    expect(summarizeRefusals(lines, since, 'degrade')).toMatchObject({
      total: 2, byReason: { 'no-jsonl': 2 },
    });
  });

  it('wpis odmowy niesie KSZTAŁT odpowiedzi — same liczby, bez treści', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'refuse', reason: 'no-digit',
      shape: { channel: 'hook', hookTarget: true, answers: 3, target: 3, index: 1, groups: [1, 0, 2] },
    });
    await audit.flush();
    const entry = JSON.parse(readFileSync(herdrAuditPath(dataDir), 'utf8').trim()) as Record<string, unknown>;
    expect(entry['shape']).toEqual({
      channel: 'hook', hookTarget: true, answers: 3, target: 3, index: 1, groups: [1, 0, 2],
    });
  });

  it('wpis `degrade` niesie KSZTAŁT przypadku — identyfikatory, flagi i liczby, bez treści', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'degrade', reason: 'mismatch', toolName: 'Bash', cliDialog: 'permission',
      reqId: 'hook:1761214627234:f:0123456789ab', source: 'hook', promptId: '7c1d9e2a-0b3f-4e5d-8a6b-1c2d3e4f5a6b',
      agentId: 'a7e5ec6c821818fae', mismatchReason: 'operation', headerVisible: false, optionCount: 2,
      dialogTitle: null, paneRows: 28, budgetSource: 'pane', hookPaneRows: 29, hookPaneCols: 62,
    });
    await audit.flush();
    const [entry] = await readEntries(dataDir);
    expect(entry).toMatchObject({
      method: 'degrade', reason: 'mismatch', reqId: 'hook:1761214627234:f:0123456789ab', source: 'hook',
      promptId: '7c1d9e2a-0b3f-4e5d-8a6b-1c2d3e4f5a6b', agentId: 'a7e5ec6c821818fae', mismatchReason: 'operation',
      headerVisible: false, optionCount: 2, dialogTitle: null, paneRows: 28,
      // Strażnik w chwili hooka: źródło budżetu i pty ze zrzutu.
      budgetSource: 'pane', hookPaneRows: 29, hookPaneCols: 62,
    });
    expect(entry?.['toolUseId']).toBeUndefined();
  });

  it('`dialogTitle` niesie identyfikator z listy `TERMINAL_DIALOGS`', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    for (const dialogTitle of ['session-paused-safeguards', 'background-work-exit'] as const) {
      audit.log({ ...baseEvent, method: 'degrade', reason: 'no-jsonl', source: 'screen', optionCount: 2, dialogTitle });
    }
    await audit.flush();
    expect((await readEntries(dataDir)).map((entry) => entry['dialogTitle']))
      .toEqual(['session-paused-safeguards', 'background-work-exit']);
  });

  it('pole kształtu w obcym kształcie nie trafia do pliku (identyfikatory ze zrzutu hooka są niezaufane)', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'refuse', reason: 'stale-card',
      agentId: 'agent z treścią; SONIOX_API_KEY=sekret', promptId: '', toolUseId: 'x'.repeat(201),
      // Rzutowania udają wartości spoza unii, które mógłby wnieść błąd w kodzie.
      source: 'plik' as unknown as 'hook', mismatchReason: 'wymyślony' as unknown as 'kind',
      optionCount: -1, paneRows: 1.5,
      budgetSource: 'telefon' as unknown as 'pane', hookPaneRows: -29, hookPaneCols: 70_000,
      dialogTitle: 'Session paused; rm -rf' as unknown as 'session-paused-safeguards',
    });
    await audit.flush();
    const [entry] = await readEntries(dataDir);
    for (const key of [
      'agentId', 'promptId', 'toolUseId', 'source', 'mismatchReason', 'optionCount', 'paneRows',
      'budgetSource', 'hookPaneRows', 'hookPaneCols', 'dialogTitle',
    ]) {
      expect(entry?.[key], key).toBeUndefined();
    }
    expect(JSON.stringify(entry)).not.toContain('sekret');
  });

  it('wpis `approve` niesie klasę z rejestru CLI, werdykt rozdzielacza i `blockVisible`', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'approve', keys: ['1'], toolName: 'Bash', optionLabel: 'Yes', cliDialog: 'permission',
      reqId: 'toolu_01AbCdEf', source: 'jsonl', toolUseId: 'toolu_01AbCdEf', headerVisible: true, optionCount: 3,
      blockVisible: true, route: 'terminal-only', routeReason: 'permission-no-dump',
    });
    await audit.flush();
    const [entry] = await readEntries(dataDir);
    expect(entry).toMatchObject({
      method: 'approve', cliDialog: 'permission', blockVisible: true, route: 'terminal-only',
      routeReason: 'permission-no-dump',
    });
    // Stała kolejność: `blockVisible` za liczbą opcji, werdykt na końcu kształtu.
    const keys = Object.keys(entry ?? {});
    expect(keys.indexOf('blockVisible')).toBe(keys.indexOf('optionCount') + 1);
    expect(keys.indexOf('routeReason')).toBe(keys.indexOf('route') + 1);
  });

  it('werdykt spoza zamkniętych list i `blockVisible` nie-boolean nie trafiają do pliku', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'degrade', reason: 'mismatch',
      // Rzutowania udają wartości spoza unii, które mógłby wnieść błąd w kodzie.
      route: 'warstwa-3' as unknown as 'layer1', routeReason: 'bo tak' as unknown as 'sandbox',
      blockVisible: 'tak' as unknown as boolean,
    });
    await audit.flush();
    const [entry] = await readEntries(dataDir);
    for (const key of ['route', 'routeReason', 'blockVisible']) expect(entry?.[key], key).toBeUndefined();
  });

  it('`summarizeDegradeShapes` rozkłada kształt osobno dla projektów i `.claude/worktrees/`', () => {
    const since = Date.parse('2026-10-20T00:00:00Z');
    const line = (fields: Record<string, unknown>, cwd = '/Users/u/Projects/atlas'): string => JSON.stringify({
      ts: '2026-10-23T10:17:07.440Z', method: 'degrade', cwd, ...fields,
    });
    const lines = [
      line({ reason: 'mismatch', cliDialog: 'permission', source: 'hook', mismatchReason: 'operation',
        headerVisible: false, optionCount: 2, dialogTitle: null, paneRows: 28 }),
      line({ reason: 'mismatch', source: 'jsonl', mismatchReason: 'ambiguous-sources', headerVisible: true,
        optionCount: 3, dialogTitle: null, paneRows: 52 }),
      line({ reason: 'unreadable', cliDialog: 'dialog', source: 'screen', optionCount: 0, dialogTitle: null }),
      // Starszy wpis bez pól kształtu — wchodzi do sumy i klasy CLI, nie do rozkładu.
      line({ reason: 'no-jsonl', cliDialog: 'dialog' }),
      // Wartości spoza zamkniętych list wychodzą jako `inne`, nie jako obcy napis.
      line({ reason: 'mismatch', cliDialog: 'nowa-klasa', source: 'cos', mismatchReason: 'nowy', optionCount: 1 }),
      line({ reason: 'unreadable', cliDialog: 'dialog', source: 'screen', optionCount: 0 },
        '/Users/u/Projects/rarog/.claude/worktrees/komendy-e0'),
      JSON.stringify({ ts: '2026-10-23T10:00:00Z', method: 'refuse', reason: 'mismatch', optionCount: 0 }),
      JSON.stringify({ ts: '2026-10-01T10:00:00Z', method: 'degrade', reason: 'mismatch', optionCount: 0 }),
      'śmieć',
    ];
    const { projects, worktrees } = summarizeDegradeShapes(lines, since);
    expect(projects).toEqual({
      total: 5, shaped: 4,
      byMismatchReason: { operation: 1, 'ambiguous-sources': 1, inne: 1 },
      headerVisible: { visible: 1, hidden: 1, noFrame: 2 },
      bySource: { hook: 1, jsonl: 1, screen: 1, inne: 1 },
      byCliDialog: { permission: 1, brak: 1, dialog: 2, inne: 1 },
      noOptionsDialog: 1, withRows: 2, minRows: 28,
    });
    expect(worktrees).toMatchObject({ total: 1, shaped: 1, noOptionsDialog: 1, withRows: 0, minRows: null });
  });

  it('`summarizeRefusals` liczy osobno wpisy z sesji w `.claude/worktrees/`', () => {
    const lines = [
      JSON.stringify({ ts: '2026-10-23T10:00:00Z', method: 'degrade', reason: 'unreadable', cwd: '/p/.claude/worktrees/x' }),
      JSON.stringify({ ts: '2026-10-23T10:00:00Z', method: 'degrade', reason: 'unreadable', cwd: '/p' }),
    ];
    expect(summarizeRefusals(lines, 0, 'degrade')).toMatchObject({ total: 2, worktree: 1 });
  });

  it('`summarizeRefusals` sumuje po powodzie i odcina wpisy spoza okna', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 7, 28, 12, 0, 0);
    const line = (ts: number, method: string, reason?: string): string => JSON.stringify({
      ts: new Date(ts).toISOString(), method, ...(reason === undefined ? {} : { reason }),
    });
    const summary = summarizeRefusals([
      line(now - day, 'refuse', 'mismatch'),
      line(now - 2 * day, 'refuse', 'mismatch'),
      line(now - 2 * day, 'refuse', 'no-digit'),
      // Poza oknem — nie liczy się.
      line(now - 30 * day, 'refuse', 'mismatch'),
      // Wysyłka, nie odmowa.
      line(now - day, 'approve'),
      // Powód spoza zamkniętej listy = sygnał rozjazdu kodu z listą, nie cichy zerowy wpis.
      line(now - day, 'refuse', 'wymyślony'),
      '',
      'to nie jest JSON',
    ], now - REFUSALS_WINDOW_DAYS * day);

    expect(summary.total).toBe(4);
    expect(summary.byReason).toEqual({ mismatch: 2, 'no-digit': 1 });
    expect(summary.unknown).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('wpis bez czytelnego `ts` nie wchodzi do sumy (nie wiadomo, z kiedy jest)', () => {
    const summary = summarizeRefusals([
      JSON.stringify({ method: 'refuse', reason: 'mismatch' }),
      JSON.stringify({ ts: 'wczoraj', method: 'refuse', reason: 'mismatch' }),
    ], 0);
    expect(summary.total).toBe(0);
  });

  it('lista powodów jest ZAMKNIĘTA i bez duplikatów', () => {
    // Powody mają się SUMOWAĆ — dwa warianty tego samego zdarzenia rozbijałyby licznik.
    expect(new Set(HERDR_REFUSE_REASONS).size).toBe(HERDR_REFUSE_REASONS.length);
    expect(HERDR_REFUSE_REASONS).toContain('mismatch');
    expect(HERDR_REFUSE_REASONS).toContain('unreadable');
    expect(HERDR_REFUSE_REASONS).toContain('no-jsonl');
  });

  it('dziennik i kontrakt drivera dzielą JEDNĄ unię, nie dwie zgodne przez przypadek', () => {
    /*
     * Ta sama lista odpowiada za trzy rzeczy naraz: `reason` w dzienniku, `refused.reason`
     * w kontrakcie `SessionDriver` i pole `reason` w ciele 422. Dwie równoległe listy
     * rozjechałyby się przy pierwszym nowym powodzie — a wtedy `summarizeRefusals`
     * policzyłby część odmów jako `unknown` i statystyka przestałaby odpowiadać na pytanie,
     * po co w ogóle powstała.
     */
    expect(HERDR_REFUSE_REASONS).toBe(REFUSE_REASONS);
    // Każdy powód ma zdanie dla człowieka — inaczej 422 wróciłoby z pustym komunikatem.
    for (const reason of REFUSE_REASONS) {
      expect(REFUSE_MESSAGES[reason].length).toBeGreaterThan(10);
    }
    // …i przechodzi przez schemat protokołu (PWA parsuje ciało 422 tym samym `zod`-em).
    expect(refuseReasonSchema.safeParse('nie-ma-takiego').success).toBe(false);
  });

  it('odmowa slash-komendy niesie samą nazwę po redakcji i przycięciu, bez reszty wiadomości', async () => {
    const audit = createHerdrAuditLog({ dataDir, secrets: ['sk-tajny'] });
    audit.log({ ...baseEvent, method: 'refuse', reason: 'command-not-allowed', command: '/usa' });
    audit.log({ ...baseEvent, method: 'refuse', reason: 'command-not-allowed', command: `/sk-tajny${'x'.repeat(90)}` });
    await audit.flush();
    const [first, second] = await readEntries(dataDir);
    expect(first).toMatchObject({ method: 'refuse', reason: 'command-not-allowed', command: '/usa' });
    expect(first?.['textHead']).toBeUndefined();
    expect(String(second?.['command'])).not.toContain('sk-tajny');
    expect(String(second?.['command']).length).toBeLessThanOrEqual(64);
  });

  it('odmowy komend liczą się osobno, per nazwa; statystyka odmów decyzji ich nie widzi', () => {
    const since = Date.parse('2026-10-17T00:00:00Z');
    const line = (command: string, ts = '2026-10-17T12:00:00Z'): string => JSON.stringify({
      ts, method: 'refuse', reason: 'command-not-allowed', command,
    });
    const lines = [
      line('/usa'), line('/USA'), line('quit'), line('/stary', '2026-10-01T00:00:00Z'),
      JSON.stringify({ ts: '2026-10-17T12:00:00Z', method: 'refuse', reason: 'mismatch' }), 'śmieć',
    ];
    expect(summarizeCommandRefusals(lines, since)).toEqual({ total: 3, byCommand: { '/usa': 2, quit: 1 }, skipped: 1 });
    expect(summarizeRefusals(lines, since)).toMatchObject({ total: 1, byReason: { mismatch: 1 }, unknown: 0 });
  });

  it('KAŻDY powód z listy ma asercję na dzienniku w testach drivera', () => {
    /*
     * Every reason needs an assertion on `reason`, not only a test of its MESSAGE path: a lost or swapped
     * reason would pass green and spoil exactly the statistics built on it — `summarizeRefusals` would count
     * such an entry as `unknown` or not count it at all.
     *
     * Strażnik jest statyczny z rozmysłem: dopisanie DZIEWIĄTEJ wartości do listy ma wymusić
     * pokrycie, a nie tylko kompilację.
     */
    const driverTests = readFileSync(
      join(import.meta.dirname, 'herdr-driver.test.ts'), 'utf8',
    );
    for (const reason of HERDR_REFUSE_REASONS) {
      // Powody spoza drivera (`in-flight` z blokady równoległych prób) nie mają w driverze
      // ścieżki ani wpisu w dzienniku — ich pokrycia pilnuje `permissions.test.ts`.
      if (NON_DRIVER_REFUSE_REASONS.includes(reason)) continue;
      expect(
        new RegExp(`\\(\\[?'${reason}'`).test(driverTests),
        `powód \`${reason}\` nie ma ani jednej asercji na \`method: 'refuse'\``,
      ).toBe(true);
    }
  });
});

describe('szczegół kroku cienia (`shadowDetail`)', () => {
  const KEY = `${'a'.repeat(8)}-${'0'.repeat(31)}1`;

  it('`no-proof:hook-martwy` trafia do wpisu, tuż za kluczem pliku cienia w stałej kolejności', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'approve', keys: ['1'], toolName: 'Read', promptId: 'p-1', shadow: 'no-proof',
      shadowDetail: 'no-proof:hook-martwy',
    });
    audit.log({
      ...baseEvent, method: 'approve', keys: ['1'], shadow: 'written', shadowKey: KEY, shadowDetail: 'blad',
    });
    await audit.flush();
    const [entry, written] = await readEntries(dataDir);
    expect(entry).toMatchObject({ method: 'approve', shadow: 'no-proof', shadowDetail: 'no-proof:hook-martwy' });
    const keys = Object.keys(written ?? {});
    expect(keys.indexOf('shadowDetail')).toBe(keys.indexOf('shadowKey') + 1);
  });

  it('każda wartość listy przechodzi: powody `no-proof`, wynik bez dowodu i przyczyny `error`', async () => {
    expect(SHADOW_DETAILS).toEqual(expect.arrayContaining([
      'no-proof:hook-martwy', 'no-proof:kolejka', 'no-proof:rejestr-nieznany', 'no-match', 'timeout', 'blad', 'zapis',
    ]));
    const audit = createHerdrAuditLog({ dataDir });
    for (const shadowDetail of SHADOW_DETAILS) {
      audit.log({ ...baseEvent, method: 'send_keys', keys: ['escape'], shadow: 'no-proof', shadowDetail });
    }
    await audit.flush();
    expect((await readEntries(dataDir)).map((entry) => entry['shadowDetail'])).toEqual([...SHADOW_DETAILS]);
  });

  it('wartość spoza listy nie trafia do pliku (bez treści, kluczy i ścieżek)', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    const foreign = [
      'no-proof:cos-nowego', 'hook-martwy', 'no-proof:hook-martwy ', KEY, '/Users/u/Projects/atlas/plik.ts',
      'no-proof:hook-martwy; SONIOX_API_KEY=sekret', '',
    ];
    for (const shadowDetail of foreign) {
      audit.log({ ...baseEvent, method: 'approve', keys: ['1'], shadow: 'no-proof', shadowDetail });
    }
    await audit.flush();
    const entries = await readEntries(dataDir);
    expect(entries).toHaveLength(foreign.length);
    for (const entry of entries) expect(entry['shadowDetail']).toBeUndefined();
    expect(JSON.stringify(entries)).not.toContain('sekret');
  });

  it('`shadowAuditFields`: szczegół tylko wtedy, gdy kanał go podał; przy `off` (bez wyniku) żadnych pól', () => {
    expect(shadowAuditFields(null)).toEqual({});
    expect(shadowAuditFields({ result: 'written', key: KEY, sessionId: 's' }))
      .toEqual({ shadow: 'written', shadowKey: KEY });
    expect(shadowAuditFields({ result: 'ambiguous' })).toEqual({ shadow: 'ambiguous' });
    expect(shadowAuditFields({ result: 'no-proof', detail: 'no-proof:hook-martwy' }))
      .toEqual({ shadow: 'no-proof', shadowDetail: 'no-proof:hook-martwy' });
    expect(shadowAuditFields({ result: 'error', detail: 'timeout' }))
      .toEqual({ shadow: 'error', shadowDetail: 'timeout' });
  });

  it('lista obejmuje każdy dosłowny szczegół kanału cienia i drivera oraz każdy powód braku dowodu', () => {
    // Strażnik grepowy: nowy dosłowny `detail` bez wpisu na liście znikałby z dziennika po cichu.
    const repo = join(import.meta.dirname, '..', '..');
    const literals = ['server/src/herdr/dialogs/shadow/channel.ts', 'server/src/drivers/herdr-driver.ts']
      .flatMap((file) => [...readFileSync(join(repo, file), 'utf8').matchAll(/\bdetail: '([^']+)'/g)])
      .map((match) => match[1] ?? '');
    expect(new Set(literals)).toEqual(new Set(['timeout', 'blad', 'zapis']));
    for (const value of literals) expect(SHADOW_DETAILS, value).toContain(value);
    for (const reason of NO_PROOF_REASONS) expect(SHADOW_DETAILS).toContain(`no-proof:${reason}`);
    for (const why of ['no-dump', 'no-match', 'no-proof']) expect(SHADOW_DETAILS).toContain(why);
  });
});

describe('karta bloku wystawiona (`block-card`)', () => {
  const PRINT = '83f5c9612c9946c8';
  const card = (over: Partial<ActiveReq>): ActiveReq => ({
    reqId: 'screen:q:58837689f853', toolName: 'dialog:question', origin: { source: 'screen' },
    options: [{ digit: '1', label: 'Pierwszy' }, { digit: '2', label: 'Drugi' }], bodyPrint: PRINT, ...over,
  });

  it('wpis niesie tożsamość, kształt, odcisk i werdykt — bez etykiet opcji i treści', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({
      ...baseEvent, method: 'block-card', reqId: 'screen:q:58837689f853', source: 'screen', toolName: 'dialog:question',
      optionCount: 2, dialogTitle: null, print: PRINT, verdict: 'buttons',
    });
    await audit.flush();
    const [entry] = await readEntries(dataDir);
    expect(entry).toMatchObject({
      method: 'block-card', reqId: 'screen:q:58837689f853', source: 'screen', optionCount: 2, print: PRINT,
      verdict: 'buttons', toolName: 'dialog:question',
    });
    for (const field of ['text', 'textHead', 'textSha256', 'optionLabel', 'keys', 'digit']) {
      expect(entry).not.toHaveProperty(field);
    }
    // Stała kolejność: odcisk i werdykt na końcu kształtu, przed polami spoza niego.
    const keys = Object.keys(entry ?? {});
    expect(keys.indexOf('verdict')).toBe(keys.indexOf('print') + 1);
  });

  it('odcisk w obcym kształcie i werdykt spoza listy nie trafiają do pliku', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    const prints = [PRINT.toUpperCase(), `${PRINT}0`, PRINT.slice(1), 'Yes, and don’t ask again', ''];
    for (const print of prints) audit.log({ ...baseEvent, method: 'block-card', source: 'screen', print });
    // @ts-expect-error — wartość spoza zamkniętej listy, jak z wejścia niezaufanego.
    audit.log({ ...baseEvent, method: 'block-card', source: 'screen', verdict: 'all' });
    await audit.flush();
    const entries = await readEntries(dataDir);
    expect(entries).toHaveLength(prints.length + 1);
    for (const entry of entries) {
      expect(entry['print']).toBeUndefined();
      expect(entry['verdict']).toBeUndefined();
    }
  });

  it('`blockCardRecord`: werdykt z `terminalOnly` opcji karty, odcisk z karty, `null` poza ekranem', () => {
    expect(BLOCK_CARD_VERDICTS).toEqual(['buttons', 'partial', 'no-buttons']);
    expect(blockCardRecord(card({}))).toEqual({
      reqId: 'screen:q:58837689f853', toolName: 'dialog:question', verdict: 'buttons', print: PRINT,
    });
    expect(blockCardRecord(card({
      options: [{ digit: '1', label: 'Yes' }, { digit: '2', label: 'Yes, and always allow', terminalOnly: true }],
    }))?.verdict).toBe('partial');
    expect(blockCardRecord(card({ options: [{ digit: '1', label: 'Stop', terminalOnly: true }] }))?.verdict)
      .toBe('no-buttons');
    const bare = blockCardRecord(card({ options: [], bodyPrint: undefined }));
    expect(bare).toEqual({ reqId: 'screen:q:58837689f853', toolName: 'dialog:question', verdict: 'no-buttons' });
    expect(blockCardRecord(card({ origin: { source: 'jsonl', toolUseId: 'toolu_x' } }))).toBeNull();
    expect(blockCardRecord(card({ origin: { source: 'hook' } }))).toBeNull();
    expect(blockCardRecord(card({ origin: undefined }))).toBeNull();
  });

  it('`blockCardRecord` nie zmienia karty', () => {
    const active = card({ options: [{ digit: '1', label: 'Yes', terminalOnly: true }] });
    const before = JSON.stringify(active);
    blockCardRecord(active);
    expect(JSON.stringify(active)).toBe(before);
  });

  it('karta warstwy 2: linia JSON kończy kształt polami `layer2` i `layer2Why`, bez wycinka i tytułu', async () => {
    const audit = createHerdrAuditLog({ dataDir, now: () => new Date(Date.UTC(2026, 10, 1, 12, 0, 0)) });
    audit.log({
      ...baseEvent, method: 'block-card', reqId: 'screen:1:f:3b2f0c1d9e7a', source: 'screen', toolName: 'dialog',
      optionCount: 0, dialogTitle: null, verdict: 'no-buttons', layer2: true, layer2Why: 'block-no-digits',
    });
    await audit.flush();
    const raw = await readFile(herdrAuditPath(dataDir), 'utf8');
    expect(raw).toBe(`${JSON.stringify({
      ts: '2026-11-01T12:00:00.000Z', sessionId: baseEvent.sessionId, key: 'w9:p72', paneId: 'w9:p72',
      cwd: '/Users/u/Projects/atlas', method: 'block-card', mode: 'auto', reqId: 'screen:1:f:3b2f0c1d9e7a',
      source: 'screen', optionCount: 0, dialogTitle: null, verdict: 'no-buttons', layer2: true,
      layer2Why: 'block-no-digits', toolName: 'dialog',
    })}\n`);
  });

  it('`layer2` inne niż `true` i `layer2Why` spoza listy nie trafiają do pliku', async () => {
    const audit = createHerdrAuditLog({ dataDir });
    audit.log({ ...baseEvent, method: 'block-card', source: 'screen', verdict: 'no-buttons', layer2: false });
    // @ts-expect-error — powód spoza zamkniętej listy, jak z wejścia niezaufanego.
    audit.log({ ...baseEvent, method: 'block-card', source: 'screen', verdict: 'no-buttons', layer2Why: 'no-shape' });
    await audit.flush();
    for (const entry of await readEntries(dataDir)) {
      expect(entry).not.toHaveProperty('layer2');
      expect(entry).not.toHaveProperty('layer2Why');
    }
  });

  it('`blockCardRecord`: powód warstwy 2 z karty, a bez śladu warstwy 2 rekord jak dotąd', () => {
    expect(LAYER2_WHYS).toContain('block-no-digits');
    const plain = card({ options: [], bodyPrint: undefined });
    expect(blockCardRecord(plain)).not.toHaveProperty('layer2Why');
    expect(blockCardRecord({ ...plain, layer2: { why: 'block-no-digits', print: PRINT } })).toEqual({
      reqId: 'screen:q:58837689f853', toolName: 'dialog:question', verdict: 'no-buttons', layer2Why: 'block-no-digits',
    });
  });
});
