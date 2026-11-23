/**
 * Driver sesji przypiętej do panelu herdr (`drivers/herdr-driver.ts`).
 *
 * Driver nie dotyka gniazda: pracuje przeciw interfejsowi `HerdrClient` i uchwytowi agenta,
 * więc wszystkie testy jadą na fake'ach z licznikiem wywołań. Fake liczy KAŻDE wywołanie
 * mutujące — to on jest dowodem w najważniejszym teście pliku (`dispose()` nie wysyła nic).
 *
 * Transkrypt jest prawdziwy: follower czyta plik jsonl z katalogu tymczasowego, bo tylko tak
 * da się sprawdzić, że podyktowany prompt pojawia się w transkrypcie DOKŁADNIE RAZ.
 */
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { MODE_CYCLE_MAX_PRESSES } from '../src/herdr/mode-cycle.ts';
import type { HerdrFooterMode } from '../src/herdr/dialogs/screen/mode-footer.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, rename, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { REFUSE_REASONS, isDelegatingTool } from '@rarog/shared';
import type { HerdrMode, Question, RefuseReason, WorkflowRun } from '@rarog/shared';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { driverStateFor } from '../src/drivers/herdr-driver.ts';
import type { HerdrAuditEntry, HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import {
  PAUSE_ESCAPE_MESSAGE, SCREEN_CHANGED_MESSAGE, STALE_DECISION_MESSAGE, TERMINAL_DIALOG_MESSAGE,
} from '../src/herdr/dialogs/copy.ts';
import { parseTrustArrowDialog } from '../src/herdr/dialogs/screen/trust-arrow.ts';
import { ANSWERED_HOOK_SHIELD_MS } from '../src/herdr/dialogs/timing.ts';
import {
  SUBAGENTS_ACTIVITY_TOOL, WORKFLOW_ACTIVITY_TOOL,
} from '../src/drivers/herdr/transcript.ts';
import {
  GONE_INTERRUPT_MESSAGE, INTERRUPT_DONE_MESSAGE, STALLED_PROMPT_MESSAGE, ULTRACODE_OFF_DONE_MESSAGE,
  ULTRACODE_ON_DONE_MESSAGE, ULTRACODE_REFUSED_MESSAGE, commandRefusedInline, commandResultInline, modelSetEvent,
  ultracodeUnseenMessage,
} from '../src/drivers/herdr/commands.ts';
import { EVIDENCE, ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';
import { buildCatalog, registryCatalog } from '../src/herdr/commands/catalog.ts';
import type { CommandCatalog } from '../src/herdr/commands/catalog.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import type { DecisionOutcome } from '../src/drivers/types.ts';
import {
  HerdrBlockedError, HerdrGoneError, HerdrOutOfScopeError, HerdrReadOnlyError, HerdrStalledError,
} from '../src/herdr/types.ts';
import type { HerdrAgentInfo, HerdrScreen } from '../src/herdr/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import type { AgentFileFacts, AgentFileReader } from '../src/herdr/background/agent-file.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower, TranscriptPresence } from '../src/herdr/jsonl-follow.ts';
import { UPLOAD_DIR_NAME } from '../src/herdr/uploads.ts';
import { NON_DRIVER_REFUSE_REASONS } from '../src/herdr/audit.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { clearPendingHook, readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME, HOOK_SHADOW_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import { createShadowChannel } from '../src/herdr/dialogs/shadow/channel.ts';
import type { ShadowChannel, ShadowConsentChannel, ShadowOutcome } from '../src/herdr/dialogs/shadow/channel.ts';
import { SHADOW_DEADLINE_MS } from '../src/herdr/dialogs/timing.ts';
import type { RefusalDump } from '../src/herdr/dialogs/refusals.ts';
import { projectSlug } from '../src/cli-store.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { Scheduler } from '../src/drivers/runtime.ts';
import {
  DIALOG_PERMISSION, EMPTY_FIELD, FIXTURES, FakeClient, NIE_DIALOG, PANE, SESSION, TIMING, base, cleared,
  commandOpts, composerPane, drivenClock, fieldScreen, inTurn, makeDriver, pasteFlow, permissions, questions, quiet,
  reads, root, screenDialogs, states, systemCodes, systemTexts, toolResultLine, toolUseLine, useDriverSandbox,
  userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Call, Fixture } from './helpers/herdr-driver-atrapy.ts';

const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';

useDriverSandbox();

/**
 * Dialog zaufania z etykietą bez markera eskalacji („Yes, proceed"). Kreska nad zdaniem jest obowiązkowa:
 * znany dialog rozpoznaje się wyłącznie w bloku rysowanym przez CLI, a prawdziwe dialogi zaufania ją mają
 * (`dialog-trust.txt`, `dialog-trust-2.1.293.txt`).
 */
const TRUST_DIALOG = `${'─'.repeat(63)}\n Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n`;
const DIALOG_QUESTION = readFileSync(join(FIXTURES, 'dialog-askuserquestion.txt'), 'utf8');
const DIALOG_PREVIEW = readFileSync(join(FIXTURES, 'dialog-askuserquestion-preview.txt'), 'utf8');
const DIALOG_PLAN = readFileSync(join(FIXTURES, 'dialog-exitplanmode.txt'), 'utf8');
const DIALOG_MULTI_START =
  readFileSync(join(FIXTURES, 'dialog-askuserquestion-multi-live-start.txt'), 'utf8');
/** Zakładki 1 i 3 TEGO SAMEGO formularza wielopytaniowego (CLI 2.1.257). */
const DIALOG_MULTIQ_TAB1 =
  readFileSync(join(FIXTURES, 'dialog-askuserquestion-multiq-tab1-jednokrotne.txt'), 'utf8');
const DIALOG_MULTIQ_TAB2 =
  readFileSync(join(FIXTURES, 'dialog-askuserquestion-multiq-tab2-multiselect-next.txt'), 'utf8');
const DIALOG_MULTIQ_TAB3 =
  readFileSync(join(FIXTURES, 'dialog-askuserquestion-multiq-tab3-ostatnie.txt'), 'utf8');
const DIALOG_MULTIQ_REVIEW =
  readFileSync(join(FIXTURES, 'dialog-askuserquestion-multiq-review.txt'), 'utf8');
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Fake'i
// ---------------------------------------------------------------------------

/**
 * Stałe czasu, które test PODAJE DRIVEROWI, muszą być KRÓTSZE od `quiet()`.
 *
 * Inaczej asercja negatywna po `quiet()` wypada PRZED deadline'em drivera i jest zielona
 * z definicji — deadline nie miał jeszcze prawa nadejść (np. watchdog 30 ms sprawdzany po 15 ms
 * ciszy). Zasada obowiązuje w obie strony: kto skraca `quiet()`, skraca też te stałe.
 *
 * Sprawdzone mutacją po zmianie — każde z tych zdjęć czerwieni test, który go
 * pilnuje: rozbrojenie watchdoga w `interrupt()`, skasowanie timera watchdoga w `dispose()`,
 * hamulec zamrożonej blokady (OBIE kopie sprawdzenia `#blockedSeq`), token sondy po
 * przerwaniu i porównanie rozkładu w czytniku workflow. Watchdog nad panelem, który RUSZYŁ,
 * ma dwie niezależne bramki (status i `#lastFollowAt`) — czerwieni się po zdjęciu obu.
 */
const TEST_WATCHDOG_MS = 5;
/** Pauza między cyfrą a `enter` — z tego samego powodu mieści się w oknie `quiet()`. */
const TEST_FORM_CONFIRM_MS = 5;

/** Katalog z komendą pluginu — rejestr nie zna pluginów, a test „dziury 3” ich potrzebuje. */
const PLUGIN_CATALOG: CommandCatalog = buildCatalog('/projekt', {
  commands: [{ name: 'code-review:code-review', source: 'plugin', origin: 'plugin-command' }],
  hidden: [], synced: [], skippedPlugins: [], notes: [], stamps: new Map(),
});

/** Input `Bash` z polem, którego na ekranie NIE MA (ekran jest przycięty do szerokości panelu). */
const BASH_INPUT = {
  command: 'pnpm exec vitest run server/test/state-machine.test.ts',
  description: 'Uruchamia testy maszyny stanów po zmianie w /Users/u/Projects/atlas/.env.local',
};

// ---------------------------------------------------------------------------
// Mapowanie statusu
// ---------------------------------------------------------------------------

describe('driverStateFor', () => {
  it('rozróżnia `idle` (wynik widziany) od `done` (wynik niewidziany)', () => {
    expect(driverStateFor('idle')).toEqual({ state: 'idle', seen: true });
    // Bez detail „nowy wynik": informację niesie samo `seen: false`.
    expect(driverStateFor('done')).toEqual({ state: 'idle', seen: false });
  });

  it('`unknown` nie ma odpowiednika — nie wolno udawać końca pracy', () => {
    expect(driverStateFor('unknown')).toBeNull();
    expect(driverStateFor('working')).toEqual({ state: 'working' });
    expect(driverStateFor('blocked')).toEqual({ state: 'blocked' });
  });
});

// ---------------------------------------------------------------------------
// Sprzątanie
// ---------------------------------------------------------------------------

describe('dispose', () => {
  /**
   * NAJWAŻNIEJSZY TEST W MODULE.
   *
   * `dispose()` managera leci przy każdym SIGTERM — czyli przy każdym deployu Raroga, dla
   * WSZYSTKICH sesji naraz. Gdyby driver wysyłał przy odpięciu `ctrl+c` (jak driver SDK, który
   * jest właścicielem procesu), restart Raroga przerywałby pracę wszystkich paneli w terminalu
   * użytkownika. Licznik ma pokazać ZERO.
   */
  it('nie wysyła do herdr ANI JEDNEGO wywołania mutującego', async () => {
    const fx = await makeDriver({ transcript: userLine('coś w historii') });
    await waitFor(() => fx.events.length > 0, 'historia');

    fx.driver.dispose();
    await quiet();

    expect(fx.client.mutations).toBe(0);
    expect(fx.audit).toEqual([]);
  });

  it('domyka strumień zdarzeń', async () => {
    const fx = await makeDriver();
    let ended = false;
    void (async () => {
      for await (const _ of fx.driver.events) void _;
      ended = true;
    })();

    fx.driver.dispose();
    await waitFor(() => ended, 'koniec strumienia');
  });

  it('po `dispose()` wysyłka nie dociera do panelu', async () => {
    const fx = await makeDriver();
    fx.driver.dispose();
    fx.driver.send('za późno');
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('zdarzenie `gone` z uchwytu kończy strumień, nie wysyłając nic', async () => {
    const fx = await makeDriver();
    let ended = false;
    void (async () => {
      for await (const _ of fx.driver.events) void _;
      ended = true;
    })();

    fx.emit({ type: 'gone' });
    await waitFor(() => ended, 'koniec strumienia po `gone`');
    expect(fx.client.mutations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Klawisze
// ---------------------------------------------------------------------------

describe('klawisze', () => {
  it('`interrupt()` wysyła dokładnie jeden `escape` — kanoniczne przerwanie Claude Code', async () => {
    // NIE `ctrl+c`: nie oddaje promptu do composera i bywa ignorowany w trakcie tury.
    // I nie DWA `escape`: podwójny na pustym polu otwiera menu rewind, a pojedynczy przerywa
    // Claude'a (docs `interactive-mode.md`, „General controls”).
    const fx = await makeDriver();
    fx.driver.interrupt();
    await waitFor(() => fx.client.mutations > 0, 'escape');
    await quiet();

    expect(fx.client.calls).toEqual([{ method: 'send_keys', paneId: PANE, keys: ['escape'] }]);
    expect(fx.audit).toHaveLength(1);
    expect(fx.audit[0]?.method).toBe('send_keys');
    expect(fx.audit[0]?.mode).toBe('auto');
  });

  it('odrzucenie dialogu wysyła dokładnie `escape`', async () => {
    const fx = await makeDriver();
    fx.driver.respondPermission('p-1', 'deny');
    await waitFor(() => fx.client.mutations > 0, 'escape');
    await quiet();

    expect(fx.client.calls).toEqual([{ method: 'send_keys', paneId: PANE, keys: ['escape'] }]);
  });

  it('`allow` nie dotyka panelu — zgodę zatwierdza człowiek przy terminalu', async () => {
    const fx = await makeDriver();
    fx.driver.respondPermission('p-1', 'allow');
    fx.driver.answerQuestion('q-1', [['Ciemny']]);
    await quiet();

    expect(fx.client.mutations).toBe(0);
  });

  it('odrzucenie sprząta zrzut hooka PreToolUse — dokładnie raz, po udanym `escape`', async () => {
    // Bez sprzątania po Esc zrzut żyje do TTL (10 min), więc następny dialog tego samego
    // narzędzia mógłby dostać treść POPRZEDNIEGO wywołania.
    const cleared: [string, string | undefined][] = [];
    const fx = await makeDriver({
      deps: { clearPendingHook: (sid, answerKey) => { cleared.push([sid, answerKey]); } },
    });
    fx.driver.respondPermission('p-1', 'deny');
    await waitFor(() => fx.client.mutations > 0, 'escape');
    await quiet();

    expect(fx.client.calls).toEqual([{ method: 'send_keys', paneId: PANE, keys: ['escape'] }]);
    // BEZ klucza, czyli zrzut całej sesji: `escape` zamyka CAŁY formularz, więc żadna
    // generacja zrzutu nie opisuje już niczego, co stoi (zawężenie po kluczu ma wyłącznie
    // odpowiedź plikiem — patrz „kasowany jest zrzut O TYM kluczu").
    expect(cleared).toEqual([[SESSION, undefined]]);
  });

  it('nieudane `escape` NIE sprząta zrzutu hooka — dialog stoi dalej, zrzut go opisuje', async () => {
    const cleared: string[] = [];
    const fx = await makeDriver({
      deps: { clearPendingHook: (sid) => { cleared.push(sid); } },
    });
    fx.client.sendKeys = () => Promise.reject(new Error('panel nie odpowiada'));
    fx.driver.respondPermission('p-1', 'deny');
    await waitFor(() => systemTexts(fx.events).some((t) => t.includes("Couldn't send to the pane")), 'błąd');
    await quiet();

    expect(cleared).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wysyłka
// ---------------------------------------------------------------------------

describe('send', () => {
  it('bez wcześniejszego `interrupt` idzie sam `prompt`', async () => {
    const fx = await makeDriver();
    fx.driver.send('napisz test');
    await waitFor(() => fx.client.calls.length > 0, 'prompt');
    await quiet();

    // Bramka dialogu zgody czyta ekran przed wysyłką (`read`) — poza nią do panelu idzie SAM `prompt`.
    expect(fx.client.calls.filter((c) => c.method !== 'read')).toEqual([
      { method: 'prompt', paneId: PANE, text: 'napisz test', wait: true },
    ]);
  });

  it('po `interrupt` czyści pole parą `esc esc` potwierdzoną ekranem, dopiero potem pisze', async () => {
    const fx = await makeDriver();
    // CC oddał przerwany prompt do composera (ostatnia linia `❯` niepusta). Podwójny Esc czyści
    // niepuste pole (docs `interactive-mode.md`, „General controls”); że czyści dopiero PARA
    // w jednym `send_keys`, a pojedynczy Esc nic, to obserwacja Raroga bez zapisanej wersji CLI.
    fx.client.screenText = '❯ przerwany prompt oddany do composera';
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) fx.client.screenText = '❯';
      return raw(paneId, keys);
    };
    fx.driver.interrupt();
    fx.driver.send('druga próba');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt po esc');
    await quiet();

    expect(fx.client.calls.filter((c) => c.method !== 'read').map((c) => c.keys ?? c.text))
      .toEqual([['escape'], ['escape', 'escape'], 'druga próba']);
    // Druga wysyłka nie powtarza czyszczenia — pole jest już puste.
    fx.driver.send('trzecia');
    const prompts = (): number => fx.client.calls.filter((c) => c.method === 'prompt').length;
    await waitFor(() => prompts() === 2, 'drugi prompt');
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toHaveLength(2);
  });

  it('puste pole po `interrupt` = ZERO czyszczących klawiszy — para na pustym otwiera rewind', async () => {
    const fx = await makeDriver();
    fx.client.screenText = '❯';
    fx.driver.interrupt();
    fx.driver.send('nowa wiadomość');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await quiet();
    // Jedyny `escape` to samo przerwanie; czyszczenia nie było: para `esc esc` na pustym polu
    // otwiera menu rewind (docs `interactive-mode.md`, „General controls”), które zjada kolejne
    // wysyłki (obserwacja Raroga bez zapisanej wersji CLI).
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['escape']]);
  });

  it('slash-komenda idzie jako zwykły tekst', async () => {
    const fx = await makeDriver();
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await waitFor(() => fx.client.calls.length > 0, 'prompt');
    expect(fx.client.calls.find((c) => c.method === 'prompt')?.text).toBe('/compact');
  });

  it('zdjęcie ląduje w `<cwd>/.rarog-uploads/`, a ścieżka bezwzględna w promptcie', async () => {
    const fx = await makeDriver();
    fx.driver.send('co tu nie gra?', [PNG]);
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt ze zdjęciem');

    const text = fx.client.calls.find((c) => c.method === 'prompt')?.text ?? '';
    const path = text.split(' ').at(-1) ?? '';
    // Ścieżka doklejona po SPACJI do ostatniej linii — w osobnej linii TUI zawiesza prompt
    // w polu wejściowym (obserwacja bez zapisanej wersji CLI, patrz `appendImagePaths`).
    expect(text.startsWith('co tu nie gra? ')).toBe(true);
    expect(text.includes('\n')).toBe(false);
    expect(isAbsolute(path)).toBe(true);
    expect(path.includes(join(fx.cwd, UPLOAD_DIR_NAME))).toBe(true);
    expect(await readdir(join(fx.cwd, UPLOAD_DIR_NAME))).toHaveLength(1);
  });

  it('plik ląduje w `<cwd>/.rarog-uploads/` pod swoją nazwą, ścieżka w tej samej linii', async () => {
    const fx = await makeDriver();
    fx.driver.send('przejrzyj ten log', undefined, [
      { name: 'build.log', dataUrl: 'data:text/plain;base64,YnVpbGQ=' },
    ]);
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt z plikiem');

    const text = fx.client.calls.find((c) => c.method === 'prompt')?.text ?? '';
    const path = text.split(' ').at(-1) ?? '';
    expect(text.startsWith('przejrzyj ten log ')).toBe(true);
    expect(text.includes('\n')).toBe(false);
    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith(join(fx.cwd, UPLOAD_DIR_NAME))).toBe(true);
    // Nazwa oryginalna zostaje — agent widzi w promptcie, że dostał `build.log`.
    expect(path.endsWith('-build.log')).toBe(true);
  });

  it('zdjęcia i pliki w jednej wiadomości idą JEDNYM blokiem, zdjęcia pierwsze', async () => {
    const fx = await makeDriver();
    fx.driver.send('oba', [PNG], [{ name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' }]);
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt z obydwoma');

    const text = fx.client.calls.find((c) => c.method === 'prompt')?.text ?? '';
    const paths = text.split(' ').slice(1);
    expect(paths).toHaveLength(2);
    expect(paths[0]?.endsWith('.png')).toBe(true);
    expect(paths[1]?.endsWith('-a.txt')).toBe(true);
    expect(await readdir(join(fx.cwd, UPLOAD_DIR_NAME))).toHaveLength(2);
  });

  it('dziennik dostaje ŚCIEŻKI, nigdy treści załącznika', async () => {
    const fx = await makeDriver();
    fx.driver.send('sprawdź', [PNG], [{ name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' }]);
    await waitFor(() => fx.audit.length > 0, 'wpis w dzienniku');

    const logged = fx.audit.map((e) => e.text ?? '').join('\n');
    // Dziennik jest do śledztwa, nie do archiwum — base64 zdjęcia z telefonu nie ma tam czego szukać.
    expect(logged).not.toContain('base64');
    expect(logged).not.toContain(PNG.slice(-24));
    expect(logged).toContain(UPLOAD_DIR_NAME);
  });

  it('brak modułu uploadów to JAWNY brak wysyłki, nie cichy tekst bez pliku', async () => {
    const fx = await makeDriver({ deps: { uploads: undefined } });
    fx.driver.send('przejrzyj', undefined, [{ name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' }]);
    await waitFor(() => systemTexts(fx.events).length > 0, 'komunikat o braku wysyłki');

    expect(fx.client.mutations).toBe(0);
    expect(systemTexts(fx.events)[0]).toContain('The message was not sent');
  });

  it('tekst przechodzi przez strażnika, a jego odmowa NIE dotyka gniazda', async () => {
    const fx = await makeDriver({
      deps: {
        guard: (text) => {
          if (text.startsWith('/permissions')) throw new Error('Komenda /permissions jest zablokowana.');
          return { text: text.trimEnd(), slash: null };
        },
      },
    });

    fx.driver.send('/permissions add Bash');
    await waitFor(() => systemTexts(fx.events).length > 0, 'komunikat o odrzuceniu');

    expect(fx.client.mutations).toBe(0);
    expect(systemTexts(fx.events)[0]).toContain('/permissions');
  });

  it('strażnik sanityzuje tekst PRZED wysyłką', async () => {
    // Bajt sterujący budowany z kodu — repo zabrania surowych znaków sterujących w źródłach.
    const bel = String.fromCharCode(7);
    const fx = await makeDriver({
      deps: { guard: (text) => ({ text: text.split(bel).join('').trimEnd(), slash: null }) },
    });
    fx.driver.send(`dzwonek${bel} w tekście   `);
    await waitFor(() => fx.client.calls.length > 0, 'prompt');
    expect(fx.client.calls.find((c) => c.method === 'prompt')?.text).toBe('dzwonek w tekście');
  });

  it('dziennik dostaje wpis z trybem i pełnym tekstem do skrócenia', async () => {
    const fx = await makeDriver();
    fx.driver.send('do dziennika');
    await waitFor(() => fx.audit.length > 0, 'wpis w dzienniku');

    expect(fx.audit[0]).toMatchObject({
      key: PANE, paneId: PANE, method: 'prompt', mode: 'auto', text: 'do dziennika',
    });
  });

  it('po udanej wysyłce startuje karencja `idle` w supervisorze', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({ deps: { markSent: (key) => marked.push(key) } });
    fx.driver.send('cokolwiek');
    await waitFor(() => marked.length > 0, 'markSent');
    expect(marked).toEqual([PANE]);
  });
});

// ---------------------------------------------------------------------------
// Stall-guard wysyłki i watchdog tury
// ---------------------------------------------------------------------------

describe('stall-guard wysyłki', () => {
  const stalled = (): HerdrStalledError => new HerdrStalledError(foreign('agent_prompt_stalled'));
  const escs = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');

  it('zwykły prompt jedzie z `wait`, slash-komenda z composera bez', async () => {
    const fx = await makeDriver();
    fx.driver.send('napisz test', undefined, undefined, commandOpts('napisz test'));
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await waitFor(() => prompts(fx).length === 2, 'slash');

    expect(prompts(fx)[0]?.wait).toBe(true);
    expect('wait' in (prompts(fx)[1] ?? {})).toBe(false);
  });

  it('wiadomość zaczynająca się od ŚCIEŻKI nie traci detekcji', async () => {
    const fx = await makeDriver();
    fx.driver.send('/tmp/x.log przeczytaj i streść', undefined, undefined, commandOpts('/tmp/x.log przeczytaj i streść'));
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    expect(prompts(fx)[0]?.wait).toBe(true);
  });

  /**
   * Dziura 3 z researchu komend „/". Komenda pluginu szła ścieżką stall-guarda,
   * a ten szuka echa promptu w CAŁYM ekranie — echo w scrollbacku potrafiło potwierdzić
   * fałszywy stall i wysłać komendę DRUGI RAZ.
   */
  it('komenda pluginu z dwukropkiem jedzie BEZ `wait`, jak każda inna slash-komenda', async () => {
    const fx = await makeDriver();
    fx.driver.send('/code-review:code-review', undefined, undefined, commandOpts('/code-review:code-review', PLUGIN_CATALOG));
    await waitFor(() => prompts(fx).length === 1, 'slash');
    expect('wait' in (prompts(fx)[0] ?? {})).toBe(false);
  });

  it('wysyłka W ŚRODKU TURY bez `wait`: samo wklejenie i osobny Enter', async () => {
    // `wait` przy pracującym panelu kończy się timeoutem herdr i „Wysyłka nie powiodła się" przy
    // wiadomości, która NORMALNIE dochodzi: wiadomość wysłana w trakcie tury czeka w kolejce (docs
    // `interactive-mode.md`, „Queue messages while Claude works”). Panel Claude w turze nie dostaje
    // `agent.prompt` wcale: wklejenie, tekst w polu, Enter — `wait` nie ma gdzie wejść.
    const fx = await makeDriver({ agent: { status: 'working' } });
    composerPane(fx);
    fx.driver.send('dopisek w trakcie tury');
    await waitFor(() => pasteFlow(fx).includes('enter'), 'enter');
    expect(pasteFlow(fx)).toEqual(['paste:dopisek w trakcie tury', 'enter']);
    expect(prompts(fx)).toEqual([]);
  });

  it('stall, ale panel RUSZYŁ w międzyczasie — fałszywy alarm, zero ponowień', async () => {
    // Wyścig: `wait` poszedł przy bezczynnym panelu, tura wystartowała szybciej, niż herdr
    // zdążył to zobaczyć. Bramka „znaki życia" (#turnAlive) łapie świeży `working` i NIE ponawia.
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { stallSettleMs: 50, markSent: (key) => marked.push(key) },
    });
    fx.client.promptErrors.push(stalled());

    fx.driver.send('kolejka w środku tury');
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'refaktor' });
    await waitFor(() => marked.length > 0, 'markSent');

    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
    expect(systemTexts(fx.events)).toEqual([]);
  });

  it('potwierdzony stall: czyszcząca para + DOKŁADNIE jedno ponowienie, bez komunikatu', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { stallSettleMs: 5, markSent: (key) => marked.push(key) },
    });
    // Composer trzyma nasz tekst (połamany na szerokość panelu — porównanie zbija białe znaki).
    fx.client.screenText = '❯ zawieszony prompt\n  w composerze';
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) fx.client.screenText = '❯';
      return raw(paneId, keys);
    };
    fx.client.promptErrors.push(stalled());

    fx.driver.send('zawieszony prompt w composerze');
    await waitFor(() => marked.length > 0, 'markSent po ponowieniu');

    expect(prompts(fx).map((c) => c.text)).toEqual([
      'zawieszony prompt w composerze', 'zawieszony prompt w composerze',
    ]);
    expect(escs(fx)).toEqual([['escape', 'escape']]);
    expect(systemTexts(fx.events)).toEqual([]);
  });

  it('podwójny stall mówi głośno, oddaje composer i czyści pole przy następnej wysyłce', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { stallSettleMs: 5, markSent: (key) => marked.push(key) },
    });
    fx.client.screenText = '❯ utknęło na dobre';
    fx.client.promptErrors.push(stalled(), stalled());

    fx.driver.send('utknęło na dobre');
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'komunikat');
    await quiet();

    // Bez `markSent`: karencja `idle` po NIEUDANEJ wysyłce maskowałaby prawdziwy stan.
    expect(marked).toEqual([]);
    // Composer wraca do życia: herdr widzi panel bezczynny, więc idzie `idle`.
    expect(states(fx.events).at(-1)?.state).toBe('idle');

    /*
     * Następna wysyłka: `#needsEscape` każe sprawdzić pole. Tekst nadal w nim wisi
     * (komunikat obiecuje „tekst zostaje w polu"), więc idzie DRUGA para — a po niej,
     * z czystym ekranem, prompt. Razem: para z ponowienia stalla + para tej wysyłki.
     */
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) fx.client.screenText = '❯';
      return raw(paneId, keys);
    };
    fx.driver.send('druga wiadomość');
    await waitFor(() => prompts(fx).length === 3, 'druga wysyłka');
    expect(escs(fx)).toEqual([
      ['escape', 'escape'], ['escape', 'escape'], ['escape', 'escape'], ['escape', 'escape'],
    ]);
  });

  it('przyciemniona podpowiedź CLI w pustym polu = zero `escape`, prompt idzie', async () => {
    /*
     * Regresja: po stallu `#needsEscape` każe sprawdzić pole, a CLI 2.1.258
     * pokazuje w PUSTYM composerze podpowiedź następnego promptu przyciemnioną (SGR 2). Odczyt
     * bez atrybutów widział ją jako tekst → para Esc na pustym polu → rewind zjadał wysyłkę.
     * Composer czyta się z atrybutami (`visible` + `ansi`); zwykły zrzut wciąż niesie tę
     * podpowiedź jako goły tekst — i to on NIE MA prawa rozstrzygać.
     */
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { stallSettleMs: 5, markSent: (key) => marked.push(key) },
    });
    fx.client.screenText = '❯ utknęło na dobre';
    fx.client.promptErrors.push(stalled(), stalled());
    fx.driver.send('utknęło na dobre');
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'komunikat');
    await quiet();
    const escsAfterStall = escs(fx).length;

    fx.client.screenText = '❯ Dopisz test do tej funkcji i puść go';
    fx.client.screenAnsi = '❯ \x1b[0m\x1b[2mDopisz test do tej funkcji i puść go\x1b[0m';
    fx.driver.send('druga wiadomość');
    await waitFor(() => marked.length > 0, 'druga wysyłka');

    expect(escs(fx).length).toBe(escsAfterStall);
    expect(prompts(fx).at(-1)?.text).toBe('druga wiadomość');
    expect(fx.client.calls.filter((c) => c.method === 'read').at(-1)?.source).toBe('visible');
  });

  it('ekran BEZ naszego tekstu = zero `escape` (rozstrzyga watchdog, nie retry)', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { stallSettleMs: 5, markSent: (key) => marked.push(key) },
    });
    fx.client.screenText = 'zupełnie inny ekran';
    fx.client.promptErrors.push(stalled());

    fx.driver.send('ta wiadomość mogła jednak wejść');
    await waitFor(() => marked.length > 0, 'optymistyczny sukces');

    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
    expect(systemTexts(fx.events)).toEqual([]);
  });
});

describe('przerwanie (Esc) — regresje', () => {
  const escCount = (fx: Fixture): number =>
    fx.client.calls.filter((c) => c.method === 'send_keys' && c.keys?.[0] === 'escape').length;
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');

  it('przywrócony prompt schodzi PARAMI weryfikowanymi EKRANEM — wiadomości się nie skleją', async () => {
    const fx = await makeDriver();
    fx.driver.send('pierwsza wiadomość do panelu');
    await waitFor(() => prompts(fx).length === 1, 'pierwszy prompt');
    fx.driver.interrupt();
    await waitFor(() => escCount(fx) === 1, 'escape przerwania');

    /*
     * CC oddał prompt do composera (przypadek 13:47 — wtedy wiadomości się skleiły).
     * Uparty TUI: pierwsza para nie zdjęła tekstu, czyści dopiero druga — driver ma dojść
     * do skutku, weryfikując ekran po każdej parze.
     */
    fx.client.screenText = '❯ pierwsza wiadomość do panelu';
    let pairs = 0;
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) {
        pairs += 1;
        if (pairs >= 2) fx.client.screenText = '❯';
      }
      return raw(paneId, keys);
    };

    fx.driver.send('druga wiadomość');
    await waitFor(() => prompts(fx).length === 2, 'druga wysyłka');

    expect(prompts(fx)[1]?.text).toBe('druga wiadomość');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([
      ['escape'], ['escape', 'escape'], ['escape', 'escape'],
    ]);
  });

  it('sonda po przerwaniu pyta herdr o stan wprost i gasi wskrzeszone „pracuje"', async () => {
    // Opóźniony push `working` z ubitej tury wskrzeszał spinner aż do resyncu (test 13:47).
    const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [5, 10] } });
    fx.client.getAgent = (): Promise<HerdrAgentInfo> =>
      Promise.resolve({ status: 'idle' } as HerdrAgentInfo);
    fx.driver.interrupt();
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'idle z sondy');
  });

  it('nowsza wysyłka unieważnia sondę — jej `idle` nie zgasi świeżo startującej tury', async () => {
    // Sonda MUSI strzelić w oknie `quiet()` — przy 20 ms asercja idzie w wyścig z sondą (mierzone
    // ~17-19 ms po `interrupt()` przy strzale ~21 ms), więc czułość zależy od maszyny, nie od
    // kodu. Przy 1 ms sonda zdąży ZAWSZE.
    const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [1] } });
    fx.client.getAgent = (): Promise<HerdrAgentInfo> =>
      Promise.resolve({ status: 'idle' } as HerdrAgentInfo);
    fx.driver.interrupt();
    fx.driver.send('nowa tura zaraz po przerwaniu');
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    await quiet();
    expect(states(fx.events).some((e) => e.state === 'idle')).toBe(false);
  });

  it('Esc rozbraja watchdog tury — przerwana tura nie kończy się fałszywym „utknęła"', async () => {
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('tura do przerwania');
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    fx.driver.interrupt();
    await quiet();
    /*
     * Transkrypt PUSTY, i to jest cała asercja: panel nie zdążył wejść w `working`, więc śladu
     * po geście nie ma (patrz `midTurn` przy `INTERRUPT_DONE_MESSAGE`), a jedyne, co mogłoby
     * tu jeszcze stanąć, to fałszywe „wiadomość utknęła" z rozbrojonego watchdoga.
     */
    expect(systemTexts(fx.events)).toEqual([]);
  });
});

/**
 * Wynik `interrupt()` jest treścią odpowiedzi HTTP (`delivered`), więc każde `false`
 * kończy się w PWA czerwonym banerem nad przerwaniem. Ten blok pilnuje, komu to `false`
 * przysługuje — i tego, żeby zdania o błędzie nie mówiły o wiadomości, której nikt nie wysyłał.
 */
describe('przerwanie (Esc) — wynik dostarczenia i zdania o błędzie', () => {
  /** Podmienia `sendKeys` tak, że KAŻDY `escape` kończy się podanym błędem. */
  const failEscape = (fx: Fixture, err: unknown): void => {
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys[0] === 'escape' && keys.length === 1) {
        fx.client.calls.push({ method: 'send_keys', paneId, keys });
        return Promise.reject(err as Error);
      }
      return raw(paneId, keys);
    };
  };

  it('`herdr-stalled` to DOSTARCZENIE — klawisz poszedł, tylko herdr nie doczekał się echa',
    async () => {
      const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [] } });
      inTurn(fx);
      failEscape(fx, new HerdrStalledError(foreign('agent_prompt_stalled')));

      await expect(fx.driver.interrupt()).resolves.toBe(true);
      /*
       * Wpis mówi „przerwana", NIE „nie udało się" — i to jest treść wymagania: `herdr-stalled`
       * jest fałszywym alarmem, a ostrzeżenie nad udanym Esc zachęcałoby do drugiego, ten zaś
       * na pustym polu otwiera w CC rewind.
       */
      expect(systemTexts(fx.events)).toEqual([INTERRUPT_DONE_MESSAGE.text]);
      expect(INTERRUPT_DONE_MESSAGE.text).not.toContain('⚠');
      // Asercja na SŁOWO, nie na stałą: `toEqual([INTERRUPT_DONE_MESSAGE])` porównuje stałą samą
      // ze sobą, więc podmiana treści na „Nie udało się przerwać" przeszłaby bez mrugnięcia.
      expect(INTERRUPT_DONE_MESSAGE.text).toContain('Turn interrupted');
    });

  it('stall rozpoznany po TREŚCI nie jest sukcesem — `send_keys` nie używa `wait`', async () => {
    /*
     * `mapRemoteError` produkuje `herdr-stalled` DWIEMA drogami: z kodu `agent_prompt_stalled`
     * i z dopasowania „timed out waiting for agent" do dowolnego NIEZNANEGO kodu. Druga droga
     * powstała dla `agent.prompt` z `wait`; przy Esc połknięcie jej zamieniało nieznaną awarię
     * w fałszywe „Tura przerwana" plus TRWAŁY wpis w transkrypcie.
     */
    const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [] } });
    inTurn(fx);
    failEscape(fx, new HerdrStalledError(foreign('timed out waiting for agent status'), 'message'));

    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await quiet();
    const texts = systemTexts(fx.events);
    expect(texts).not.toContain(INTERRUPT_DONE_MESSAGE.text);
    // Nieznana awaria nazywa siebie i DROGĘ WYJŚCIA — cisza zostawiłaby człowieka bez niczego.
    expect(texts[0]).toContain("Couldn't interrupt the turn");
    expect(texts[0]).toContain('Open the pane in herdr on the Mac');
  });

  it('tryb tylko do odczytu przy Esc mówi o PRZERWANIU, nie o wiadomości — i ostrzega', async () => {
    const fx = await makeDriver();
    inTurn(fx);
    failEscape(fx, new HerdrReadOnlyError(foreign('feature_disabled')));

    await expect(fx.driver.interrupt()).resolves.toBe(false);
    const text = systemTexts(fx.events)[0] ?? '';
    expect(systemCodes(fx.events)[0]).toBe('commands.interrupt-read-only');
    expect(text).not.toContain('message');
    // `⚠` jak u sąsiadów: to ODMOWA, a wpis bez ostrzeżenia czytało się jak notkę o stanie
    // herdr — jedyne zdanie o przerwaniu bez tego znaku ma być sukcesem.
    expect(text.startsWith('⚠')).toBe(true);
  });

  it('odmowa herdr przy Esc nie ogłasza niewysłanej wiadomości', async () => {
    const fx = await makeDriver();
    failEscape(fx, new HerdrBlockedError(foreign('agent_blocked')));

    await expect(fx.driver.interrupt()).resolves.toBe(false);
    const text = systemTexts(fx.events)[0] ?? '';
    expect(systemCodes(fx.events)[0]).toBe('commands.interrupt-blocked');
    expect(text).toContain('The turn was not interrupted');
    expect(text).not.toContain('message');
    // Wejście w `blocked` zostaje — to informacja o panelu, nie o gestcie.
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  it('nieznany błąd przy Esc nazywa przerwanie i niesie DROGĘ WYJŚCIA na Maca', async () => {
    const fx = await makeDriver();
    failEscape(fx, new Error('gniazdo padło.'));

    await expect(fx.driver.interrupt()).resolves.toBe(false);
    expect(systemTexts(fx.events)[0]).toContain("Couldn't interrupt the turn");
    /*
     * Odmowa herdr i tryb read-only nazywają przeszkodę same z siebie, nieznana awaria nie —
     * a telefon nie dopisuje swojego „otwórz go w herdr na Macu". Bez tej rady człowiek zostaje
     * z samym tekstem wyjątku.
     */
    expect(systemTexts(fx.events)[0]).toContain('Open the pane in herdr on the Mac');
    // Kropka z komunikatu wyjątku nie zostaje podwojona — „padło.. Otwórz" wygląda na literówkę.
    expect(systemTexts(fx.events)[0]).not.toContain('..');

    // Bramka na drugą stronę rozróżnienia: `SendOp` nie ma prawa wyciec na ścieżkę promptu.
    fx.client.promptError = new Error('gniazdo dalej padło');
    fx.driver.send('zwykła wiadomość');
    await waitFor(() => systemTexts(fx.events).length > 1, 'komunikat wysyłki');
    expect(systemTexts(fx.events)[1]).toContain("Couldn't send to the pane");
  });
});

/**
 * Ślad po geście w transkrypcie pisze SERWER.
 *
 * Podział, którego te testy pilnują: **linia pod polem mówi to, co wie TELEFON, a transkrypt
 * to, co SIĘ STAŁO.** Notka lokalna PWA w transkrypcie nie
 * byłaby widoczna na drugim urządzeniu i znikałaby po wyjściu z sesji i powrocie, bo transkrypt
 * odtwarza się wtedy ze snapshotu serwera. Wynik dostarczenia zna wyłącznie serwer, więc to
 * jego zdanie jest jedynym trwałym.
 */
describe('przerwanie (Esc) — trwały ślad w transkrypcie', () => {
  const failEscape = (fx: Fixture, err: unknown): void => {
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys[0] === 'escape' && keys.length === 1) {
        fx.client.calls.push({ method: 'send_keys', paneId, keys });
        return Promise.reject(err as Error);
      }
      return raw(paneId, keys);
    };
  };

  it('dostarczony `escape` dokłada wiadomość systemową — jedną, po rozstrzygnięciu wysyłki',
    async () => {
      const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [] } });
      inTurn(fx);

      await expect(fx.driver.interrupt()).resolves.toBe(true);
      await quiet();
      expect(systemTexts(fx.events)).toEqual([INTERRUPT_DONE_MESSAGE.text]);
    });

  it('Esc do panelu, który JUŻ STOI, nie dopisuje nic — żadnej tury nie było', async () => {
    /*
     * Przebieg z recenzji: wpis wysyłki wisi (echo nie przyszło), `inFlightSends > 0` trzyma
     * Stop na ekranie, a drugi Esc po 2 s przechodzi (debounce minął). Bez warunku „tura w toku"
     * transkrypt dostawał DRUGIE „Tura przerwana z Raroga" nad panelem, który nic nie robił —
     * a w Claude Code taki `escape` na pustym composerze mógł otworzyć REWIND.
     */
    const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [] } });

    // Klawisz LECI mimo to: bramka na wysyłce połykałaby prawdziwe przerwania w karencji
    // `waiting-input` (konstrukcja odrzucona w review) — milczy WYŁĄCZNIE transkrypt.
    await expect(fx.driver.interrupt()).resolves.toBe(true);
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['escape']]);
    expect(systemTexts(fx.events)).toEqual([]);
  });

  it('panel na dialogu (`blocked`) to wciąż tura — wpis zostaje', async () => {
    const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [] } });
    inTurn(fx, 'blocked');

    await expect(fx.driver.interrupt()).resolves.toBe(true);
    await quiet();
    expect(systemTexts(fx.events)).toContain(INTERRUPT_DONE_MESSAGE.text);
  });

  it('odmowa herdr dokłada OSTRZEŻENIE i ani słowa o przerwanej turze', async () => {
    const fx = await makeDriver();
    failEscape(fx, new HerdrBlockedError(foreign('agent_blocked')));

    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await quiet();
    // Jedno zdanie na jeden klawisz: przyczynę nazywa `#reportSendError`, więc `interrupt()`
    // nie dokłada drugiego ⚠ obok.
    const texts = systemTexts(fx.events);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('⚠');
    expect(texts).not.toContain(INTERRUPT_DONE_MESSAGE.text);
  });

  it('zniknięty panel też mówi — `detached` przestawia kartę, ale nie tłumaczy gestu', async () => {
    const fx = await makeDriver();
    failEscape(fx, new HerdrGoneError(foreign('agent_gone')));

    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await quiet();
    // Zdanie MUSI wyjść przed `detached`, inaczej manager zdąży oznaczyć sesję jako nieaktualną.
    expect(systemTexts(fx.events)).toEqual([GONE_INTERRUPT_MESSAGE.text]);
    const detachedAt = fx.events.findIndex((e) => e.type === 'detached');
    const saidAt = fx.events.findIndex((e) => e.type === 'message');
    expect(saidAt).toBeGreaterThan(-1);
    expect(saidAt).toBeLessThan(detachedAt);
  });

  it('wpis jedzie jako wiadomość roli `system` — tą samą drogą, którą manager zapisuje trwale',
    async () => {
      const fx = await makeDriver({ deps: { interruptProbeDelaysMs: [] } });
      inTurn(fx);

      await expect(fx.driver.interrupt()).resolves.toBe(true);
      await quiet();
      const said = fx.events.find((e) => e.type === 'message');
      expect(said).toBeDefined();
      expect(said?.type === 'message' ? said.role : null).toBe('system');
    });
});

/**
 * Rozpoznanie komendy w driverze: driver NIE zgaduje komendy z tekstu. Bierze klasyfikację
 * managera z `SendOptions`, a drugi strażnik klasyfikuje tekst ponownie z TEJ SAMEJ migawki — rozjazd
 * to odmowa, bo od tej decyzji zależy, czy tekst ominie stall-guard (który potrafi wysłać DRUGI raz).
 */
describe('rozpoznanie komendy w driverze', () => {
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');

  it('bez strażnika i bez klasyfikacji tekst „/compact” jedzie jak prompt — driver nie zgaduje', async () => {
    const fx = await makeDriver();
    fx.driver.send('/compact');
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    expect(prompts(fx)[0]?.wait).toBe(true);
  });

  it('strażnik bez klasyfikacji managera bierze migawkę z `deps.commandCatalog`', async () => {
    const seen: string[] = [];
    const fx = await makeDriver({
      deps: {
        guard: assertSendable,
        commandCatalog: (cwd) => { seen.push(cwd); return PLUGIN_CATALOG; },
      },
    });
    fx.driver.send('/code-review:code-review');
    await waitFor(() => prompts(fx).length === 1, 'slash');
    expect('wait' in (prompts(fx)[0] ?? {})).toBe(false);
    expect(seen).toEqual([fx.cwd]);
  });

  it('rozjazd z klasyfikacją managera = odmowa bez ani jednego bajtu do panelu', async () => {
    const fx = await makeDriver({ deps: { guard: assertSendable } });
    // Manager twierdzi „prompt”, a ta sama migawka mówi „komenda” — wysyłki nie ma.
    fx.driver.send('/compact', undefined, undefined, { command: { catalog: registryCatalog(), slash: null } });
    await waitFor(() => systemTexts(fx.events).length > 0, 'odmowa');
    expect(fx.client.mutations).toBe(0);
    expect(systemTexts(fx.events)[0]).toMatch(/recognize the command differently/);
  });

  it('odmowa drugiego strażnika ląduje w dzienniku jako `refuse` z samą nazwą komendy', async () => {
    const fx = await makeDriver({ deps: { guard: assertSendable } });
    fx.driver.send('/usa sekret', undefined, undefined, { command: { catalog: registryCatalog(), slash: null } });
    await waitFor(() => fx.audit.length > 0, 'wpis odmowy');
    expect(fx.client.mutations).toBe(0);
    expect(fx.audit[0]).toMatchObject({ method: 'refuse', reason: 'command-not-allowed', command: '/usa' });
    expect(JSON.stringify(fx.audit[0])).not.toContain('sekret');
  });

  it('komenda z katalogu przechodzi oba strażniki i jedzie bez `wait`', async () => {
    const fx = await makeDriver({ deps: { guard: assertSendable } });
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await waitFor(() => prompts(fx).length === 1, 'slash');
    expect('wait' in (prompts(fx)[0] ?? {})).toBe(false);
  });
});

/*
 * Artefakty sesji: zdarzenie followera `artifacts` idzie do managera 1:1. Nie jest znakiem życia pliku —
 * pierwsza wypłata przychodzi także BEZ pliku (pudło globu), a watchdog tury liczy ciszę od przyrostu pliku.
 */
describe('artefakty sesji', () => {
  const artifactsOf = (events: readonly DriverEvent[]): DriverEvent[] => events.filter((e) => e.type === 'artifacts');

  it('lista z pliku rozmowy idzie 1:1 jako zdarzenie `artifacts`', async () => {
    const url = 'https://claude.ai/artifact/ArtefaktTestowyH000001';
    const fx = await makeDriver({ transcript: `${JSON.stringify({
      type: 'user', timestamp: '2026-10-16T10:01:00.000Z', isSidechain: false, sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      toolUseResult: { url, title: 'Raport', updated: false, path: '/private/tmp/x/raport.html' },
    })}\n` });
    await waitFor(() => artifactsOf(fx.events).length > 0, 'lista artefaktów');
    expect(artifactsOf(fx.events)).toEqual([{
      type: 'artifacts', artifacts: [{ url, title: 'Raport', publishedAt: '2026-10-16T10:01:00.000Z' }],
    }]);
  });

  it('panel bez pliku: pusta lista od razu, a watchdog tury dalej widzi ciszę po wysyłce', async () => {
    const fx = await makeDriver({ noTranscript: true, deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('wysłane w próżnię');
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'watchdog');
    await waitFor(() => artifactsOf(fx.events).length > 0, 'pusta lista artefaktów');
    expect(artifactsOf(fx.events)).toEqual([{ type: 'artifacts', artifacts: [] }]);
  });
});

/*
 * Nazwa rozmowy: wpis `custom-title` pliku rozmowy jedzie do managera jako `title` ze źródłem, od razu, bez
 * czekania na tytuł panelu w herdr.
 */
describe('nazwa rozmowy z `custom-title`', () => {
  it('wpis z pliku rozmowy → `title` z `source: custom-title`', async () => {
    const fx = await makeDriver({
      transcript: `${JSON.stringify({ type: 'custom-title', customTitle: 'demo-eksport', sessionId: SESSION })}\n`,
    });
    await waitFor(() => fx.events.some((e) => e.type === 'title'), 'nazwa rozmowy');
    expect(fx.events.filter((e) => e.type === 'title'))
      .toEqual([{ type: 'title', title: 'demo-eksport', source: 'custom-title' }]);
  });
});

/*
 * Zadania w tle: pierwsza lista po podpięciu idzie zawsze, także pusta (wymiana drivera zachowuje sesję z listą
 * poprzedniego). Pusta wypłata przychodzi także BEZ pliku, więc zdarzenie `tasks` nie jest znakiem życia pliku:
 * strażnik zawieszonej wysyłki i watchdog tury liczą ciszę od pozostałych zdarzeń followera.
 */
describe('zadania w tle: pierwsza lista po podpięciu', () => {
  const tasksOf = (events: readonly DriverEvent[]): DriverEvent[] => events.filter((e) => e.type === 'background-tasks');

  /** Follower sterowany z testu: zdarzenie wychodzi dokładnie wtedy, gdy test je poda. */
  const manualFollower = (): { follower: JsonlFollower; push: (event: FollowEvent) => void } => {
    const queue = new AsyncEventQueue<FollowEvent>();
    return {
      follower: {
        events: queue,
        repoint: () => undefined,
        dropEcho: () => undefined,
        forgetEcho: () => undefined, joinEcho: () => undefined,
        expectTranscript: () => undefined,
        hasTranscript: () => 'no',
        noteProcessStart: () => undefined,
        noteUltracodeRequest: () => undefined,
        close: () => { queue.close(); },
      },
      push: (event) => { queue.push(event); },
    };
  };

  it('panel bez pliku: pusta lista od razu idzie do managera', async () => {
    const fx = await makeDriver({ noTranscript: true });
    await waitFor(() => tasksOf(fx.events).length > 0, 'pusta lista zadań');
    await quiet();
    expect(tasksOf(fx.events)).toEqual([{ type: 'background-tasks', tasks: [] }]);
  });

  it('pusta wypłata zadań w oknie watchdoga nie zeruje licznika ciszy: watchdog i tak oddaje composer', async () => {
    const manual = manualFollower();
    const fx = await makeDriver({ noTranscript: true, deps: { turnWatchdogMs: 150, follow: () => manual.follower } });
    fx.driver.send('wysłane w próżnię');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    // Watchdog jest już uzbrojony; wypłata przychodzi w jego oknie, jak pierwsza lista po pudle globu.
    await new Promise((resolve) => setTimeout(resolve, 20));
    manual.push({ type: 'tasks', tasks: [] });
    await waitFor(() => tasksOf(fx.events).length > 0, 'pusta lista zadań');
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'watchdog');
    expect(tasksOf(fx.events)).toEqual([{ type: 'background-tasks', tasks: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Komendy sterujące `/model` i `/effort`
// ---------------------------------------------------------------------------

/** Ekran z dialogiem potwierdzenia `/model` — sygnatura `model` z zamkniętej listy. */
const DIALOG_MODEL = readFileSync(join(FIXTURES, 'dialog-model-switch.txt'), 'utf8');
/**
 * Ekran z dialogiem `Change effort level?` — klasa `confirm` silnika dialogów (rekonstrukcja realnego
 * ekranu, wersja CLI niezapisana).
 */
const DIALOG_EFFORT = readFileSync(join(FIXTURES, 'dialog-effort-change.txt'), 'utf8');
/**
 * Zrzut z realnego panelu: opcja „don’t ask again" z apostrofem typograficznym (zmierzonym
 * na CLI 2.1.246).
 */
const DIALOG_SUBAGENT =
  readFileSync(join(FIXTURES, 'dialog-permission-subagent.txt'), 'utf8');
/**
 * Rekonstrukcja realnego ekranu (wersja CLI niezapisana): reguła `Ask` w trybie auto,
 * opcja „Yes, and allow … commands".
 */
const DIALOG_ASK_RULE_AUTO =
  readFileSync(join(FIXTURES, 'dialog-permission-ask-rule-auto.txt'), 'utf8');

// ---------------------------------------------------------------------------
// Dialog ZGODY CLI, którego herdr nie widzi (CLI 2.1.258)
// ---------------------------------------------------------------------------

describe('dialog zgody CLI przy panelu `idle`', () => {
  const CONSENT = readFileSync(join(FIXTURES, 'dialog-automode-teach-2.1.258.txt'), 'utf8');
  const escs = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');

  it('zdarzenie nadzorcy → karta „zgoda CLI" bez zatwierdzania, stan `blocked`, wpis odmowy', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    fx.client.screenText = CONSENT;

    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta');

    const card = screenDialogs(fx.events)[0]!;
    expect(card.knownDialog).toBeUndefined();
    expect(card.reason).toBe('consent-dialog');
    expect(card.screen).toContain('Teach auto mode');
    // Dla herdr panel jest `idle`; dla telefonu CZEKA NA DECYZJĘ.
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
    const refusals = fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'));
    expect(refusals.map((e) => e.reason)).toEqual(['consent-dialog']);
    expect(refusals[0]?.toolName).toBe('dialog:auto-mode-teach');

    // Ten sam dialog drugi raz = zero nowych kart (idempotencja).
    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await quiet();
    expect(screenDialogs(fx.events)).toHaveLength(1);
  });

  it('wysyłka przy stojącym dialogu NIE idzie do panelu — zdanie „NIE została wysłana"', async () => {
    /*
     * Bez bramki tekst wpada w kolejkę CLI za dialogiem: `agent.prompt` z `wait` kończy się
     * timeoutem, watchdog melduje „utknęła", a wiadomość wychodzi sama po zgodzie przy biurku
     * Bramka czyta ekran przed KAŻDĄ wysyłką, także
     * bez zdarzenia nadzorcy — i sama stawia kartę.
     */
    const fx = await makeDriver({ transcript: userLine('start') });
    fx.client.screenText = CONSENT;

    fx.driver.send('pytam bo mam takie usecase');
    await waitFor(() => systemCodes(fx.events).includes('commands.send-held.consent-dialog'), 'zdanie');
    await quiet();

    expect(prompts(fx)).toEqual([]);
    expect(escs(fx)).toEqual([]);
    expect(screenDialogs(fx.events)).toHaveLength(1);
    expect(states(fx.events).at(-1)?.state).toBe('blocked');

    // Komenda sterująca też stoi — `/model` wpisany w dialog trafiał do tej samej kolejki.
    fx.driver.sendCommands?.(['/model fable']);
    await quiet();
    expect(prompts(fx)).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'model_change')).toEqual([]);
  });

  it('„Odrzuć (Esc)" z karty zamyka dialog: Esc, karta gaśnie, stan wraca do `idle`', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    fx.client.screenText = CONSENT;
    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta');

    fx.client.screenText = '❯';
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual({ kind: 'applied' });
    await quiet();

    expect(escs(fx)).toEqual([['escape']]);
    expect(fx.events.some((e) => e.type === 'permission-cleared')).toBe(true);
    expect(states(fx.events).at(-1)?.state).toBe('idle');

    // Po zamknięciu wysyłka idzie normalnie.
    fx.driver.send('teraz już można');
    await waitFor(() => prompts(fx).length > 0, 'prompt');
    expect(prompts(fx).at(-1)?.text).toBe('teraz już można');
  });

  it('zniknięcie dialogu z ekranu (zdarzenie `null`) i start tury gaszą kartę', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    fx.client.screenText = CONSENT;
    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta');

    fx.client.screenText = '❯';
    fx.emit({ type: 'consent-dialog', dialog: null });
    await waitFor(() => fx.events.some((e) => e.type === 'permission-cleared'), 'zgaszenie');
    expect(states(fx.events).at(-1)?.state).toBe('idle');

    // Dialog wraca, a potem panel wchodzi w turę (zgoda przy biurku wypuściła kolejkę).
    fx.client.screenText = CONSENT;
    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await waitFor(() => screenDialogs(fx.events).length > 1, 'druga karta');
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: 'refaktor' });
    await quiet();
    expect(states(fx.events).at(-1)?.state).toBe('working');
    expect(fx.events.filter((e) => e.type === 'permission-cleared')).toHaveLength(2);
  });
});

describe('sendCommands', () => {
  /** Driver z krótkim odstępem prób — realne 400 ms sprawdza wyłącznie `setTimeout`. Pole promptu puste. */
  const makeCommandDriver = async (): Promise<Fixture> => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { modelConfirmPollMs: 5 } });
    fx.client.screenAnsi = EMPTY_FIELD;
    return fx;
  };

  const modelSets = (fx: Fixture): Extract<DriverEvent, { type: 'model-set' }>[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'model-set' }> => e.type === 'model-set');

  const keys = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);

  it('wysyła komendę i POTWIERDZA dialog cyfrą opcji twierdzącej', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_MODEL;

    fx.driver.sendCommands?.(['/model opus']);
    await waitFor(() => keys(fx).length > 0, 'cyfra potwierdzenia');
    await quiet();

    expect(fx.client.calls.filter((c) => c.method === 'prompt').map((c) => c.text))
      .toEqual(['/model opus']);
    // „1. Yes, switch to Opus 5" — cyfra z TEKSTU opcji, nie z pozycji na ekranie.
    expect(keys(fx)).toEqual([['1']]);
    /*
     * Dziennik ma odpowiadać na pytanie „czy ktoś przestawił model konta": osobna metoda
     * `model_change` daje na to jeden grep, a etykieta mówi, CO zatwierdzono.
     */
    expect(fx.audit.map((e) => e.method)).toEqual(['model_change', 'model_change']);
    expect(fx.audit[0]?.text).toBe('/model opus');
    expect(fx.audit[1]).toMatchObject({ keys: ['1'], optionLabel: 'Yes, switch to Opus 5' });
  });

  it('dialog `Change effort level?` po `/effort` jest potwierdzany (silnik dialogów)', async () => {
    /*
     * Regresja (wersja CLI niezapisana): `/effort high` pokazuje dialog potwierdzenia; bez jego
     * obsługi pigułka effortu zmienia się w Rarogu, a panel zostaje przy starym poziomie. Dialog
     * przechodzi klasą `confirm`: treść pytania niesie nazwę komendy, cyfra idzie z TEKSTU opcji.
     */
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_EFFORT;

    fx.driver.sendCommands?.(['/effort high']);
    await waitFor(() => keys(fx).length > 0, 'cyfra potwierdzenia');
    await quiet();

    expect(keys(fx)).toEqual([['1']]);
    // Dziennik nazywa rozpoznanie: `dialog:confirm`, nie `dialog:model` — to nie ta sygnatura.
    expect(fx.audit[1]).toMatchObject({
      keys: ['1'], toolName: 'dialog:confirm', optionLabel: 'Yes, switch to high',
    });
    expect(modelSets(fx)).toEqual([{ type: 'model-set', effort: 'high' }]);
  });

  it('dialog effortu przy komendzie `/model` = obcy — klasa confirm pilnuje TEJ komendy', async () => {
    // Dialog nie mówi ani o „model" w treści, ani o wartości `opus` w opcjach → zero klawiszy.
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_EFFORT;

    fx.driver.sendCommands?.(['/model opus']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-foreign-dialog'), 'ostrz');
    await quiet();

    expect(keys(fx)).toEqual([]);
    expect(modelSets(fx)).toEqual([]);
  });

  it('dialog, którego Rarog nie zamawiał, NIE dostaje ani jednej cyfry', async () => {
    /*
     * TEST OBOWIĄZKOWY. Między wysłaniem `/model` a odczytem ekranu panel mógł pokazać coś
     * zupełnie innego (zgoda na `Bash`, która właśnie wjechała). Ślepe wysłanie cyfry
     * zatwierdzałoby wtedy CUDZĄ zgodę — dlatego rozstrzyga sygnatura, nie sam fakt dialogu.
     */
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_PERMISSION;

    fx.driver.sendCommands?.(['/model opus']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-foreign-dialog'), 'ostrz');
    await quiet();

    expect(keys(fx)).toEqual([]);
  });

  it('numerowana lista w scrollbacku NIE jest obcym dialogiem — pętla czeka dalej', async () => {
    /*
     * Regresja (CLI 2.1.258): nad echem `/model` stoi odpowiedź agenta „1. Run the unit tests…
     * 2. Read the new error message…". Parser oddaje `kind: 'other'` z dwiema opcjami; pętla nie może uznać tego
     * za obcy dialog i pisać „nie rozpoznałem — dokończ w terminalu", gdy panel model ustawił
     * (wiersz „⎿ Set model to …"). Tu ekran ma listę, ale NIE ma wiersza
     * wyniku — pętla ma dojść do końca i skończyć zdaniem „nie poprosił o potwierdzenie".
     */
    const fx = await makeCommandDriver();
    fx.client.screenText = readFileSync(join(FIXTURES, 'model-set-inline-2.1.258.txt'), 'utf8')
      .replace('  ⎿  Set model to Fable 5.1 and saved as your default for new sessions\n', '');

    fx.driver.sendCommands?.(['/model fable']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-no-dialog'), 'zdanie');
    await quiet();

    expect(keys(fx)).toEqual([]);
    expect(systemCodes(fx.events).includes('model.change-foreign-dialog')).toBe(false);
    expect(modelSets(fx)).toEqual([{ type: 'model-set', model: 'fable' }]);
  });

  it('wynik `/model` wypisany w miejscu kończy czekanie od razu (2.1.258)', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = readFileSync(join(FIXTURES, 'model-set-inline-2.1.258.txt'), 'utf8');

    fx.driver.sendCommands?.(['/model fable']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-inline'), 'zdanie');
    await quiet();

    expect(keys(fx)).toEqual([]);
    // Bramka dialogu zgody (1) + pole promptu (1) + jeden odczyt pętli (1) — bez wiersza wyniku pętla robi ich
    // MODEL_CONFIRM_ATTEMPTS.
    expect(fx.client.calls.filter((c) => c.method === 'read').length).toBe(3);
    expect(modelSets(fx)).toEqual([{ type: 'model-set', model: 'fable' }]);
  });

  it('brak dialogu kończy się zdaniem, a nie ciszą', async () => {
    // Tak zachowuje się m.in. `/effort`: komenda działa od razu, potwierdzenia nie ma.
    const fx = await makeCommandDriver();
    fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';

    fx.driver.sendCommands?.(['/effort high']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-no-dialog'), 'zdanie');
    expect(keys(fx)).toEqual([]);
  });

  it('nieudana wysyłka komendy nie prowadzi do żadnej cyfry', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_MODEL;
    fx.client.promptError = new HerdrBlockedError(foreign('agent_blocked'));

    fx.driver.sendCommands?.(['/model opus']);
    await quiet();

    // Panel odrzucił komendę, więc dialogu potwierdzenia nie ma i nie ma czego zatwierdzać.
    expect(keys(fx)).toEqual([]);
  });

  it('dwie komendy jadą PO KOLEI, nigdy równolegle', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_MODEL;
    // A key brings back the prompt field, `/effort high` draws its own dialog (it confirms only a dialog about itself).
    const [prompt, raw] = [fx.client.prompt.bind(fx.client), fx.client.sendKeys];
    fx.client.prompt = async (paneId, text, wait) => {
      await prompt(paneId, text, wait);
      if (text === '/effort high') fx.client.screenText = DIALOG_EFFORT;
    };
    fx.client.sendKeys = (paneId, sent) => { fx.client.screenText = EMPTY_FIELD; return raw(paneId, sent); };

    fx.driver.sendCommands?.(['/model opus', '/effort high']);
    await waitFor(() => keys(fx).length === 2, 'dwa potwierdzenia');

    const order = fx.client.calls
      .filter((c) => c.method === 'prompt' || c.method === 'send_keys')
      .map((c) => c.text ?? (c.keys ?? []).join(''));
    expect(order).toEqual(['/model opus', '1', '/effort high', '1']);
  });

  it('przyjęta komenda emituje `model-set` — pigułka nie czeka na następną turę', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_MODEL;

    fx.driver.sendCommands?.(['/model opus']);
    await waitFor(() => modelSets(fx).length > 0, 'model-set');

    expect(modelSets(fx)).toEqual([{ type: 'model-set', model: 'opus' }]);
  });

  it('`/effort` bez dialogu też emituje `model-set`', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';

    fx.driver.sendCommands?.(['/effort high']);
    await waitFor(() => modelSets(fx).length > 0, 'model-set');

    expect(modelSets(fx)).toEqual([{ type: 'model-set', effort: 'high' }]);
  });

  it('obcy dialog na ekranie = ZERO `model-set` (pigułka nie zgaduje)', async () => {
    const fx = await makeCommandDriver();
    fx.client.screenText = DIALOG_PERMISSION;

    fx.driver.sendCommands?.(['/model opus']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-foreign-dialog'), 'ostrz');
    await quiet();

    expect(modelSets(fx)).toEqual([]);
  });

  /*
   * `agent.prompt` dopisuje tekst do pola CLI i naciska Enter, a po przerwaniu Esc CLI oddaje przerwany prompt
   * do pola — bez czyszczenia `/effort high` wyszedłby razem z nim jako zwykły prompt. Reguła: Enter tylko na
   * pole puste.
   */
  describe('pole promptu przed komendą', () => {
    const prompts = (fx: Fixture): string[] => fx.client.calls
      .filter((c) => c.method === 'prompt').map((c) => c.text ?? '');
    const fieldReads = (fx: Fixture): number => fx.client.calls
      .filter((c) => c.method === 'read' && c.source === 'visible').length;

    it('przerwanie z Raroga: oddany prompt czyści para Esc, dopiero potem `/effort high`', async () => {
      const fx = await makeCommandDriver();
      fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';
      fx.driver.send('pierwszy prompt');
      await waitFor(() => prompts(fx).length === 1, 'pierwszy prompt');
      inTurn(fx);
      await quiet();
      // CLI oddał przerwany prompt do pola; para Esc je czyści.
      fx.client.screenAnsi = fieldScreen('pierwszy prompt');
      const raw = fx.client.sendKeys;
      fx.client.sendKeys = (paneId, sent) => {
        if (sent.length === 2) fx.client.screenAnsi = EMPTY_FIELD;
        return raw(paneId, sent);
      };
      fx.driver.interrupt();
      fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 9, title: 'refaktor' });
      fx.driver.sendCommands?.(['/effort high']);
      await waitFor(() => modelSets(fx).length > 0, 'model-set');
      await quiet();

      expect(fx.client.calls.filter((c) => c.method === 'prompt' || c.method === 'send_keys')
        .map((c) => c.keys ?? c.text))
        .toEqual(['pierwszy prompt', ['escape'], ['escape', 'escape'], '/effort high']);
      expect(modelSets(fx)).toEqual([{ type: 'model-set', effort: 'high' }]);
    });

    it('pole `filled` bez przerwania z Raroga: zero klawiszy, zdanie, bez `model-set`', async () => {
      const fx = await makeCommandDriver();
      fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';
      fx.client.screenAnsi = fieldScreen('szkic wpisany przy biurku');

      fx.driver.sendCommands?.(['/effort high']);
      await waitFor(() => systemCodes(fx.events).includes('model.change-unsent-prompt.mac'), 'zdanie');
      await quiet();

      expect(prompts(fx)).toEqual([]);
      expect(keys(fx)).toEqual([]);
      expect(modelSets(fx)).toEqual([]);
      expect(fx.audit.filter((e) => e.method === 'model_change')).toEqual([]);
      expect(systemTexts(fx.events)).toContain(
        "⚠ “/effort high” wasn't sent. There's unsent text in the prompt field on the Mac. Send it or clear it, "
        + 'then try again.',
      );
    });

    it('pole `filled` na VPS: słowo maszyny z systemu serwera', async () => {
      const fx = await makeDriver({
        transcript: userLine('start'), deps: { modelConfirmPollMs: 5, system: 'linux' },
      });
      fx.client.screenAnsi = fieldScreen('szkic');

      fx.driver.sendCommands?.(['/model opus']);
      await waitFor(() => systemCodes(fx.events).includes('model.change-unsent-prompt.vps'), 'zdanie');
      expect(prompts(fx)).toEqual([]);
    });

    it('pole `unknown` (brak ramki albo błąd odczytu): zero klawiszy, zdanie, bez `model-set`', async () => {
      for (const broken of [true, false]) {
        const fx = await makeCommandDriver();
        fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';
        fx.client.screenAnsi = '❯ ';
        if (broken) {
          const raw = fx.client.readScreen.bind(fx.client);
          fx.client.readScreen = (paneId, source, format) => (
            format === 'ansi' ? Promise.reject(new Error('EIO')) : raw(paneId, source, format));
        }

        fx.driver.sendCommands?.(['/effort high']);
        await waitFor(() => systemCodes(fx.events).includes('model.change-composer-unknown'), 'zdanie');
        await quiet();

        expect(prompts(fx)).toEqual([]);
        expect(keys(fx)).toEqual([]);
        expect(modelSets(fx)).toEqual([]);
      }
    });

    it('paczka `/model` + `/effort`: odczyt pola przed KAŻDĄ komendą', async () => {
      const fx = await makeCommandDriver();
      fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';
      // Po pierwszej komendzie ktoś zaczął pisać w terminalu.
      const raw = fx.client.prompt.bind(fx.client);
      fx.client.prompt = (paneId, text, wait) => {
        fx.client.screenAnsi = fieldScreen('ktoś pisze przy biurku');
        return raw(paneId, text, wait);
      };

      fx.driver.sendCommands?.(['/model opus', '/effort high']);
      await waitFor(() => systemCodes(fx.events).includes('model.change-unsent-prompt.mac'), 'zdanie');
      await quiet();

      expect(prompts(fx)).toEqual(['/model opus']);
      expect(fieldReads(fx)).toBe(2);
      expect(modelSets(fx)).toEqual([{ type: 'model-set', model: 'opus' }]);
    });

    it('pole puste: komenda jak dziś, jeden odczyt pola, zero Esc', async () => {
      const fx = await makeCommandDriver();
      fx.client.screenText = 'zwykły ekran panelu bez żadnego dialogu';

      fx.driver.sendCommands?.(['/effort high']);
      await waitFor(() => modelSets(fx).length > 0, 'model-set');

      expect(prompts(fx)).toEqual(['/effort high']);
      expect(keys(fx)).toEqual([]);
      expect(fieldReads(fx)).toBe(1);
    });
  });
});

describe('sendCommands — ultracode', () => {
  /** Zrzuty z pomiaru 2.1.317: echo komendy i wiersz wyniku w miejscu, bez dialogu. */
  const ON_SCREEN = readFileSync(join(FIXTURES, 'ultracode', 'wynik-effort-ultracode-2.1.317.txt'), 'utf8');
  const OFF_SCREEN = readFileSync(join(FIXTURES, 'ultracode', 'wynik-effort-ultracode-off-2.1.317.txt'), 'utf8');
  /** Zdanie odmowy z pliku dowodu (pomiar z wyłączonymi workflow) w miejscu wyniku włączenia. */
  const REFUSAL = (JSON.parse(readFileSync(join(FIXTURES, 'commands', EVIDENCE.ultracode.file), 'utf8')) as {
    observed: { stdout: { unavailable: string } };
  }).observed.stdout.unavailable;
  /** Zrzut włączenia z podmienionym wierszem wyniku pod OSTATNIM echem `on` (wyżej stoi też wynik `off`). */
  const underOnEcho = (replace: (line: string) => string): string => {
    const echo = `❯ ${ULTRACODE_COMMANDS.on}\n`;
    const start = ON_SCREEN.lastIndexOf(echo) + echo.length;
    const end = ON_SCREEN.indexOf('\n', start);
    return ON_SCREEN.slice(0, start) + replace(ON_SCREEN.slice(start, end)) + ON_SCREEN.slice(end);
  };
  const REFUSED_SCREEN = underOnEcho(() => `  ⎿  ${REFUSAL}`);

  const modelSets = (fx: Fixture): Extract<DriverEvent, { type: 'model-set' }>[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'model-set' }> => e.type === 'model-set');
  const keys = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);

  /** Driver z krótkim odstępem prób i followerem, który notuje żądania ultracode. */
  async function ultracodeDriver(screen: string): Promise<{ fx: Fixture; requests: number[] }> {
    const requests: number[] = [];
    const follower: JsonlFollower = {
      ...stubFollower(() => 'no'),
      noteUltracodeRequest: (atMs) => { requests.push(atMs); },
    };
    const fx = await makeDriver({
      transcript: userLine('start'), deps: { modelConfirmPollMs: 5, follow: () => follower },
    });
    fx.client.screenText = screen;
    fx.client.screenAnsi = EMPTY_FIELD;
    return { fx, requests };
  }

  it('włączenie: wynik w miejscu kończy czekanie, `model-set` z ultracode i uzbrojona reguła pierwszej tury', async () => {
    const { fx, requests } = await ultracodeDriver(ON_SCREEN);
    const before = Date.now();
    fx.driver.sendCommands?.([ULTRACODE_COMMANDS.on]);
    await waitFor(() => systemCodes(fx.events).includes(ULTRACODE_ON_DONE_MESSAGE.ref.code), 'zdanie');
    await quiet();

    expect(fx.client.calls.filter((c) => c.method === 'prompt').map((c) => c.text)).toEqual([ULTRACODE_COMMANDS.on]);
    // Bramka dialogu zgody (1) + pole promptu (1) + jeden odczyt pętli (1): wynik w miejscu kończy czekanie od razu.
    expect(fx.client.calls.filter((c) => c.method === 'read').length).toBe(3);
    expect(keys(fx)).toEqual([]);
    expect(modelSets(fx)).toEqual([{ type: 'model-set', ultracode: true }]);
    // Chwila żądania sprzed wysyłki: wynik komendy w pliku rozmowy nie jest od niej starszy.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBeGreaterThanOrEqual(before);
    // Bez zdania o ustawieniach konta: ultracode działa tylko w tej sesji.
    expect(systemTexts(fx.events).some((t) => t.includes('account settings'))).toBe(false);
  });

  it('wyłączenie: wynik `off` pod echem `off`, `model-set` z `false`, bez uzbrajania reguły', async () => {
    const { fx, requests } = await ultracodeDriver(OFF_SCREEN);
    fx.driver.sendCommands?.([ULTRACODE_COMMANDS.off]);
    await waitFor(() => systemCodes(fx.events).includes(ULTRACODE_OFF_DONE_MESSAGE.ref.code), 'zdanie');
    await quiet();

    expect(modelSets(fx)).toEqual([{ type: 'model-set', ultracode: false }]);
    expect(requests).toEqual([]);
  });

  it('stary wynik włączenia na ekranie NIE potwierdza wysłanego `off`: pętla do końca, bez `model-set`', async () => {
    const { fx } = await ultracodeDriver(ON_SCREEN);
    fx.driver.sendCommands?.([ULTRACODE_COMMANDS.off]);
    await waitFor(() => systemTexts(fx.events).includes(ultracodeUnseenMessage(ULTRACODE_COMMANDS.off).text), 'zdanie');
    await quiet();

    expect(keys(fx)).toEqual([]);
    expect(modelSets(fx)).toEqual([]);
  });

  it('bez wiersza wyniku (komenda w trakcie tury): zdanie „wyniku nie widziałem”, bez `model-set`', async () => {
    const { fx, requests } = await ultracodeDriver('zwykły ekran panelu bez żadnego dialogu');
    fx.driver.sendCommands?.([ULTRACODE_COMMANDS.on]);
    await waitFor(() => systemTexts(fx.events).includes(ultracodeUnseenMessage(ULTRACODE_COMMANDS.on).text), 'zdanie');
    await quiet();

    expect(modelSets(fx)).toEqual([]);
    // Stan potwierdzi pierwsza tura: reguła jest uzbrojona mimo braku wyniku.
    expect(requests).toHaveLength(1);
  });

  it('odmowa CLI w miejscu wyniku (wyłączone workflow): zdanie z ostrzeżeniem, bez `model-set`', async () => {
    const { fx } = await ultracodeDriver(REFUSED_SCREEN);
    fx.driver.sendCommands?.([ULTRACODE_COMMANDS.on]);
    await waitFor(() => systemCodes(fx.events).includes(ULTRACODE_REFUSED_MESSAGE.ref.code), 'zdanie');
    await quiet();

    expect(fx.client.calls.filter((c) => c.method === 'read').length).toBe(3);
    expect(modelSets(fx)).toEqual([]);
  });

  it('dialog po komendzie ultracode jest zawsze obcy: zero cyfr, bez `model-set`', async () => {
    // „Change effort level?” mówi o `/effort` — dla `/effort high` to potwierdzenie, dla ultracode nie (bez dialogu).
    const { fx } = await ultracodeDriver(DIALOG_EFFORT);
    fx.driver.sendCommands?.([ULTRACODE_COMMANDS.on]);
    await waitFor(() => systemCodes(fx.events).includes('model.change-foreign-dialog'), 'ostrz');
    await quiet();

    expect(keys(fx)).toEqual([]);
    expect(modelSets(fx)).toEqual([]);
  });

  it('wynik liczy się tylko pod OSTATNIM echem `/effort` i tylko gdy to echo jest wysłaną komendą', () => {
    expect(commandResultInline(ULTRACODE_COMMANDS.on, ON_SCREEN)).toBe(true);
    expect(commandResultInline(ULTRACODE_COMMANDS.off, OFF_SCREEN)).toBe(true);
    // Echo innej komendy ultracode albo stan przeciwny niż wysłany: nie ten wynik.
    expect(commandResultInline(ULTRACODE_COMMANDS.off, ON_SCREEN)).toBe(false);
    expect(commandResultInline(ULTRACODE_COMMANDS.on, OFF_SCREEN)).toBe(false);
    // Paczka `/effort xhigh` + ultracode: echo poziomu stoi niżej, komenda ultracode jeszcze nie doszła na ekran.
    const later = underOnEcho((line) => `${line}\n\n❯ /effort xhigh\n  ⎿  Set effort level to xhigh`);
    expect(commandResultInline(ULTRACODE_COMMANDS.on, later)).toBe(false);
    // Echo wysłanej komendy z innym wierszem pod nim (odmowa) nie jest wynikiem, tylko odmową.
    expect(commandResultInline(ULTRACODE_COMMANDS.on, REFUSED_SCREEN)).toBe(false);
    expect(commandRefusedInline(ULTRACODE_COMMANDS.on, REFUSED_SCREEN)).toBe(true);
    expect(commandRefusedInline(ULTRACODE_COMMANDS.on, ON_SCREEN)).toBe(false);
    // Odmowa dotyczy wyłącznie komend ultracode.
    expect(commandRefusedInline('/effort high', REFUSED_SCREEN)).toBe(false);
  });

  it('`model-set` z formy komendy; `/effort <poziom>` bez zmian', () => {
    expect(modelSetEvent(ULTRACODE_COMMANDS.on)).toEqual({ type: 'model-set', ultracode: true });
    expect(modelSetEvent(ULTRACODE_COMMANDS.off)).toEqual({ type: 'model-set', ultracode: false });
    expect(modelSetEvent('/effort xhigh')).toEqual({ type: 'model-set', effort: 'xhigh' });
    expect(modelSetEvent(`${ULTRACODE_COMMANDS.on} on`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Błędy z gniazda
// ---------------------------------------------------------------------------

describe('błędy wysyłki', () => {
  it('`agent_blocked` daje ostrzeżenie i stan `blocked`, ZERO ponownych prób', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new HerdrBlockedError(foreign('agent_blocked'));

    fx.driver.send('podyktowane zdanie');
    await waitFor(() => states(fx.events).length > 0, 'agent-state');
    await quiet();

    expect(fx.client.calls.filter((c) => c.method === 'prompt')).toHaveLength(1);
    expect(systemCodes(fx.events)[0]).toBe('commands.send-blocked');
    expect(states(fx.events)[0]?.state).toBe('blocked');
  });

  it('`agent_prompt_stalled` jest ciszą — slash-komenda się wykonała', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new HerdrStalledError(foreign('agent_prompt_stalled'));

    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await waitFor(() => fx.client.calls.length > 0, 'prompt');
    await quiet();

    // Pierwsze (puste) listy zadań w tle i artefaktów followera przychodzą niezależnie od wysyłki.
    expect(fx.events.filter((e) => !['artifacts', 'background-tasks', 'scheduled-tasks'].includes(e.type))).toEqual([]);
  });

  it('zniknięty panel daje `detached`, a nie `exit`', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new HerdrGoneError(foreign('pane_not_found'));

    fx.driver.send('cokolwiek');
    await waitFor(() => fx.events.some((e) => e.type === 'detached'), 'detached');
    expect(fx.events.some((e) => e.type === 'exit')).toBe(false);
  });

  it('tryb tylko do odczytu mówi wprost, że wiadomość nie poszła', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new HerdrReadOnlyError(foreign('feature_disabled'));

    fx.driver.send('cokolwiek');
    await waitFor(() => systemTexts(fx.events).length > 0, 'komunikat');
    expect(systemCodes(fx.events)[0]).toBe('commands.send-read-only');
  });

  it('nieudana wysyłka zostaje w dzienniku', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new HerdrBlockedError(foreign('agent_blocked'));
    fx.driver.send('próba');
    await waitFor(() => fx.audit.length > 0, 'wpis w dzienniku');
    expect(fx.audit[0]?.text).toBe('próba');
  });
});

// ---------------------------------------------------------------------------
// Zdarzenia uchwytu
// ---------------------------------------------------------------------------

describe('zdarzenia panelu', () => {
  it('status mapuje się na stan i niesie tryb uprawnień', async () => {
    const fx = await makeDriver();
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'refaktor' });
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 9, title: 'refaktor' });
    await waitFor(() => states(fx.events).length === 2, 'dwa stany');

    // `stateChangeSeq` jedzie z KAŻDYM stanem: manager zapisuje przy nim znacznik
    // „obejrzałem to na telefonie", a bez numeru znacznik musiałby wygasać po czasie.
    expect(states(fx.events)[0]).toEqual({
      type: 'agent-state', state: 'working', mode: 'auto', stateChangeSeq: 8,
    });
    expect(states(fx.events)[1]).toEqual({
      type: 'agent-state',
      state: 'idle',
      mode: 'auto',
      seen: false,
      stateChangeSeq: 9,
    });
  });

  it('`unknown` nie emituje niczego', async () => {
    const fx = await makeDriver();
    fx.emit({ type: 'status', status: 'unknown', stateChangeSeq: 8, title: '' });
    await quiet();
    // Pierwsze (puste) listy zadań w tle i artefaktów followera przychodzą niezależnie od statusu panelu.
    expect(fx.events.filter((e) => !['artifacts', 'background-tasks', 'scheduled-tasks'].includes(e.type))).toEqual([]);
  });

  it('zmiana trybu odświeża chip bez zmiany stanu', async () => {
    const fx = await makeDriver();
    fx.emit({ type: 'mode', mode: 'bypass' });
    await waitFor(() => states(fx.events).length > 0, 'agent-state z trybem');

    const state = states(fx.events)[0];
    expect(state?.mode).toBe('bypass');
    expect(state?.state).toBe('idle');
    // Kolejna wysyłka ma być oceniana już w NOWYM trybie.
    const seen: HerdrMode[] = [];
    const fx2 = await makeDriver({
      deps: { guard: (text, o) => { seen.push(o.mode); return { text, slash: null }; } },
    });
    fx2.emit({ type: 'mode', mode: 'bypass' });
    fx2.driver.send('test');
    await waitFor(() => seen.length > 0, 'strażnik');
    expect(seen[0]).toBe('bypass');
  });

  /*
   * Wejście w `blocked` nie dokleja wycinka ekranu do
   * transkryptu (nawet z deduplikacją po hashu miganie `blocked→working→blocked` powtarzałoby go
   * przy każdym obrocie). Treść dialogu należy do KARTY, a transkrypt
   * ma zostać zapisem rozmowy — nie miejscem, w którym po godzinie leży kilkanaście zrzutów
   * ekranu opisujących jeden dialog. Odczyt ekranu przy wejściu w blokadę zostaje: dzieli
   * pamięć z najbliższą oceną (`#readDialog`), a bez niego karta czekałaby na zegar.
   */
  it('wejście w `blocked` czyta ekran, ale NIE dokleja go do transkryptu', async () => {
    const fx = await makeDriver();

    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => states(fx.events).length > 0, 'blocked');
    expect(fx.client.calls.some((c) => c.method === 'read' && c.source === 'detection')).toBe(true);
    expect(systemTexts(fx.events)).toEqual([]);

    // Miganie blocked → working → blocked na tym samym dialogu też niczego nie dopisuje.
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await waitFor(() => states(fx.events).length === 3, 'trzy stany');
    await quiet();
    expect(systemTexts(fx.events)).toEqual([]);

    // Nowy dialog (inny ekran) — nadal ani jednej wiadomości systemowej.
    fx.client.screenText = 'Kolor motywu?\n1. Ciemny\n2. Jasny';
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 11, title: '' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 12, title: '' });
    await waitFor(() => states(fx.events).length === 5, 'piąty stan');
    await quiet();
    expect(systemTexts(fx.events)).toEqual([]);
  });

  it('nieczytelny ekran nie blokuje zmiany stanu', async () => {
    const fx = await makeDriver();
    fx.client.screenText = '   \n\n  ';
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => states(fx.events).length > 0, 'blocked mimo pustego ekranu');
    expect(systemTexts(fx.events)).toEqual([]);
  });

  it('`pane move` przekierowuje kolejne wywołania na nowy adres', async () => {
    const fx = await makeDriver();
    fx.emit({ type: 'pane-changed', paneId: 'w3:p11' });
    fx.driver.send('po przeprowadzce');
    await waitFor(() => fx.client.calls.length > 0, 'prompt');

    expect(fx.client.calls[0]?.paneId).toBe('w3:p11');
    // Sama zmiana adresu nie jest zdarzeniem dla managera — dla sesji Raroga nic się nie stało. Pierwsze
    // (puste) listy zadań w tle i artefaktów followera przychodzą niezależnie od adresu panelu.
    expect(fx.events.filter((e) => !['artifacts', 'background-tasks', 'scheduled-tasks'].includes(e.type))).toEqual([]);
  });

  it('`/clear` przepina transkrypt i ogłasza nową sesję silnika', async () => {
    const fx = await makeDriver({ transcript: userLine('przed /clear') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    const storeDir = join(root, projectSlug(fx.cwd));
    await writeFile(join(storeDir, `${SESSION_B}.jsonl`), userLine('po /clear'));
    fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });

    await waitFor(() => fx.events.some((e) => e.type === 'init'), 'init');
    const init = fx.events.find((e): e is Extract<DriverEvent, { type: 'init' }> => e.type === 'init');
    // `model: ''` jest umową z managerem: pustej wartości nie nadpisuje.
    expect(init).toEqual({ type: 'init', engineSessionId: SESSION_B, model: '' });
    await waitFor(
      () => fx.events.filter((e) => e.type === 'history').length === 2,
      'historia nowego pliku',
    );
  });
});

// ---------------------------------------------------------------------------
// Transkrypt
// ---------------------------------------------------------------------------

describe('transkrypt', () => {
  it('podyktowany prompt pojawia się w transkrypcie DOKŁADNIE RAZ', async () => {
    const fx = await makeDriver({ transcript: userLine('stary wpis') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.driver.send('zrób refaktor');
    await waitFor(() => fx.client.calls.length > 0, 'prompt');
    // Silnik zapisuje echo do jsonl chwilę po wysyłce — manager ma już swój lokalny wpis.
    await appendFile(fx.transcript, userLine('zrób refaktor'));
    await quiet();

    const userMessages = fx.events.filter(
      (e) => e.type === 'message' && e.role === 'user',
    );
    expect(userMessages).toEqual([]);
  });

  it('prompt wpisany w terminalu trafia do Raroga', async () => {
    const fx = await makeDriver({ transcript: userLine('stary wpis') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await appendFile(fx.transcript, userLine('to pisałem w terminalu'));
    await waitFor(
      () => fx.events.some((e) => e.type === 'message' && e.role === 'user'),
      'wiadomość z terminala',
    );
  });
});

// ---------------------------------------------------------------------------
// Panel poza zasięgiem
// ---------------------------------------------------------------------------

describe('panel poza RAROG_HERDR_ROOTS', () => {
  it('nie oddaje transkryptu i odrzuca każdą próbę wysyłki', async () => {
    const fx = await makeDriver({
      agent: { inScope: false }, transcript: userLine('tego nikt nie ma zobaczyć'),
    });
    await quiet();

    expect(fx.events).toEqual([]);
    expect(() => fx.driver.send('nie wolno')).toThrow(HerdrOutOfScopeError);
    expect(() => fx.driver.interrupt()).toThrow(HerdrOutOfScopeError);
    expect(() => fx.driver.respondPermission('p-1', 'deny')).toThrow(HerdrOutOfScopeError);
    expect(fx.client.mutations).toBe(0);
  });

  it('stan panelu jest dalej widoczny — karta ma pokazywać prawdę', async () => {
    const fx = await makeDriver({ agent: { inScope: false } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'poza zasięgiem' });
    await waitFor(() => states(fx.events).length > 0, 'agent-state');
    expect(states(fx.events)[0]?.state).toBe('working');
  });
});

describe('kontrakt drivera', () => {
  it('nie jest właścicielem procesu silnika', async () => {
    const fx = await makeDriver();
    expect(fx.driver.ownsProcess).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Karta decyzji: treść z jsonl, cyfry z ekranu, rozjazd = fail-closed
// ---------------------------------------------------------------------------

/** Ustawia panel w stan „czeka" i dokłada do pliku niedomknięte wywołanie narzędzia. */
async function blockOn(
  fx: Fixture, opts: { id: string; tool: string; input: unknown; screen: string },
): Promise<void> {
  fx.client.screenText = opts.screen;
  await appendFile(fx.transcript, toolUseLine(opts.id, opts.tool, opts.input));
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
}

describe('zgody i pytania', () => {
  it('`blocked` + czekające narzędzie daje kartę z PEŁNYM inputem z jsonl', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-1', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION,
    });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    const card = permissions(fx.events)[0];
    expect(card?.reqId).toBe('t-1');
    expect(card?.toolName).toBe('Bash');
    // Ekran jest przycięty do szerokości panelu — `description` widać WYŁĄCZNIE w jsonl.
    // Na tym polu liczy się ryzyko (`classifyRisk`), więc karta musi je nieść w całości.
    expect(card?.input).toEqual(BASH_INPUT);
    expect(DIALOG_PERMISSION).not.toContain('.env.local');
    expect(card?.displayText).toContain('pnpm exec vitest');
  });

  it('`AskUserQuestion` daje kartę pytania w kształcie 1:1 z inputem', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    const input = {
      questions: [{
        question: 'Który wariant zapisu wybrać?',
        header: 'Zapis pliku',
        multiSelect: false,
        options: [
          { label: 'Zapis atomowy (tmp + rename)', description: 'Bezpieczniejszy' },
          { label: 'Zapis w miejscu', description: 'Szybszy' },
        ],
      }],
    };
    await blockOn(fx, {
      id: 'q-1', tool: 'AskUserQuestion', input, screen: DIALOG_QUESTION,
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    const card = questions(fx.events)[0];
    expect(card?.reqId).toBe('q-1');
    // 1:1 z inputem plus rola opcji: payload autora to same odpowiedzi — chrome CLI
    // („Type something.", „Chat about this") w payloadzie nie występuje.
    expect(card?.questions).toEqual((input.questions as Question[]).map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option, role: 'answer' })),
    })));
    expect(permissions(fx.events)).toEqual([]);
  });

  it('formularz pytania BEZ jsonl dostaje kartę pytania Z EKRANU, a cyfra idzie po etykiecie', async () => {
    /*
     * Claude Code przed 2.1.267 zapisywał `tool_use` formularza `AskUserQuestion` do jsonl dopiero
     * PO rozstrzygnięciu dialogu. Od CLI 2.1.267 wpis stoi w jsonl nad STOJĄCYM dialogiem; test
     * trzyma przypadek bez
     * wpisu (follower nie dogonił, sesja bez transkryptu). Karta pytania MUSI wtedy powstać
     * z ekranu: on niesie komplet (nagłówek, treść, opcje z cyframi), a odpowiedź idzie tą samą
     * drogą co zawsze — cyfrą po TEKŚCIE etykiety.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z ekranu');

    const card = questions(fx.events)[0];
    expect(card?.questions[0]?.question).toContain('Który wariant zapisu wybrać?');
    expect(card?.questions[0]?.options.map((o) => o.label)).toEqual([
      'Zapis atomowy (tmp + rename)', 'Zapis w miejscu',
    ]);
    // ŻADNEJ karty „dialog spoza transkryptu" — to była cała awaria.
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(permissions(fx.events)).toEqual([]);

    // Odpowiedź z telefonu: etykieta → cyfra z ekranu, nigdy pozycja.
    fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis w miejscu']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['2']]);
  });

  it('dialog `confirm` BEZ jsonl dostaje kartę z DOSŁOWNYMI opcjami z ekranu (silnik dialogów)', async () => {
    /*
     * Dialog potwierdzenia ustawień CLI postawiony poza Rarogiem (np. `/effort` wpisane
     * w terminalu) nie kończy się wycinkiem ekranu i samym „Odrzuć". Klasa
     * `confirm` daje mu tę samą kartę co formularzowi pytania: treść i etykiety jadą
     * dosłownie, wybór wraca cyfrą po TEKŚCIE etykiety — bez opcji domyślnej
     * i bez interpretacji, więc granica „przyciski tylko dla rozpoznanych dialogów” zostaje nienaruszona.
     */
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_EFFORT;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta potwierdzenia z ekranu');

    const card = questions(fx.events)[0];
    expect(card?.questions[0]?.question).toContain('Change effort level?');
    expect(card?.questions[0]?.options.map((o) => o.label)).toEqual([
      'Yes, switch to high', 'No, go back',
    ]);
    // Karta potwierdzenia zastępuje kartę „dialog spoza transkryptu", nie dubluje jej.
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(permissions(fx.events)).toEqual([]);

    fx.driver.answerQuestion(card?.reqId ?? '', [['No, go back']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['2']]);
  });

  it('zgoda na narzędzie BEZ jsonl dostaje kartę z ekranu; opcja eskalująca bez wysyłki', async () => {
    /*
     * Uniwersalna karta dla dialogu zgody na narzędzie bez wpisu w jsonl (a wpis NIE POWSTAJE
     * aż do decyzji — zmierzone na CLI 2.1.246): karta z dosłowną treścią i opcjami; „don't ask again" jedzie z `terminalOnly`
     * i jej cyfra jest ODRZUCANA po stronie drivera niezależnie od UI.
     */
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    // Redesign A: zgoda na narzędzie jedzie KARTĄ ZGODY (ryzyko, hold,
    // Odrzuć/Zatwierdź), nie kartą pytania — patrz #openScreenPermission.
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');

    const card = permissions(fx.events)[0];
    expect(card?.reqId?.startsWith('screen:p:')).toBe(true);
    expect(card?.toolName).toBe('Bash');
    // Boilerplate CLI wycięty: karta zgody SAMA jest pytaniem, para przycisków odpowiada.
    expect(card?.displayText).toContain('pnpm exec vitest run');
    expect(card?.displayText).not.toContain('Do you want to proceed?');
    expect(card?.input).not.toBeNull();

    const sentKeys = (): string[][] => fx.client.calls
      .filter((c) => c.method === 'send_keys').map((c) => c.keys as string[]);
    // `allow` wybiera cyfrę `affirmativeOption` po TREŚCI: jednorazowe „Yes" — opcja
    // eskalująca („don't ask again…") strukturalnie nie jest celem tapnięcia.
    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => sentKeys().length > 0, 'cyfra zgody');
    expect(sentKeys()).toEqual([['1']]);
    expect(fx.audit.at(-1)).toMatchObject({
      method: 'approve', keys: ['1'], toolName: 'Bash', optionLabel: 'Yes',
    });
  });

  /*
   * Opcja „Yes, and don't ask again…" dostaje na karcie
   * zgody WŁASNY przycisk — decyzja `allow-always` jedzie osobnym wariantem i wybiera cyfrę
   * selektorem `alwaysOption` (twierdząca ORAZ eskalująca, dokładnie jedna). Zwykłe `allow`
   * dalej nie ma jak trafić w eskalację.
   */
  describe('allow-always — jawny przycisk opcji eskalującej', () => {
    it('karta zgody z ekranu NIESIE dosłowną etykietę opcji eskalującej', async () => {
      const fx = await makeDriver({ transcript: userLine('pracuj') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = DIALOG_PERMISSION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
      expect(permissions(fx.events)[0]?.alwaysLabel)
        .toBe("Yes, and don't ask again for pnpm commands in /Users/u/Projects/demo");
    });

    it('allow-always wysyła cyfrę opcji eskalującej, z jej etykietą w dzienniku', async () => {
      const fx = await makeDriver({ transcript: userLine('pracuj') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = DIALOG_PERMISSION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
      const card = permissions(fx.events)[0];

      fx.driver.respondPermission(card?.reqId ?? '', 'allow-always');
      await waitFor(() => fx.client.calls.some((c) => c.method === 'send_keys'), 'cyfra');
      expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
        .toEqual([['2']]);
      // Dziennik odpowiada na „CO zatwierdzono" — etykieta eskalacji, nie sama cyfra.
      expect(fx.audit.at(-1)).toMatchObject({
        method: 'approve',
        keys: ['2'],
        optionLabel: "Yes, and don't ask again for pnpm commands in /Users/u/Projects/demo",
      });
    });

    it('dialog BEZ opcji eskalującej: karta bez alwaysLabel, allow-always = zero klawiszy + odbudowa', async () => {
      const fx = await makeDriver({ transcript: userLine('pracuj') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      // Sama para Yes/No — jak dialog z reguły `Ask rule` (fixture opis).
      fx.client.screenText = DIALOG_PERMISSION.replace(
        "2. Yes, and don't ask again for pnpm commands in /Users/u/Projects/demo",
        '2. No, and tell Claude what to do differently                            ',
      ).replace('3. No, and tell Claude what to do differently (esc)',
        '                                                    ');
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
      const card = permissions(fx.events)[0];
      expect(card?.alwaysLabel).toBeUndefined();

      fx.driver.respondPermission(card?.reqId ?? '', 'allow-always');
      await waitFor(
        () => systemTexts(fx.events).some((t) => t.includes("Couldn't tell which dialog option")),
        'odmowa allow-always',
      );
      await waitFor(() => permissions(fx.events).length > 1, 'odbudowana karta');
      expect(fx.client.mutations).toBe(0);
    });

    /*
     * Dialog sieci sandboksa zatwierdza się z telefonu WYŁĄCZNIE jednorazowo. Karta nie niesie „zawsze", a `allow-always` od starego albo obcego
     * klienta nie wysyła żadnego klawisza — „don't ask again for <host>" zostaje przy biurku.
     */
    it('dialog sieci sandboksa: bez „zawsze", allow-always = zero klawiszy, allow = „Yes"', async () => {
      const fx = await makeDriver({ transcript: userLine('pracuj') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = readFileSync(
        join(FIXTURES, 'measured', 'zgoda-siec-2.1.293.txt'), 'utf8',
      );
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
      const card = permissions(fx.events)[0];
      expect(card?.toolName).toBe('SandboxNetwork');
      expect(card?.alwaysLabel).toBeUndefined();

      fx.driver.respondPermission(card?.reqId ?? '', 'allow-always');
      await waitFor(
        () => fx.audit.some((entry) => entry['reason'] === 'terminal-only'),
        'odmowa allow-always',
      );
      expect(fx.client.mutations).toBe(0);
      // Odmowa gasi kartę i każe ocenie zbudować ją od nowa (jak `allow-always` bez opcji eskalującej).
      await waitFor(() => permissions(fx.events).length > 1, 'odbudowana karta');

      const fresh = permissions(fx.events).at(-1);
      fx.driver.respondPermission(fresh?.reqId ?? '', 'allow');
      await waitFor(() => fx.client.calls.some((c) => c.method === 'send_keys'), 'cyfra');
      expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
        .toEqual([['1']]);
    });

    /*
     * CLI kolejkuje wiadomości (docs `interactive-mode.md`, „Queue messages while
     * Claude works”), więc w TEJ SAMEJ blokadzie dialog sieci dla `example.org` potrafi ustąpić dialogowi dla
     * innego hosta. „Yes" stoi pod cyfrą 1 w obu, więc sama etykieta niczego nie dowodzi — zgoda z karty
     * starego hosta nie ma prawa pójść na nowy.
     */
    it('dialog sieci: zmiana hosta przed zatwierdzeniem = `screen-changed`, zero klawiszy', async () => {
      const fx = await makeDriver({ transcript: userLine('pracuj') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      const network = readFileSync(join(FIXTURES, 'measured', 'zgoda-siec-2.1.293.txt'), 'utf8');
      fx.client.screenText = network;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
      const card = permissions(fx.events)[0];
      expect(card?.displayText).toContain('Host: example.org');

      fx.client.screenText = network.replaceAll('example.org', 'other.example');
      await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow'))
        .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
      expect(fx.client.mutations).toBe(0);
    });
  });

  it('opcja „don’t ask again" z apostrofem typograficznym nie odbiera karcie zatwierdzania', async () => {
    /*
     * Claude Code 2.1.246: dialog zgody na `Bash` wywołany przez subagenta ma opcję „2. Yes, and don’t
     * ask again for: cd *" z U+2019. Wzorce eskalacji pisane samym prostym apostrofem dają:
     *
     * - `optionEscalates` nie zapala `terminalOnly` — opcja rozszerzająca uprawnienia
     *   jedzie na telefon z ŻYWYM przyciskiem (dziura w granicy przycisków),
     * - `affirmativeOption` widzi DWIE opcje „Yes…" i oddaje `null` — karta traci
     *   zatwierdzanie, a w transkrypcie ląduje „Nie wiem, która opcja…".
     *
     * Fixture jest zrzutem z realnego panelu; test pilnuje OBU skutków naraz.
     */
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_SUBAGENT;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');

    const card = permissions(fx.events)[0];
    expect(card?.toolName).toBe('Bash');

    const sentKeys = (): string[][] => fx.client.calls
      .filter((c) => c.method === 'send_keys').map((c) => c.keys as string[]);
    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => sentKeys().length > 0, 'cyfra zgody');
    expect(sentKeys()).toEqual([['1']]);
    expect(systemTexts(fx.events).some((t) => t.includes("Couldn't tell which dialog option"))).toBe(false);
    expect(fx.audit.at(-1)).toMatchObject({
      method: 'approve', keys: ['1'], toolName: 'Bash', optionLabel: 'Yes',
    });
  });

  it('opcja „Yes, and allow … commands" (reguła Ask w trybie auto) jest eskalacją, nie drugim „Yes"', async () => {
    /*
     * Wersja CLI niezapisana, fixture `dialog-permission-ask-rule-auto.txt`: w trybie auto reguła `Ask` dla
     * `Bash(rm -rf *)` rysuje opcję 2 „Yes, and allow /private/tmp/claude access and pnpm build and … commands"
     * — CLI dopisuje TRWAŁE reguły, ale bez słów „don't ask again"/„always". Słownik eskalacji bez tej opcji
     * widzi dwie zwykłe opcje „Yes…" → `null` → „Nie wiem, która opcja…" w transkrypcie, zero klawiszy.
     * Oczekiwanie: „Zatwierdź" = `1`, a opcja 2 dostaje własny przycisk `allow-always` z dosłowną etykietą.
     */
    const ALWAYS = 'Yes, and allow /private/tmp/claude access and pnpm build and '
      + '"echo \\"build exit=$?\\"" commands';
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_ASK_RULE_AUTO;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');

    const card = permissions(fx.events)[0];
    expect(card?.toolName).toBe('Bash');
    expect(card?.alwaysLabel).toBe(ALWAYS);

    const sentKeys = (): string[][] => fx.client.calls
      .filter((c) => c.method === 'send_keys').map((c) => c.keys as string[]);
    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => sentKeys().length > 0, 'cyfra zgody');
    expect(sentKeys()).toEqual([['1']]);
    expect(systemTexts(fx.events).some((t) => t.includes("Couldn't tell which dialog option"))).toBe(false);
    expect(fx.audit.at(-1)).toMatchObject({
      method: 'approve', keys: ['1'], toolName: 'Bash', optionLabel: 'Yes',
    });
  });

  it('zrzut hooka PreToolUse daje kartę z PEŁNYM inputem; cyfry z ekranu; zrzut sprzątany', async () => {
    /*
     * Warstwa 1 uniwersalnej karty: jsonl nie zna stojącego dialogu (tak było w pomiarze na CLI
     * 2.1.246), ale pasywny hook `PreToolUse` zrzucił czekające narzędzie do pliku ZANIM dialog stanął. Karta
     * ma wtedy pełny `input` (jak z jsonl), a cyfry dalej idą z ekranu przez cross-check nazwy.
     */
    const cleared: string[] = [];
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: {
        readPendingHook: () => ({ toolName: 'Bash', toolInput: BASH_INPUT, at: 111 }),
        clearPendingHook: (sid) => { cleared.push(sid); },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody z hooka');

    const card = permissions(fx.events)[0];
    expect(card?.toolName).toBe('Bash');
    expect(card?.input).toEqual(BASH_INPUT);

    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
    // Zrzut zużyty po wysłanej decyzji — następny dialog nie może czytać starego pliku.
    expect(cleared).toEqual([SESSION]);
  });

  it('zrzut hooka o TEJ SAMEJ nazwie, ale innej treści niż ekran — spadek na kartę ekranową', async () => {
    /*
     * Zrzut to jeden plik na sesję nadpisywany przy każdym wywołaniu,
     * a nazwa („Bash" == „Bash") nie rozróżnia wywołań — równoległa paczka narzędzi mogłaby
     * podstawić pod dialog `git push --force` kartę z treścią `ls`. Dowodem tożsamości jest
     * fragment inputu widoczny na ekranie dialogu.
     */
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: {
        readPendingHook: () => ({ toolName: 'Bash', toolInput: { command: 'ls -la' }, at: 7 }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PERMISSION; // ekran mówi o `pnpm exec vitest…`, nie o `ls`
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');
    const card = permissions(fx.events)[0];
    // Karta EKRANOWA (screen:p:), nie karta z treścią zrzutu hooka o `ls`.
    expect(card?.reqId?.startsWith('screen:p:')).toBe(true);
    expect(card?.displayText).toContain('pnpm exec vitest');
    expect(card?.displayText).not.toContain('ls -la');
  });

  it('marker przycięcia w zrzucie hooka = zrzut nieobecny (karta ekranowa, nie pusta zgoda)', async () => {
    // Karta „Write" z pustą treścią i żywym przyciskiem byłaby gorsza
    // niż ekranowa z wycinkiem, którą ta sama sesja dostaje bez hooka.
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: {
        readPendingHook: () => ({
          toolName: 'Bash', toolInput: { rarogTruncated: true, preview: 'x'.repeat(50) }, at: 7,
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');
    const card = permissions(fx.events)[0];
    expect(card?.reqId?.startsWith('screen:p:')).toBe(true);
    expect(card?.input).not.toBeNull();
  });

  it('stęchły zrzut hooka (cudze narzędzie) spada na kartę ekranową, nie degraduje', async () => {
    // Hook jest WZBOGACENIEM, nie bramką: rozjazd zrzutu z ekranem nie ma prawa dawać karty
    // gorszej niż ta, którą warstwa 2 zrobiłaby bez hooka.
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: { readPendingHook: () => ({ toolName: 'Edit', toolInput: {}, at: 5 }) },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');

    const card = permissions(fx.events)[0];
    // Karta EKRANOWA o narzędziu z EKRANU — żadnej zdegradowanej (`input: null`) po
    // rozjeździe z hookiem: to byłby regres poniżej warstwy 2.
    expect(card?.reqId?.startsWith('screen:p:')).toBe(true);
    expect(card?.toolName).toBe('Bash');
    expect(card?.input).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Hook `PermissionRequest` / `PreToolUse` jako kanał TREŚCI (krok 2)
  // -------------------------------------------------------------------------

  it('zrzut `ExitPlanMode` daje kartę z TREŚCIĄ PLANU i osobnym przyciskiem „auto mode"', async () => {
    /*
     * CLI 2.1.251: `PermissionRequest` odpala się także dla `ExitPlanMode` i niesie PEŁNY plan
     * w `tool_input.plan`. Dialog pyta „Would you like to proceed?", nie „Do you want to proceed?";
     * zamknięta sygnatura ekranu daje nazwę narzędzia, treść karty jedzie
     * z hooka, a opcja „Yes, and use auto mode" — eskalująca — dostaje WŁASNY przycisk
     * z dosłowną etykietą, nigdy zwykłe „Zatwierdź".
     */
    const plan = '## Plan\n\n1. Przeczytać dokumentację\n2. Poprawić parser\n';
    const fx = await makeDriver({
      transcript: userLine('zaplanuj'),
      deps: {
        readPendingHook: () => ({
          toolName: 'ExitPlanMode',
          // Nazwa pliku planu jest losowa PER PLAN i stoi w stopce dialogu — to ona jest
          // cross-checkiem tożsamości zrzutu (CLI 2.1.251).
          toolInput: { plan, planFilePath: '/Users/u/.claude/plans/floofy-prancing-hejlsberg.md' },
          at: 41,
          hookEventName: 'PermissionRequest',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PLAN;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta planu');

    const card = permissions(fx.events)[0];
    expect(card?.toolName).toBe('ExitPlanMode');
    // Treść to PLAN, nie JSON z `\n` — karta jest miejscem, w którym człowiek go czyta.
    expect(card?.displayText).toBe(plan);
    expect(card?.alwaysLabel).toBe('Yes, and use auto mode');

    // „Zatwierdź" wybiera opcję NAJWĘŻSZĄ: zgodę na plan bez przestawiania trybu sesji.
    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['2']]);
    expect(fx.audit.at(-1)).toMatchObject({
      method: 'approve', toolName: 'ExitPlanMode', optionLabel: 'Yes, manually approve edits',
    });
  });

  it('zrzut planu o INNYM pliku niż stopka dialogu NIE wchodzi na kartę (cross-check)', async () => {
    /*
     * Ścieżka do rozjazdu: zrzut planu A leży w `pending/` (decyzja
     * podjęta przy biurku — nikt pliku nie sprząta), a `PermissionRequest` dla planu B nie
     * nadpisał go, bo hook tamtej sesji pisał do innego `dataDir` albo zapis padł. W oknie
     * TTL telefon pokazywał PLAN A, a cyfra zatwierdzała PLAN B — karta planu jest przy tym
     * NAJBARDZIEJ treściowa z wszystkich i ma działający przycisk „Zatwierdź".
     *
     * `tool_input` `ExitPlanMode` nie ma `command`/`file_path`/`url`/`pattern`, więc dawny
     * cross-check wracał `true` BEZ ani jednego porównania. Klucz jest jednak na ekranie:
     * stopka niesie `~/.claude/plans/<losowa-nazwa>.md`. Brak nazwy = fail-closed.
     */
    const fx = await makeDriver({
      transcript: userLine('zaplanuj'),
      deps: {
        readPendingHook: () => ({
          toolName: 'ExitPlanMode',
          toolInput: {
            plan: '## PLAN A — z poprzedniej tury\n',
            planFilePath: '/Users/u/.claude/plans/stary-plan-a.md',
          },
          at: 42,
          hookEventName: 'PermissionRequest',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PLAN;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta planu');

    const card = permissions(fx.events)[0];
    // Karta jest — ekranowa, z sygnatury `PLAN_DIALOG_PATTERN` — ale treści zrzutu nie niesie.
    expect(card?.toolName).toBe('ExitPlanMode');
    expect(card?.displayText).not.toContain('PLAN A');
    expect(card?.displayText).toContain('written up a plan');
  });

  it('zrzut planu BEZ `planFilePath` jest fail-closed (nie ma czym dowieść tożsamości)', async () => {
    const fx = await makeDriver({
      transcript: userLine('zaplanuj'),
      deps: {
        readPendingHook: () => ({
          toolName: 'ExitPlanMode',
          toolInput: { plan: '## PLAN bez ścieżki\n' },
          at: 43,
          hookEventName: 'PermissionRequest',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PLAN;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta planu');

    expect(permissions(fx.events)[0]?.displayText).not.toContain('PLAN bez ścieżki');
  });

  it('dialog planu BEZ hooka: karta ekranowa z dosłowną treścią, nadal z nazwą z sygnatury', async () => {
    // Sygnatura ekranu działa sama — sesja bez zainstalowanego hooka dostaje kartę z treścią
    // dialogu zamiast wycinka bez przycisków.
    const fx = await makeDriver({ transcript: userLine('zaplanuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PLAN;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta planu');

    const card = permissions(fx.events)[0];
    expect(card?.toolName).toBe('ExitPlanMode');
    expect(card?.displayText).toContain('written up a plan');
    expect(card?.alwaysLabel).toBe('Yes, and use auto mode');
  });

  it('pytanie ze zrzutu: opisy i nagłówek z hooka, etykiety z EKRANU', async () => {
    /*
     * Treść pytania (`header`, `options[].description`, `multiSelect`) istnieje WYŁĄCZNIE
     * w payloadzie `PreToolUse` — ekran jej nie niesie w komplecie. Karta bierze ją z hooka,
     * ale wyłącznie po dopasowaniu treści pytania i KOMPLETU etykiet; cyfry i lista opcji
     * zostają z ekranu.
     */
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: {
        readPendingHook: () => ({
          toolName: 'AskUserQuestion',
          toolInput: {
            questions: [{
              question: 'Który schemat ścieżek URL wolisz dla API Raroga?',
              header: 'Schemat URL',
              multiSelect: false,
              options: [
                { label: 'Płaski zasobowy', description: 'Jeden poziom, bez zagnieżdżeń' },
                { label: 'Zagnieżdżony po projekcie', description: 'Ścieżka niesie projekt' },
                { label: 'Wersjonowany RPC', description: 'Prefiks /v1 i czasowniki' },
              ],
            }],
          },
          at: 12,
          hookEventName: 'PreToolUse',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z hooka');

    const card = questions(fx.events)[0];
    expect(card?.reqId.startsWith('hook:')).toBe(true);
    const question = card?.questions[0];
    expect(question?.header).toBe('Schemat URL');
    expect(question?.multiSelect).toBe(false);
    // Etykiety Z EKRANU (opisy z hooka doklejone po etykiecie, nie odwrotnie).
    expect(question?.options.map((o) => o.label))
      .toEqual(['Płaski zasobowy', 'Zagnieżdżony po projekcie', 'Wersjonowany RPC']);
    expect(question?.options[1]?.description).toBe('Ścieżka niesie projekt');
  });

  it('zrzut o INNYM pytaniu niż ekran: karta ekranowa, bez opisów z hooka', async () => {
    // Stęchły payload (poprzednie pytanie tej samej sesji) nie ma prawa opisać cudzego
    // formularza — cross-check jest po treści pytania i komplecie etykiet, nie po nazwie.
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: {
        readPendingHook: () => ({
          toolName: 'AskUserQuestion',
          toolInput: {
            questions: [{
              question: 'Zupełnie inne pytanie z poprzedniej tury?',
              header: 'Stare',
              multiSelect: false,
              options: [{ label: 'Płaski zasobowy', description: 'nie ten formularz' }],
            }],
          },
          at: 13,
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z ekranu');

    const card = questions(fx.events)[0];
    expect(card?.reqId.startsWith('screen:q:')).toBe(true);
    expect(card?.questions[0]?.header).not.toBe('Stare');
    expect(card?.questions[0]?.options.every((o) => o.description === undefined)).toBe(true);
  });

  it('`multiSelect: true` z hooka ODBIERA kartę formularzowi, który ekran widzi jako jednokrotny',
    async () => {
      /*
       * Druga strona autorytetu hooka: gdyby sygnatury ekranu przegapiły checkboxy, jedna cyfra
       * poleciałaby w formularz czekający na zaznaczenie + „Submit".
       * Autor pytania wie o swoim formularzu więcej niż glify — jego `multiSelect` wygrywa,
       * a karta spada do „odpowiedz w terminalu" i zostawia wpis odmowy w dzienniku.
       */
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie'),
        deps: {
          readPendingHook: () => ({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [{
                question: 'Który schemat ścieżek URL wolisz dla API Raroga?',
                header: 'Schemat URL',
                multiSelect: true,
                options: [
                  { label: 'Płaski zasobowy' }, { label: 'Zagnieżdżony po projekcie' },
                  { label: 'Wersjonowany RPC' },
                ],
              }],
            },
            at: 14,
          }),
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_PREVIEW;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');

      expect(questions(fx.events)).toEqual([]);
      expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
        .toContain('multi-select');
    });

  it('`multiSelect: false` z hooka PRZYWRACA kartę formularzowi z checkboxami na ekranie',
    async () => {
      /*
       * Kierunek odwrotny: sygnatura ekranu (checkbox w linii opcji) jest fail-closed
       * z rozmysłem, ale bywa fałszywym alarmem. Payload autora pytania rozstrzyga to
       * jednoznacznie — a wtedy jedna cyfra JEST uczciwą odpowiedzią i karta ma przyciski.
       */
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie'),
        deps: {
          readPendingHook: () => ({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [{
                question: 'Które dodatki?',
                header: 'Dodatki',
                multiSelect: false,
                options: [
                  { label: 'Posypka', description: 'Kolorowa' }, { label: 'Polewa' },
                  { label: 'Bita śmietana' },
                ],
              }],
            },
            at: 15,
          }),
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_MULTI_START;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania mimo checkboxów');

      const card = questions(fx.events)[0];
      expect(card?.questions[0]?.multiSelect).toBe(false);
      // Cyfra wychodzi — także przez `#digitStillHolds`, który parsuje ekran DRUGI RAZ.
      fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka']]);
      await waitFor(() => fx.client.mutations > 0, 'cyfra odpowiedzi');
      expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
        .toEqual([['1']]);
    });

  it('rozjazd zrzutu z ekranem zostawia wpis odmowy `mismatch` w dzienniku', async () => {
    /*
     * Licznik odmów: dziennik miał setki wysyłek i ZERO danych o porażkach, więc
     * „ścieżka cyfrowa bywa zawodna" nie miało po swojej stronie ani jednej liczby.
     * Wpis `refuse` nie niesie ani klawiszy, ani treści — sam powód z zamkniętej listy.
     */
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-9', tool: 'Edit', input: { file_path: '/Users/u/a.ts' }, screen: DIALOG_PERMISSION,
    });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zdegradowana');

    expect(permissions(fx.events)[0]?.input).toBeNull();
    const refusals = fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'));
    expect(refusals.map((e) => e.reason)).toEqual(['mismatch']);
    expect(refusals[0]).toMatchObject({ toolName: 'Edit' });
    expect(refusals[0]?.keys).toBeUndefined();
  });

  it('odmowa na ścieżce hooka trafia do dziennika z WŁASNYM powodem, nie jako `no-jsonl`',
    async () => {
      /*
       * Gałąź `expected === null` zawsze zwraca `no-jsonl`, więc rozpoznanie nadpisane ZANIM
       * ktokolwiek policzy powód wysłałoby KAŻDĄ odmowę hookową do dziennika jako `no-jsonl`,
       * a rozkład powodów w dzienniku ma odróżniać dialogi spoza transkryptu.
       *
       * Tu: zrzut mówi o INNYM pytaniu niż ekran (cross-check `#hookQuestion` odpada), a ekran
       * jest formularzem WIELOKROTNYM — `resolveOptions` z `expected` daje `multi-select`.
       */
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie o dodatki'),
        deps: {
          readPendingHook: () => ({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [{
                question: 'Zupełnie inne pytanie z poprzedniej tury?',
                header: 'Stare',
                multiSelect: false,
                options: [{ label: 'Cokolwiek' }],
              }],
            },
            at: 16,
          }),
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = readFileSync(
        join(FIXTURES, 'dialog-askuserquestion-multi.txt'), 'utf8',
      );
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');

      const reasons = fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason);
      expect(reasons).toContain('multi-select');
      expect(reasons).not.toContain('no-jsonl');
    });

  it('ekran nieczytelny przy obecnym zrzucie hooka liczy się jako `unreadable`', async () => {
    // Druga strona tej samej reguły: bez zapamiętania powodu ten przypadek też puchłby
    // `no-jsonl`, czyli kubełek, po którym dziennik ma poznać dialogi spoza transkryptu.
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: {
        readPendingHook: () => ({
          toolName: 'Bash',
          toolInput: { command: 'ls -la' },
          at: 17,
          hookEventName: 'PermissionRequest',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    // Ekran bez ani jednej linii opcji — `parseOptions` oddaje `null` także po ponowieniu.
    fx.client.screenText = 'jakiś przemalowany ekran bez dialogu\n\n(nic tu nie ma)\n';
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');

    const reasons = fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason);
    expect(reasons).toContain('unreadable');
    expect(reasons).not.toContain('no-jsonl');
  });

  it('bramka przycisków działa na karcie pytania ze ŹRÓDŁA JSONL (opcja eskalująca bez cyfry)',
    async () => {
      /*
       * Opcje z gałęzi `status: 'ok'` w `resolveOptions` trafiają wprost do `ActiveReq.options`;
       * bez `terminalOnly` warunek w `answerQuestion` nie miałby czego trafić i cyfra opcji
       * eskalującej wyszłaby z Raroga, choć ta sama etykieta na ścieżce ekranowej jest
       * wyszarzona i odmawiana.
       */
      const eskalacja = DIALOG_QUESTION
        .replace('2. Zapis w miejscu', "2. Zapis w miejscu, and don't ask again");
      const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      await blockOn(fx, {
        id: 't-esc',
        tool: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Który wariant zapisu wybrać?',
            header: 'Zapis pliku',
            multiSelect: false,
            options: [
              { label: 'Zapis atomowy (tmp + rename)' },
              { label: "Zapis w miejscu, and don't ask again" },
            ],
          }],
        },
        screen: eskalacja,
      });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania z jsonl');

      const card = questions(fx.events)[0];
      expect(card?.reqId).toBe('t-esc');
      const before = fx.client.mutations;
      fx.driver.answerQuestion(card?.reqId ?? '', [["Zapis w miejscu, and don't ask again"]]);
      await quiet();

      expect(fx.client.mutations).toBe(before);
      expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
        .toContain('terminal-only');
    });

  it('karta pytania z jsonl bez hooka: opcja eskalująca jedzie z `terminalOnly`, zwykła idzie cyfrą', async () => {
    /*
     * Karta z etykietami payloadu (`payloadAnswers`, kanał `keys`) bez `terminalOnly` rysowałaby w apce
     * przycisk przy opcji eskalującej, a bramka cyfry w `answerQuestion` (`optionPolicy`) i tak by go
     * odmówiła. Karta ma nieść ten sam werdykt co bramka.
     */
    const ESKALACJA = "Zapis w miejscu, and don't ask again";
    const ZWYKLA = 'Zapis atomowy (tmp + rename)';
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-esc-karta',
      tool: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Który wariant zapisu wybrać?',
          header: 'Zapis pliku',
          multiSelect: false,
          options: [{ label: ZWYKLA }, { label: ESKALACJA }],
        }],
      },
      screen: DIALOG_QUESTION.replace('2. Zapis w miejscu', `2. ${ESKALACJA}`),
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z jsonl');

    const card = questions(fx.events)[0];
    // `reqId` z wpisu jsonl = karta z etykietami payloadu, nie zakładka dopasowana do ekranu.
    expect(card?.reqId).toBe('t-esc-karta');
    expect(card?.channel).toBe('keys');
    expect(card?.questions[0]?.options).toEqual([
      { label: ZWYKLA, role: 'answer' },
      { label: ESKALACJA, terminalOnly: true, role: 'answer' },
    ]);

    // Opcja z `terminalOnly` na karcie: ta sama odmowa co dotąd, zero klawiszy.
    const before = fx.client.mutations;
    await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[ESKALACJA]]))
      .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
    expect(fx.client.mutations).toBe(before);
    expect(fx.audit.at(-1)).toMatchObject({ method: 'refuse', reason: 'terminal-only' });

    // Odmowa gasi kartę, ocena wystawia ją od nowa; zwykła opcja idzie cyfrą z ekranu.
    await waitFor(() => questions(fx.events).length > 1, 'karta po odmowie');
    const again = questions(fx.events).at(-1);
    expect(again?.reqId).toBe('t-esc-karta');
    fx.driver.answerQuestion(again?.reqId ?? '', [[ZWYKLA]]);
    await waitFor(() => fx.client.mutations > before, 'cyfra zwykłej opcji');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
  });

  it('karta pytania z jsonl: `terminalOnly` z etykiety kanonicznej, jak w bramce cyfry', async () => {
    // Autor złamał etykietę: surowa „this\nsession" nie trafia w słownik eskalacji, kanoniczna tak. Bramka cyfry
    // porównuje i ocenia etykietę kanoniczną, więc karta musi liczyć tak samo.
    const ZLAMANA = 'Zapis w miejscu, for this\nsession';
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-esc-kanon',
      tool: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Który wariant zapisu wybrać?',
          header: 'Zapis pliku',
          multiSelect: false,
          options: [{ label: 'Zapis atomowy (tmp + rename)' }, { label: ZLAMANA }],
        }],
      },
      screen: DIALOG_QUESTION.replace('2. Zapis w miejscu', '2. Zapis w miejscu, for this session'),
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z jsonl');

    const card = questions(fx.events)[0];
    expect(card?.reqId).toBe('t-esc-kanon');
    expect(card?.questions[0]?.options.find((o) => o.label === ZLAMANA)?.terminalOnly).toBe(true);
    await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[ZLAMANA]]))
      .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
  });

  it('karta pytania z jsonl: marker eskalacji za 200. znakiem etykiety daje `terminalOnly`', async () => {
    // `canonicalLabel` ucina do `OPTION_LABEL_MAX_CHARS` (200); polityka na uciętej etykiecie gubiłaby marker za tą
    // granicą. Karta liczy ją na pełnej etykiecie ze zwiniętymi białymi znakami.
    const DLUGA = `Zapis w katalogu ${'x'.repeat(190)}, for this session`;
    expect(DLUGA.length).toBeGreaterThan(200);
    expect(DLUGA.indexOf('this session')).toBeGreaterThan(200);
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-esc-dluga',
      tool: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Który wariant zapisu wybrać?',
          header: 'Zapis pliku',
          multiSelect: false,
          options: [{ label: 'Zapis atomowy (tmp + rename)' }, { label: DLUGA }],
        }],
      },
      screen: DIALOG_QUESTION.replace('2. Zapis w miejscu', `2. ${DLUGA}`),
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z jsonl');

    const card = questions(fx.events)[0];
    expect(card?.reqId).toBe('t-esc-dluga');
    expect(card?.questions[0]?.options).toEqual([
      { label: 'Zapis atomowy (tmp + rename)', role: 'answer' },
      { label: DLUGA, terminalOnly: true, role: 'answer' },
    ]);
  });

  /*
   * Bramka cyfry szuka odpowiedzi na liście opcji z ekranu, a etykiety z ekranu są ucięte do
   * `OPTION_LABEL_MAX_CHARS` (200). Polityka na takiej etykiecie nie widzi markera za 200. znakiem, choć karta
   * z etykietami payloadu oznaczyła opcję `terminalOnly`. Spreparowany klient trafia w opcję z ekranu i pełną
   * etykietą, i samym prefiksem bez markera, więc werdykt bierze się z opublikowanej karty, nie z wejścia klienta.
   */
  const DLUGA_ESKALUJACA = `Zapis w katalogu ${'x'.repeat(190)}, for this session`;
  it.each([
    ['pełną etykietę', DLUGA_ESKALUJACA],
    ['sam 200-znakowy prefiks bez markera', DLUGA_ESKALUJACA.slice(0, 200)],
  ])('karta pytania z jsonl: bramka cyfry odmawia opcji `terminalOnly` z markerem za 200. znakiem (klient wysyła %s)',
    async (_case, wyslana) => {
      expect(DLUGA_ESKALUJACA.indexOf('this session')).toBeGreaterThan(200);
      const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      await blockOn(fx, {
        id: 't-esc-bramka',
        tool: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Który wariant zapisu wybrać?',
            header: 'Zapis pliku',
            multiSelect: false,
            options: [{ label: 'Zapis atomowy (tmp + rename)' }, { label: DLUGA_ESKALUJACA }],
          }],
        },
        screen: DIALOG_QUESTION.replace('2. Zapis w miejscu', `2. ${DLUGA_ESKALUJACA}`),
      });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania z jsonl');

      const card = questions(fx.events)[0];
      expect(card?.reqId).toBe('t-esc-bramka');
      expect(card?.channel).toBe('keys');
      expect(card?.questions[0]?.options.find((o) => o.label === DLUGA_ESKALUJACA)?.terminalOnly).toBe(true);
      const before = fx.client.mutations;

      await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[wyslana]]))
        .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
      expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
      expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
      expect(fx.audit.at(-1)).toMatchObject({ method: 'refuse', reason: 'terminal-only' });
    });

  it('karta pytania z jsonl: długa etykieta BEZ markera eskalacji dalej idzie cyfrą', async () => {
    const DLUGA_ZWYKLA = `Zapis w katalogu ${'x'.repeat(190)}, z kopią zapasową`;
    expect(DLUGA_ZWYKLA.length).toBeGreaterThan(200);
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-dluga-zwykla',
      tool: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Który wariant zapisu wybrać?',
          header: 'Zapis pliku',
          multiSelect: false,
          options: [{ label: 'Zapis atomowy (tmp + rename)' }, { label: DLUGA_ZWYKLA }],
        }],
      },
      screen: DIALOG_QUESTION.replace('2. Zapis w miejscu', `2. ${DLUGA_ZWYKLA}`),
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z jsonl');

    const card = questions(fx.events)[0];
    expect(card?.reqId).toBe('t-dluga-zwykla');
    expect(card?.questions[0]?.options.find((o) => o.label === DLUGA_ZWYKLA)?.terminalOnly).toBeUndefined();
    const before = fx.client.mutations;
    fx.driver.answerQuestion(card?.reqId ?? '', [[DLUGA_ZWYKLA]]);
    await waitFor(() => fx.client.mutations > before, 'cyfra długiej opcji');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['2']]);
  });

  it('mignięcie `blocked→working→blocked` NIE unieważnia odpowiedzi ze starej karty', async () => {
    /*
     * Detekcja herdr potrafi mignąć nad STOJĄCYM dialogiem. Karta z `reqId` z numeru blokady
     * po mignięciu dostałaby nowy identyfikator, a tapnięcie w kartę wyrenderowaną przed
     * mignięciem przepadłoby BEZ ŚLADU. `reqId`
     * z TREŚCI formularza jest przez mignięcie stabilny — stara karta dalej trafia.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'pierwsza karta');
    const first = questions(fx.events)[0];

    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await quiet();
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await waitFor(() => questions(fx.events).length > 1, 'karta po mignięciu');

    // Ten sam dialog = ten sam identyfikator — telefon z kartą sprzed mignięcia dalej trafia.
    expect(questions(fx.events)[1]?.reqId).toBe(first?.reqId);
    fx.driver.answerQuestion(first?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra po mignięciu');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
  });

  it('druga zakładka formularza BEZ mignięcia statusu dostaje WŁASNĄ kartę (re-arm po cyfrze)', async () => {
    /*
     * Zmierzone klatkami ekranu co 400 ms (wersja CLI niezapisana): formularz z DWOMA pytaniami
     * po odpowiedzi przełącza zakładkę W MIEJSCU, a `agent_status` herdr zostaje `blocked` bez ani
     * jednego mignięcia. `#onStatus` nie strzela, więc bez re-armu po własnej cyfrze karta drugiego
     * pytania nie powstałaby NIGDY — telefon spadałby do „odpowiedz w terminalu".
     */
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { screenAnswerRearmDelaysMs: [10, 40] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pierwszej zakładki');
    const first = questions(fx.events)[0];

    /*
     * Panel przełącza zakładkę DOPIERO PO przyjęciu cyfry — ekran NOWY, status i numer
     * blokady TE SAME. Kolejność ma znaczenie: przed
     * wysyłką driver czyta ekran i sprawdza, czy etykieta wciąż ma tę samą cyfrę, więc
     * podmiana ekranu PRZED tapnięciem znaczyłaby „człowiek odpowiedział przy biurku",
     * a nie „formularz przełączył zakładkę po naszej odpowiedzi".
     */
    const secondTab = DIALOG_QUESTION
      .replace('Który wariant zapisu wybrać?', 'Czy dodać testy regresji?')
      .replace('1. Zapis atomowy (tmp + rename)', '1. Tak, dodaj testy')
      .replace('2. Zapis w miejscu', '2. Nie, zostaw');
    const sendKeys = fx.client.sendKeys;
    fx.client.sendKeys = async (paneId, keys) => {
      await sendKeys(paneId, keys);
      fx.client.screenText = secondTab;
    };
    fx.driver.answerQuestion(first?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    await waitFor(() => questions(fx.events).length > 1, 'karta drugiej zakładki');

    const second = questions(fx.events)[1];
    expect(second?.reqId).not.toBe(first?.reqId);
    expect(second?.questions[0]?.question).toContain('Czy dodać testy regresji?');
    // Odpowiedź w drugą kartę trafia tą samą drogą: cyfra po TEKŚCIE etykiety.
    fx.driver.answerQuestion(second?.reqId ?? '', [['Nie, zostaw']]);
    await waitFor(() => fx.client.mutations > 1, 'druga cyfra');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1'], ['2']]);
  });

  it('formularz 2 pytań z hooka: odpowiedź na pierwsze NIE kasuje zrzutu, druga karta jest z hooka', async () => {
    /*
     * Rarog wysyła cyfrę za zakładkę 1, CLI przechodzi na zakładkę 2. Gdyby `clearPendingHook`
     * skasował wtedy zrzut, ocena szłaby czysto ekranowo, a karta spadałaby do „odpowiedz
     * w terminalu" sekundę po `approve`.
     *
     * Zrzut `AskUserQuestion` przeżywa własną cyfrę, dopóki na ekranie stoi formularz
     * pytania. Ponowna ocena po własnej cyfrze należy się także karcie Z HOOKA, więc
     * zakładka 2 wchodzi od razu, a nie po zegarze oceny. Ekrany są z pomiaru na żywo
     * (Claude Code 2.1.257), nie z ręki.
     */
    const cleared: string[] = [];
    let zrzut: PendingHookTool | null = {
      toolName: 'AskUserQuestion',
      hookEventName: 'PermissionRequest',
      toolInput: {
        questions: [
          {
            question: 'Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?',
            header: 'Odstęp',
            multiSelect: false,
            options: [
              { label: '52 px — wartość `wide` (rekomendacja)', description: 'z hooka: największa' },
              { label: '40 px — wartość `default`', description: 'z hooka: środkowa' },
              { label: 'Nowa wartość pośrednia', description: 'z hooka: do ustalenia' },
            ],
          },
          {
            question: 'Jaki kolor przycisku?',
            header: 'Kolor',
            multiSelect: false,
            options: [
              { label: 'Niebieski (Rekomendacja)', description: 'z hooka: jak dziś' },
              { label: 'Zielony', description: 'z hooka: nowy' },
            ],
          },
        ],
      },
      at: 11,
    };
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: {
        screenAnswerRearmDelaysMs: [1, 5],
        readPendingHook: () => zrzut,
        // Atrapa trzyma się semantyki pliku: skasowany zrzut przestaje być czytany.
        clearPendingHook: (sid) => { cleared.push(sid); zrzut = null; },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_MULTIQ_TAB1;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pierwszego pytania');
    const first = questions(fx.events)[0];
    // Nagłówek i opisy spod etykiet pochodzą z payloadu, nie z ekranu — to znak ścieżki hooka.
    expect(first?.questions[0]?.header).toBe('Odstęp');
    expect(first?.questions[0]?.options[0]?.description).toBe('z hooka: największa');

    // Panel przełącza zakładkę DOPIERO PO przyjęciu cyfry — ekran nowy, numer blokady ten sam.
    const sendKeys = fx.client.sendKeys;
    fx.client.sendKeys = async (paneId, keys) => {
      await sendKeys(paneId, keys);
      fx.client.screenText = DIALOG_MULTIQ_TAB3;
    };
    fx.driver.answerQuestion(first?.reqId ?? '', [['52 px — wartość `wide` (rekomendacja)']]);
    await waitFor(() => questions(fx.events).length > 1, 'karta drugiego pytania');

    // Zrzut przeżył własną cyfrę — bez tego zakładka 2 nie ma skąd wziąć treści.
    expect(cleared).toEqual([]);
    const second = questions(fx.events)[1];
    expect(second?.questions[0]?.question).toContain('Jaki kolor przycisku?');
    // Karta z HOOKA, nie fallback: `reqId` ze zrzutu + odcisk treści zakładki (inna
    // zakładka to inna karta), nagłówek i opisy z payloadu.
    expect(second?.reqId.startsWith('hook:')).toBe(true);
    expect(second?.reqId).not.toBe(first?.reqId);
    expect(second?.questions[0]?.header).toBe('Kolor');
    expect(second?.questions[0]?.options[0]?.description).toBe('z hooka: jak dziś');
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'))).toEqual([]);

    // Odpowiedź w drugą kartę jedzie tą samą drogą: cyfra po TEKŚCIE etykiety.
    fx.driver.answerQuestion(second?.reqId ?? '', [['Zielony']]);
    await waitFor(() => fx.client.mutations > 1, 'cyfra drugiego pytania');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1'], ['2']]);
  });

  it('zakładka multiSelect w środku formularza z hooka NIE zabiera karty następnym pytaniom',
    async () => {
      /*
       * Karta fallbacku z `reqId` stałym na całą blokadę (`hook:<id>`) po zakładce WIELOKROTNEJ
       * kończyłaby ocenę bramką „ta sama karta stoi" przed spojrzeniem na ekran — telefon
       * zostawałby ze zdaniem „Wielokrotny wybór zrób w terminalu" nad pytaniem jednokrotnym.
       *
       * Łańcuch jest z pomiaru (CLI 2.1.257): zakładka 1 jednokrotna (cyfra z Raroga),
       * zakładka 2 wielokrotna (uczciwy fallback, człowiek odpowiada przy biurku),
       * zakładka 3 jednokrotna — i ona ZNÓW ma dostać kartę.
       */
      const zrzut: PendingHookTool = {
        toolName: 'AskUserQuestion',
        hookEventName: 'PermissionRequest',
        toolInput: {
          questions: [
            {
              question: 'Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?',
              header: 'Odstęp',
              multiSelect: false,
              options: [
                { label: '52 px — wartość `wide` (rekomendacja)' },
                { label: '40 px — wartość `default`' },
                { label: 'Nowa wartość pośrednia' },
              ],
            },
            {
              question: 'Które dodatki włączyć?',
              header: 'Dodatki',
              multiSelect: true,
              options: [
                { label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' },
              ],
            },
            {
              question: 'Jaki kolor przycisku?',
              header: 'Kolor',
              multiSelect: false,
              options: [{ label: 'Niebieski (Rekomendacja)' }, { label: 'Zielony' }],
            },
          ],
        },
        at: 11,
      };
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie'),
        deps: {
          screenCacheMs: 5,
          blockedPollMs: 25,
          screenAnswerRearmDelaysMs: [1, 5],
          readPendingHook: () => zrzut,
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_MULTIQ_TAB1;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta zakładki 1');
      const first = questions(fx.events)[0];
      expect(first?.questions[0]?.header).toBe('Odstęp');

      // Cyfra z Raroga przełącza formularz na zakładkę WIELOKROTNĄ — bez mignięcia statusu.
      const sendKeys = fx.client.sendKeys;
      fx.client.sendKeys = async (paneId, keys) => {
        await sendKeys(paneId, keys);
        fx.client.screenText = DIALOG_MULTIQ_TAB2;
      };
      fx.driver.answerQuestion(first?.reqId ?? '', [['52 px — wartość `wide` (rekomendacja)']]);
      await waitFor(() => screenDialogs(fx.events).length > 0, 'fallback zakładki wielokrotnej');
      expect(screenDialogs(fx.events).at(-1)?.reason).toBe('multi-select');

      // Człowiek zaznaczył dodatki przy biurku: zakładka 3 znów jest jednokrotna.
      fx.client.screenText = DIALOG_MULTIQ_TAB3;
      await waitFor(() => questions(fx.events).length > 1, 'karta zakładki 3');
      const third = questions(fx.events).at(-1);
      // Znów karta Z HOOKA (nagłówek z payloadu), a nie sam ekran.
      expect(third?.questions[0]?.header).toBe('Kolor');
      expect(third?.reqId.startsWith('hook:')).toBe(true);
      expect(third?.reqId).not.toBe(first?.reqId);
    });

  it('odczyt trafiony w przemalowanie NIE zamraża fallbacku — drugi odczyt omija cache', async () => {
    /*
     * Ekran przy wejściu w `blocked` jest czytany od razu i cache'owany (`#reportBlocked`).
     * Odczyt w środku przemalowania TUI dawał pusty parse, a fallback „odpowiedz w terminalu"
     * zamrażał się nad dialogiem, który chwilę później parsował się poprawnie. Pusty
     * `no-jsonl` dostaje dziś JEDNO ponowienie z pominięciem cache'u — jak `unreadable`.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = 'panel w połowie przemalowany, bez ani jednej opcji';
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => reads(fx.client) >= 1, 'pierwszy odczyt (cache blokady)');
    // Zanim minie odstęp ponowienia, TUI kończy przemalowanie.
    fx.client.screenText = DIALOG_QUESTION;

    await waitFor(() => questions(fx.events).length > 0, 'karta po ponownym odczycie');
    expect(questions(fx.events)[0]?.questions[0]?.question)
      .toContain('Który wariant zapisu wybrać?');
    expect(screenDialogs(fx.events)).toEqual([]);
  });

  it('odpowiedź w INNY dialog niż stojący mówi o tym głośno, nie znika po cichu', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta');

    fx.driver.answerQuestion('screen:q:nieaktualna', [['Zapis w miejscu']]);
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('the dialog in the terminal changed in the meantime')),
      'głośny zrzut',
    );
    expect(fx.client.mutations).toBe(0);
  });

  it('czekające narzędzie BEZ `blocked` nie robi karty (długi `Bash` to nie dialog)', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await appendFile(fx.transcript, toolUseLine('t-1', 'Bash', BASH_INPUT));
    await quiet();

    expect(permissions(fx.events)).toEqual([]);
    expect(reads(fx.client)).toBe(0);
  });

  it('rozjazd nazwy narzędzia → karta bez przycisków, ZERO ponowień', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    // Ekran mówi „Bash", jsonl mówi „Edit" — Rarog nie wie, co by zatwierdził.
    await blockOn(fx, {
      id: 't-2', tool: 'Edit', input: { file_path: '/Users/u/Projects/atlas/a.ts' },
      screen: DIALOG_PERMISSION,
    });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zdegradowana');
    await quiet();

    expect(permissions(fx.events)[0]?.input).toBeNull();
    // Rozjazd nie jest problemem czasu, więc ponawianie odczytu byłoby tylko odwlekaniem.
    expect(reads(fx.client)).toBe(1);
    // Bez cyfr `allow` nie ma czego wysłać.
    fx.driver.respondPermission('t-2', 'allow');
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('nieczytelny ekran → DOKŁADNIE dwa odczyty, potem fail-closed', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, {
      id: 't-3', tool: 'Bash', input: BASH_INPUT, screen: 'panel przemalowuje się właśnie teraz',
    });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zdegradowana');
    await quiet();

    expect(reads(fx.client)).toBe(2);
    expect(permissions(fx.events)[0]).toMatchObject({ input: null, reason: 'unreadable' });
    // Tożsamość z WNIOSKU, nie goła baza `t-3`: z bazą bramka „ta sama
    // karta" w driverze zamrażała tę kartę do końca blokady, choćby dialog wrócił na ekran.
    expect(permissions(fx.events)[0]?.reqId.startsWith('t-3:d:')).toBe(true);
  });

  it('`blocked` bez czekającego narzędzia → karta dialogu, NIE karta zgody', async () => {
    /*
     * Dialog spoza jsonl nie jest `permission-request`. Powód jest
     * strukturalny, nie kosmetyczny — taka karta nie ma `permId` (nie ma wpisu `tool_use`,
     * z którego mógłby powstać), więc jej decyzja adresuje się SAMĄ SESJĄ. Rozpoznana
     * sygnatura („zaufanie katalogu") niesie identyfikator, z którego UI robi przycisk.
     */
    const fx = await makeDriver({ transcript: userLine('cokolwiek') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = TRUST_DIALOG;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu spoza jsonl');

    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
    expect(permissions(fx.events)).toHaveLength(0);
    // Zatwierdzenie rozpoznanego dialogu wysyła DOKŁADNIE cyfrę opcji twierdzącej — wybraną
    // po tekście etykiety („Yes, proceed"), nigdy po pozycji na ekranie.
    fx.driver.respondPermission('sess-1', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
  });

  /**
   * Panel podpięty JUŻ zablokowany, w katalogu bez pliku jsonl.
   *
   * Tak wygląda świeży katalog z dialogiem zaufania: `claude` staje na pytaniu, zanim manager
   * zdąży podpiąć drivera. Zdarzenia zmiany statusu już nie będzie (status się nie zmienia),
   * a `tool_use` nie powstanie, bo agent nie ruszył — bez oceny przy podpięciu Rarog nie ma
   * ani jednego wyzwalacza i karta nie pokazuje się NIGDY (`pendingQuestions` puste).
   */
  it('podpięcie do panelu JUŻ zablokowanego wystawia kartę dialogu (bez pliku jsonl)', async () => {
    const trust: number[] = [];
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked' },
      screen: TRUST_DIALOG,
      deps: { markTrustDialog: () => { trust.push(1); } },
    });

    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu przy podpięciu');
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
    // Stan „czeka na decyzję" leci tak samo jak przy przejściu w `blocked` — inaczej composer
    // zostałby aktywny nad panelem, który nic nie przyjmie.
    expect(states(fx.events).some((s) => s.state === 'blocked')).toBe(true);
    // Nadzorca dostaje meldunek o dialogu zaufania: to on trzyma karencję zniknięcia po
    // re-eksekucji `claude`.
    expect(trust.length).toBeGreaterThan(0);
  });

  it('brak pliku jsonl NIE każe czekać na `tool_use`, który nie ma jak powstać', async () => {
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked' },
      screen: TRUST_DIALOG,
      // Karencja uzgadniania jsonl ↔ herdr kosztowałaby tu DRUGIE tyle czystej zwłoki:
      // ocena rusza po jednym debouncie, a bez pliku nie ma na co czekać.
      deps: { pendingDebounceMs: 200 },
    });

    const started = Date.now();
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta bez czekania na jsonl');
    expect(Date.now() - started).toBeLessThan(400);
  });

  /**
   * Między podpięciem drivera a końcem globu po uuid follower NIE ZNA ścieżki. Gdyby
   * `hasTranscript()` mówiło wtedy `false`, driver pominąłby karencję jsonl ↔ ekran i oceniał
   * dialog na ekranie z tej samej milisekundy — w pół przemalowania TUI. „Nie wiem" ma być
   * traktowane jak „możliwe": ocena czeka pełną karencję (2 × debounce), a panel zablokowany
   * przy podpięciu („nie ma" po nieudanym globie) dalej rusza bez zwłoki.
   */
  it('nieustalona ścieżka transkryptu każe czekać pełną karencję przed oceną z ekranu', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked' },
      screen: TRUST_DIALOG,
      deps: {
        scheduler: clock.scheduler,
        pendingDebounceMs: 30,
        follow: () => stubFollower(() => 'unknown'),
      },
    });

    // Zegar stoi, więc karencja NIE MIJA: ocena ma odkładać się debounce po debounce,
    // bez ani jednej karty i bez ani jednego dodatkowego odczytu ekranu.
    await quiet();
    await quiet();
    await quiet();
    expect(screenDialogs(fx.events)).toEqual([]);
    // Jedyny odczyt to ten przy wejściu w `blocked` (`#reportBlocked`, wycinek + cache).
    expect(reads(fx.client)).toBe(1);

    clock.advance(60);
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta po pełnej karencji');
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
  });

  it('ścieżka rozstrzygnięta na „nie ma" ocenia dialog od razu — stojący zegar nie blokuje', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked' },
      screen: TRUST_DIALOG,
      deps: {
        scheduler: clock.scheduler,
        pendingDebounceMs: 30,
        follow: () => stubFollower(() => 'no'),
      },
    });
    // Ten sam stojący zegar co wyżej: bez pliku nie ma na co czekać, więc karta jest od razu.
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta bez karencji');
  });

  it('decyzja na dialogu zaufania melduje się nadzorcy (karencja re-eksekucji)', async () => {
    let marks = 0;
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked' },
      screen: TRUST_DIALOG,
      deps: { markTrustDialog: () => { marks += 1; } },
    });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu zaufania');
    const atCard = marks;

    fx.driver.respondPermission('sess-1', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zaufania');

    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
    // Meldunek leci DRUGI raz, przy samej decyzji: od niej liczy się karencja zniknięcia.
    expect(marks).toBeGreaterThan(atCard);
    expect(fx.audit.at(-1)?.toolName).toBe('dialog:trust');
  });

  it('dialog SPOZA zamkniętej listy sygnatur nie dostaje ani jednej cyfry', async () => {
    const fx = await makeDriver({ transcript: userLine('cokolwiek') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    // Poprawnie ponumerowane opcje, a mimo to ZERO przycisków: sygnatury nie ma na liście.
    fx.client.screenText = 'Allow this MCP server?\n1. Yes, allow\n2. No';
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu spoza jsonl');

    expect(screenDialogs(fx.events)[0]?.knownDialog).toBeUndefined();
    fx.driver.respondPermission('sess-1', 'allow');
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('zniknięcie czekającego narzędzia gasi kartę', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, { id: 't-4', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    // Człowiek zdecydował przy biurku: `tool_result` ląduje w pliku, a agent rusza dalej.
    await appendFile(fx.transcript, toolResultLine('t-4'));
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await waitFor(() => cleared(fx.events).length > 0, 'wygaszenie karty');
    expect(cleared(fx.events)[0]?.reqId).toBe('t-4');
  });

  it('wyjście z `blocked` gasi kartę, nawet gdy wpis został w pliku', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, { id: 't-5', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 9, title: '' });
    await waitFor(() => cleared(fx.events).length > 0, 'wygaszenie karty');
  });
});

describe('wysyłka decyzji', () => {
  it('`allow` wysyła cyfrę opcji „tak, ten jeden raz" i zapisuje CO zatwierdzono', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, { id: 't-6', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    fx.driver.respondPermission('t-6', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra');
    await quiet();

    // `1. Yes`, nigdy `2. Yes, and don't ask again …` — ta druga zmienia konfigurację projektu.
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
    // `approve`, nie `send_keys` — zatwierdzenie z kontekstem decyzji ma własny grep
    // w runbooku kradzieży.
    expect(fx.audit.at(-1)).toMatchObject({
      method: 'approve', keys: ['1'], toolName: 'Bash', optionLabel: 'Yes',
    });
  });

  it('`allow` na nieaktualnym `reqId` nie wysyła nic', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, { id: 't-7', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    fx.driver.respondPermission('inny-req', 'allow');
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  /**
   * TEST OBOWIĄZKOWY: brak cyfry w mapie = brak wysyłki.
   *
   * Ekran bez opcji zaczynającej się od „Yes" (inne CLI, inny język) nie ma prawa skończyć się
   * strzałem w przypadkową pozycję — cyfra wynika z TEKSTU albo nie wynika wcale.
   */
  it('brak jednoznacznej opcji twierdzącej → ZERO klawiszy i wyjaśnienie w transkrypcie', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    const screen = DIALOG_PERMISSION.replace('❯ 1. Yes', '❯ 1. Proceed');
    await blockOn(fx, { id: 't-8', tool: 'Bash', input: BASH_INPUT, screen });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    fx.driver.respondPermission('t-8', 'allow');
    await quiet();
    expect(fx.client.mutations).toBe(0);
    expect(systemTexts(fx.events).some((t) => t.includes("Couldn't tell which dialog option"))).toBe(true);
  });

  it('odpowiedź na pytanie wybiera cyfrę po TEKŚCIE etykiety, nie po pozycji', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    const input = {
      questions: [{
        question: 'Który wariant zapisu wybrać?',
        header: 'Zapis pliku',
        multiSelect: false,
        options: [{ label: 'Zapis atomowy (tmp + rename)' }, { label: 'Zapis w miejscu' }],
      }],
    };
    await blockOn(fx, { id: 'q-2', tool: 'AskUserQuestion', input, screen: DIALOG_QUESTION });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    fx.driver.answerQuestion('q-2', [['Zapis w miejscu']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra');
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['2']]);
  });

  it('wielokrotny wybór nie idzie z telefonu', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    const input = {
      questions: [{
        question: 'Które pliki?',
        header: 'Pliki',
        multiSelect: true,
        options: [{ label: 'Zapis atomowy (tmp + rename)' }, { label: 'Zapis w miejscu' }],
      }],
    };
    await blockOn(fx, { id: 'q-3', tool: 'AskUserQuestion', input, screen: DIALOG_QUESTION });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    fx.driver.answerQuestion('q-3', [['Zapis atomowy (tmp + rename)', 'Zapis w miejscu']]);
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  /**
   * Cyfra nie może być wybierana z ekranu SPRZED dowolnie długiego czasu.
   *
   * Formularz `AskUserQuestion` z kilkoma pytaniami przełącza zakładkę W MIEJSCU: `agent_status`
   * zostaje `blocked` bez ani jednego mignięcia, a `#rearmAfterScreenAnswer` odpala się WYŁĄCZNIE
   * po WŁASNEJ cyfrze Raroga — więc odpowiedź CZŁOWIEKA przy biurku nie unieważnia karty niczym.
   * Telefon dalej pokazuje stare opcje, a tapnięcie wysłałoby ich cyfrę w dialog, którego nikt
   * nie widzi. Dlatego przed wysyłką idzie świeży odczyt i asercja po ETYKIECIE.
   */
  it('człowiek odpowiedział przy biurku → cyfra ze starej karty NIE idzie do panelu', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pierwszej zakładki');
    const card = questions(fx.events)[0];

    // Odpowiedź przy biurku: druga zakładka formularza, TA SAMA blokada i ZERO zdarzeń statusu.
    fx.client.screenText = DIALOG_QUESTION
      .replace('Który wariant zapisu wybrać?', 'Czy usunąć katalog build?')
      .replace('1. Zapis atomowy (tmp + rename)', '1. Tak, usuń')
      .replace('2. Zapis w miejscu', '2. Nie, zostaw');

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('The pane now shows a different dialog')),
      'zdanie o rozjeździe ekranu',
    );
    await quiet();
    // Cyfra „1" znaczyłaby na żywym ekranie „Tak, usuń" — dlatego nie poszła ŻADNA.
    expect(fx.client.mutations).toBe(0);
    expect(fx.audit.some((e) => e.method === 'send_keys')).toBe(false);
    // Karta jest zgaszona i odbudowana z tego, co stoi TERAZ — telefon nie zostaje z kłamstwem.
    expect(cleared(fx.events).map((c) => c.reqId)).toContain(card?.reqId);
    await waitFor(() => questions(fx.events).length > 1, 'karta z nowego ekranu');
    expect(questions(fx.events).at(-1)?.questions[0]?.question).toContain('Czy usunąć katalog build?');
  });

  it('formularz z preview: cyfra → weryfikacja `❯` na świeżym ekranie → enter', async () => {
    /*
     * Pomiar na CLI 2.1.246 (żywe panele): w wariancie z preview cyfra tylko przesuwa
     * podświetlenie, a `[cyfra, enter]` w jednej ramce gubi cyfrę i zatwierdza opcję
     * DOMYŚLNĄ. Jedyna uczciwa droga: cyfra, świeży odczyt, dowód `❯` na wybranej
     * etykiecie, dopiero wtedy `enter` — osobną metodą klienta, poza `ALLOWED_KEYS`.
     */
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { formSubmitConfirmDelayMs: 1, screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta formularza z preview');
    const card = questions(fx.events)[0];

    // Panel po cyfrze przemalowuje podświetlenie — symulujemy to w chwili wysyłki cyfry.
    const sendKeysBase = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.includes('2')) {
        fx.client.screenText = DIALOG_PREVIEW
          .replace('❯ 1.', '  1.').replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony');
      }
      return sendKeysBase(paneId, keys);
    };

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zagnieżdżony po projekcie']]);
    await waitFor(
      () => fx.client.calls.some((c) => c.method === 'form_submit'),
      'enter po weryfikacji',
    );
    const decision = fx.client.calls.filter(
      (c) => c.method === 'send_keys' || c.method === 'form_submit',
    );
    expect(decision.map((c) => [c.method, ...(c.keys ?? [])])).toEqual([
      ['send_keys', '2'], ['form_submit', 'enter'],
    ]);
    // Dziennik: OBA klawisze jako `approve` z etykietą — „co zatwierdzono", nie „co wysłano".
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e['keys']))
      .toEqual([['2'], ['enter']]);
  });

  it('cyfra połknięta (❯ został na domyślnej) → ZERO enterów, karta zgaszona', async () => {
    /*
     * Dokładnie zmierzony najgorszy scenariusz jednej ramki — tu jest bramką: skoro świeży
     * ekran nie dowodzi, że podświetlona jest WYBRANA etykieta, `enter` nie wychodzi wcale
     * i nie jest ponawiany. Formularz zostaje nietknięty decyzją, człowiek dostaje zdanie.
     */
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { formSubmitConfirmDelayMs: 1, screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta formularza z preview');
    const card = questions(fx.events)[0];

    // Ekran NIE zmienia się po cyfrze — podświetlenie stoi na opcji 1 (domyślnej).
    fx.driver.answerQuestion(card?.reqId ?? '', [['Zagnieżdżony po projekcie']]);
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('The confirmation (Enter) was not sent')),
      'zdanie o odmowie entera',
    );
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'form_submit')).toEqual([]);
    expect(cleared(fx.events).map((c) => c.reqId)).toContain(card?.reqId);
  });

  it('mignięcie statusu między cyfrą a enterem → enter NIE wychodzi (zamrożona blokada)', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { formSubmitConfirmDelayMs: TEST_FORM_CONFIRM_MS, screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta formularza z preview');
    const card = questions(fx.events)[0];

    const sendKeysBase = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.includes('2')) {
        // Ekran wygląda idealnie… ale to już INNA blokada — dialog zdążył się wymienić.
        fx.client.screenText = DIALOG_PREVIEW
          .replace('❯ 1.', '  1.').replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony');
        fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
        fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
      }
      return sendKeysBase(paneId, keys);
    };

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zagnieżdżony po projekcie']]);
    await waitFor(() => fx.client.calls.some((c) => c.keys?.includes('2') === true), 'cyfra');
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'form_submit')).toEqual([]);
  });

  it('odmowa gniazda przy enterze NIE jest ponawiana', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { formSubmitConfirmDelayMs: 1, screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta formularza z preview');
    const card = questions(fx.events)[0];

    const sendKeysBase = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.includes('2')) {
        fx.client.screenText = DIALOG_PREVIEW
          .replace('❯ 1.', '  1.').replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony');
      }
      return sendKeysBase(paneId, keys);
    };
    let submits = 0;
    fx.client.sendFormSubmit = () => {
      submits += 1;
      return Promise.reject(new Error('gniazdo odmówiło'));
    };

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zagnieżdżony po projekcie']]);
    await waitFor(() => submits > 0, 'próba entera');
    await quiet();
    // Drugi enter szedłby w ekran, którego nikt nie widział — próba jest DOKŁADNIE jedna.
    expect(submits).toBe(1);
  });

  it('formularz BEZ preview zatwierdza samą cyfrą — entera nie ma w ogóle', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { formSubmitConfirmDelayMs: 1, screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    const card = questions(fx.events)[0];

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis w miejscu']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra');
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'form_submit')).toEqual([]);
  });

  it('ścieżka hooka: inne pytanie o tych samych etykietach po cyfrze → ZERO enterów', async () => {
    /*
     * Karta z hooka (`#openDecision`) bez treści pytania nie pozwala weryfikacji przed enterem
     * dowieść „to samo pytanie" — a formularz wielopytaniowy przełącza zakładki BEZ mignięcia
     * statusu i etykiety sąsiednich pytań potrafią brzmieć identycznie. Treść pytania jedzie więc
     * z EKRANU także na tej ścieżce,
     * a rozjazd kończy się odmową z powodem, nigdy enterem w cudze pytanie.
     */
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: {
        formSubmitConfirmDelayMs: 1,
        screenAnswerRearmDelaysMs: [1, 5],
        readPendingHook: () => ({
          toolName: 'AskUserQuestion',
          toolInput: {
            questions: [{
              question: 'Który schemat ścieżek URL wolisz dla API Raroga?',
              header: 'Schemat URL',
              multiSelect: false,
              options: [
                { label: 'Płaski zasobowy' }, { label: 'Zagnieżdżony po projekcie' },
                { label: 'Wersjonowany RPC' },
              ],
            }],
          },
          at: 11,
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z hooka');
    const card = questions(fx.events)[0];
    expect(card?.reqId.startsWith('hook:')).toBe(true);

    // Po cyfrze panel pokazuje już NASTĘPNE pytanie — inna treść, TE SAME etykiety, ❯ na 2.
    const sendKeysBase = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.includes('2')) {
        fx.client.screenText = DIALOG_PREVIEW
          .replace('Który schemat ścieżek URL wolisz dla API Raroga?', 'A schemat dla eksportu?')
          .replace('❯ 1.', '  1.').replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony');
      }
      return sendKeysBase(paneId, keys);
    };

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zagnieżdżony po projekcie']]);
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('the form now shows a different question than the card')),
      'odmowa z powodem „inne pytanie"',
    );
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'form_submit')).toEqual([]);
    // Licznik odmów: weryfikacja przed `enter` to JEDYNE miejsce, w którym Rarog
    // zatrzymuje decyzję już po pierwszym klawiszu — bez wpisu suma odmów nie widzi jej
    // porażek w ogóle (`abort()` robił kiedyś `#system` bez wpisu do dziennika).
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toContain('form-submit');
  });

  it('tryb edycji notatki na żywym ekranie blokuje cyfrę z wcześniejszej karty', async () => {
    /*
     * Pomiar na CLI 2.1.246: po `n` cyfra wpisuje się do pola notatki jako TEKST
     * („Notes: 5"). Karta mogła powstać PRZED wejściem człowieka w notatkę przy biurku — bramka
     * `#digitStillHolds` czyta żywy ekran tuż przed wysyłką i widzi sygnaturę `ctrl+g`.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_PREVIEW;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta formularza z preview');
    const card = questions(fx.events)[0];

    // Człowiek przy biurku wszedł w tryb notatki: te same opcje, stopka z `ctrl+g`.
    fx.client.screenText = DIALOG_PREVIEW.replace(
      'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
      'Enter to select · ↑/↓ to navigate · n to add notes · ctrl+g to\nedit in Nvim · Esc to cancel',
    );

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zagnieżdżony po projekcie']]);
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('The pane now shows a different dialog')),
      'zdanie o rozjeździe ekranu',
    );
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('po WŁASNEJ cyfrze przemalowanie ekranu nie wypycha karty „zobacz w terminalu"', async () => {
    /*
     * Rearm po własnej cyfrze czyta ekran W TRAKCIE zamykania dialogu (nieparsowalny); pusta
     * ocena zamieniona na kartę-fallback („herdr o coś pyta — zobacz w terminalu") mignęłaby
     * na telefonie, zanim zgasi ją `working`. W oknie tej samej blokady pusta
     * ocena po własnej odpowiedzi NIE otwiera karty; nowa blokada wraca do normalnych reguł.
     */
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    const card = questions(fx.events)[0];
    const fallbacksBefore = screenDialogs(fx.events).length;

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra odpowiedzi');
    // Ekran w trakcie przemalowania po zamkniętym dialogu — nic się nie parsuje.
    fx.client.screenText = '⏺ pracuję dalej…';
    await quiet();
    expect(screenDialogs(fx.events).length).toBe(fallbacksBefore);

    // NOWA blokada (inny dialog, też nieczytelny) — fallback wraca do łask, fail-closed zostaje.
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await quiet();
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > fallbacksBefore, 'fallback nowej blokady');
  });

  /*
   * Dialog podmieniony w miejscu — druga zakładka formularza po odpowiedzi PRZY BIURKU albo
   * kolejna zgoda pod rząd — nie daje ani jednego zdarzenia statusu. Zrzut ekranu ma więc
   * termin ważności, a zegar ponownej oceny czyta ekran dalej; inaczej telefon zostawałby
   * z kartą opisującą CO INNEGO niż terminal, aż do końca blokady.
   */
  describe('stojący dialog jest oceniany PONOWNIE, nie raz na blokadę', () => {
    /** Krótkie czasy: cache 1 ms, zegar ponownej oceny 8 ms (produkcja: 1 s i 4 s). */
    const fresh = { screenCacheMs: 1, blockedPollMs: 8 } as const;

    /**
     * Migawka „wszystkie zdarzenia przed obrotami zegara” dopiero po pierwszych wypłatach po podpięciu: historii z pliku
     * i list artefaktów oraz zadań w tle. Obie listy idą po globie katalogu sesji na prawdziwych `fs/promises`, czyli
     * poza sterowanym zegarem ({@link drivenClock}); pod obciążeniem wejścia-wyjścia (runner CI, cztery procesy testów)
     * przychodziły w trakcie `clock.advance(100)` i liczyły się jako zdarzenia obrotu.
     */
    const attached = (fx: Fixture): Promise<void> => waitFor(
      () => (['history', 'artifacts', 'background-tasks'] as const).every((type) => fx.events.some((e) => e.type === type)),
      'historia i pierwsze listy artefaktów i zadań',
    );

    it('druga zakładka formularza po odpowiedzi PRZY BIURKU dostaje własną kartę', async () => {
      const fx = await makeDriver({ transcript: userLine('zapytaj mnie'), deps: { ...fresh } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_QUESTION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pierwszego pytania');

      // Człowiek odpowiedział w terminalu: formularz przełączył zakładkę, status się NIE ruszył.
      fx.client.screenText = DIALOG_QUESTION
        .replace('Który wariant zapisu wybrać?', 'Czy dodać testy regresji?')
        .replace('1. Zapis atomowy (tmp + rename)', '1. Tak, dodaj testy')
        .replace('2. Zapis w miejscu', '2. Nie, zostaw');

      await waitFor(() => questions(fx.events).length > 1, 'karta drugiego pytania');
      expect(questions(fx.events).at(-1)?.questions[0]?.question)
        .toContain('Czy dodać testy regresji?');
      // Stara karta jest zgaszona JAWNIE — telefon nie zostaje z dwiema.
      expect(cleared(fx.events).map((c) => c.reqId)).toContain(questions(fx.events)[0]?.reqId);
    });

    it('kolejna zgoda pod rząd (bez mignięcia statusu) dostaje własną kartę', async () => {
      const fx = await makeDriver({ transcript: userLine('zrób coś'), deps: { ...fresh } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_PERMISSION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody A');
      expect(permissions(fx.events)[0]?.displayText).toContain('pnpm exec vitest');

      // Zgoda A zatwierdzona w terminalu, CLI od razu maluje zgodę na NASTĘPNE narzędzie.
      fx.client.screenText = DIALOG_PERMISSION
        // Globalnie: komenda stoi na ekranie DWA razy (linia `⏺ Bash(…)` i wnętrze ramki).
        .replaceAll('pnpm exec vitest run server/test/state-machine.test.ts', 'rm -rf node_modules')
        .replaceAll('Uruchamia testy maszyny stanów', 'Czyści zależności');

      await waitFor(() => permissions(fx.events).length > 1, 'karta zgody B');
      expect(permissions(fx.events).at(-1)?.displayText).toContain('rm -rf node_modules');
    });

    it('ten sam dialog NIE mruga kartą przy każdym obrocie zegara', async () => {
      const clock = drivenClock();
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie'), deps: { ...fresh, scheduler: clock.scheduler },
      });
      await attached(fx);

      fx.client.screenText = DIALOG_QUESTION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await clock.advance(40);
      expect(questions(fx.events).length).toBeGreaterThan(0);

      // Kilkanaście obrotów zegara nad NIEZMIENIONYM ekranem: ekran czytany wielokrotnie,
      // karta postawiona dokładnie raz i ani razu nie zgaszona.
      const readsBefore = reads(fx.client);
      const eventsBefore = fx.events.length;
      await clock.advance(100);
      expect(reads(fx.client)).toBeGreaterThan(readsBefore);
      expect(questions(fx.events)).toHaveLength(1);
      expect(cleared(fx.events)).toHaveLength(0);
      // Obrót nad niezmienionym dialogiem jest zdarzeniem ZEROWYM — także bez wycinka ekranu
      // (ogon ekranu bywa animowany, więc sam dedup po hashu by nie wystarczył).
      expect(fx.events).toHaveLength(eventsBefore);
    });

    /*
     * Ten sam hamulec, ale dla ekranu, który się NIE parsuje. `sameForm` wymaga
     * `questionForm !== null`, więc zakrywa wyłącznie ścieżkę formularza; nad stojącą kartą
     * ekranową, której ekran przestał się parsować (człowiek odpowiedział przy biurku, a CLI
     * postawiło dialog B bez mignięcia statusu), ocena szła dalej i wsypywała wycinek ekranu
     * do transkryptu przy KAŻDYM obrocie zegara — co 4 s w produkcji, dopóki panel jest
     * `blocked`. Dedup po hashu nie ratuje, bo hash powstaje z OGONA, a ogon jest animowany.
     */
    it('nieparsowalny ekran nad stojącą kartą NIE wsypuje wycinka co obrót zegara', async () => {
      const clock = drivenClock();
      const fx = await makeDriver({
        transcript: userLine('zrób coś'), deps: { ...fresh, scheduler: clock.scheduler },
      });
      await attached(fx);

      fx.client.screenText = DIALOG_PERMISSION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await clock.advance(40);
      expect(permissions(fx.events).length).toBeGreaterThan(0);

      /*
       * Ekran CZYTELNY, ale bez listy opcji (`parseOptions` → null) i z ogonem, który zmienia
       * się przy każdym odczycie — czyli dokładnie ten kształt, którego hash nie wycisza.
       */
      let tick = 0;
      Object.defineProperty(fx.client, 'screenText', {
        configurable: true,
        get: () => {
          tick += 1;
          return '⏺ Bash(pnpm test)\n  ⎿  Running…\n\n'
            + 'Czekam na potwierdzenie w innym oknie…\n\n'
            + `✻ Churned for ${String(tick)} s`;
        },
      });

      const eventsBefore = fx.events.length;
      const readsBefore = reads(fx.client);
      await clock.advance(100);

      // Ekran JEST czytany dalej (hamulec nie gasi zegara — gasi tylko skutki uboczne)…
      expect(reads(fx.client)).toBeGreaterThan(readsBefore);
      // …a na zewnątrz nie wychodzi ani jedno zdarzenie: karta stoi i nie jest gaszona.
      // Wycinek ekranu jest polem karty, więc pytanie „czy obrót zegara jest zdarzeniem
      // zerowym" zadajemy wprost.
      expect(fx.events).toHaveLength(eventsBefore);
      expect(permissions(fx.events)).toHaveLength(1);
      expect(cleared(fx.events)).toHaveLength(0);
    });

    /*
     * Karta BEZ OPCJI nie może zamrażać oceny na całą blokadę.
     *
     * Ze stałym `reqId` (`screen:<numer blokady>` albo `hook:<id>`) bramka „ta sama karta stoi"
     * kończyłaby ocenę, zanim ktokolwiek spojrzy na NOWY ekran: po zakładce `multiSelect` żaden
     * kolejny ekran tego samego formularza nie dostałby karty. Tożsamość takiej karty liczy się
     * więc z TREŚCI ekranu — jak każda inna karta ekranowa.
     */
    it('po zakładce multiSelect kolejne zakładki formularza wracają do kart', async () => {
      const fx = await makeDriver({ transcript: userLine('zapytaj mnie'), deps: { ...fresh } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_MULTIQ_TAB1;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta zakładki 1');

      // Zakładka 2 jest WIELOKROTNA — uczciwy fallback z powodem, bez cyfr.
      fx.client.screenText = DIALOG_MULTIQ_TAB2;
      await waitFor(() => screenDialogs(fx.events).length > 0, 'fallback zakładki 2');
      expect(screenDialogs(fx.events).at(-1)?.reason).toBe('multi-select');

      // Człowiek odpowiedział przy biurku: zakładka 3 znów jest jednokrotna — i znów ma kartę.
      fx.client.screenText = DIALOG_MULTIQ_TAB3;
      await waitFor(() => questions(fx.events).length > 1, 'karta zakładki 3');
      expect(questions(fx.events).at(-1)?.questions[0]?.question)
        .toContain('Jaki kolor przycisku?');

      // Ekran przeglądu to zwykła para z cyframi — też dostaje kartę, nie ciszę.
      fx.client.screenText = DIALOG_MULTIQ_REVIEW;
      await waitFor(() => questions(fx.events).length > 2, 'karta ekranu przeglądu');
      expect(questions(fx.events).at(-1)?.questions[0]?.options.map((o) => o.label))
        .toEqual(['Submit answers', 'Cancel']);
    });

    /*
     * Odwrotna strona tej samej zmiany: karta bez opcji nad NIEZMIENIONYM ekranem ma być
     * zdarzeniem zerowym. Bez hamulca po treści każdy obrót zegara audytowałby odmowę,
     * wsypywał wycinek do transkryptu i gasił kartę, żeby postawić identyczną.
     */
    it('stojąca zakładka multiSelect NIE mruga fallbackiem przy każdym obrocie zegara', async () => {
      const clock = drivenClock();
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie'), deps: { ...fresh, scheduler: clock.scheduler },
      });
      await attached(fx);

      fx.client.screenText = DIALOG_MULTIQ_TAB2;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await clock.advance(40);
      expect(screenDialogs(fx.events).length).toBeGreaterThan(0);

      const eventsBefore = fx.events.length;
      const refusalsBefore = fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).length;
      const readsBefore = reads(fx.client);
      await clock.advance(100);

      expect(reads(fx.client)).toBeGreaterThan(readsBefore);
      expect(fx.events).toHaveLength(eventsBefore);
      expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'))).toHaveLength(refusalsBefore);
    });

    it('zegar gaśnie razem z blokadą — bezczynny panel nie jest odpytywany', async () => {
      const clock = drivenClock();
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie'), deps: { ...fresh, scheduler: clock.scheduler },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_QUESTION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await clock.advance(40);
      expect(questions(fx.events).length).toBeGreaterThan(0);
      fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 9, title: '' });
      await clock.advance(20);

      const readsAfterIdle = reads(fx.client);
      await clock.advance(100);
      expect(reads(fx.client)).toBe(readsAfterIdle);
    });
  });

  /*
   * Manager rozstrzyga pending FIRST-WINS, czyli usuwa wpis, ZANIM zawoła driver — więc bez
   * odbudowy każda odmowa po stronie drivera zdejmowałaby kartę z telefonu NA ZAWSZE, choć dialog
   * stoi dalej w terminalu.
   */
  describe('odmowa wysyłki cyfry odbudowuje kartę', () => {
    it('wielokrotny wybór: zdanie ORAZ świeża karta', async () => {
      const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      fx.client.screenText = DIALOG_QUESTION;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
      const card = questions(fx.events)[0];

      fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis atomowy (tmp + rename)', 'Zapis w miejscu']]);
      await waitFor(
        () => systemTexts(fx.events).some((t) => t.includes('Make multiple selections in the terminal')),
        'zdanie o wielokrotnym wyborze',
      );
      await waitFor(() => questions(fx.events).length > 1, 'odbudowana karta');
      expect(questions(fx.events).at(-1)?.reqId).toBe(card?.reqId);
      expect(fx.client.mutations).toBe(0);
    });

    it('zgoda bez jednoznacznej opcji „tak": zdanie ORAZ świeża karta', async () => {
      const fx = await makeDriver({ transcript: userLine('zrób coś') });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

      // Dwie opcje „Yes…", żadna nie jest czystą zgodą jednorazową — `affirmativeOption` odmawia.
      fx.client.screenText = DIALOG_PERMISSION
        .replace('1. Yes  ', '1. Yes, proceed once  ')
        .replace("2. Yes, and don't ask again for pnpm commands in /Users/u/Projects/demo",
          '2. Yes, but remember my choice                                            ');
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
      const card = permissions(fx.events)[0];

      fx.driver.respondPermission(card?.reqId ?? '', 'allow');
      await waitFor(
        () => systemTexts(fx.events).some((t) => t.includes("Couldn't tell which dialog option")),
        'zdanie o braku cyfry',
      );
      await waitFor(() => permissions(fx.events).length > 1, 'odbudowana karta zgody');
      expect(fx.client.mutations).toBe(0);
    });
  });

  it('CLI przetasowało numerację → decyzja nie idzie, choć etykieta wciąż jest na ekranie', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta');
    const card = questions(fx.events)[0];

    // Te same etykiety, PRZETASOWANA numeracja — dokładnie ten kształt, przed którym broni cross-check.
    // Cyfra „1" z karty znaczy teraz coś innego, więc nie ma prawa wyjść: Rarog NIE zgaduje,
    // że „to pewnie ten sam dialog, tylko inaczej ponumerowany".
    fx.client.screenText = DIALOG_QUESTION
      .replace('1. Zapis atomowy (tmp + rename)', '1. TYMCZASOWO')
      .replace('2. Zapis w miejscu', '2. Zapis atomowy (tmp + rename)')
      .replace('1. TYMCZASOWO', '1. Zapis w miejscu');

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('The pane now shows a different dialog')),
      'zdanie o rozjeździe ekranu',
    );
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('niewinne przemalowanie (przesunięty marker wyboru) NIE blokuje decyzji', async () => {
    /*
     * Druga strona tej samej bramki: sprawdzenie ma odciąć ZMIANĘ ZNACZENIA cyfry, a nie każdy
     * ruch pikseli. TUI przemalowuje panel przy byle nawigacji strzałkami — gdyby świeży odczyt
     * blokował decyzję za samo przesunięcie „❯", karty z telefonu przestałyby działać.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta');
    const card = questions(fx.events)[0];

    fx.client.screenText = DIALOG_QUESTION
      .replace('❯ 1. Zapis atomowy (tmp + rename)', '  1. Zapis atomowy (tmp + rename)')
      .replace('  2. Zapis w miejscu', '❯ 2. Zapis w miejscu');

    fx.driver.answerQuestion(card?.reqId ?? '', [['Zapis w miejscu']]);
    await waitFor(() => fx.client.mutations > 0, 'cyfra ze świeżego ekranu');
    await quiet();
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['2']]);
    expect(fx.audit.at(-1)).toMatchObject({ keys: ['2'], optionLabel: 'Zapis w miejscu' });
  });

  it('dialog zaufania zastąpiony innym → ZERO klawiszy i brak meldunku o zaufaniu', async () => {
    let marks = 0;
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked' },
      screen: TRUST_DIALOG,
      deps: { markTrustDialog: () => { marks += 1; } },
    });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta zaufania');
    const atCard = marks;

    // Panel podmienia dialog W MIEJSCU: „Yes" stoi teraz pod DRUGĄ cyfrą, a jedynka to „No".
    fx.client.screenText = `${'▔'.repeat(63)}\n Switch model?\n\n ❯ 1. No, go back\n   2. Yes, switch to Opus 5\n`;

    fx.driver.respondPermission('sess-1', 'allow');
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('The pane now shows a different dialog')),
      'zdanie o rozjeździe ekranu',
    );
    await quiet();
    expect(fx.client.mutations).toBe(0);
    // Karencja re-eksekucji `claude` NIE rusza: żadna decyzja nie wyszła do panelu.
    expect(marks).toBe(atCard);
  });

  describe('dialog zaufania bez cyfr: sekwencja klawiszy na `zaufanie-2.1.319.txt`', () => {
    const TRUST_319 = readFileSync(join(FIXTURES, 'kontrolny', 'zaufanie-2.1.319.txt'), 'utf8');
    const TRUST_319_DOWN = readFileSync(join(FIXTURES, 'kontrolny', 'zaufanie-po-down-2.1.319.txt'), 'utf8');
    const TRUST_CWD = '/Users/u/projekt';
    const OTHER = (text: string): string => text.replace(TRUST_CWD, '/Users/u/inny');

    interface TrustFx { fx: Fixture; marks: () => number }
    async function trustFx(opts: { cwd?: string; screen?: string; deps?: Partial<HerdrDriverDeps> } = {}):
      Promise<TrustFx> {
      let marks = 0;
      const fx = await makeDriver({
        noTranscript: true,
        agent: { status: 'blocked', cwd: opts.cwd ?? TRUST_CWD },
        screen: opts.screen ?? TRUST_319,
        deps: { formSubmitConfirmDelayMs: 0, markTrustDialog: () => { marks += 1; }, ...opts.deps },
      });
      await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu');
      return { fx, marks: () => marks };
    }
    /** `down` przenosi `❯` jak w pomiarze na CLI 2.1.319: ekran po klawiszu to `zaufanie-po-down-2.1.319.txt`. */
    function liveDown(fx: Fixture, after: string = TRUST_319_DOWN, fail: { down?: boolean; enter?: boolean } = {}): void {
      fx.client.sendTrustStep = (paneId, key) => {
        fx.client.calls.push({ method: 'trust_step', paneId, keys: [key] });
        if (fail[key as 'down' | 'enter'] === true) return Promise.reject(new Error('gniazdo odmówiło'));
        if (key === 'down') fx.client.screenText = after;
        return Promise.resolve();
      };
    }
    const trustKeys = (fx: Fixture): (string | undefined)[] => fx.client.calls
      .filter((call) => call.method === 'trust_step').map((call) => call.keys?.[0]);
    const noOtherKeys = (fx: Fixture): void => {
      // Nigdy `escape` ani cyfra: żaden inny klawisz poza ścieżką zaufania.
      expect(fx.client.calls.filter((call) => call.method === 'send_keys' || call.method === 'form_submit'))
        .toEqual([]);
    };

    it('karta: `knownDialog: trust`, bez opcji z cyframi', async () => {
      const { fx } = await trustFx();
      expect(screenDialogs(fx.events).at(-1)).toMatchObject({ type: 'screen-dialog', knownDialog: 'trust' });
      expect(fx.client.mutations).toBe(0);
    });

    it('świeży odczyt z `❯` na „No” → `down` → drugi odczyt z `❯` na „Yes” → `enter`', async () => {
      const { fx, marks } = await trustFx();
      liveDown(fx);
      const before = marks();
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome.kind).toBe('applied');
      expect(trustKeys(fx)).toEqual(['down', 'enter']);
      noOtherKeys(fx);
      expect(marks()).toBeGreaterThan(before);
      const sent = fx.audit.filter((entry) => entry.toolName === 'dialog:trust' && entry.keys !== undefined);
      expect(sent.map((entry) => [entry.method, entry.keys])).toEqual([['send_keys', ['down']], ['approve', ['enter']]]);
      expect(sent.at(-1)).toMatchObject({ optionLabel: 'Yes, I trust this folder' });
    });

    it('podmiana folderu przed `down` przy identycznych etykietach → brak klawisza', async () => {
      const { fx } = await trustFx();
      liveDown(fx);
      fx.client.screenText = OTHER(TRUST_319);
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
      expect(trustKeys(fx)).toEqual([]);
      expect(fx.client.mutations).toBe(0);
    });

    it('podmiana folderu po `down` → bez `enter`', async () => {
      const { fx } = await trustFx();
      liveDown(fx, OTHER(TRUST_319_DOWN));
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
      expect(trustKeys(fx)).toEqual(['down']);
      noOtherKeys(fx);
    });

    it('ponowne tapnięcie po samym `down` → sam `enter`, bez drugiego `down`', async () => {
      const { fx } = await trustFx();
      liveDown(fx, TRUST_319_DOWN, { enter: true });
      const first = await fx.driver.respondPermission('sess-1', 'allow');
      expect(first).toMatchObject({ kind: 'refused', reason: 'send-failed' });
      expect(trustKeys(fx)).toEqual(['down', 'enter']);
      liveDown(fx);
      const second = await fx.driver.respondPermission('sess-1', 'allow');
      expect(second.kind).toBe('applied');
      expect(trustKeys(fx)).toEqual(['down', 'enter', 'enter']);
      noOtherKeys(fx);
    });

    it('błąd wysyłki `down` → bez ponowienia i bez `enter`', async () => {
      const { fx } = await trustFx();
      liveDown(fx, TRUST_319_DOWN, { down: true });
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'send-failed' });
      await quiet();
      expect(trustKeys(fx)).toEqual(['down']);
      noOtherKeys(fx);
    });

    it('dialog zniknął (odpowiedź przy biurku) → nic nie idzie', async () => {
      const { fx } = await trustFx();
      liveDown(fx);
      fx.client.screenText = '❯ \n';
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome.kind).not.toBe('applied');
      await quiet();
      expect(fx.client.mutations).toBe(0);
    });

    it('trzy opcje → karta bez przycisku i zero klawiszy', async () => {
      const three = TRUST_319.replace('   Yes, I trust this folder\n', '   Yes, I trust this folder\n   Maybe later\n');
      const { fx } = await trustFx({ screen: three });
      expect(screenDialogs(fx.events).at(-1)?.knownDialog).toBeUndefined();
      await fx.driver.respondPermission('sess-1', 'allow');
      await quiet();
      expect(fx.client.mutations).toBe(0);
    });

    it('ucięty render (bez kreski i tytułu) → karta bez przycisku i zero klawiszy', async () => {
      const cut = TRUST_319.slice(TRUST_319.indexOf(' /Users/u/projekt'));
      const { fx } = await trustFx({ screen: cut });
      expect(screenDialogs(fx.events).at(-1)?.knownDialog).toBeUndefined();
      await fx.driver.respondPermission('sess-1', 'allow');
      await quiet();
      expect(fx.client.mutations).toBe(0);
    });

    it('folder z dialogu inny niż `cwd` sesji → brak klawisza', async () => {
      const { fx } = await trustFx({ cwd: '/Users/u/inny' });
      liveDown(fx);
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
      expect(fx.client.mutations).toBe(0);
    });

    it('folder pod katalogiem domowym z `~` → rozwinięty katalogiem domowym, pełna sekwencja', async () => {
      const tilde = (text: string): string => text.replace(TRUST_CWD, '~/projekt');
      const { fx } = await trustFx({ screen: tilde(TRUST_319), deps: { homeDir: '/Users/u' } });
      liveDown(fx, tilde(TRUST_319_DOWN));
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      expect(outcome.kind).toBe('applied');
      expect(trustKeys(fx)).toEqual(['down', 'enter']);
    });

    /*
     * Zmiana stanu w oknie między świeżym odczytem a klawiszem. Zdarzenie panelu wchodzi tylko na `await`, więc
     * zmianę dostarcza mikrozadanie na głębokości `depth`, liczonej od wywołania `readScreen` przed danym klawiszem.
     * Pętla głębokości przechodzi przez całe okno (odczyt ekranu, kontrola w odczycie, wznowienie ścieżki) i dalej,
     * za klawisz. Kontrakt: klawisz nigdy nie idzie PO zmianie, a zmiana przed klawiszem to odmowa `screen-changed`.
     */
    type TrustChange = (fx: Fixture) => void;
    const CHANGES: readonly (readonly [string, TrustChange])[] = [
      ['sesja silnika (`session-changed`)', (fx) => {
        fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
      }],
      // Druga decyzja na tej karcie (`allow-always` nie ma tu opcji) gasi kartę synchronicznie.
      ['karta (zgaszona przez inną decyzję)', (fx) => { void fx.driver.respondPermission('sess-1', 'allow-always'); }],
      ['numer blokady (wyjście z blokady i nowa blokada)', (fx) => {
        fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'refaktor' });
        fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 9, title: 'refaktor' });
      }],
    ];

    async function trustRace(change: TrustChange, before: 'down' | 'enter', depth: number):
      Promise<{ order: string[]; outcome: DecisionOutcome; marked: number }> {
      const { fx, marks } = await trustFx();
      const atCard = marks();
      const order: string[] = [];
      let armed = before === 'down';
      fx.client.sendTrustStep = (paneId, key) => {
        fx.client.calls.push({ method: 'trust_step', paneId, keys: [key] });
        order.push(key);
        if (key === 'down') {
          fx.client.screenText = TRUST_319_DOWN;
          armed = before === 'enter';
        }
        return Promise.resolve();
      };
      const read = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = (...args) => {
        if (armed) {
          armed = false;
          let left = depth;
          const tick = (): void => {
            if (left > 0) {
              left -= 1;
              queueMicrotask(tick);
              return;
            }
            order.push('change');
            change(fx);
          };
          tick();
        }
        return read(...args);
      };
      const outcome = await fx.driver.respondPermission('sess-1', 'allow');
      return { order, outcome, marked: marks() - atCard };
    }

    for (const [label, change] of CHANGES) {
      for (const before of ['down', 'enter'] as const) {
        it(`zmiana w oknie odczyt → \`${before}\`: ${label} → odmowa bez klawisza po zmianie`, async () => {
          let refusals = 0;
          for (let depth = 0; depth <= 6; depth += 1) {
            const { order, outcome, marked } = await trustRace(change, before, depth);
            const at = order.indexOf('change');
            const trace = `głębokość ${depth}: ${order.join(' → ')}`;
            expect(at, trace).toBeGreaterThanOrEqual(0);
            expect(order.slice(at + 1), trace).toEqual([]);
            if (!order.slice(0, at).includes(before)) {
              expect(outcome, trace).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
              // Meldunek o dialogu zaufania idzie dopiero po kontroli, tuż przed `enter`: odmowa go nie daje.
              expect(marked, trace).toBe(0);
              refusals += 1;
            }
          }
          // Pętla trafia także za klawisz (zmiana po nim nie cofa decyzji), więc nie każda głębokość to odmowa.
          expect(refusals).toBeGreaterThan(0);
          expect(refusals).toBeLessThan(7);
        });
      }
    }
  });

  it('ekran nie do odczytania w chwili decyzji jest fail-closed, nie domysłem', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await blockOn(fx, { id: 't-9', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    // Panel przemalowuje się w sekundzie decyzji — z takiego ekranu nie da się potwierdzić NIC.
    fx.client.screenText = 'panel przemalowuje się właśnie teraz';
    fx.driver.respondPermission('t-9', 'allow');
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('The pane now shows a different dialog')),
      'zdanie o rozjeździe ekranu',
    );
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('`deny` działa zawsze — także dla karty bez cyfr', async () => {
    const fx = await makeDriver({ transcript: userLine('cokolwiek') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = 'jakiś nierozpoznany dialog';
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta');

    // `escape` nie potrzebuje ani cyfr, ani zgodnego `reqId`: anuluje, nigdy nie zatwierdza.
    fx.driver.respondPermission('sess-1', 'deny');
    await waitFor(() => fx.client.mutations > 0, 'escape');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['escape']]);
  });
});

// ---------------------------------------------------------------------------
// Hold na dobrej karcie nie może wylądować w karcie-fallbacku
// ---------------------------------------------------------------------------

describe('świeżość karty przy decyzji', () => {
  /** Ekranowa karta zgody (screen:p:…) zbudowana bez wpisu w jsonl. */
  async function screenCard(fx: Fixture): Promise<string> {
    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'ekranowa karta zgody');
    return permissions(fx.events)[0]?.reqId ?? '';
  }

  it('`allow` z nieświeżym reqId na karcie EKRANOWEJ nie wysyła nic i mówi o tym głośno', async () => {
    /*
     * Stary gate przepuszczał KAŻDY `reqId` na dowolną kartę `screen: true` — hold rozpoczęty
     * na pełnoprawnej karcie zgody lądował w karcie, która zdążyła ją zastąpić, i kończył się
     * „Nie wiem, która opcja" (albo cyfrą w cudzy dialog, gdyby etykiety się pokryły).
     */
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await screenCard(fx);

    fx.driver.respondPermission('screen:p:po-starej-karcie', 'allow');
    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes('the dialog in the terminal changed in the meantime')),
      'głośny komunikat o nieświeżej karcie',
    );
    expect(fx.client.mutations).toBe(0);
  });

  it('mignięcie `blocked→working→blocked` nad nieczytelnym ekranem NIE degraduje karty', async () => {
    /*
     * Resize/przemalowanie panelu przy biurku potrafi mignąć statusem i oddać ekran w trakcie
     * rysowania. Stara ścieżka gasiła wtedy stojącą kartę zgody i stawiała fallback bez
     * przycisków — a decyzja użytkownika trafiała w pustkę. Karta ma przetrwać: jej cyfrę
     * i tak weryfikuje `#digitStillHolds` na żywym ekranie tuż przed wysyłką.
     */
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const reqId = await screenCard(fx);

    // Mignięcie: panel „pracuje" ułamek sekundy, wraca do `blocked`, ekran w pół przemalowania.
    fx.client.screenText = '   ';
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(cleared(fx.events)).toEqual([]);
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(permissions(fx.events)).toHaveLength(1);

    // Ekran wraca — decyzja na tej samej karcie działa jak gdyby nigdy nic.
    fx.client.screenText = DIALOG_PERMISSION;
    fx.driver.respondPermission(reqId, 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
  });

  it('karta z JSONL przeżywa mrugnięcie `pending: null` nad nieczytelnym ekranem', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-27', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    // Mignięcie + ekran w przemalowaniu: ocena bez pendingu nie ma prawa zgasić karty.
    fx.client.screenText = '   ';
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(screenDialogs(fx.events)).toEqual([]);
    expect(permissions(fx.events)).toHaveLength(1);

    fx.client.screenText = DIALOG_PERMISSION;
    fx.driver.respondPermission('t-27', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['1']]);
  });
});

// ---------------------------------------------------------------------------
// Metadane z transkryptu
// ---------------------------------------------------------------------------

describe('metadane z jsonl', () => {
  it('zużycie okna leci dalej RAZEM ze stanem „limit nieznany"', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      sessionId: SESSION,
      message: {
        role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1_000, output_tokens: 200 },
      },
    })}\n`);
    await waitFor(() => fx.events.some((e) => e.type === 'usage'), 'zużycie');

    const usage = fx.events.find((e): e is Extract<DriverEvent, { type: 'usage' }> =>
      e.type === 'usage');
    // `claude-fable-5` z wpisu potwierdza okno 1M (`KNOWN_CONTEXT_LIMITS`).
    expect(usage?.context).toEqual({
      kind: 'known', tokens: 1_200, limit: 1_000_000, source: 'model',
    });
  });

  /**
   * Zadania w tle idą przez drivera PRZELOTEM — kształt jest już protokołowy, więc nie ma tu
   * czego tłumaczyć i nie ma gdzie pomylić. Test pilnuje właśnie tego: co follower policzył,
   * to manager dostaje, bajt w bajt (`docs/background-tasks.md`).
   */
  it('zadania w tle przechodzą 1:1 jako `background-tasks`', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const lists = (): Extract<DriverEvent, { type: 'background-tasks' }>[] => fx.events
      .filter((e): e is Extract<DriverEvent, { type: 'background-tasks' }> => e.type === 'background-tasks');
    // Pierwsza lista po podpięciu idzie zawsze, także pusta: nadpisuje listę poprzedniego drivera.
    await waitFor(() => lists().length === 1, 'pierwsza lista');

    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'user',
      isSidechain: false,
      sessionId: SESSION,
      timestamp: '2026-08-25T14:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
      toolUseResult: { stdout: '', interrupted: false, backgroundTaskId: 'b28xs0cd6' },
    })}\n`);
    await waitFor(() => lists().length === 2, 'zadania');

    expect(lists().map((e) => e.tasks)).toEqual([
      [],
      [{ id: 'b28xs0cd6', kind: 'command', startedAt: '2026-08-25T14:00:00.000Z' }],
    ]);
  });

  /**
   * Wiadomość od subagenta stoi w pliku jako wpis `user` z `isMeta: true`, więc do transkryptu nie
   * trafia. Manager musi mimo to wiedzieć, że turę wywołało coś więcej niż meldunek o postoju
   * — driver przepisuje `turn-input` followera 1:1, bez wiadomości obok.
   */
  it('ukryte wejście tury (wiadomość subagenta) przechodzi 1:1 jako `turn-input`, bez wiadomości', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const before = fx.events.filter((e) => e.type === 'message').length;

    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'user',
      isSidechain: false,
      isMeta: true,
      sessionId: SESSION,
      timestamp: '2026-10-09T21:53:52.149Z',
      origin: { kind: 'peer', from: 'a7c3bc19e5d808853', senderTaskId: 'a7c3bc19e5d808853', handback: true },
      turnOrigin: 'peer',
      promptSource: 'system',
      message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message>raport</agent-message>' },
    })}\n`);
    await waitFor(() => fx.events.some((e) => e.type === 'turn-input'), 'wejście tury');

    expect(fx.events.filter((e) => e.type === 'turn-input')).toEqual([{ type: 'turn-input' }]);
    expect(fx.events.filter((e) => e.type === 'message')).toHaveLength(before);
  });

  /**
   * Follower wysyła `tasks` także wtedy, gdy lista się nie zmieniła: koniec zadania, którego
   * startu w pliku głównym nie było (własna komenda subagenta). Manager po każdej liście rozsyła
   * `session-changed`, więc ta sama lista drugi raz byłaby pustą ramką do każdego klienta.
   */
  it('koniec bez startu nie wysyła tej samej listy drugi raz', async () => {
    const done = (id: string): string => `${JSON.stringify({
      type: 'queue-operation', operation: 'enqueue', sessionId: SESSION,
      content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n`
        + '<summary>Background command "sleep" completed (exit code 0)</summary>\n</task-notification>',
    })}\n`;
    const followed: FollowEvent[] = [];
    const endedSeen = (id: string): boolean =>
      followed.some((e) => e.type === 'tasks' && e.ended?.includes(id) === true);
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: {
        follow: (o) => tappedFollower(createJsonlFollower({ ...o, root, watch: false, timing: TIMING }), followed),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const lists = (): Extract<DriverEvent, { type: 'background-tasks' }>[] => fx.events
      .filter((e): e is Extract<DriverEvent, { type: 'background-tasks' }> => e.type === 'background-tasks');
    // Pierwsza lista po podpięciu (pusta) idzie zawsze; od niej liczymy.
    await waitFor(() => lists().length === 1, 'pierwsza lista');

    // Koniec bez startu przy pustej liście: follower go ogłasza, w górę nie idzie nic.
    await appendFile(fx.transcript, done('bwlasna0'));
    await waitFor(() => endedSeen('bwlasna0'), 'follower ogłosił koniec przy pustej liście');
    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'user', isSidechain: false, sessionId: SESSION, timestamp: '2026-08-25T14:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
      toolUseResult: { backgroundTaskId: 'b28xs0cd6' },
    })}\n`);
    await waitFor(() => lists().some((e) => e.tasks.length === 1), 'start');

    // Koniec bez startu przy niepustej liście, w OSOBNYM zdarzeniu followera, potem prawdziwy
    // koniec. Ten drugi dowodzi, że driver pierwsze już przerobił: zdarzenia idą po kolei.
    await appendFile(fx.transcript, done('bwlasna1'));
    await waitFor(() => endedSeen('bwlasna1'), 'follower ogłosił koniec przy niepustej liście');
    await appendFile(fx.transcript, done('b28xs0cd6'));
    const followedLists = (): number => followed.filter((e) => e.type === 'tasks').length;
    await waitFor(() => followedLists() === 5 && lists().at(-1)?.tasks.length === 0 && lists().length > 2, 'koniec');
    expect(lists().map((e) => e.tasks.map((task) => task.id))).toEqual([[], ['b28xs0cd6'], []]);
  });

  /**
   * Rozkład workflow: driver dokleja `run` do zadania po `runId`, z czytnika, którego
   * odczyt jest NIEZALEŻNY od tury — workflow żyje po tym, jak agent skończył wypowiedź.
   * Zmiana rozkładu = nowa lista w górę; ten sam rozkład = cisza (manager nie ma czego rysować).
   */
  it('workflow z `runId` dostaje rozkład z czytnika, a zmiana rozkładu idzie jako nowa lista', async () => {
    let calls = 0;
    let launchedAt: string | undefined;
    let run: WorkflowRun = { phases: ['Faza A'], agents: [{ id: 'a1', done: false }] };
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: {
        tasksPollMs: 5,
        workflowRuns: () => ({
          read: async (_runId, at) => { calls += 1; launchedAt = at; return run; },
          repoint: () => undefined,
          relocated: () => undefined,
          close: () => undefined,
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'user',
      isSidechain: false,
      sessionId: SESSION,
      timestamp: '2026-08-28T06:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
      toolUseResult: {
        status: 'async_launched', taskId: 'wl4g4ha1y', taskType: 'local_workflow',
        workflowName: 'audyt-wdrozenie', runId: 'wf_d6b24986-923',
      },
    })}\n`);
    const lists = (): Extract<DriverEvent, { type: 'background-tasks' }>[] => fx.events
      .filter((e): e is Extract<DriverEvent, { type: 'background-tasks' }> => e.type === 'background-tasks');
    await waitFor(() => lists().some((e) => e.tasks[0]?.run !== undefined), 'rozkład');
    expect(lists().at(-1)?.tasks[0]).toMatchObject({
      id: 'wl4g4ha1y', kind: 'workflow', runId: 'wf_d6b24986-923', run,
    });
    // Chwila uruchomienia = `timestamp` wpisu z wynikiem `Workflow`; po niej czytnik odsiewa
    // przerwanych agentów wznowionego przebiegu (`withoutInterrupted`).
    expect(launchedAt).toBe('2026-08-28T06:00:00.000Z');

    /*
     * Ten sam rozkład przy kolejnym odczycie nie produkuje kolejnej listy. Czekamy na DWA
     * kolejne ODCZYTY czytnika, nie na stałą ciszę: `quiet()` (15 ms) przy `tasksPollMs`
     * 20 ms kończy się, zanim czytnik odezwie się choć raz, więc „cisza" nie dowodzi
     * niczego. Pierwszy odczyt dowodzi, że czytnik zapytał, drugi —
     * że skutek pierwszego jest już przetworzony.
     */
    const before = lists().length;
    const readsBefore = calls;
    await waitFor(() => calls > readsBefore + 1, 'dwa kolejne odczyty rozkładu');
    expect(lists().length).toBe(before);

    run = { phases: ['Faza A'], agents: [{ id: 'a1', done: true, label: 'impl:A1' }] };
    await waitFor(() => lists().at(-1)?.tasks[0]?.run?.agents[0]?.done === true, 'zmiana');
  });

  it('model i effort z pliku jadą jako `init`, tryb NIE (bramka wysyłki)', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      sessionId: SESSION,
      effort: 'high',
      permissionMode: 'bypassPermissions',
      message: {
        role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'ok' }],
      },
    })}\n`);
    await waitFor(() => fx.events.some((e) => e.type === 'init'), 'init');

    const init = fx.events.find((e): e is Extract<DriverEvent, { type: 'init' }> =>
      e.type === 'init');
    expect(init).toEqual({
      type: 'init', engineSessionId: SESSION, model: 'claude-fable-5', effort: 'high',
    });
    // Tryb z jsonl powstaje PO turze i nie ma prawa dotknąć `session.herdrMode`, bo to on jest
    // argumentem `assertSendable` — panel przełączony `shift+tab` wyglądałby na `manual`.
    expect(states(fx.events).every((s) => s.mode === 'auto')).toBe(true);
  });

  it('brak transkryptu po karencji daje wiadomość systemową, nie zmianę stanu', async () => {
    // Panel ma sesję silnika, której pliku NIE MA nigdzie w magazynie — dokładnie to robi
    // zmienna `CLAUDECODE` w środowisku panelu: agent działa, a transkrypt nie powstaje.
    const fx = await makeDriver({
      agent: { agentSessionId: SESSION_B },
      deps: {
        follow: (o) => createJsonlFollower({
          ...o, root, watch: false, timing: { ...TIMING, graceMs: 1 },
        }),
      },
    });
    // Alarm ma POWÓD dopiero po wysyłce: od niej plik ma prawo istnieć.
    fx.driver.send('zrób coś');

    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes("This session isn't producing a transcript")),
      'alarm o braku transkryptu',
    );
    expect(states(fx.events)).toEqual([]);
  });

  /**
   * Regresja: pusta sesja NIE alarmuje.
   *
   * Panel stoi, nikt nic nie wysłał, pliku nie ma — i to jest stan zdrowy. Strażnik odlicza
   * dopiero od pierwszej wysyłki albo od pierwszej tury (`working`).
   */
  it('pusta sesja bez wysyłki i bez tury NIE dostaje alarmu o transkrypcie', async () => {
    const fx = await makeDriver({
      agent: { agentSessionId: SESSION_B },
      deps: {
        follow: (o) => createJsonlFollower({
          ...o, root, watch: false, timing: { ...TIMING, graceMs: 1 },
        }),
      },
    });

    await quiet();
    await quiet();
    expect(systemTexts(fx.events).join(' ')).not.toContain("This session isn't producing a transcript");
  });

  it('tura rozpoczęta PRZY BIURKU też uzbraja strażnika transkryptu', async () => {
    const fx = await makeDriver({
      agent: { agentSessionId: SESSION_B },
      deps: {
        follow: (o) => createJsonlFollower({
          ...o, root, watch: false, timing: { ...TIMING, graceMs: 1 },
        }),
      },
    });
    // Nikt nie wysyłał z Raroga — panel po prostu ruszył z pracą, więc plik MA prawo istnieć.
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    await waitFor(
      () => systemTexts(fx.events).some((t) => t.includes("This session isn't producing a transcript")),
      'alarm po turze z terminala',
    );
  });
});

// ---------------------------------------------------------------------------
// Strumień życia (S-live): puls katalogu sesji
// ---------------------------------------------------------------------------

/**
 * Zegar sterowany dla LICZNIKA CISZY.
 *
 * `setTimeout` zostaje prawdziwy (debounce decyzji ma działać jak w produkcji) — podmieniamy
 * wyłącznie `now()`, bo to od niego zależy, czy puls ma prawo odezwać się zamiast jsonl.
 */
function fakeClock(): { scheduler: Scheduler; advance: (ms: number) => void } {
  let now = Date.now();
  return {
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => now,
    },
    advance: (ms) => { now += ms; },
  };
}

/**
 * Follower-atrapa z jedną sterowaną odpowiedzią: `hasTranscript()`.
 *
 * Prawdziwy follower rozstrzyga ścieżkę w kilka milisekund — za szybko, żeby test trafił
 * w okno „nie wiem" deterministycznie. Atrapa ZAMRAŻA to okno; reszta kontraktu milczy.
 */
function stubFollower(presence: () => TranscriptPresence): JsonlFollower {
  const queue = new AsyncEventQueue<FollowEvent>();
  return {
    events: queue,
    repoint: () => undefined,
    dropEcho: () => undefined,
    forgetEcho: () => undefined, joinEcho: () => undefined,
    expectTranscript: () => undefined,
    hasTranscript: presence,
    noteProcessStart: () => undefined,
    noteUltracodeRequest: () => undefined,
    close: () => { queue.close(); },
  };
}

/**
 * Prawdziwy follower z podsłuchem: `seen` dostaje każde zdarzenie, ZANIM przerobi je driver.
 *
 * Driver nie pokazuje zdarzeń followera, a część z nich celowo nie daje nic w górę (`tasks`
 * z samym `ended`). Bez podsłuchu test nie odróżniłby „driver zmilczał" od „follower jeszcze
 * nie przeczytał".
 */
function tappedFollower(real: JsonlFollower, seen: FollowEvent[]): JsonlFollower {
  const events = (async function* tap(): AsyncGenerator<FollowEvent> {
    for await (const event of real.events) {
      seen.push(event);
      yield event;
    }
  })();
  return {
    events,
    repoint: (agentSessionId) => { real.repoint(agentSessionId); },
    dropEcho: (text, token, send) => { real.dropEcho(text, token, send); },
    forgetEcho: (token) => { real.forgetEcho(token); }, joinEcho: (token, field) => { real.joinEcho(token, field); },
    expectTranscript: () => { real.expectTranscript(); },
    hasTranscript: () => real.hasTranscript(),
    noteProcessStart: (startedAtMs) => { real.noteProcessStart(startedAtMs); },
    noteUltracodeRequest: (atMs, firstTurn) => { real.noteUltracodeRequest(atMs, firstTurn); },
    close: () => { real.close(); },
  };
}

const activities = (
  events: readonly DriverEvent[],
): Extract<DriverEvent, { type: 'activity' }>[] => events.filter(
  (e): e is Extract<DriverEvent, { type: 'activity' }> => e.type === 'activity',
);

describe('puls katalogu sesji', () => {
  it('watcher chodzi TYLKO w turze — 17 bezczynnych paneli nie ogląda plików', async () => {
    const fx = await makeDriver();
    expect(fx.pulse?.starts).toBe(0);

    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });
    expect(fx.pulse?.running).toBe(true);
    expect(fx.pulse?.starts).toBe(1);

    // `blocked` to nadal tura (`waiting-*`): czekamy na ruch po drugiej stronie.
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 9, title: '' });
    expect(fx.pulse?.running).toBe(true);

    fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 10, title: '' });
    expect(fx.pulse?.running).toBe(false);
    expect(fx.pulse?.stops).toBe(1);

    fx.driver.dispose();
    expect(fx.pulse?.closes).toBe(1);
  });

  it('panel poza zasięgiem nie zakłada pulsu (żadnych plików, jak transkryptu)', async () => {
    const fx = await makeDriver({ agent: { inScope: false } });
    expect(fx.pulse).toBeNull();
  });

  it('rosnące transkrypty agentów dają FAKTY: liczbę agentów i nazwę przebiegu', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    clock.advance(30_000);
    fx.pulse?.beat({ agents: 4, workflowName: 'rarog-fala-1' });

    await waitFor(() => activities(fx.events).length > 0, 'wiersz aktywności');
    // Żadnego gotowego zdania — odmianę liczebnika składa `views/format.ts`.
    expect(activities(fx.events).at(-1)).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Workflow',
      agents: 4, workflow: 'rarog-fala-1', elapsedSeconds: 30, delegation: 'workflow',
    });
  });

  it('subagenci spoza workflow: nazwy przebiegu NIE MA, a nie jest pusta', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    clock.advance(30_000);
    fx.pulse?.beat({ agents: 1 });

    await waitFor(() => activities(fx.events).length > 0, 'wiersz aktywności');
    const last = activities(fx.events).at(-1);
    expect(last).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Agent', agents: 1, elapsedSeconds: 30,
      delegation: 'agents',
    });
    // Pusty string znaczyłby „workflow bez nazwy" i zapaliłby w PWA gałąź przebiegu.
    expect(last && 'workflow' in last).toBe(false);
  });

  /*
   * Nazwa „narzędzia" w pulsie jest TOKENEM PROTOKOŁU, nie etykietą: PWA rozpoznaje po niej
   * wiersz delegacji (`isDelegatingTool`). Przetłumaczona nazwa nie trafiłaby w żadną gałąź
   * i wylądowała na ekranie dosłownie, jako „uruchamia: Subagenci".
   */
  it('nazwa narzędzia w pulsie należy do DELEGATING_TOOLS', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    clock.advance(30_000);
    fx.pulse?.beat({ agents: 2, workflowName: 'x' });
    await waitFor(() => activities(fx.events).length > 0, 'wiersz aktywności');

    for (const name of [WORKFLOW_ACTIVITY_TOOL, SUBAGENTS_ACTIVITY_TOOL]) {
      expect(isDelegatingTool(name)).toBe(true);
    }
  });

  it('dopóki mówi jsonl, puls milczy — nie biją się o ten sam wiersz', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    // Cisza krótsza niż okno throttle'a pulsu: plik dopiero co coś powiedział.
    clock.advance(1_000);
    fx.pulse?.beat({ agents: 3 });
    await quiet();
    expect(activities(fx.events)).toEqual([]);
  });

  it('sam ruch w katalogu po długiej ciszy = „myśli" z licznikiem', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    clock.advance(12_000);
    fx.pulse?.beat({ other: 2 });

    await waitFor(() => activities(fx.events).length > 0, 'wiersz aktywności');
    expect(activities(fx.events).at(-1)).toEqual({
      type: 'activity', kind: 'thinking', elapsedSeconds: 12,
    });
  });

  it('krótka cisza z samym ruchem plików nie mówi nic (uczciwość)', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    clock.advance(5_000);
    fx.pulse?.beat({ other: 1 });
    await quiet();
    expect(activities(fx.events)).toEqual([]);
  });

  it('ten sam wiersz nie leci co 3 s — powtórkę wypuszczamy dopiero po odświeżeniu', async () => {
    const clock = fakeClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });

    clock.advance(30_000);
    fx.pulse?.beat({ agents: 2, workflowName: 'rarog-fala-1' });
    await waitFor(() => activities(fx.events).length > 0, 'pierwszy wiersz');

    clock.advance(3_000);
    fx.pulse?.beat({ agents: 2, workflowName: 'rarog-fala-1' });
    await quiet();
    expect(activities(fx.events)).toHaveLength(1);

    // Zmiana liczby agentów to nowa informacja — ta leci od razu.
    fx.pulse?.beat({ agents: 3, workflowName: 'rarog-fala-1' });
    await waitFor(() => activities(fx.events).length > 1, 'wiersz po zmianie liczby');
  });

  it('`/clear` przestawia puls na katalog NOWEJ sesji silnika', async () => {
    const fx = await makeDriver();
    fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    expect(fx.pulse?.repoints).toEqual([SESSION_B]);
  });

  /**
   * `EnterWorktree`: CLI przenosi transkrypt `rename(2)`-em do slugu worktree, a herdr
   * o niczym nie melduje (`agent_session` bez zmian, `cwd` panelu ten sam). Follower znajduje
   * plik po uuid i czyta dalej — a puls i czytnik workflow muszą pójść za nim, bo ich cache
   * katalogu wskazuje adres, którego już nie ma.
   */
  it('przeniesienie transkryptu do worktree każe pulsowi zapomnieć katalog', async () => {
    const fx = await makeDriver({ transcript: userLine('przed przeprowadzką') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    expect(fx.pulse?.relocations).toBe(0);

    const dst = join(root, projectSlug(join(base, 'projekt', '.claude', 'worktrees', 'w1')));
    await mkdir(dst, { recursive: true });
    const moved = join(dst, `${SESSION}.jsonl`);
    await rename(fx.transcript, moved);
    await appendFile(moved, userLine('po przeprowadzce'));

    await waitFor(() => (fx.pulse?.relocations ?? 0) > 0, 'sygnał relokacji do pulsu');
    // Treść jedzie DALEJ z nowego adresu — relokacja nie jest przerwą w transmisji.
    await waitFor(
      () => fx.events.some((e) => e.type === 'message'
        && e.blocks.some((b) => b.type === 'text' && b.text.text === 'po przeprowadzce')),
      'wiadomość spod nowego adresu',
    );
    await quiet();
    expect(fx.pulse?.relocations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Plik rozmowy subagenta — wybudzenie agenta w postoju
// ---------------------------------------------------------------------------

/** Atrapa czytnika plików subagentów: fakty podaje test, a każde wołanie jest policzone. */
class FakeAgentFiles implements AgentFileReader {
  readonly facts = new Map<string, AgentFileFacts>();
  readonly reads: string[] = [];
  readonly repoints: string[] = [];
  relocations = 0;
  closes = 0;

  read(agentId: string): Promise<AgentFileFacts | null> {
    this.reads.push(agentId);
    return Promise.resolve(this.facts.get(agentId) ?? null);
  }

  repoint(agentSessionId: string): void {
    this.repoints.push(agentSessionId);
  }

  relocated(): void {
    this.relocations += 1;
  }

  close(): void {
    this.closes += 1;
  }
}

describe('plik rozmowy subagenta', () => {
  const AGENT = 'a52b91f105b002e8d';
  /** Dopisek o POSTOJU, znak w znak z `fixtures/herdr/tasks/measured/postoj.jsonl`. */
  const STANDBY_NOTE = 'This agent stopped with background work of its own still running. It may resume on its '
    + 'own when that work completes or reports, and the same task-id notifies again if it does; the result '
    + 'below may be interim.';
  const ENDED_NOTE = 'A task-notification fires each time this agent stops with no live background children of '
    + 'its own. The user can send it another message and resume it, so the same task-id may notify more than once.';

  const agentStart = (at: string): string => `${JSON.stringify({
    type: 'user', isSidechain: false, sessionId: SESSION, timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: '' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT, description: 'Przegląd' },
  })}\n`;

  /** Meldunek o zatrzymaniu agenta w kolejce pliku głównego; `n` rozróżnia meldunki (wynik i `<usage>`). */
  const agentStopped = (note: string, n: number, at: string): string => `${JSON.stringify({
    type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, timestamp: at,
    content: [
      '<task-notification>', `<task-id>${AGENT}</task-id>`, '<status>completed</status>',
      '<summary>Agent "Przegląd" finished</summary>', `<note>${note}</note>`,
      `<result>wynik meldunku ${String(n)}</result>`,
      `<usage><subagent_tokens>${String(1000 + n)}</subagent_tokens><tool_uses>${String(n)}</tool_uses></usage>`,
      '</task-notification>',
    ].join('\n'),
  })}\n`;

  const lists = (fx: Fixture): Extract<DriverEvent, { type: 'background-tasks' }>[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'background-tasks' }> => e.type === 'background-tasks');
  /** Stan agenta w ostatniej liście, która poszła do managera. */
  const shown = (fx: Fixture): string => {
    const all = lists(fx);
    const task = all.at(-1)?.tasks.find((item) => item.id === AGENT);
    if (all.length === 0 || task === undefined) return 'brak';
    return task.waitingSince === undefined ? 'pracuje' : `czeka od ${task.waitingSince}`;
  };

  /**
   * TEST OBOWIĄZKOWY. Plik główny mówi, że agent stanął, ale nie mówi, kiedy sam ruszył: ten
   * moment stoi w pliku subagenta. Driver czyta go w ticku i zestawia z postojem z followera.
   */
  it('czeka → wpis w pliku subagenta → pracuje → nowy postój → czeka → koniec', async () => {
    const files = new FakeAgentFiles();
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { tasksPollMs: 5, agentFiles: () => files },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    await appendFile(fx.transcript, agentStart('2026-10-09T21:39:58.108Z'));
    await waitFor(() => shown(fx) === 'pracuje', 'start agenta');
    await appendFile(fx.transcript, agentStopped(STANDBY_NOTE, 1, '2026-10-09T21:51:18.194Z'));
    await waitFor(() => shown(fx) === 'czeka od 2026-10-09T21:51:18.194Z', 'postój');

    // Plik subagenta sprzed postoju: ostatni wpis jest starszy niż meldunek, agent dalej czeka.
    files.facts.set(AGENT, { lastEntryAt: '2026-10-09T21:51:18.101Z', commands: [] });
    const before = files.reads.length;
    await waitFor(() => files.reads.length > before + 1, 'dwa odczyty pliku');
    expect(shown(fx)).toBe('czeka od 2026-10-09T21:51:18.194Z');

    // Wybudzenie: pierwszy wpis po postoju (najkrótszy zmierzony odstęp to 18 ms).
    files.facts.set(AGENT, { lastEntryAt: '2026-10-09T21:51:18.212Z', commands: [] });
    await waitFor(() => shown(fx) === 'pracuje', 'wybudzenie');
    expect(lists(fx).at(-1)?.tasks).toEqual([
      { id: AGENT, kind: 'agent', description: 'Przegląd', startedAt: '2026-10-09T21:39:58.108Z' },
    ]);

    // Ten sam fakt przy kolejnych tickach nie daje kolejnych list.
    const sent = lists(fx).length;
    const reads = files.reads.length;
    await waitFor(() => files.reads.length > reads + 1, 'dwa kolejne odczyty');
    expect(lists(fx)).toHaveLength(sent);

    // Agent stanął drugi raz: nowy postój jest późniejszy niż wszystko, co dotąd zapisał.
    await appendFile(fx.transcript, agentStopped(STANDBY_NOTE, 2, '2026-10-09T21:52:23.557Z'));
    await waitFor(() => shown(fx) === 'czeka od 2026-10-09T21:52:23.557Z', 'drugi postój');

    await appendFile(fx.transcript, agentStopped(ENDED_NOTE, 3, '2026-10-09T21:59:27.507Z'));
    await waitFor(() => lists(fx).at(-1)?.tasks.length === 0, 'koniec agenta');

    // Zamknięty agent nie jest już czytany: zegar staje razem z listą.
    const after = files.reads.length;
    await quiet();
    await quiet();
    expect(files.reads.length).toBe(after);
    expect(new Set(files.reads)).toEqual(new Set([AGENT]));
  });

  /**
   * ODTWORZENIE NA DANYCH ZMIERZONYCH (CLI 2.1.296). `fixtures/herdr/tasks/measured/postoj.jsonl`
   * niesie linie obu plików jednej sesji: subagent puszcza własną komendę w tle i staje, komenda
   * się kończy, CLI go budzi, agent kończy naprawdę. Test dopisuje te linie do PRAWDZIWYCH plików
   * w kolejności czasu, a driver czyta je prawdziwym followerem i prawdziwym czytnikiem.
   */
  it('zmierzony postój: jedna własna komenda otwarta w postoju, zero po jej końcu', async () => {
    const SUB = 'a1000000000000000';
    const COMMAND = { id: 'b00000001', command: 'sleep 40', startedAt: '2026-01-01T00:00:06.000Z' };
    const measured = readFileSync(
      join(import.meta.dirname, 'fixtures/herdr/tasks/measured/postoj.jsonl'), 'utf8',
    ).split('\n').filter((line) => line !== '').map((line) => {
      const entry = JSON.parse(line) as { _plik: string; timestamp: string };
      return { line, file: entry._plik, at: entry.timestamp };
    }).sort((a, b) => a.at.localeCompare(b.at));
    expect(measured.map((item) => item.file).filter((file) => file !== 'glowny')).toEqual(Array(4).fill(`subagent:${SUB}`));

    const fx = await makeDriver({ transcript: '', deps: { tasksPollMs: 5 } });
    // Pierwsza lista po podpięciu (pusta) idzie zawsze; linie pomiaru dopisujemy dopiero po niej.
    await waitFor(() => lists(fx).length === 1, 'pierwsza lista');
    const agentFile = join(dirname(fx.transcript), SESSION, 'subagents', `agent-${SUB}.jsonl`);
    await mkdir(dirname(agentFile), { recursive: true });
    /** Dopisuje wszystkie niedopisane jeszcze linie o czasie nie późniejszym niż `at`. */
    const feedUntil = async (at: string): Promise<void> => {
      while (measured[0] !== undefined && measured[0].at <= at) {
        const item = measured.shift();
        if (item !== undefined) await appendFile(item.file === 'glowny' ? fx.transcript : agentFile, `${item.line}\n`);
      }
    };
    const agent = (): unknown => lists(fx).at(-1)?.tasks.find((task) => task.id === SUB);
    const base = {
      id: SUB, kind: 'agent', description: 'pomiar-postoj', agentType: 'general-purpose',
      startedAt: '2026-01-01T00:00:03.000Z',
    };
    const eventually = async (expected: unknown, label: string): Promise<void> => {
      await waitFor(() => JSON.stringify(agent()) === JSON.stringify(expected), label);
    };

    // Agent wystartował i puścił własną komendę: pracuje, a komendę już widać.
    await feedUntil('2026-01-01T00:00:06.000Z');
    await eventually({ ...base, ownTasks: [COMMAND] }, 'pracuje z własną komendą');

    // Postój: agent czeka i wiadomo, na co.
    await feedUntil('2026-01-01T00:00:09.000Z');
    await eventually({ ...base, waitingSince: '2026-01-01T00:00:07.000Z', ownTasks: [COMMAND] }, 'czeka na komendę');

    // Koniec komendy stoi tylko w kolejce pliku GŁÓWNEGO; plik subagenta jeszcze o nim nie wie.
    await feedUntil('2026-01-01T00:00:10.001Z');
    await eventually({ ...base, waitingSince: '2026-01-01T00:00:07.000Z' }, 'czeka, komenda zamknięta');

    // Wybudzenie: pierwszy wpis w pliku subagenta po postoju.
    await feedUntil('2026-01-01T00:00:11.000Z');
    await eventually(base, 'pracuje po wybudzeniu');

    // Koniec agenta: lista pusta.
    await feedUntil('2026-01-01T00:00:14.000Z');
    await waitFor(() => lists(fx).at(-1)?.tasks.length === 0, 'koniec agenta');
    expect(measured).toEqual([]);
    // Żadna lista nie pokazała komendy po jej końcu ani agenta czekającego po wybudzeniu.
    const states = lists(fx).map((e) => {
      const task = e.tasks.find((item) => item.id === SUB);
      if (task === undefined) return 'brak';
      return `${task.waitingSince === undefined ? 'pracuje' : 'czeka'}:${String(task.ownTasks?.length ?? 0)}`;
    });
    expect(states.filter((state, n) => state !== states[n - 1])).toEqual(
      ['brak', 'pracuje:0', 'pracuje:1', 'czeka:1', 'czeka:0', 'pracuje:0', 'brak'],
    );
  });

  /**
   * TEST OBOWIĄZKOWY (pełny przegląd pliku głównego przy podpięciu). Gdyby po restarcie Raroga
   * follower czytał sam ogon pliku, początkiem tego, co wie o pliku głównym (`since`), byłby pierwszy
   * wpis OKNA, a komenda subagenta wystartowana przed nim miałaby „los nieznany” i nie byłaby
   * pokazywana. Po przeglądzie `since` to początek pliku.
   */
  it('komenda subagenta sprzed okna ogona nie ma „losu nieznanego”: `ownTasks` ją niesie', async () => {
    const COMMAND = {
      id: 'b00000001', command: 'until grep -q gotowe log; do sleep 5; done', startedAt: '2026-10-09T21:45:00.000Z',
    };
    const first = `${JSON.stringify({
      type: 'user', isSidechain: false, sessionId: SESSION, timestamp: '2026-10-09T21:30:00.000Z',
      message: { role: 'user', content: 'start' },
    })}\n`;
    // Wypełniacz z czasem PÓŹNIEJSZYM niż start komendy: to on otwiera okno ogona.
    const padding = Array.from({ length: 60 }, (_, n) => `${JSON.stringify({
      type: 'assistant', isSidechain: false, sessionId: SESSION, timestamp: '2026-10-09T21:50:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `wypowiedź ${String(n)} ${'x'.repeat(40)}` }] },
    })}\n`).join('');
    const transcript = first + agentStart('2026-10-09T21:39:58.108Z') + padding
      + agentStopped(STANDBY_NOTE, 1, '2026-10-09T21:51:18.194Z');
    const smallWindow = (scan: { maxBytes?: number }) => (o: Parameters<typeof createJsonlFollower>[0]) =>
      createJsonlFollower({
        ...o, root, watch: false, timing: TIMING,
        historyBytes: 2_048, historyMaxBytes: 2_048, historyMessages: 5, tasksScan: scan, logger: () => undefined,
      });
    const writeAgentFile = async (fx: Fixture): Promise<void> => {
      const agentFile = join(dirname(fx.transcript), SESSION, 'subagents', `agent-${AGENT}.jsonl`);
      await mkdir(dirname(agentFile), { recursive: true });
      await writeFile(agentFile, `${JSON.stringify({
        type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: '2026-10-09T21:44:59.000Z',
        message: { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_cmd', name: 'Bash', input: { command: COMMAND.command, run_in_background: true },
        }] },
      })}\n${JSON.stringify({
        type: 'user', isSidechain: true, agentId: AGENT, timestamp: COMMAND.startedAt,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cmd' }] },
        toolUseResult: { backgroundTaskId: COMMAND.id },
      })}\n`);
    };
    const agent = (fx: Fixture): unknown => lists(fx).at(-1)?.tasks.find((task) => task.id === AGENT);

    const fx = await makeDriver({ transcript, deps: { tasksPollMs: 5, follow: smallWindow({}) } });
    await writeAgentFile(fx);
    await waitFor(() => JSON.stringify(agent(fx) ?? {}).includes('ownTasks'), 'własna komenda pod agentem');
    expect(agent(fx)).toEqual({
      id: AGENT, kind: 'agent', description: 'Przegląd', startedAt: '2026-10-09T21:39:58.108Z',
      waitingSince: '2026-10-09T21:51:18.194Z', ownTasks: [COMMAND],
    });
    fx.driver.dispose();

    // Sufit zero wyłącza przegląd: stan sprzed tej zmiany. Agent wraca z meldunku w oknie jako wpis
    // minimalny, a jego komenda ma los nieznany, choć plik subagenta ją niesie.
    const before = await makeDriver({ transcript, deps: { tasksPollMs: 5, follow: smallWindow({ maxBytes: 0 }) } });
    await writeAgentFile(before);
    await waitFor(() => agent(before) !== undefined, 'agent z okna');
    await quiet();
    await quiet();
    expect(agent(before)).toEqual({
      id: AGENT, kind: 'agent', description: 'Przegląd', waitingSince: '2026-10-09T21:51:18.194Z',
    });
  });

  it('panel poza zasięgiem nie zakłada czytnika plików subagentów', async () => {
    let created = 0;
    await makeDriver({
      agent: { inScope: false },
      deps: { agentFiles: () => { created += 1; return new FakeAgentFiles(); } },
    });
    expect(created).toBe(0);
  });

  /**
   * TEST OBOWIĄZKOWY: wyłącznik `RAROG_AGENT_FILES=0`. Czytnik nie powstaje wcale, więc żaden plik
   * subagenta nie jest otwierany: agent po postoju stoi na „czeka" do wznowienia albo końca i nie
   * ma listy własnych komend, choć jego plik mówi i jedno, i drugie.
   */
  it('wyłącznik: bez odczytu plików subagentów agent czeka do wznowienia i nie ma `ownTasks`', async () => {
    let created = 0;
    const opened: string[] = [];
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: {
        readAgentFiles: false,
        tasksPollMs: 5,
        agentFiles: (o) => {
          created += 1;
          return createAgentFileReader({
            ...o, root, open: (path) => { opened.push(path); return Promise.reject(new Error('nie wolno')); },
          });
        },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    // Plik subagenta istnieje i niesie własną komendę oraz wpis PO postoju.
    const agentFile = join(dirname(fx.transcript), SESSION, 'subagents', `agent-${AGENT}.jsonl`);
    await mkdir(dirname(agentFile), { recursive: true });
    await writeFile(agentFile, `${JSON.stringify({
      type: 'user', isSidechain: true, agentId: AGENT, timestamp: '2026-10-09T21:45:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cmd' }] },
      toolUseResult: { backgroundTaskId: 'b00000001' },
    })}\n${JSON.stringify({
      type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: '2026-10-09T21:51:18.212Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ruszyłem' }] },
    })}\n`);

    await appendFile(fx.transcript, agentStart('2026-10-09T21:39:58.108Z'));
    await waitFor(() => shown(fx) === 'pracuje', 'start agenta');
    await appendFile(fx.transcript, agentStopped(STANDBY_NOTE, 1, '2026-10-09T21:51:18.194Z'));
    await waitFor(() => shown(fx) === 'czeka od 2026-10-09T21:51:18.194Z', 'postój');

    // Kilka okresów zegara: nic się nie zmienia i nikt niczego nie otwiera.
    await quiet();
    await quiet();
    expect(shown(fx)).toBe('czeka od 2026-10-09T21:51:18.194Z');
    expect(lists(fx).at(-1)?.tasks[0]).not.toHaveProperty('ownTasks');
    expect([created, opened]).toEqual([0, []]);

    // Wznowienie z pliku głównego dalej działa: to jedyna droga do „pracuje".
    await appendFile(fx.transcript, `${JSON.stringify({
      type: 'user', isSidechain: false, sessionId: SESSION, timestamp: '2026-10-09T22:05:30.546Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '' }] },
      toolUseResult: { message: 'Resuming agent a52b91f', pin: false, resumedAgentId: AGENT, success: true },
    })}\n`);
    await waitFor(() => shown(fx) === 'pracuje', 'wznowienie');
    expect([created, opened]).toEqual([0, []]);
  });

  it('okablowanie produkcyjne: fabryka drivera w index.ts bierze wyłącznik z konfiguracji', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toContain('readAgentFiles: config.agentFiles,');
  });

  it('`/clear` przestawia czytnik na nową sesję silnika, a `dispose()` go zamyka', async () => {
    const files = new FakeAgentFiles();
    const fx = await makeDriver({ deps: { agentFiles: () => files } });

    fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    expect(files.repoints).toEqual([SESSION_B]);

    fx.driver.dispose();
    expect(files.closes).toBe(1);
  });

  it('przeniesienie transkryptu do worktree każe czytnikowi zapomnieć adres katalogu', async () => {
    const files = new FakeAgentFiles();
    const fx = await makeDriver({ transcript: userLine('przed przeprowadzką'), deps: { agentFiles: () => files } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    const dst = join(root, projectSlug(join(base, 'projekt', '.claude', 'worktrees', 'w1')));
    await mkdir(dst, { recursive: true });
    await rename(fx.transcript, join(dst, `${SESSION}.jsonl`));
    await appendFile(join(dst, `${SESSION}.jsonl`), userLine('po przeprowadzce'));

    await waitFor(() => files.relocations > 0, 'sygnał relokacji do czytnika');
    expect(files.repoints).toEqual([]);
  });
});

/*
 * Start procesu CLI jako fakt dla zadań w tle. Manager czyta rejestr procesów CLI i podaje
 * driverowi chwilę startu jedynego procesu rozmowy; driver przekazuje ją followerowi, a ten
 * maszynie stanów, która zamyka subagentów sprzed restartu. Driver sam nie ma tu stanu: pilnuje
 * tylko, żeby fakt o INNEJ rozmowie nie trafił do followera.
 */
describe('start procesu CLI', () => {
  const AGENT = 'a52b91f105b002e8d';
  const STANDBY_NOTE = 'This agent stopped with background work of its own still running. It may resume on its '
    + 'own when that work completes or reports, and the same task-id notifies again if it does; the result '
    + 'below may be interim.';
  const AFTER_STANDBY = Date.parse('2026-08-22T10:30:00.000Z');
  /** Subagent wystartowany o 10:00:05 i w postoju od 10:11:00, w rozmowie `session`. */
  const standing = (session: string): string => [
    {
      type: 'user', isSidechain: false, sessionId: session, timestamp: '2026-08-22T10:00:05.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: '' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT, description: 'Przegląd' },
    },
    {
      type: 'queue-operation', operation: 'enqueue', sessionId: session, timestamp: '2026-08-22T10:11:00.000Z',
      content: [
        '<task-notification>', `<task-id>${AGENT}</task-id>`, '<status>completed</status>',
        '<summary>Agent "Przegląd" finished</summary>', `<note>${STANDBY_NOTE}</note>`,
        '<result>wynik</result>', '</task-notification>',
      ].join('\n'),
    },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join('');
  const lists = (fx: Fixture): Extract<DriverEvent, { type: 'background-tasks' }>[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'background-tasks' }> => e.type === 'background-tasks');
  /** Driver bez czytnika plików subagentów: liczy się sama lista z pliku głównego. */
  const noFiles = { readAgentFiles: false } as const;

  it('fakt o rozmowie panelu zamyka agenta w postoju sprzed restartu', async () => {
    const fx = await makeDriver({ transcript: userLine('start') + standing(SESSION), deps: noFiles });
    await waitFor(() => lists(fx).length === 1, 'agent w postoju');
    expect(lists(fx)[0]?.tasks.map((task) => task.waitingSince)).toEqual(['2026-08-22T10:11:00.000Z']);

    fx.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: AFTER_STANDBY });
    await waitFor(() => lists(fx).length === 2, 'lista po sygnale');
    expect(lists(fx)[1]?.tasks).toEqual([]);
  });

  it('fakt o innej rozmowie odpada', async () => {
    const fx = await makeDriver({ transcript: userLine('start') + standing(SESSION), deps: noFiles });
    await waitFor(() => lists(fx).length === 1, 'agent w postoju');
    fx.driver.noteCliProcessStart?.({ sessionId: SESSION_B, startedAt: AFTER_STANDBY });
    await quiet();
    expect(lists(fx)).toHaveLength(1);
  });

  /**
   * `/resume` w panelu: odczyt rejestru zrobiony przed przełączeniem niesie jeszcze starą rozmowę.
   * W nowej mógłby zamknąć agentów, których pisze inny proces, więc driver go pomija; fakt
   * oznaczony nową rozmową działa.
   */
  it('po `session-changed` liczy się tylko fakt o NOWEJ rozmowie', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: noFiles });
    await writeFile(join(dirname(fx.transcript), `${SESSION_B}.jsonl`), userLine('start') + standing(SESSION_B));
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    // Pierwsza lista po podpięciu (pusta) idzie zawsze; od niej liczymy.
    await waitFor(() => lists(fx).length === 1, 'pierwsza lista');
    fx.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: AFTER_STANDBY });

    fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    await waitFor(() => lists(fx).length === 2, 'agent z nowej rozmowy');
    // Chwila podana dla starej rozmowy nie przeszła na nową: agent stoi na liście.
    expect(lists(fx)[1]?.tasks.map((task) => task.id)).toEqual([AGENT]);

    fx.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: AFTER_STANDBY });
    await quiet();
    expect(lists(fx)).toHaveLength(2);

    fx.driver.noteCliProcessStart?.({ sessionId: SESSION_B, startedAt: AFTER_STANDBY });
    await waitFor(() => lists(fx).length === 3, 'agent zamknięty w nowej rozmowie');
    expect(lists(fx)[2]?.tasks).toEqual([]);
  });

  /**
   * Ultracode z tego samego faktu: `/exit` i `claude --resume` przy biurku zostawiają rozmowę, a załącznik
   * w pliku mówi o procesie, którego już nie ma. `init` mówi wtedy wprost „nie wiem” (`null`), bo brak pola
   * znaczy dla managera „bez zmiany” i karta zostałaby przy stanie sprzed restartu.
   */
  it('start późniejszy od znacznika ultracode: `init` z `ultracode: null`', async () => {
    const startFlaga = readFileSync(join(FIXTURES, 'ultracode', 'start-flaga.jsonl'), 'utf8');
    const inits = (fx: Fixture): Extract<DriverEvent, { type: 'init' }>[] => fx.events
      .filter((e): e is Extract<DriverEvent, { type: 'init' }> => e.type === 'init');
    const fx = await makeDriver({ transcript: startFlaga, deps: noFiles });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: Date.parse('2026-01-01T00:00:00.000Z') });
    await waitFor(() => inits(fx).some((e) => e.ultracode === true), 'init z ultracode');

    fx.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: Date.parse('2026-01-01T00:01:00.000Z') });
    await waitFor(() => inits(fx).at(-1)?.ultracode === null, 'init po restarcie procesu');
    expect(inits(fx).at(-1)).toEqual({
      type: 'init', engineSessionId: SESSION, model: '', ultracode: null, // no model or effort news in the file
    });
  });

  it('panel poza zasięgiem i driver po `dispose()` przyjmują fakt bez skutku i bez wyjątku', async () => {
    const outside = await makeDriver({ agent: { inScope: false }, transcript: standing(SESSION) });
    outside.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: AFTER_STANDBY });

    const fx = await makeDriver({ transcript: userLine('start') + standing(SESSION), deps: noFiles });
    await waitFor(() => lists(fx).length === 1, 'agent w postoju');
    fx.driver.dispose();
    fx.driver.noteCliProcessStart?.({ sessionId: SESSION, startedAt: AFTER_STANDBY });
    await quiet();
    expect(lists(fx)).toHaveLength(1);
    expect(lists(outside)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Formularz WIELOKROTNEGO wyboru — karta bez wysyłki, fail-closed
// ---------------------------------------------------------------------------

describe('formularz multiSelect z ekranu', () => {
  const DIALOG_MULTI = readFileSync(
    join(FIXTURES, 'dialog-askuserquestion-multi.txt'),
    'utf8',
  );
  /*
   * Wariant JEDNOKROTNY tego samego renderu: bez checkboxów ORAZ bez „✔ Submit" w pasku
   * zakładek. Przycisk „Submit" jest własną sygnaturą wielokrotności, więc
   * „jednokrotny z Submitem" to render, którego nikt nie zmierzył — a fixture'y jednokrotne
   * mają goły `☐ Nazwa`.
   */
  const DIALOG_SINGLE = DIALOG_MULTI
    .replace(/\[[ ✔]\] /g, '')
    .replace('← ☒ Dodatki ✔ Submit →', '← ☐ Dodatki →');

  it('nie dostaje karty pytania — zostaje wycinek i karta „odpowiedz w terminalu"', async () => {
    /*
     * CLI 2.1.246: formularz z checkboxami nie ma stopki `space to …` (nie ma jej też
     * `measured/multiselect-2.1.258.txt`, CLI 2.1.258), więc parser bez sygnatury checkboxów widziałby go jak
     * jednokrotny, a karta obiecywałaby „Tapnięcie wysyła odpowiedź". Jedna cyfra nie odpowiada na nic — zaznaczenie i „Submit" to dwa
     * osobne kroki, a dojście do „Submit" znaczyłoby nawigację po POZYCJI.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie o dodatki') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_MULTI;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');

    expect(questions(fx.events)).toEqual([]);
    expect(permissions(fx.events)).toEqual([]);
    // Wycinek ekranu jedzie NA KARCIE — to jedyna treść, jaką człowiek dostaje na
    // telefonie przy dialogu, którego Rarog nie umie obsłużyć. Transkrypt zostaje czysty.
    expect(screenDialogs(fx.events)[0]?.screen).toContain('Które dodatki do lodów?');
    expect(systemTexts(fx.events).join('\n')).not.toContain('Które dodatki do lodów?');
    // …i wpis do licznika odmów. Powód liczy się z EKRANU, więc formularz wielokrotny jest tu
    // `multi-select`, a nie `no-jsonl`: to dwie różne awarie i tylko rozdzielone mówią, czy
    // multi-select jest realnym problemem, czy ciekawostką.
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toContain('multi-select');
    // Karta bez decyzji przy OCENIE ekranu to `degrade` — nikt jeszcze nie tapnął.
    expect(fx.audit.find((e) => e.reason === 'multi-select')?.method).toBe('degrade');
    expect(fx.audit.filter((e) => e.method === 'refuse')).toEqual([]);
  });

  it('etykieta spoza żywej listy opcji = odmowa `no-digit` w dzienniku', async () => {
    // Ostatni z ośmiu powodów bez pokrycia: zgubiony `reason` w tej
    // gałęzi przechodził na zielono, a `summarizeRefusals` liczyłby wpis jako `unknown`.
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie o dodatki') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_SINGLE;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    fx.driver.answerQuestion(questions(fx.events)[0]?.reqId ?? '', [['Nie ma takiej opcji']]);
    await quiet();

    expect(fx.client.mutations).toBe(0);
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toContain('no-digit');
  });

  it('formularz JEDNOKROTNY z tego samego renderu ma opisy opcji na karcie', async () => {
    /*
     * Opis spod etykiety (`options[].description` z inputu narzędzia) jedzie na karcie ekranowej,
     * bo autor pytania napisał w nim, czym warianty się różnią (UI pokazuje go w `option__desc`).
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie o dodatki') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_SINGLE;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    const card = questions(fx.events)[0]?.questions[0];
    expect(card?.header).toBe('Dodatki');
    expect(card?.question).toBe('Które dodatki do lodów?');
    expect(card?.multiSelect).toBe(false);
    expect(card?.options.slice(0, 3)).toEqual([
      { label: 'Posypka', description: 'Kolorowa', role: 'answer' },
      { label: 'Polewa', description: 'Czekoladowa', role: 'answer' },
      { label: 'Bita śmietana', description: 'Domowa', role: 'answer' },
    ]);
    // Chrome CLI z ekranu dostaje rolę na serwerze — klient nie zna jego brzmienia.
    expect(card?.options.slice(3).map((option) => [option.label, option.role])).toEqual([
      ['Type something', 'custom'],
      ['Chat about this', 'exit'],
    ]);
  });

  it('odpowiedź w NIEISTNIEJĄCĄ kartę nie robi nic (odrzucenie obcego reqId)', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie o dodatki') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_MULTI;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');

    // To NIE jest bramka multi-select, tylko `#reportStaleDecision`: identyfikator nie pasuje
    // do stojącej karty, więc `answerQuestion` wychodzi zanim dojdzie do żywego odczytu.
    fx.driver.answerQuestion('screen:q:cokolwiek', [['Posypka']]);
    await quiet();
    expect(fx.client.mutations).toBe(0);
    expect(systemTexts(fx.events).join('\n')).toContain(STALE_DECISION_MESSAGE.text);
    // Powód jedzie też do dziennika — bez tej asercji zgubiony `reason` przechodziłby
    // na zielono i psuł statystykę odmów.
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toContain('stale-card');
  });

  it('karta JEDNOKROTNA + ekran już WIELOKROTNY = zero klawiszy (weryfikacja przed cyfrą)', async () => {
    /*
     * Realna droga do tego stanu: formularz z kilkoma pytaniami przełącza
     * zakładkę BEZ mignięcia `agent_status` (patrz `#rearmAfterScreenAnswer`), więc karta
     * z zakładki jednokrotnej stoi na telefonie, gdy panel pokazuje już zakładkę wielokrotną.
     * Etykiety kolidują między zakładkami („Type something", „Chat about this" stoją
     * zawsze na końcu z tą samą cyfrą), więc dopasowanie „etykieta → cyfra" w `#digitStillHolds`
     * PRZECHODZI. Zatrzymać cyfrę może wyłącznie warunek `multiSelect` na ŻYWYM ekranie:
     * ścieżka `answerQuestion` → `#sendDigit` nie woła `resolveOptions`, więc rozjazd
     * `multi-select` z parsera ekranu jej nie chroni.
     */
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie o dodatki') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_SINGLE;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    const reqId = questions(fx.events)[0]?.reqId ?? '';
    expect(reqId).not.toBe('');
    const before = fx.client.mutations;

    // Ekran przełącza się na formularz WIELOKROTNY — bez mignięcia statusu, więc karta stoi.
    fx.client.screenText = DIALOG_MULTI;
    fx.driver.answerQuestion(reqId, [['Posypka']]);
    await quiet();

    expect(fx.client.mutations).toBe(before);
    expect(systemTexts(fx.events).join('\n')).toContain(SCREEN_CHANGED_MESSAGE.text);
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toContain('screen-changed');
  });

  it('karta z HOOKA (`multiSelect: false`) + ekran przełączony na INNE, wielokrotne pytanie'
    + ' = zero klawiszy', async () => {
    /*
     * Lustro testu wyżej dla ścieżki hooka. Override `multiSelect: false`
     * z karty jechał do `parseOptions` BEZWARUNKOWO, więc warunek `dialog?.multiSelect !== true`
     * w `#digitStillHolds` — JEDYNA bramka multi-select tej ścieżki — nie mógł już nigdy
     * zadziałać. Scenariusz: formularz z dwoma pytaniami, zrzut pasuje do zakładki 1 (single),
     * człowiek przy biurku odpowiada, zakładka 2 jest WIELOKROTNA i przełącza się bez mignięcia
     * `agent_status`; etykieta kolidująca między zakładkami pasuje razem z cyfrą, więc
     * cyfra wychodziła w formularz, w którym niczego nie zatwierdza — a dziennik
     * zapisywał `approve` z etykietą STAREJ zakładki.
     */
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        readPendingHook: () => ({
          toolName: 'AskUserQuestion',
          toolInput: {
            questions: [{
              question: 'Które dodatki do lodów?',
              header: 'Dodatki',
              multiSelect: false,
              options: [
                { label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' },
              ],
            }],
          },
          at: 18,
          hookEventName: 'PreToolUse',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = DIALOG_SINGLE;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z hooka');
    const card = questions(fx.events)[0];
    expect(card?.reqId.startsWith('hook:')).toBe(true);
    const before = fx.client.mutations;

    // Zakładka 2: INNA treść pytania, checkboxy — i te same etykiety z tymi samymi cyframi.
    fx.client.screenText = DIALOG_MULTI
      .replace('\n Które dodatki do lodów?\n', '\n A które polewy do gofrów?\n');
    fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka']]);
    await quiet();

    expect(fx.client.mutations).toBe(before);
    expect(systemTexts(fx.events).join('\n')).toContain(SCREEN_CHANGED_MESSAGE.text);
    expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Kontrakt `DecisionOutcome`
// ---------------------------------------------------------------------------

/**
 * Przy decyzji `void` manager zdejmowałby pending PRZED wywołaniem drivera,
 * więc każda odmowa zjadałaby kartę z telefonu, choć dialog stoi dalej w terminalu. Ten blok
 * pilnuje drugiej strony naprawy — samego WYNIKU, który driver oddaje managerowi.
 *
 * Tabela na końcu jest strażnikiem zamkniętej unii: nowy powód bez wpisu = czerwono.
 */
describe('kontrakt decyzji: applied | refused | stale', () => {
  it('udane `escape` to `applied`', async () => {
    const fx = await makeDriver();
    await expect(fx.driver.respondPermission('p-1', 'deny')).resolves.toEqual({ kind: 'applied' });
    await quiet();
  });

  it('odrzucone wywołanie herdr to `refused: send-failed` — i wpis w liczniku odmów', async () => {
    /*
     * Jedyna odmowa, która nie bierze się z ekranu, tylko z KANAŁU: herdr odmówił wysyłki
     * (panel zniknął, tryb tylko do odczytu, blokada). Do kontraktu `DecisionOutcome` taka
     * decyzja wracała do telefonu jako 200 — czyli jako zatwierdzenie, którego nie było.
     */
    const fx = await makeDriver();
    fx.client.sendKeys = () => Promise.reject(new HerdrGoneError(foreign('panel zniknął')));

    await expect(fx.driver.respondPermission('p-1', 'deny'))
      .resolves.toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toContain('send-failed');
    await quiet();
  });

  it('decyzja w kartę, której nie ma, to `stale` (a nie odmowa)', async () => {
    // Normalny wyścig: dialog rozstrzygnięto przy biurku ułamek sekundy wcześniej. Karta
    // nie ma czego reprezentować, więc manager ma ją WYGASIĆ (410), nie zostawiać z powodem.
    const fx = await makeDriver();
    await expect(fx.driver.respondPermission('p-nieznane', 'allow'))
      .resolves.toEqual({ kind: 'stale' });
    await expect(fx.driver.answerQuestion('q-nieznane', [['A']]))
      .resolves.toEqual({ kind: 'stale' });
    expect(fx.client.mutations).toBe(0);
  });

  it('zgoda bez jednoznacznej opcji „tak" to `refused: no-digit`', async () => {
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    // Dialog `AskUserQuestion` nie ma opcji „Yes, and…" — `respondPermission('allow')`
    // nie ma tu czego znaleźć, więc odmawia zamiast zgadywać cyfrę.
    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    const reqId = questions(fx.events)[0]?.reqId ?? '';
    await expect(fx.driver.respondPermission(reqId, 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'no-digit' });
    expect(fx.client.mutations).toBe(0);
  });

  it('decyzja adresująca INNĄ kartę to `refused: stale-card`', async () => {
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    await expect(fx.driver.answerQuestion('screen:q:nieswoje', [['Posypka']]))
      .resolves.toEqual({ kind: 'refused', reason: 'stale-card' });
    expect(fx.client.mutations).toBe(0);
  });

  /**
   * Które powody unii są WYNIKIEM decyzji, a które powstają przy OCENIE karty.
   *
   * Tabela jest jawna, bo unia jest wspólna dla dziennika i kontraktu: powód dopisany do
   * `REFUSE_REASONS` bez wpisu tutaj przewraca ten test, zamiast po cichu nie mieć pokrycia.
   */
  const REASON_ROLE: Readonly<Record<RefuseReason, 'decyzja' | 'ocena karty' | 'blokada'>> = {
    mismatch: 'ocena karty',
    unreadable: 'ocena karty',
    'no-jsonl': 'ocena karty',
    'multi-select': 'decyzja',
    'no-digit': 'decyzja',
    'terminal-only': 'decyzja',
    'screen-changed': 'decyzja',
    'stale-card': 'decyzja',
    'form-submit': 'decyzja',
    'send-failed': 'decyzja',
    // Trzecia rola: powstaje w MANAGERZE (blokada równoległych prób), nie w driverze — więc
    // ten plik nie ma jej ścieżki i dziennik nie ma jej wpisu.
    'in-flight': 'blokada',
    // Karta „zgoda CLI" powstaje przy OCENIE ekranu (nadzorca albo bramka wysyłki).
    'consent-dialog': 'ocena karty',
  };

  it('każdy powód z unii ma przypisaną rolę (strażnik zamkniętej listy)', () => {
    expect(Object.keys(REASON_ROLE).sort()).toEqual([...REFUSE_REASONS].sort());
    // Role „blokada" pilnuje jedno źródło prawdy — inaczej dopisanie powodu spoza drivera
    // przechodziłoby tu na zielono, a strażnik pokrycia w `herdr-audit.test.ts` by go szukał.
    expect(Object.entries(REASON_ROLE).filter(([, role]) => role === 'blokada').map(([r]) => r))
      .toEqual([...NON_DRIVER_REFUSE_REASONS]);
    // Powody „oceny karty" nie mają prawa wrócić z decyzji: nikt jeszcze o nic nie pytał,
    // więc nie ma żądania HTTP, na które można by odpowiedzieć 422.
    expect(Object.values(REASON_ROLE).filter((role) => role === 'decyzja')).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Powód odmowy z ekranu i zrzut diagnostyczny
// ---------------------------------------------------------------------------

describe('powód odmowy na ścieżce ekranowej', () => {
  /*
   * Ta gałąź nie może liczyć KAŻDEJ odmowy spoza jsonl jako `no-jsonl`: `refuseReasonFor`
   * dostaje tam rozpoznanie przeliczone z `expected = null`, a ono zwraca ten jeden status
   * zawsze. Suma odmów (`summarizeRefusals`) pokazywałaby wtedy worek zamiast rozkładu
   * powodów. Trzy poniższe ekrany to trzy różne
   * awarie — i mają dawać trzy różne powody.
   */
  const MULTI = readFileSync(join(FIXTURES, 'dialog-askuserquestion-multi.txt'), 'utf8');

  /** Odmowa z ekranu: `blocked` bez wpisu w jsonl, ekran podstawiony przed statusem. */
  async function screenRefusals(screenText: string): Promise<string[]> {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = screenText;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');
    return fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason ?? '');
  }

  it('formularz WIELOKROTNY z ekranu to `multi-select`', async () => {
    expect(await screenRefusals(MULTI)).toEqual(['multi-select']);
  });

  it('ekran, którego nie da się sparsować, to `unreadable`', async () => {
    expect(await screenRefusals(NIE_DIALOG)).toEqual(['unreadable']);
  });

  it('dialog sparsowany, ale bez karty (tryb notatki) zostaje `no-jsonl`', async () => {
    // Ekran PARSUJE się i nie jest wielokrotny — to jest właśnie „dialog spoza transkryptu,
    // którego Rarog nie umie obsłużyć". Ten kubełek ma zostać wąski, żeby cokolwiek znaczył.
    const notatka = DIALOG_QUESTION.replace(
      'esc to cancel',
      'n to add notes · ctrl+g to edit in Nvim · esc to cancel',
    );
    expect(notatka).not.toBe(DIALOG_QUESTION);
    expect(await screenRefusals(notatka)).toEqual(['no-jsonl']);
  });
});

describe('stęchły wpis jsonl kontra świeży zrzut hooka', () => {
  const ekran = readFileSync(join(FIXTURES, 'dialog-bash-stechly-read-2.1.295.txt'), 'utf8');
  const komenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-stechly-read-2.1.295.command.json'), 'utf8',
  )) as { command: string }).command;
  /** Zrzut hooka sekundę po wpisie `tool_use` z `toolUseLine` (10:00:06). */
  const zrzut = { toolName: 'Bash', toolInput: { command: komenda }, at: Date.parse('2026-08-22T10:00:07.000Z'),
    hookEventName: 'PermissionRequest' };

  it('martwy `Read` w jsonl nie zasłania zgody `Bash` z hooka: karta z treścią i cyfra z ekranu', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_read', 'Read', { file_path: '/a.png' }),
      deps: { readPendingHook: () => zrzut },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events).at(-1);
    expect(card?.toolName).toBe('Bash');
    expect(card?.input).toEqual({ command: komenda });
    // Tożsamość samego zrzutu, który wygrał z wpisem na ekranie.
    expect(card?.reqId).toBe(`hook:${String(zrzut.at)}`);

    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
  });

  it('ucięty nagłówek: zrzut hooka dochodzi PO pierwszej ocenie i odblokowuje kartę', async () => {
    const naglowek = readFileSync(join(FIXTURES, 'dialog-bash-uciety-naglowek-2.1.294.txt'), 'utf8');
    const cmd = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-uciety-naglowek-2.1.294.command.json'), 'utf8',
    )) as { command: string }).command;
    let hookDump: PendingHookTool | null = null;
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_bash', 'Bash', { command: cmd }),
      deps: { readPendingHook: () => hookDump, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = naglowek;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta bez przycisków');
    expect(permissions(fx.events).at(-1)?.input).toBeNull();

    hookDump = { ...zrzut, toolInput: { command: cmd } };
    await waitFor(() => permissions(fx.events).at(-1)?.input !== null, 'karta z treścią po dojściu hooka');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: cmd });
    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
  });

  it('karta z jsonl: inna komenda w ramce przed tapnięciem = `screen-changed`, zero klawiszy', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_bash', 'Bash', { command: komenda }),
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: komenda });

    // Komenda X rozstrzygnięta przy biurku, na ekranie już Y — ta sama etykieta i cyfra „1. Yes".
    fx.client.screenText = ekran.split('\n').map((line) => (line.startsWith(' │ ')
      ? line.replace("'rarog-uikit.*'", "'rarog-uikiX.*'") : line)).join('\n');
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
    expect(fx.client.mutations).toBe(0);
  });

  it('ucięta ramka: podmiana X na Y o wspólnym końcu przed tapnięciem = odmowa', async () => {
    const wysoki = readFileSync(join(FIXTURES, 'measured', 'zgoda-bash-wysoka-2.1.295.txt'), 'utf8');
    const ogon = (JSON.parse(readFileSync(
      join(FIXTURES, 'zgoda-bash-wysoka-2.1.295.command.json'), 'utf8',
    )) as { command: string }).command;
    const x = `echo safe\n${ogon}`;
    const y = `rm -rf ~/Pictures\n${ogon}`;
    let hookDump: PendingHookTool = { ...zrzut, toolInput: { command: x } };
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_x', 'Bash', { command: x }),
      deps: { readPendingHook: () => hookDump },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = wysoki;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody X');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: x });

    // X rozstrzygnięty przy biurku, na ekranie Y — ten sam widoczny koniec, nowy zrzut hooka.
    hookDump = { ...zrzut, toolInput: { command: y }, at: zrzut.at + 5_000 };
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
    expect(fx.client.mutations).toBe(0);
  });

  it('zrzut z komendą, której ekran nie pokazuje — dalej karta bez przycisków', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_read', 'Read', { file_path: '/a.png' }),
      deps: { readPendingHook: () => ({ ...zrzut, toolInput: { command: 'rm -rf ~/Library/Caches/inne' } }) },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    expect(permissions(fx.events).at(-1)?.input).toBeNull();
  });
});

/*
 * Licznik auto-odmowy w brzmieniu CLI 2.1.316 („will automatically block this request in 1:38, to avoid holding
 * up an unattended session”). Wzorzec zna też brzmienie 2.1.294; licznik nierozpoznany wchodziłby do odcisku
 * karty i zmieniał się między kartą a tapnięciem — każde tapnięcie kończyłoby się `screen-changed`, zero klawiszy.
 */
describe('licznik auto-odmowy CLI 2.1.316 tyka między kartą a tapnięciem', () => {
  const ekran = readFileSync(join(FIXTURES, 'dialog-bash-licznik-block-2.1.316.txt'), 'utf8');
  const komenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-licznik-block-2.1.316.command.json'), 'utf8',
  )) as { command: string }).command;
  const zrzut = { toolName: 'Bash', toolInput: { command: komenda }, at: Date.parse('2026-08-22T10:00:07.000Z'),
    hookEventName: 'PermissionRequest' };
  const za = (czas: string): string => ekran.replace('block this request in 1:38,', `block this request in ${czas},`);

  it('karta z jsonl i zrzutu hooka przy 1:38, tapnięcie przy 1:35 → cyfra', async () => {
    expect(za('1:35')).not.toBe(ekran);
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_bash', 'Bash', { command: komenda }),
      deps: { readPendingHook: () => zrzut },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: komenda });

    fx.client.screenText = za('1:35');
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
  });

  it('inna komenda w ramce przy tykającym liczniku dalej = `screen-changed`, zero klawiszy', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_bash', 'Bash', { command: komenda }),
      deps: { readPendingHook: () => zrzut },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events).at(-1);

    fx.client.screenText = za('1:35').replace('grep -c demo src/modul.ts', 'grep -c test src/modul.ts');
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
    expect(fx.client.mutations).toBe(0);
  });
});

/*
 * Zgoda `Bash` SUBAGENTA, a agent główny pracuje obok:
 * wpis agenta głównego dochodzi PO zrzucie dialogu subagenta, więc jest od niego młodszy. Karta ze zrzutu
 * ma zostać (bez podmiany i bez śladu „Zgoda wygasła"), a cyfra przejść kontrolę przed wysłaniem.
 */
describe('zgoda subagenta przy pracującym agencie głównym', () => {
  const ekran = readFileSync(join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.txt'), 'utf8');
  const komenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.command.json'), 'utf8',
  )) as { command: string }).command;
  /** Zrzut dialogu subagenta 6 s PRZED wpisem `tool_use` z `toolUseLine` (10:00:06). */
  const zrzut: PendingHookTool = { toolName: 'Bash', toolInput: { command: komenda },
    at: Date.parse('2026-08-22T10:00:00.000Z'), hookEventName: 'PermissionRequest' };
  const degrades = (fx: Fixture): number => fx.audit.filter((e) => e.method === 'degrade').length;

  it('karta z samego zrzutu, potem wpisy agenta głównego → ta sama karta i cyfra', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: { readPendingHook: () => zrzut, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody subagenta');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: komenda });
    expect(card?.reqId).toBe(`hook:${String(zrzut.at)}`);

    // Agent główny puszcza własne narzędzia: wpis młodszy od zrzutu, potem następny.
    for (const [index, line] of [
      toolUseLine('toolu_main', 'Bash', { command: 'pnpm test' }),
      toolResultLine('toolu_main') + toolUseLine('toolu_main2', 'Read', { file_path: '/a.png' }),
    ].entries()) {
      const before = reads(fx.client);
      await appendFile(fx.transcript, line);
      // Ocena nad nowym wpisem CZYTA ekran (tożsamość oceny niesie oba źródła) i kończy się bez zdarzenia.
      await waitFor(() => reads(fx.client) >= before + 3, `obroty zegara po wpisie ${String(index + 1)}`);
    }
    await quiet();
    expect(permissions(fx.events)).toHaveLength(1);
    expect(cleared(fx.events)).toEqual([]);
    expect(degrades(fx)).toBe(0);

    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
  });

  it('karta z samego zrzutu → młodszy wpis → cyfra → dialog się zamyka przy `blocked`: bez nowej karty', async () => {
    let hookDump: PendingHookTool | null = zrzut;
    const fx = await makeDriver({
      transcript: userLine('pracuj'),
      deps: {
        readPendingHook: () => hookDump,
        clearPendingHook: () => { hookDump = null; },
        blockedPollMs: 20, screenCacheMs: 5, screenAnswerRearmDelaysMs: [5, 10],
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody subagenta');
    const card = permissions(fx.events).at(-1);

    const before = reads(fx.client);
    await appendFile(fx.transcript, toolUseLine('toolu_main', 'Bash', { command: 'pnpm test' }));
    await waitFor(() => reads(fx.client) >= before + 3, 'oceny nad młodszym wpisem');

    // Cyfra zamyka dialog: ekran bez dialogu (komenda subagenta biegnie), herdr jeszcze mówi `blocked`.
    const send = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      fx.client.screenText = '  ⎿  Running…\n\n❯ \n';
      return send(paneId, keys);
    };
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(hookDump).toBeNull();
    const after = reads(fx.client);
    await waitFor(() => reads(fx.client) >= after + 4, 'oceny po cyfrze');
    await quiet();
    expect(permissions(fx.events)).toHaveLength(1);
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(degrades(fx)).toBe(0);
  });

  it('karta z wpisu agenta głównego obok starszego zrzutu innej komendy stoi na bramce „ta sama karta"', async () => {
    const szeroki = readFileSync(join(FIXTURES, 'dialog-bash-stechly-read-szeroki-2.1.295.txt'), 'utf8');
    const glowna = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-stechly-read-szeroki-2.1.295.command.json'), 'utf8',
    )) as { command: string }).command;
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_main', 'Bash', { command: glowna }),
      // Zrzut zgody zatwierdzonej przy biurku (Rarog kasuje zrzut tylko po własnej cyfrze) — starszy od wpisu.
      deps: { readPendingHook: () => zrzut, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = szeroki;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody agenta głównego');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: glowna });
    expect(card?.reqId).toBe('toolu_main');

    // Widok przewinięty w górę: karta z wpisu nie czyta ekranu na obrotach zegara, więc nie spada.
    const before = reads(fx.client);
    fx.client.screenText = readFileSync(join(FIXTURES, 'dialog-bash-przewiniety-widok-2.1.295.txt'), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads(fx.client)).toBe(before);
    expect(permissions(fx.events)).toHaveLength(1);
    expect(degrades(fx)).toBe(0);
  });

  it('ten sam przebieg przy ramce uciętej u góry → karta bez przycisków', async () => {
    const lines = ekran.split('\n');
    const uciety = lines.slice(lines.findIndex((l) => l.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_main', 'Bash', { command: 'pnpm test' }),
      deps: { readPendingHook: () => zrzut },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = uciety;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    expect(permissions(fx.events).at(-1)?.input).toBeNull();
  });
});

/*
 * Zgoda `Bash` subagenta po ponad 10 minutach w kolejce CLI: zrzut
 * `PermissionRequest` żyje 60 minut, a po dziesiątej wchodzi do oceny wyłącznie z dowodem z ekranu — tytuł `Bash`,
 * cała ramka pod widocznym nagłówkiem, ramka równa całej komendzie. Zrzut idzie przez PRAWDZIWY czytnik z zegarem
 * testu, wpis otwartego narzędzia wątku głównego przez prawdziwy follower.
 */
describe('zgoda subagenta po 10 minutach w kolejce', () => {
  const ekran = readFileSync(join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.txt'), 'utf8');
  const komenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.command.json'), 'utf8',
  )) as { command: string }).command;
  const tytul = 'Bash command · from the general-purpose agent';
  /** Zrzut subagenta 4 s PO wpisie `tool_use` wątku głównego z `toolUseLine` (10:00:06). */
  const zrzutAt = Date.parse('2026-08-22T10:00:10.000Z');
  const MIN = 60_000;

  /** Zrzut na dysku i czytnik z sterowanym zegarem: `wiek()` to minuty od zapisu zrzutu. */
  async function dysk(cmd: string, minuty: number): Promise<{
    read: (sid: string) => PendingHookTool | null; wiek: (m: number) => void;
  }> {
    const dataDir = join(base, 'dane');
    await mkdir(join(dataDir, HOOK_PENDING_DIRNAME), { recursive: true });
    await writeFile(join(dataDir, HOOK_PENDING_DIRNAME, `${SESSION}.json`), JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: { command: cmd }, at: zrzutAt,
      hookEventName: 'PermissionRequest', agentId: 'a0b1c2d3e4f5a6b7c',
    }));
    let now = zrzutAt + minuty * MIN;
    return {
      read: (sid) => readPendingHook(dataDir, sid, () => now),
      wiek: (m) => { now = zrzutAt + m * MIN; },
    };
  }

  for (const [nazwa, screen] of [
    ['cała ramka', ekran],
    ['cała ramka z licznikiem „2 of 2”', ekran.replace(tytul, `${tytul}${' '.repeat(30)}2 of 2`)],
  ] as const) {
    it(`${nazwa}, zrzut sprzed 16 min, otwarte narzędzie wątku głównego → karta z przyciskami i cyfra`, async () => {
      const zrzut = await dysk(komenda, 16);
      const fx = await makeDriver({
        transcript: userLine('pracuj') + toolUseLine('toolu_main', 'Bash', { command: 'pnpm test' }),
        deps: { readPendingHook: zrzut.read, blockedPollMs: 20, screenCacheMs: 5 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = screen;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody subagenta');
      const card = permissions(fx.events).at(-1);
      expect(card?.input).toEqual({ command: komenda });
      // Tożsamość samego zrzutu, który wygrał z wpisem na ekranie.
      expect(card?.reqId).toBe(`hook:${String(zrzutAt)}`);

      // Obroty zegara nad stojącym dialogiem: ta sama karta, bez karty bez przycisków.
      const before = reads(fx.client);
      await waitFor(() => reads(fx.client) >= before + 3, 'obroty zegara');
      expect(permissions(fx.events)).toHaveLength(1);
      expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);

      await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
      expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
      expect(fx.audit.at(-1)).toMatchObject({
        method: 'approve', keys: ['1'], toolName: 'Bash', route: 'none', routeReason: 'dump-no-class',
      });
    });
  }

  it('podwójny dowód przy ramce uciętej: po dziesiątej minucie karta traci przyciski', async () => {
    const lines = ekran.split('\n');
    const uciety = lines.slice(lines.findIndex((l) => l.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
    // Wpis wątku głównego z TĄ SAMĄ komendą co zrzut, zrzut nie starszy od wpisu: ramkę uciętą dowodzą dwa źródła.
    const zrzut = await dysk(komenda, 9);
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_main', 'Bash', { command: komenda }),
      deps: { readPendingHook: zrzut.read, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = uciety;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z podwójnym dowodem');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: komenda });

    zrzut.wiek(11);
    await waitFor(() => permissions(fx.events).length > 1, 'karta po dziesiątej minucie');
    expect(permissions(fx.events).at(-1)?.input).toBeNull();
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.not.toEqual({ kind: 'applied' });
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
  });

  it('podwójny dowód przy ramce uciętej: cyfra po dziesiątej minucie, zanim ocena zdejmie kartę → odmowa', async () => {
    const lines = ekran.split('\n');
    const uciety = lines.slice(lines.findIndex((l) => l.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
    const zrzut = await dysk(komenda, 9);
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_main', 'Bash', { command: komenda }),
      // Zegar oceny stoi: kontrolę przed cyfrą robi wyłącznie świeży odczyt w `respondPermission`.
      deps: { readPendingHook: zrzut.read, blockedPollMs: 60_000, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = uciety;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z podwójnym dowodem');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: komenda });

    zrzut.wiek(11);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.not.toEqual({ kind: 'applied' });
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
  });
});

/*
 * Cyfra Raroga na dialog wątku głównego „1 of 2” nie może skasować zrzutu zgody subagenta, która czeka w kolejce
 * za nim: hook odpala raz, więc jej dialog wyszedłby na wierzch jako „2 of 2” bez przycisków (`degrade`,
 * `mismatch`). Po decyzji zostaje zrzut `Bash` INNEGO dialogu (`otherDialogDump`), każdy inny znika.
 */
describe('zrzut zgody subagenta w kolejce przeżywa decyzję Raroga na dialogu przed nią', () => {
  const komenda = (name: string): string => (JSON.parse(readFileSync(
    join(FIXTURES, `${name}.command.json`), 'utf8',
  )) as { command: string }).command;
  const ekran = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
  const kolejka = (text: string, title: string, counter: string): string => (
    text.replace(title, `${title}${' '.repeat(30)}${counter}`));
  /** Dialog wątku głównego na wierzchu kolejki: cała ramka komendy `M`. */
  const M = komenda('dialog-bash-ask-rule-2.1.295');
  const GLOWNY = kolejka(ekran('dialog-bash-ask-rule-2.1.295'), 'Bash command (unsandboxed)', '1 of 2');
  /** Dialog subagenta, który wychodzi na wierzch po decyzji: cała ramka komendy `S`. */
  const S = komenda('dialog-bash-subagent-naglowek-2.1.302');
  const SUBAGENT = kolejka(
    ekran('dialog-bash-subagent-naglowek-2.1.302'), 'Bash command · from the general-purpose agent', '2 of 2',
  );
  /** Zrzut subagenta minutę PRZED wpisem `tool_use` wątku głównego z `toolUseLine` (10:00:06), jak w incydencie. */
  const zrzutAt = Date.parse('2026-08-22T09:59:06.000Z');
  const HOOK = `hook:${String(zrzutAt)}`;
  /** Zrzut subagenta 5 s PO wpisie wątku głównego: źródła konkurują (tożsamość oceny `hook:<at>~toolu_main`). */
  const mlodszyAt = Date.parse('2026-08-22T10:00:11.000Z');
  const HOOK_MLODSZY = `hook:${String(mlodszyAt)}`;
  const MIN = 60_000;
  const plikZrzutu = (): string => join(base, 'dane', HOOK_PENDING_DIRNAME, `${SESSION}.json`);

  /** Zapis synchroniczny: w trakcie wysyłki klawisza żaden obrót zegara nie wchodzi między zapis a koniec wysyłki. */
  function zapiszZrzut(cmd: string, at: number): void {
    const path = plikZrzutu();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: { command: cmd }, at,
      hookEventName: 'PermissionRequest', agentId: 'a0b1c2d3e4f5a6b7c',
    }));
  }

  /** Prawdziwy czytnik zrzutu (zegar `now`) i prawdziwe kasowanie po decyzji. */
  function czytnik(now: number): Partial<HerdrDriverDeps> {
    const dataDir = join(base, 'dane');
    return {
      readPendingHook: (sid) => readPendingHook(dataDir, sid, () => now),
      clearPendingHook: (sid, answerKey) => { clearPendingHook(dataDir, sid, answerKey); },
    };
  }

  /** Zrzut na dysku o generacji `at`, czytany `minuty` po zapisie. */
  function dysk(
    cmd: string, minuty: number, at = zrzutAt,
  ): Promise<{ path: string; deps: Partial<HerdrDriverDeps> }> {
    zapiszZrzut(cmd, at);
    return Promise.resolve({ path: plikZrzutu(), deps: czytnik(at + minuty * MIN) });
  }

  /** Blokada nad `screen` z wpisem wątku głównego `tool_use` (`toolName`, `input`) i zrzutem z `deps`. */
  async function blokada(
    deps: Partial<HerdrDriverDeps>, screen: string, toolName = 'Bash', input: unknown = { command: M },
    reqId = 'toolu_main',
  ): Promise<Fixture> {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_main', toolName, input),
      deps: { ...deps, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = screen;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta dialogu wątku głównego');
    expect(permissions(fx.events).at(-1)?.reqId).toBe(reqId);
    expect(permissions(fx.events).at(-1)?.input).toEqual(input);
    return fx;
  }

  const klawisze = (fx: Fixture): unknown[] => fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);

  /** Dialog subagenta na wierzchu: karta z przyciskami i treścią zrzutu, cyfra przechodzi, zrzut znika po niej. */
  async function subagentNaWierzchu(fx: Fixture, path: string, hookId = HOOK): Promise<void> {
    fx.client.screenText = SUBAGENT;
    await waitFor(() => permissions(fx.events).length > 1, 'karta dialogu subagenta');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: S });
    expect(card?.reqId).toBe(hookId);
    expect(existsSync(path)).toBe(true);
    await expect(fx.driver.respondPermission(hookId, 'allow')).resolves.toEqual({ kind: 'applied' });
    // Zrzut rozstrzygniętej zgody subagenta znika: ta sama komenda co karta.
    expect(existsSync(path)).toBe(false);
  }

  for (const minuty of [16, 2]) {
    it(`(1) cyfra na „1 of 2” zostawia zrzut subagenta sprzed ${String(minuty)} min, „2 of 2” ma przyciski`, async () => {
      const zrzut = await dysk(S, minuty);
      const fx = await blokada(zrzut.deps, GLOWNY);
      await expect(fx.driver.respondPermission('toolu_main', 'allow')).resolves.toEqual({ kind: 'applied' });
      expect(fx.audit.at(-1)).toMatchObject({ method: 'approve', keys: ['1'], toolName: 'Bash', source: 'jsonl' });
      await subagentNaWierzchu(fx, zrzut.path);
      expect(klawisze(fx)).toEqual([['1'], ['1']]);
      expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
    });
  }

  it('(2) „Odrzuć” na „1 of 2” zostawia zrzut subagenta, „2 of 2” ma przyciski', async () => {
    const zrzut = await dysk(S, 16);
    const fx = await blokada(zrzut.deps, GLOWNY);
    await expect(fx.driver.respondPermission('toolu_main', 'deny')).resolves.toEqual({ kind: 'applied' });
    // Bez `tool_result` odmowy: rozstrzygnięta karta nie trzyma bramki „ta sama karta”.
    await subagentNaWierzchu(fx, zrzut.path);
    expect(klawisze(fx)).toEqual([['escape'], ['1']]);
  });

  it('(3) cyfra na dialog `Bash`, zrzut tej samej komendy: skasowany', async () => {
    const zrzut = await dysk(M, 2);
    const fx = await blokada(zrzut.deps, GLOWNY);
    await expect(fx.driver.respondPermission('toolu_main', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(existsSync(zrzut.path)).toBe(false);
  });

  it('(5) „Odrzuć”, gdy ramka dialogu jest ucięta u góry: komendy dialogu nie widać, zrzut skasowany', async () => {
    const zrzut = await dysk(S, 2);
    const fx = await blokada(zrzut.deps, GLOWNY);
    const lines = GLOWNY.split('\n');
    // Ekran sprzed `escape`: od trzeciej linii ramki, bez tytułu i górnej kreski.
    fx.client.screenText = lines.slice(lines.findIndex((l) => l.includes('│ P+=("$B"/build'))).join('\n');
    await expect(fx.driver.respondPermission('toolu_main', 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(klawisze(fx)).toEqual([['escape']]);
    expect(existsSync(zrzut.path)).toBe(false);
  });

  it('(6) po cyfrze rozstrzygnięty dialog „1 of 2” nie wraca, choć zrzut subagenta zostaje', async () => {
    const zrzut = await dysk(S, 2);
    const fx = await blokada(zrzut.deps, GLOWNY);
    await expect(fx.driver.respondPermission('toolu_main', 'allow')).resolves.toEqual({ kind: 'applied' });
    // Ekran sprzed przemalowania: ten sam dialog, wpis jsonl bez `tool_result`, zrzut subagenta obok.
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 6, 'obroty zegara nad rozstrzygniętym dialogiem');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
    expect(klawisze(fx)).toEqual([['1']]);
  });

  /** Obroty zegara (`blockedPollMs` 20 ms) nad ekranem, który stoi: mierzone czasem, bo bramka nie czyta ekranu. */
  const obroty = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

  /*
   * Zrzut subagenta MŁODSZY od wpisu wątku głównego, czyli źródła konkurują i tożsamość oceny
   * niesie oba. Karta dialogu subagenta ma tożsamość samego zrzutu, inną niż rozstrzygnięta karta wpisu, więc
   * przechodzi osłonę po decyzji (8 s) od razu; po `escape` bramka „ta sama karta” jej nie trzyma.
   */
  for (const decyzja of ['allow', 'deny'] as const) {
    const klawisz = decyzja === 'allow' ? 'cyfra' : '„Odrzuć”';
    it(`(7) ${klawisz} na „1 of 2”, zrzut młodszy od wpisu: „2 of 2” od razu`, async () => {
      const zrzut = await dysk(S, 2, mlodszyAt);
      const glowna = `${HOOK_MLODSZY}~toolu_main`;
      const fx = await blokada(zrzut.deps, GLOWNY, 'Bash', { command: M }, glowna);
      await expect(fx.driver.respondPermission(glowna, decyzja)).resolves.toEqual({ kind: 'applied' });
      expect(existsSync(zrzut.path)).toBe(true);
      // Ekran sprzed przemalowania: rozstrzygnięty dialog stoi dalej, wpis bez `tool_result`, zrzut subagenta obok.
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);
      await subagentNaWierzchu(fx, zrzut.path, HOOK_MLODSZY);
      expect(klawisze(fx)).toEqual([decyzja === 'allow' ? ['1'] : ['escape'], ['1']]);
      expect(permissions(fx.events).slice(1).map((p) => p.input)).toEqual([{ command: S }]);
      expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
    });
  }

  /*
   * Zrzut subagenta powstaje W TRAKCIE wysyłki klawisza, więc migawka osłony sprzed klawisza
   * go nie zna. Zrzut innego dialogu zostaje, a jego generacja nie zdejmuje osłony: rozstrzygnięty dialog, wciąż
   * na ekranie, nie dostaje drugiej karty z przyciskami. Dialog subagenta przechodzi osłonę jak w (7).
   */
  for (const decyzja of ['allow', 'deny'] as const) {
    const klawisz = decyzja === 'allow' ? 'cyfra' : '„Odrzuć”';
    it(`(8) ${klawisz}, zrzut subagenta zapisany w trakcie klawisza: „1 of 2” nie wraca`, async () => {
      const fx = await blokada(czytnik(mlodszyAt + 2 * MIN), GLOWNY);
      const send = fx.client.sendKeys;
      fx.client.sendKeys = (paneId, keys) => {
        zapiszZrzut(S, mlodszyAt);
        return send(paneId, keys);
      };
      await expect(fx.driver.respondPermission('toolu_main', decyzja)).resolves.toEqual({ kind: 'applied' });
      fx.client.sendKeys = send;
      expect(existsSync(plikZrzutu())).toBe(true);
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);
      await subagentNaWierzchu(fx, plikZrzutu(), HOOK_MLODSZY);
      expect(permissions(fx.events).slice(1).map((p) => p.input)).toEqual([{ command: S }]);
      expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
    });
  }

  for (const decyzja of ['allow', 'deny'] as const) {
    const klawisz = decyzja === 'allow' ? 'cyfra' : '„Odrzuć”';
    it(`(9) ${klawisz}, zrzut tej samej komendy zapisany w trakcie klawisza: skasowany`, async () => {
      const fx = await blokada(czytnik(mlodszyAt + 2 * MIN), GLOWNY);
      const send = fx.client.sendKeys;
      fx.client.sendKeys = (paneId, keys) => {
        zapiszZrzut(M, mlodszyAt);
        return send(paneId, keys);
      };
      await expect(fx.driver.respondPermission('toolu_main', decyzja)).resolves.toEqual({ kind: 'applied' });
      fx.client.sendKeys = send;
      expect(existsSync(plikZrzutu())).toBe(false);
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);
      expect(klawisze(fx)).toEqual([decyzja === 'allow' ? ['1'] : ['escape']]);
    });
  }

  /*
   * Karta ze zrzutu `Bash` ma tożsamość samego zrzutu, więc stoi bez przebudowy, gdy wpis obok
   * się zmienia: agent główny dostaje wynik i puszcza narzędzie MŁODSZE od zrzutu. Osłona po decyzji bierze wpis
   * z chwili klawisza, więc rozstrzygnięty dialog nie dostaje karty bez przycisków ani nad niezmienionym ekranem,
   * ani po zamknięciu.
   */
  for (const decyzja of ['allow', 'deny'] as const) {
    const klawisz = decyzja === 'allow' ? 'cyfra' : '„Odrzuć”';
    it(`(10) ${klawisz} na karcie ze zrzutu, wpis obok zmieniony na młodszy: dialog nie wraca`, async () => {
      const zrzut = await dysk(S, 2, mlodszyAt);
      const fx = await makeDriver({
        transcript: userLine('pracuj') + toolUseLine('toolu_main', 'Bash', { command: 'pnpm test' }),
        deps: { ...zrzut.deps, blockedPollMs: 20, screenCacheMs: 5 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = SUBAGENT;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta ze zrzutu');
      expect(permissions(fx.events)[0]).toMatchObject({ reqId: HOOK_MLODSZY, input: { command: S } });

      // Wynik `toolu_main` i nowe narzędzie agenta głównego, 9 s po zrzucie; dialog subagenta stoi dalej.
      const asystent = (): number => fx.events.filter((e) => e.type === 'message' && e.role === 'assistant').length;
      const przed = asystent();
      await appendFile(fx.transcript, toolResultLine('toolu_main') + toolUseLine('toolu_main2', 'Bash', {
        command: 'pnpm run build',
      }).replace('2026-08-22T10:00:06.000Z', '2026-08-22T10:00:20.000Z'));
      await waitFor(() => asystent() > przed, 'wpis toolu_main2');
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);

      await expect(fx.driver.respondPermission(HOOK_MLODSZY, decyzja)).resolves.toEqual({ kind: 'applied' });
      expect(existsSync(zrzut.path)).toBe(false);
      // Ekran sprzed przemalowania: rozstrzygnięty dialog stoi dalej.
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);
      // Dialog zamknięty: samo pole promptu.
      fx.client.screenText = '❯';
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);
      // Agent główny pracuje dalej (wpis młodszy od zrzutu, `pendingYounger`): kolejny wpis osłony nie zdejmuje.
      const potem = asystent();
      await appendFile(fx.transcript, toolResultLine('toolu_main2') + toolUseLine('toolu_main3', 'Bash', {
        command: 'pnpm run lint',
      }).replace('2026-08-22T10:00:06.000Z', '2026-08-22T10:00:25.000Z'));
      await waitFor(() => asystent() > potem, 'wpis toolu_main3');
      await obroty();
      expect(permissions(fx.events)).toHaveLength(1);
      expect(screenDialogs(fx.events)).toEqual([]);
      expect(klawisze(fx)).toEqual([decyzja === 'allow' ? ['1'] : ['escape']]);
    });
  }

  /** Zrzut na dysku o generacji `at` i czytnik ze sterowanym zegarem: `wiek()` to minuty od zapisu zrzutu. */
  function zegar(cmd: string, at: number, minuty: number): {
    deps: Partial<HerdrDriverDeps>; wiek: (m: number) => void;
  } {
    zapiszZrzut(cmd, at);
    const dataDir = join(base, 'dane');
    let now = at + minuty * MIN;
    return {
      deps: {
        readPendingHook: (sid) => readPendingHook(dataDir, sid, () => now),
        clearPendingHook: (sid, answerKey) => { clearPendingHook(dataDir, sid, answerKey); },
      },
      wiek: (m) => { now = at + m * MIN; },
    };
  }

  /** Dialog subagenta od trzeciej linii ramki: bez tytułu i górnej kreski, komendy `S` nie widać w całości. */
  const SUBAGENT_UCIETY = ((): string => {
    const lines = SUBAGENT.split('\n');
    return lines.slice(lines.findIndex((l) => l.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
  })();

  /*
   * Właściciel zatwierdza dialog wątku głównego „1 of 2” PRZY BIURKU, bez Raroga. Na wierzch
   * wychodzi dialog subagenta, blokada się nie zmienia, długa komenda `M` nie ma jeszcze `tool_result`, a zrzut
   * subagenta jest młodszy od wpisu, więc karta „1 of 2” ma tożsamość obu źródeł. Póki zrzut jest świeży, ta
   * tożsamość się nie zmienia i karta „1 of 2” stoi (znana luka). Po dziesiątej minucie zrzut wchodzi do oceny
   * tylko z dowodem z ekranu, a ten dowodzi innej komendy niż komenda karty: karta „2 of 2” z przyciskami.
   */
  it('(11) decyzja przy biurku na „1 of 2”, zrzut subagenta po 10 min: karta „2 of 2” z przyciskami', async () => {
    const zrzut = zegar(S, mlodszyAt, 2);
    const glowna = `${HOOK_MLODSZY}~toolu_main`;
    const fx = await blokada(zrzut.deps, GLOWNY, 'Bash', { command: M }, glowna);
    fx.client.screenText = SUBAGENT;
    await obroty();
    zrzut.wiek(9);
    await obroty();
    // Znana luka (`docs/dialogs.md`): w pierwszych 10 minutach karta dialogu z wierzchu stoi.
    expect(permissions(fx.events)).toHaveLength(1);

    zrzut.wiek(11);
    await waitFor(() => permissions(fx.events).length > 1, 'karta dialogu subagenta po dziesiątej minucie');
    expect(permissions(fx.events).at(-1)).toMatchObject({ reqId: HOOK_MLODSZY, input: { command: S } });
    expect(cleared(fx.events).map((c) => c.reqId)).toEqual([glowna]);
    await expect(fx.driver.respondPermission(HOOK_MLODSZY, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(klawisze(fx)).toEqual([['1']]);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
  });

  /*
   * Znana luka z (11) w pierwszych 10 minutach: tapnięcie w kartę rozstrzygniętego dialogu nie wysyła klawisza
   * (kontrola świeżego ekranu przed cyfrą), gasi tę kartę, a dialog subagenta dostaje kartę z przyciskami.
   */
  it('(12) decyzja przy biurku, zrzut świeży: tapnięcie w kartę „1 of 2” daje odmowę i kartę „2 of 2”', async () => {
    const zrzut = zegar(S, mlodszyAt, 2);
    const glowna = `${HOOK_MLODSZY}~toolu_main`;
    const fx = await blokada(zrzut.deps, GLOWNY, 'Bash', { command: M }, glowna);
    fx.client.screenText = SUBAGENT;
    await obroty();
    expect(permissions(fx.events)).toHaveLength(1);
    await expect(fx.driver.respondPermission(glowna, 'allow')).resolves.toEqual({
      kind: 'refused', reason: 'screen-changed',
    });
    expect(klawisze(fx)).toEqual([]);
    await waitFor(() => permissions(fx.events).length > 1, 'karta dialogu subagenta po odmowie');
    expect(permissions(fx.events).at(-1)).toMatchObject({ reqId: HOOK_MLODSZY, input: { command: S } });
    await expect(fx.driver.respondPermission(HOOK_MLODSZY, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(klawisze(fx)).toEqual([['1']]);
  });

  /*
   * Przebieg z (11), ale ramka dialogu subagenta jest ucięta u góry. Zrzut po dziesiątej minucie
   * nie ma dowodu z ekranu, więc wypada z oceny i z jej tożsamości: karta „1 of 2” ustępuje
   * karcie bez przycisków, dialog subagenta nie dostaje przycisków, a cyfra z karty zrzutu nie wychodzi.
   */
  it('(13) decyzja przy biurku, „2 of 2” z ramką uciętą: po 10 min bez przycisków dla subagenta', async () => {
    const zrzut = zegar(S, mlodszyAt, 2);
    const glowna = `${HOOK_MLODSZY}~toolu_main`;
    const fx = await blokada(zrzut.deps, GLOWNY, 'Bash', { command: M }, glowna);
    fx.client.screenText = SUBAGENT_UCIETY;
    await obroty();
    expect(permissions(fx.events)).toHaveLength(1);

    zrzut.wiek(11);
    await waitFor(() => permissions(fx.events).length > 1, 'karta po dziesiątej minucie');
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 6, 'obroty zegara po dziesiątej minucie');
    expect(permissions(fx.events)).toHaveLength(2);
    expect(permissions(fx.events).at(-1)?.input).toBeNull();
    expect(permissions(fx.events).map((p) => p.reqId)).not.toContain(HOOK_MLODSZY);
    await expect(fx.driver.respondPermission(HOOK_MLODSZY, 'allow')).resolves.not.toEqual({ kind: 'applied' });
    expect(klawisze(fx)).toEqual([]);
  });

  /*
   * Zrzut `Bash` sprzed 16 min BEZ wpisu jsonl. Dowód z ekranu liczy się przy KAŻDEJ ocenie:
   * gdy znika, zrzut wypada z oceny, a cyfra ze starej karty nie wychodzi.
   */
  for (const [nazwa, zmieniony] of [
    ['ramka ucięta u góry', (() => {
      const lines = SUBAGENT.split('\n');
      return lines.slice(lines.findIndex((l) => l.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
    })()],
    ['cała ramka innej komendy', ekran('dialog-bash-stechly-read-szeroki-2.1.295')],
  ] as const) {
    it(`zrzut sprzed 16 min bez wpisu jsonl: cała ramka → przyciski; potem ${nazwa} → zrzut odrzucony`, async () => {
      const zrzut = await dysk(S, 16);
      const fx = await makeDriver({
        transcript: userLine('pracuj'), deps: { ...zrzut.deps, blockedPollMs: 20, screenCacheMs: 5 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = SUBAGENT;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta ze zrzutu');
      expect(permissions(fx.events)[0]).toMatchObject({ reqId: HOOK, input: { command: S } });

      fx.client.screenText = zmieniony;
      await waitFor(() => cleared(fx.events).some((c) => c.reqId === HOOK), 'karta ze zrzutu zgaszona');
      // Karta po zmianie nie jest kartą zrzutu: bez przycisków przy ramce uciętej, z samego ekranu przy innej
      // komendzie (karta ekranowa, jak bez zrzutu).
      for (const card of permissions(fx.events).slice(1)) {
        expect(card.reqId).not.toBe(HOOK);
        expect(card.input).not.toEqual({ command: S });
      }
      await expect(fx.driver.respondPermission(HOOK, 'allow')).resolves.not.toEqual({ kind: 'applied' });
      expect(klawisze(fx)).toEqual([]);
      expect(existsSync(zrzut.path)).toBe(true);
    });
  }
});

/*
 * Widok fullscreen przewinięty w górę chowa dialog i karta spada do `unreadable`. Bramka „ta sama karta"
 * nie może potem kończyć każdej oceny przed odczytem ekranu, bo karta bez przycisków stałaby nad dialogiem,
 * który parsuje się bez zarzutu.
 */
describe('karta bez przycisków z jsonl odżywa, gdy dialog wraca na ekran', () => {
  const PRZEWINIETY = readFileSync(join(FIXTURES, 'dialog-bash-przewiniety-widok-2.1.295.txt'), 'utf8');
  const WIDOCZNY = readFileSync(join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.txt'), 'utf8');
  const komenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.command.json'), 'utf8',
  )) as { command: string }).command;
  /** Zrzut `PermissionRequest` sekundę po wpisie `tool_use` (podwójny dowód `Bash`). */
  const zrzut = { toolName: 'Bash', toolInput: { command: komenda }, at: Date.parse('2026-08-22T10:00:07.000Z'),
    hookEventName: 'PermissionRequest' };
  const degrades = (fx: Fixture): number => fx.audit.filter((e) => e.method === 'degrade').length;

  it('przewinięty → bez przycisków, obroty zegara bez zdarzeń, dialog na ekranie → przyciski i cyfra', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_rm', 'Bash', { command: komenda }),
      deps: { readPendingHook: () => zrzut, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = PRZEWINIETY;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta bez przycisków');
    expect(permissions(fx.events).at(-1)?.input).toBeNull();
    expect(degrades(fx)).toBe(1);

    // Kilka obrotów zegara nad tym samym widokiem: ekran JEST czytany, ale nic nie wychodzi.
    const kart = permissions(fx.events).length;
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 6, 'obroty zegara z odczytem ekranu');
    expect(permissions(fx.events)).toHaveLength(kart);
    expect(cleared(fx.events)).toEqual([]);
    expect(degrades(fx)).toBe(1);

    fx.client.screenText = WIDOCZNY;
    await waitFor(() => permissions(fx.events).at(-1)?.input !== null, 'karta z przyciskami');
    const card = permissions(fx.events).at(-1);
    expect(card?.input).toEqual({ command: komenda });
    expect(degrades(fx)).toBe(1);
    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => fx.client.mutations > 0, 'cyfra zgody');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
  });

  it('ucięty nagłówek BEZ zrzutu hooka: obroty zegara czytają ekran, karta dalej bez przycisków', async () => {
    const naglowek = readFileSync(join(FIXTURES, 'dialog-bash-uciety-naglowek-2.1.294.txt'), 'utf8');
    const cmd = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-uciety-naglowek-2.1.294.command.json'), 'utf8',
    )) as { command: string }).command;
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_bash', 'Bash', { command: cmd }),
      deps: { blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = naglowek;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta bez przycisków');
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 6, 'obroty zegara z odczytem ekranu');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(permissions(fx.events)[0]?.input).toBeNull();
    expect(degrades(fx)).toBe(1);
    fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('karta Z PRZYCISKAMI nie spada, gdy widok przewinie się w górę', async () => {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_rm', 'Bash', { command: komenda }),
      deps: { readPendingHook: () => zrzut, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = WIDOCZNY;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z przyciskami');
    expect(permissions(fx.events).at(-1)?.input).toEqual({ command: komenda });
    const kart = permissions(fx.events).length;

    fx.client.screenText = PRZEWINIETY;
    for (let i = 0; i < 10; i += 1) await quiet();
    expect(permissions(fx.events)).toHaveLength(kart);
    expect(cleared(fx.events)).toEqual([]);
    expect(degrades(fx)).toBe(0);
  });
});

/*
 * Po własnej cyfrze karta nie może zniknąć i wrócić: ocena w oknie, w którym herdr dalej mówi `blocked`,
 * zbudowałaby ją z ekranu sprzed przemalowania (albo z cache'u) od nowa — aż do `working`.
 */
describe('karta nie wraca po WŁASNEJ decyzji (osłona po cyfrze i Esc)', () => {
  /** Krótkie czasy: cache 1 ms, zegar ponownej oceny 8 ms (produkcja: 1 s i 4 s). */
  const fresh = { screenCacheMs: 1, blockedPollMs: 8 } as const;
  const NIC = '⏺ pracuję dalej…';

  it('po cyfrze dialog jeszcze na ekranie, herdr dalej `blocked` → ta sama karta NIE wraca', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to'), deps: { ...fresh } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-1', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events)[0];

    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty zegara nad starym ekranem');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(0);
  });

  it('po cyfrze dialog już zniknął, herdr dalej `blocked` → bez karty bez przycisków', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to'), deps: { ...fresh } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-1', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    fx.client.screenText = NIC;
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty zegara nad pustym ekranem');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(0);
  });

  it('„Odrzuć" na karcie bez przycisków: dialog jeszcze widać → karta z przyciskami NIE wyskakuje', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to'), deps: { ...fresh } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-1', tool: 'Bash', input: BASH_INPUT, screen: NIC });
    await waitFor(() => permissions(fx.events).length > 0, 'karta bez przycisków');
    expect(permissions(fx.events)[0]?.input).toBeNull();

    await expect(fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'deny'))
      .resolves.toEqual({ kind: 'applied' });
    // Przemalowanie po `escape` jeszcze nie doszło, a widok wrócił akurat na dół.
    fx.client.screenText = DIALOG_PERMISSION;
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty zegara po odmowie');
    expect(permissions(fx.events)).toHaveLength(1);
  });

  it('pytanie z ekranu odpowiedziane cyfrą: ta sama zakładka nie wraca, następna dostaje kartę', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'), deps: { ...fresh, screenAnswerRearmDelaysMs: [1, 5] },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG_QUESTION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    await fx.driver.answerQuestion(questions(fx.events)[0]?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty zegara nad starą zakładką');
    expect(questions(fx.events)).toHaveLength(1);

    // Formularz przełącza zakładkę w miejscu, bez mignięcia statusu — nowe pytanie musi dostać kartę.
    fx.client.screenText = DIALOG_QUESTION
      .replace('Który wariant zapisu wybrać?', 'Czy dodać testy regresji?')
      .replace('1. Zapis atomowy (tmp + rename)', '1. Tak, dodaj testy')
      .replace('2. Zapis w miejscu', '2. Nie, zostaw');
    await waitFor(() => questions(fx.events).length > 1, 'karta drugiej zakładki');
  });

  /** Zrzut hooka, który Rarog kasuje po decyzji (`clearPendingHook`), jak w produkcji. */
  const kasowalny = (initial: PendingHookTool | null): { deps: Partial<HerdrDriverDeps>; set: (h: PendingHookTool | null) => void } => {
    let hook = initial;
    return {
      deps: { readPendingHook: () => hook, clearPendingHook: () => { hook = null; } },
      set: (h) => { hook = h; },
    };
  };
  const STECHLY = readFileSync(join(FIXTURES, 'dialog-bash-stechly-read-2.1.295.txt'), 'utf8');
  const stechlaKomenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-stechly-read-2.1.295.command.json'), 'utf8',
  )) as { command: string }).command;
  const zrzutBash: PendingHookTool = {
    toolName: 'Bash', toolInput: { command: stechlaKomenda }, at: Date.parse('2026-08-22T10:00:07.000Z'),
    hookEventName: 'PermissionRequest',
  };

  it('karta ze zrzutu obok stęchłego wpisu `Read`: po cyfrze zero kart i zero `degrade`', async () => {
    const hook = kasowalny(zrzutBash);
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_read', 'Read', { file_path: '/a.png' }),
      deps: { ...fresh, ...hook.deps },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = STECHLY;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta ze zrzutu');
    expect(permissions(fx.events)[0]?.input).toEqual({ command: stechlaKomenda });

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    // Zrzut skasowany, stęchły `Read` dalej w jsonl, ekran jeszcze z dialogiem `Bash`, potem pusty.
    let odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 3, 'obroty nad starym dialogiem');
    fx.client.screenText = NIC;
    odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 3, 'obroty nad pustym ekranem');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(0);
  });

  it('karta TYLKO ze zrzutu (bez wpisu jsonl): po cyfrze nie wraca jako karta z ekranu', async () => {
    const hook = kasowalny(zrzutBash);
    const fx = await makeDriver({ transcript: userLine('pracuj'), deps: { ...fresh, ...hook.deps } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = STECHLY;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta ze zrzutu');
    expect(permissions(fx.events)[0]?.input).toEqual({ command: stechlaKomenda });

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty nad starym dialogiem');
    expect(permissions(fx.events)).toHaveLength(1);
  });

  it('pytanie z jsonl odpowiedziane cyfrą: przy zamykaniu bez karty bez przycisków', async () => {
    const INPUT_Q = { questions: [{
      question: 'Który wariant zapisu wybrać?', header: 'Zapis pliku', multiSelect: false,
      options: [
        { label: 'Zapis atomowy (tmp + rename)', description: 'Bezpieczniejszy, o jeden syscall więcej' },
        { label: 'Zapis w miejscu', description: 'Szybszy, ryzyko uciętego pliku przy awarii' },
      ],
    }] };
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie'), deps: { ...fresh } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-q', tool: 'AskUserQuestion', input: INPUT_Q, screen: DIALOG_QUESTION });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    await fx.driver.answerQuestion(questions(fx.events)[0]?.reqId ?? '', [['Zapis atomowy (tmp + rename)']]);
    fx.client.screenText = NIC;
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty nad zamykanym formularzem');
    expect(permissions(fx.events)).toHaveLength(0);
    expect(questions(fx.events)).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(0);
  });

  it('„Odrzuć" na karcie Z przyciskami (podwójny dowód): skasowany zrzut nie daje karty bez przycisków', async () => {
    const komenda = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.command.json'), 'utf8',
    )) as { command: string }).command;
    const hook = kasowalny({ ...zrzutBash, toolInput: { command: komenda } });
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_rm', 'Bash', { command: komenda }),
      deps: { ...fresh, ...hook.deps },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = readFileSync(join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.txt'), 'utf8');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z przyciskami');
    expect(permissions(fx.events)[0]?.reqId).toContain('~');

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'deny');
    fx.client.screenText = NIC;
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 3, 'obroty po odmowie');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(0);
  });

  it('nowa generacja zrzutu po cyfrze (ten sam dialog drugi raz) → karta wychodzi od razu', async () => {
    const komenda = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.command.json'), 'utf8',
    )) as { command: string }).command;
    const hook = kasowalny({ ...zrzutBash, toolInput: { command: komenda } });
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_rm', 'Bash', { command: komenda }),
      deps: { ...fresh, ...hook.deps },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = readFileSync(join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.txt'), 'utf8');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    await quiet();
    expect(permissions(fx.events)).toHaveLength(1);

    // Hook pisze NOWY zrzut: CLI postawiło kolejny dialog o identycznej treści.
    hook.set({ ...zrzutBash, toolInput: { command: komenda }, at: zrzutBash.at + 5_000 });
    await waitFor(() => permissions(fx.events).length > 1, 'karta nowego dialogu');
  });

  it('ucięty nagłówek z podwójnym dowodem: po cyfrze skasowany zrzut nie daje karty bez przycisków', async () => {
    const naglowek = readFileSync(join(FIXTURES, 'dialog-bash-uciety-naglowek-2.1.294.txt'), 'utf8');
    const cmd = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-uciety-naglowek-2.1.294.command.json'), 'utf8',
    )) as { command: string }).command;
    const hook = kasowalny({ ...zrzutBash, toolInput: { command: cmd } });
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_bash', 'Bash', { command: cmd }),
      deps: { ...fresh, ...hook.deps },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = naglowek;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z przyciskami');
    expect(permissions(fx.events)[0]?.input).toEqual({ command: cmd });

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty nad tym samym dialogiem');
    expect(permissions(fx.events)).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(0);
  });

  it('karta ze zrzutu dla dialogu BEZ ramki: po cyfrze nie wraca jako karta z ekranu', async () => {
    const hook = kasowalny({ ...zrzutBash, toolInput: BASH_INPUT });
    const fx = await makeDriver({ transcript: userLine('pracuj'), deps: { ...fresh, ...hook.deps } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta ze zrzutu');
    expect(permissions(fx.events)[0]?.input).toEqual(BASH_INPUT);

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty nad starym dialogiem');
    expect(permissions(fx.events)).toHaveLength(1);
  });

  it('karta z EKRANU, po decyzji dochodzi spóźniony wpis jsonl tego wywołania → karta nie wraca', async () => {
    const komenda = (JSON.parse(readFileSync(
      join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.command.json'), 'utf8',
    )) as { command: string }).command;
    const fx = await makeDriver({ transcript: userLine('pracuj'), deps: { ...fresh } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = readFileSync(join(FIXTURES, 'dialog-bash-ask-rule-2.1.295.txt'), 'utf8');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z ekranu');
    expect(permissions(fx.events)[0]?.reqId.startsWith('screen:p:')).toBe(true);

    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    await appendFile(fx.transcript, toolUseLine('toolu_late', 'Bash', { command: komenda }));
    const odczyty = reads(fx.client);
    await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty po dojściu wpisu');
    expect(permissions(fx.events)).toHaveLength(1);
  });

  it('karta ze zrzutu obok stęchłego `Read`, potem INNY dialog bez nowego zrzutu → karta od razu', async () => {
    const hook = kasowalny(zrzutBash);
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_read', 'Read', { file_path: '/a.png' }),
      deps: { ...fresh, ...hook.deps },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = STECHLY;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta ze zrzutu');
    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');

    fx.client.screenText = readFileSync(join(FIXTURES, 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8');
    await waitFor(() => permissions(fx.events).length > 1, 'karta dialogu Edit (bez czekania na termin)');
    expect(permissions(fx.events).at(-1)?.toolName).toBe('Edit');
  });

  it('zgubiona cyfra: niezmieniony dialog dostaje kartę z powrotem po terminie osłony', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to'), deps: { ...fresh, decidedShieldMs: 60 } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-1', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    await quiet();
    expect(permissions(fx.events)).toHaveLength(1);
    await waitFor(() => permissions(fx.events).length > 1, 'karta po terminie osłony');
    expect(permissions(fx.events).at(-1)?.reqId).toBe('t-1');
  });

  it('druga zgoda pod rząd (nowy wpis jsonl, bez mignięcia statusu) dostaje kartę od razu', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to'), deps: { ...fresh } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-1', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody A');
    await fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');

    const inputB = { command: 'rm -rf node_modules', description: 'Czyści zależności' };
    fx.client.screenText = DIALOG_PERMISSION
      .replaceAll('pnpm exec vitest run server/test/state-machine.test.ts', inputB.command)
      .replaceAll('Uruchamia testy maszyny stanów', inputB.description);
    await appendFile(fx.transcript, toolResultLine('t-1') + toolUseLine('t-2', 'Bash', inputB));
    await waitFor(() => permissions(fx.events).some((p) => p.reqId === 't-2'), 'karta zgody B');
    expect(permissions(fx.events).at(-1)?.input).toEqual(inputB);
  });
});

describe('zrzut diagnostyczny odmowy', () => {
  it('każda odmowa oddaje ekran, metadane hooka i status jsonl — BEZ `toolInput`', async () => {
    /*
     * Powód bez ekranu jest nie do zbadania: bez ekranu z chwili odmowy nie da się rozstrzygnąć,
     * skąd się wzięła. Zrzut niesie tekst ekranu, ale ze zrzutu hooka WYŁĄCZNIE metadane —
     * `toolInput` mieszka w `pending/` i nie ma powodu leżeć na dysku drugi raz.
     */
    const dumps: RefusalDump[] = [];
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: {
        dumpRefusal: (dump) => { dumps.push(dump); },
        readPendingHook: () => ({
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'SEKRETNA TRESC', options: [] }] },
          at: 17,
          hookEventName: 'PermissionRequest',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = NIE_DIALOG;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');

    expect(dumps).toHaveLength(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).length);
    const dump = dumps[0];
    expect(dump?.reason).toBe('unreadable');
    expect(dump?.screen).toContain('przemalowany panel');
    expect(dump?.hook)
      .toEqual({ toolName: 'AskUserQuestion', at: 17, hookEventName: 'PermissionRequest' });
    // Dialog spoza jsonl — „brak" jest tu informacją diagnostyczną, nie luką.
    expect(dump?.jsonl).toBeNull();
    expect(JSON.stringify(dump)).not.toContain('SEKRETNA TRESC');
  });

  it('wyjątek zapisywacza nie przewraca obsługi odmowy', async () => {
    // Diagnostyka jest best-effort na każdym poziomie: pełny dysk nie ma prawa zabrać
    // człowiekowi karty „odpowiedz w terminalu".
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { dumpRefusal: () => { throw new Error('ENOSPC'); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = NIE_DIALOG;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta „odpowiedz w terminalu"');
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade')).map((e) => e.reason))
      .toEqual(['unreadable']);
  });
});

// ---------------------------------------------------------------------------
// Kanał ODPOWIEDZI na `AskUserQuestion`
// ---------------------------------------------------------------------------

/**
 * Odpowiedź plikiem zamiast cyfrą — i powrót na cyfrę, kiedy pliku nikt nie zużyje.
 *
 * Kanał jest w testach ATRAPĄ (`FakeAnswers`), bo po drugiej stronie stoi ŻYWY, śpiący proces
 * hooka; jego kontrakt (nazwa pliku, kształt treści, kasowanie po odczycie) sprawdza
 * `pending-hook.test.ts` na prawdziwym zapisywaczu z `herdr/dialogs/hook/answers.ts`. Tutaj chodzi
 * wyłącznie o driver: KTÓRA karta dostaje kanał, co ląduje w dzienniku i co się dzieje,
 * gdy hook nie odpowiada.
 */
describe('kanał odpowiedzi hooka', () => {
  const DIALOG = readFileSync(join(FIXTURES, 'dialog-askuserquestion-multi.txt'), 'utf8')
    .replace(/\[[ ✔]\] /g, '')
    .replace('← ☒ Dodatki ✔ Submit →', '← ☐ Dodatki →');

  /** Atrapa kanału: zapisuje „plik" w pamięci i mówi, czy ktoś go zużył. */
  class FakeAnswers {
    written: {
      key: string; answers: Record<string, string>;
      annotations?: Readonly<Record<string, { notes: string; preview?: string }>>;
    }[] = [];
    cleared: string[] = [];
    /** `true` = hook go NIE zużył (plik dalej leży). */
    stillPending = false;
    /** `true` = zapis się nie udaje (killswitch, dysk) — kanał oddaje `null`. */
    failWrite = false;

    write(
      _sessionId: string, key: string, answers: Record<string, string>,
      annotations?: Readonly<Record<string, { notes: string; preview?: string }>> | null,
    ): string | null {
      if (this.failWrite) return null;
      this.written.push({ key, answers, ...(annotations ? { annotations } : {}) });
      return `/nieistotna/${key}.json`;
    }

    pending(_path: string): boolean {
      return this.stillPending;
    }

    clear(path: string): void {
      this.cleared.push(path);
    }
  }

  const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ffffffffffffffff';

  const hookDump = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{
        question: 'Które dodatki do lodów?',
        header: 'Dodatki',
        multiSelect: false,
        options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
      }],
    },
    at: 21,
    hookEventName: 'PermissionRequest',
    answerKey: KEY,
    ...over,
  });

  async function withCard(
    answers: FakeAnswers,
    dump: Record<string, unknown> | null = hookDump(),
    over: Partial<HerdrDriverDeps> = {},
  ): Promise<Fixture> {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        ...(dump === null
          ? {}
          : { readPendingHook: () => dump as unknown as PendingHookTool }),
        hookAnswers: answers,
        hookAnswerWaitMs: 20,
        hookAnswerPollMs: 1,
        screenAnswerRearmDelaysMs: [],
        ...over,
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    return fx;
  }

  it('odpowiedź z karty z hooka jedzie PLIKIEM, bez ani jednego klawisza', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers);
    const card = questions(fx.events)[0];
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

    expect(outcome.kind).toBe('applied');
    // Klucz mapy to DOKŁADNA treść pytania z `tool_input` — CLI dopasowuje po niej.
    expect(answers.written)
      .toEqual([{ key: KEY, answers: { 'Które dodatki do lodów?': 'Polewa' } }]);
    expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
    // Własna metoda w dzienniku: bez niej ta droga byłaby w śledztwie niewidoczna.
    const entry = fx.audit.find((e) => e.method === 'answer-hook');
    expect(entry?.toolName).toBe('AskUserQuestion');
    expect(entry?.optionLabel).toBe('Polewa');
    expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
  });

  /*
   * NOTATKI: notatka do wybranej opcji jedzie WYŁĄCZNIE plikiem hooka, w `annotations`
   * z ORYGINAŁEM podglądu tej opcji, bo CLI oddaje go modelowi jako `selected preview`; sam CLI
   * `annotations` nie waliduje (pomiar na CLI 2.1.288 i 2.1.293: ucięty podgląd przeszedł).
   * Odpowiedź z notatką NIGDY nie spada na tor cyfry — cyfra dowiozłaby sam wybór, a notatka
   * przepadłaby po cichu.
   */
  const PODGLAD_POLEWA = `${'│ polewa │\n'.repeat(600)}└────────┘`;
  const notedDump = (): Record<string, unknown> => hookDump({
    toolInput: {
      questions: [{
        question: 'Które dodatki do lodów?',
        header: 'Dodatki',
        multiSelect: false,
        options: [
          { label: 'Posypka' }, { label: 'Polewa', preview: PODGLAD_POLEWA },
          { label: 'Bita śmietana', preview: '(chmurka)' },
        ],
      }],
    },
  });

  it('notatka jedzie w `annotations` z ORYGINAŁEM podglądu wybranej opcji', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, notedDump());
    const card = questions(fx.events)[0];
    // Driver niesie podgląd w CAŁOŚCI (kopię dla klientów tnie dopiero manager).
    expect(card?.questions[0]?.options.find((o) => o.label === 'Polewa')?.preview).toBe(PODGLAD_POLEWA);
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']], ['bez orzechów']);

    expect(outcome.kind).toBe('applied');
    expect(answers.written).toEqual([{
      key: KEY,
      answers: { 'Które dodatki do lodów?': 'Polewa' },
      annotations: { 'Które dodatki do lodów?': { notes: 'bez orzechów', preview: PODGLAD_POLEWA } },
    }]);
    expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
    // Dziennik dostaje LICZBĘ notatek, nie ich treść.
    const entry = fx.audit.find((e) => e.method === 'answer-hook');
    expect(entry?.notes).toBe(1);
    expect(JSON.stringify(fx.audit)).not.toContain('bez orzechów');
  });

  it('opcja BEZ podglądu jedzie samą notatką; pusta notatka = zwykła odpowiedź', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, notedDump());
    const card = questions(fx.events)[0];

    await fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka']], ['tylko trochę']);
    expect(answers.written[0]?.annotations).toEqual({ 'Które dodatki do lodów?': { notes: 'tylko trochę' } });

    const answers2 = new FakeAnswers();
    const fx2 = await withCard(answers2, notedDump());
    const card2 = questions(fx2.events)[0];
    await fx2.driver.answerQuestion(card2?.reqId ?? '', [['Polewa']], ['   ']);
    expect(answers2.written).toEqual([{ key: KEY, answers: { 'Które dodatki do lodów?': 'Polewa' } }]);
  });

  it('hook NIE odebrał pliku z notatką → odmowa, ŻADNEJ cyfry, notatka cytowana w transkrypcie', async () => {
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, notedDump());
    const card = questions(fx.events)[0];
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']], ['bez orzechów']);

    expect(outcome).toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(answers.cleared, 'niezużyty plik skasowany').toHaveLength(1);
    expect(fx.client.mutations, 'cyfra zgubiłaby notatkę — nie poszła').toBe(before);
    expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
    expect(systemTexts(fx.events).some((text) => text.includes('“bez orzechów”'))).toBe(true);
    // Kanał tego zrzutu jest martwy: następna karta odpowiada cyfrą i pola notatki nie dostaje.
    await waitFor(() => questions(fx.events).length > 1, 'karta odbudowana');
    const rebuilt = fx.events.filter((e) => e.type === 'question-request').at(-1);
    expect(rebuilt?.type === 'question-request' ? rebuilt.channel : null).toBe('keys');
  });

  it('notatka dłuższa niż 2000 znaków wraca do transkryptu W CAŁOŚCI', async () => {
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, notedDump());
    const card = questions(fx.events)[0];
    const long = `${'długa notatka '.repeat(214)}KONIEC NOTATKI`;
    expect(long.length).toBeGreaterThan(3000);

    await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']], [long]);

    expect(systemTexts(fx.events).some((text) => text.includes(long))).toBe(true);
  });

  it('pytanie o treści „__proto__" nie gubi notatki ani nie spada do cyfry', async () => {
    const dump = (): Record<string, unknown> => hookDump({
      toolInput: {
        questions: [
          {
            question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
            options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
          },
          {
            question: '__proto__', header: 'Proto', multiSelect: false,
            options: [{ label: 'A', preview: 'podgląd A' }, { label: 'B' }],
          },
        ],
      },
    });
    const failing = new FakeAnswers();
    failing.failWrite = true;
    const fx = await withCard(failing, dump());
    const card = questions(fx.events)[0];
    const before = fx.client.mutations;
    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa'], ['A']], [null, 'uwaga']);
    expect(outcome).toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(fx.client.mutations, 'żadnej cyfry mimo notatki').toBe(before);

    const ok = new FakeAnswers();
    const fx2 = await withCard(ok, dump());
    const card2 = questions(fx2.events)[0];
    await fx2.driver.answerQuestion(card2?.reqId ?? '', [['Polewa'], ['A']], [null, 'uwaga']);
    const written = ok.written[0];
    expect(Object.hasOwn(written?.answers ?? {}, '__proto__')).toBe(true);
    expect(Object.hasOwn(written?.annotations ?? {}, '__proto__')).toBe(true);
    expect(JSON.stringify(written?.annotations)).toBe('{"__proto__":{"notes":"uwaga","preview":"podgląd A"}}');
  });

  it('nieudany zapis pliku z notatką → odmowa bez cyfry, karta ZOSTAJE (szkic na telefonie)', async () => {
    const answers = new FakeAnswers();
    answers.failWrite = true;
    const fx = await withCard(answers, notedDump());
    const card = questions(fx.events)[0];
    const before = fx.client.mutations;
    const cleared = fx.events.filter((e) => e.type === 'permission-cleared').length;

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']], ['bez orzechów']);

    expect(outcome).toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(fx.client.mutations).toBe(before);
    expect(fx.events.filter((e) => e.type === 'permission-cleared')).toHaveLength(cleared);
    expect(fx.audit.filter((e) => e.method === 'refuse').map((e) => e.reason)).toEqual(['send-failed']);
  });

  it('notatka na karcie CYFROWEJ (bez kanału hooka) → odmowa bez klawisza', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, null);
    const card = questions(fx.events)[0];
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']], ['bez orzechów']);

    expect(outcome).toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(fx.client.mutations).toBe(before);
    expect(answers.written).toEqual([]);
  });

  it('notatka do WOLNEGO TEKSTU (nie opcji z listy) → odmowa, nic nie wychodzi', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, notedDump());
    const card = questions(fx.events)[0];

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['coś swojego']], ['i notatka']);

    expect(outcome).toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(answers.written).toEqual([]);
  });

  it('WOLNY TEKST z pola „Własna odpowiedź" jedzie do pliku DOSŁOWNIE', async () => {
    /*
     * Pole karty kanału hooka oddaje zdanie, którego nie ma na żadnej liście
     * opcji. Driver nie ma prawa go dopasowywać ani przycinać: CLI nie waliduje `answers`
     * względem `options[].label` (CLI 2.1.257), więc to, co człowiek napisał, jest
     * odpowiedzią.
     */
    const answers = new FakeAnswers();
    const fx = await withCard(answers);
    const card = questions(fx.events)[0];
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(
      card?.reqId ?? '', [['Poproszę dwie polewy i bez orzechów']],
    );

    expect(outcome.kind).toBe('applied');
    expect(answers.written).toEqual([{
      key: KEY,
      answers: { 'Które dodatki do lodów?': 'Poproszę dwie polewy i bez orzechów' },
    }]);
    expect(fx.client.mutations, 'wolny tekst nie ma jak pojechać klawiszem').toBe(before);
    expect(fx.audit.find((e) => e.method === 'answer-hook')?.optionLabel)
      .toBe('Poproszę dwie polewy i bez orzechów');
  });

  it('niezużyty plik jest KASOWANY, a odpowiedź wraca na tor cyfry', async () => {
    /*
     * Hook już nie czeka (timeout, restart Raroga, biurko było pierwsze). Plik MUSI zniknąć —
     * gdyby został, odpowiedziałby na NASTĘPNE pytanie tej sesji (CLI 2.1.257).
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers);
    const card = questions(fx.events)[0];

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

    expect(outcome.kind).toBe('applied');
    expect(answers.cleared).toHaveLength(1);
    // Fallback: poszła cyfra z ekranu, przez zwykły cross-check etykiety.
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel))
      .toEqual(['Polewa']);
  });

  /**
   * OKNO CZEKANIA NA HOOK — najkrótsza droga do fałszywego fallbacku.
   *
   * Między zapisem pliku a jego zużyciem CLI zamyka formularz, a zegar oceny trafia w środek
   * PRZEMALOWANIA: ekran parsuje się na tyle, żeby nie być „nieczytelnym" (osłona ekranu
   * nieczytelnego go nie łapie), i na tyle mało, żeby nie dać karty. Osłona „okno po własnej
   * odpowiedzi" uzbraja się więc PRZED czekaniem; inaczej telefon dostałby w tej dziurze kartę
   * „Dialog w terminalu" — bez przycisków i na sekundę, do przejścia panelu w `working`.
   */
  it('okno czekania na zużycie pliku nie wystawia fallbacku „w terminalu"', async () => {
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, hookDump(), {
      hookAnswerWaitMs: 3000, hookAnswerPollMs: 5, blockedPollMs: 5, screenCacheMs: 0,
    });
    const card = questions(fx.events)[0];

    const decided = fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);
    // Formularz w trakcie zamykania: ekran parsuje się jako zakładka WIELOKROTNA cudzego
    // formularza, więc zrzut hooka do niego nie pasuje i karty z niego nie ma.
    fx.client.screenText = DIALOG_MULTIQ_TAB2;
    await quiet();

    expect(screenDialogs(fx.events), 'żadnej karty bez przycisków w oknie czekania')
      .toEqual([]);
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'))).toEqual([]);
    // Hook w końcu zużywa plik — wynik ten sam co zawsze.
    answers.stillPending = false;
    expect((await decided).kind).toBe('applied');
  });

  it('NOWA blokada w oknie czekania dostaje kartę normalnie', async () => {
    /*
     * Osłona jest związana z NUMEREM blokady, więc rozpada się sama, gdy w tym samym oknie
     * stanie prawdziwy nowy dialog: wcześniejsze uzbrojenie nie ma prawa go zamaskować.
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, hookDump(), {
      hookAnswerWaitMs: 3000, hookAnswerPollMs: 5, blockedPollMs: 5, screenCacheMs: 0,
    });
    const card = questions(fx.events)[0];

    const decided = fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);
    fx.client.screenText = DIALOG_PERMISSION;
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta nowej zgody');

    answers.stillPending = false;
    expect((await decided).kind).toBe('applied');
  });

  it('zrzut z `PreToolUse` nie otwiera kanału — tam proces hooka już nie żyje', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, hookDump({ hookEventName: 'PreToolUse' }));
    const card = questions(fx.events)[0];

    await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

    expect(answers.written).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'approve')).toHaveLength(1);
  });

  it('zrzut BEZ `answerKey` (stara instalacja hooka) nie otwiera kanału', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, hookDump({ answerKey: undefined }));
    const card = questions(fx.events)[0];

    await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

    expect(answers.written).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'approve')).toHaveLength(1);
  });

  /**
   * Zrzut TRZECH pytań, w tym jednego wielokrotnego — ekran pokazuje tylko pierwsze.
   *
   * Zakładka 2 i 3 nie mają na ekranie ANI JEDNEJ linii; jedynym ich źródłem jest payload.
   * O to w tym etapie chodzi: `allow` domyka całe wywołanie, więc karta musi nieść komplet.
   */
  const TRZY_PYTANIA = hookDump({
    toolInput: {
      questions: [
        {
          question: 'Które dodatki do lodów?',
          header: 'Dodatki',
          multiSelect: false,
          options: [
            { label: 'Posypka', description: 'Kolorowa' },
            { label: 'Polewa', description: 'Czekoladowa' },
            { label: 'Bita śmietana', description: 'Domowa' },
          ],
        },
        {
          question: 'A jaki kubek?',
          header: 'Kubek',
          multiSelect: false,
          options: [{ label: 'Mały' }, { label: 'Duży' }],
        },
        {
          question: 'Co dosypać na wierzch?',
          header: 'Wierzch',
          multiSelect: true,
          options: [{ label: 'Orzechy' }, { label: 'Wiórki' }, { label: 'Nic' }],
        },
      ],
    },
  });

  it('karta z kanału hooka niesie KOMPLET pytań ze zrzutu, nie jedną zakładkę', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, TRZY_PYTANIA);
    const card = questions(fx.events).at(-1);

    expect(card?.channel).toBe('hook');
    expect(card?.questions.map((q) => q.question)).toEqual([
      'Które dodatki do lodów?', 'A jaki kubek?', 'Co dosypać na wierzch?',
    ]);
    // Etykiety i opisy jadą Z PAYLOADU: ekran o zakładkach 2–3 nie wie nic, a chrome CLI
    // („Type something", „Chat about this") nie jest odpowiedzią i na tej karcie go nie ma.
    expect(card?.questions[0]?.options.map((o) => o.label))
      .toEqual(['Posypka', 'Polewa', 'Bita śmietana']);
    expect(card?.questions[0]?.options[1]?.description).toBe('Czekoladowa');
    // `multiSelect` autora pytania przestał być powodem odmowy na TEJ ścieżce:
    // odpowiedź jedzie tekstem w pliku, więc karta ma go nieść, a nie odbierać przyciski.
    expect(card?.questions[2]?.multiSelect).toBe(true);
    expect(screenDialogs(fx.events), 'żadnego fallbacku „odpowiedz w terminalu"').toEqual([]);
  });

  it('odpowiedź na TRZY pytania (w tym multiSelect) jedzie JEDNYM plikiem', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, TRZY_PYTANIA);
    const card = questions(fx.events).at(-1);
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(
      card?.reqId ?? '', [['Polewa'], ['Duży'], ['Orzechy', 'Wiórki']],
    );

    expect(outcome.kind).toBe('applied');
    // Klucze to DOSŁOWNE treści pytań z payloadu (po nich dopasowuje CLI), a wiele wartości
    // to jeden string po przecinku — dokładnie to, co przyjmuje CLI 2.1.257.
    expect(answers.written).toEqual([{
      key: KEY,
      answers: {
        'Które dodatki do lodów?': 'Polewa',
        'A jaki kubek?': 'Duży',
        'Co dosypać na wierzch?': 'Orzechy, Wiórki',
      },
    }]);
    expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
    expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
  });

  it('odpowiedź NIEPEŁNA nie jedzie kanałem — plik z dziurą domknąłby turę pustką', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, TRZY_PYTANIA);
    const card = questions(fx.events).at(-1);

    // Karta ma trzy pytania, odpowiedź niesie jedno: `allow` zamknąłby wywołanie z pustką
    // na resztę, więc kanał odpada i zostaje zwykła cyfra za zakładkę z ekranu.
    await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

    expect(answers.written).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel))
      .toEqual(['Polewa']);
  });

  it('niezużyty plik przy KILKU pytaniach: cyfra za pytanie z EKRANU, kanał zamknięty', async () => {
    /*
     * Hook nie odebrał (timeout, `kill`, biurko pierwsze). Cyfra dowozi WYŁĄCZNIE zakładkę
     * stojącą na ekranie, więc: (a) mówimy o tym wprost i po imieniu, (b) klucz idzie na
     * czarną listę, żeby następna karta tego formularza była już jednozakładkowa — inaczej
     * odpowiedź na pytanie 1 trafiałaby w zakładkę 2.
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, TRZY_PYTANIA);
    const card = questions(fx.events).at(-1);

    const outcome = await fx.driver.answerQuestion(
      card?.reqId ?? '', [['Polewa'], ['Duży'], ['Orzechy']],
    );

    expect(outcome.kind).toBe('applied');
    expect(answers.cleared).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel))
      .toEqual(['Polewa']);
    // Zdanie NAZYWA pytanie, które pojechało — „pierwsze" bywa nieprawdą (patrz test niżej).
    expect(systemTexts(fx.events).some((t) => t.includes('Które dodatki do lodów?'))).toBe(true);

    // Kanał jest zamknięty dla tego zrzutu: kolejna karta ma nieść jedno pytanie i cyfry.
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 9, title: '' });
    await waitFor(() => questions(fx.events).length > 1, 'karta po zamknięciu kanału');
    const nastepna = questions(fx.events).at(-1);
    expect(nastepna?.channel).toBe('keys');
    expect(nastepna?.questions).toHaveLength(1);
  });

  /**
   * Ekran stoi na DRUGIM pytaniu payloadu, a oba mają te same etykiety.
   *
   * Tak wygląda formularz przełączony na zakładkę 2 przy biurku (zakładki idą bez mignięcia
   * `agent_status`), po którym karta odbudowała się z kompletem pytań. Fallback cyfrą MUSI
   * wysłać odpowiedź na pytanie z ekranu — wybór `answers[0]` zapisywałby odpowiedź na
   * pytanie 1 jako odpowiedź na pytanie 2, bo `#digitStillHolds` porównuje samą etykietę.
   */
  const KOLIZJA_ETYKIET = hookDump({
    toolInput: {
      questions: [
        {
          question: 'Co na pierwszą gałkę?',
          header: 'Gałka',
          multiSelect: false,
          options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
        },
        {
          question: 'Które dodatki do lodów?',
          header: 'Dodatki',
          multiSelect: false,
          options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
        },
      ],
    },
  });

  it('niezużyty plik: cyfra niesie odpowiedź na pytanie Z EKRANU, nie na pierwsze z karty', async () => {
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, KOLIZJA_ETYKIET);
    const card = questions(fx.events).at(-1);
    expect(card?.questions.map((q) => q.question))
      .toEqual(['Co na pierwszą gałkę?', 'Które dodatki do lodów?']);

    // Pytanie 1 → „Posypka", pytanie 2 (to z ekranu) → „Bita śmietana".
    const outcome = await fx.driver.answerQuestion(
      card?.reqId ?? '', [['Posypka'], ['Bita śmietana']],
    );

    expect(outcome.kind).toBe('applied');
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel))
      .toEqual(['Bita śmietana']);
    expect(systemTexts(fx.events).some((t) => t.includes('Które dodatki do lodów?'))).toBe(true);
    expect(systemTexts(fx.events).some((t) => t.includes('Co na pierwszą gałkę?'))).toBe(false);
  });

  it('`multiSelect: true` z hooka DOSTAJE kartę, a po śmierci kanału odmawia UCZCIWIE', async () => {
    /*
     * Bez kanału ten formularz jest kartą-fallbackiem („wielokrotny wybór zrób w terminalu") —
     * i słusznie, bo cyfra przełącza tam checkbox, a nie odpowiada. Z kanałem odpowiedź jedzie
     * tekstem, więc karta ma przyciski. Gdy kanał umrze, wracamy do tej samej prawdy co
     * wcześniej: cyfrą tego nie zrobimy i mówimy o tym POWODEM, a nie „ekran się zmienił".
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withCard(answers, hookDump({
      toolInput: {
        questions: [{
          question: 'Które dodatki do lodów?',
          header: 'Dodatki',
          multiSelect: true,
          options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
        }],
      },
    }));
    const card = questions(fx.events).at(-1);
    expect(card?.channel).toBe('hook');
    expect(card?.questions[0]?.multiSelect).toBe(true);

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka', 'Polewa']]);

    expect(answers.written).toEqual([
      { key: KEY, answers: { 'Które dodatki do lodów?': 'Posypka, Polewa' } },
    ]);
    expect(outcome).toEqual({ kind: 'refused', reason: 'multi-select' });
    expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
  });

  it('formularz `multiSelect` przez hook: opcje bez `terminalOnly`, odpowiedź plikiem przyjęta', async () => {
    /*
     * Polityka opcji w kanale `hook` (`optionPolicy`): wielokrotny wybór blokuje tylko cyfrę, a odpowiedź plikiem
     * niesie tekst. Karta nie może więc zgasić opcji za `multiSelect`, a odebrany plik kończy odpowiedź bez klawisza.
     */
    const answers = new FakeAnswers();
    const fx = await withCard(answers, hookDump({
      toolInput: {
        questions: [{
          question: 'Które dodatki do lodów?',
          header: 'Dodatki',
          multiSelect: true,
          options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
        }],
      },
    }));
    const card = questions(fx.events).at(-1);
    expect(card?.channel).toBe('hook');
    expect(card?.questions[0]?.multiSelect).toBe(true);
    expect(card?.questions[0]?.options.map((o) => o.label)).toEqual(['Posypka', 'Polewa', 'Bita śmietana']);
    expect(card?.questions[0]?.options.filter((o) => o.terminalOnly === true)).toEqual([]);
    const before = fx.client.mutations;

    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka', 'Polewa']]);

    expect(outcome.kind).toBe('applied');
    expect(answers.written).toEqual([
      { key: KEY, answers: { 'Które dodatki do lodów?': 'Posypka, Polewa' } },
    ]);
    expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
    expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
  });

  /*
   * Karta kanału hooka liczy `terminalOnly` na etykiecie w postaci kanonicznej, tak jak bramka `#answerViaHook`
   * porównuje odpowiedź. Na SUROWEJ etykiecie autora złamanie linii w środku markera gubiłoby flagę na karcie,
   * a spacja na końcu gubiłaby odmowę serwera przy fladze na karcie.
   */
  it.each([
    ['złamanie linii w markerze', 'Yes, for this\nsession', 'Yes, for this session'],
    ['spacja na końcu', 'Always allow ', 'Always allow'],
  ])('opcja eskalująca w kanale hooka (%s): karta `terminalOnly`, odmowa bez pliku', async (_case, label, onScreen) => {
    const answers = new FakeAnswers();
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        readPendingHook: () => hookDump({
          toolInput: {
            questions: [{
              question: 'Które dodatki do lodów?',
              header: 'Dodatki',
              multiSelect: false,
              options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label }],
            }],
          },
        }) as unknown as PendingHookTool,
        hookAnswers: answers,
        hookAnswerWaitMs: 20,
        hookAnswerPollMs: 1,
        screenAnswerRearmDelaysMs: [],
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${onScreen}`);
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    const card = questions(fx.events)[0];
    expect(card?.channel).toBe('hook');
    // Etykieta na karcie zostaje dosłowna (tak wraca do CLI), flaga z postaci kanonicznej.
    expect(card?.questions[0]?.options).toEqual([
      { label: 'Posypka', role: 'answer' },
      { label: 'Polewa', role: 'answer' },
      { label, terminalOnly: true, role: 'answer' },
    ]);
    const before = fx.client.mutations;

    await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[label]]))
      .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
    expect(answers.written, 'plik odpowiedzi nie powstał').toEqual([]);
    expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
    expect(fx.audit.filter((e) => e.method === 'answer-hook' || e.method === 'approve')).toEqual([]);
  });

  /*
   * `canonicalLabel` ucina etykietę do `OPTION_LABEL_MAX_CHARS` (200), więc polityka
   * liczona na niej gubiłaby marker eskalacji za tą granicą. Karta i lista `blocked` wychodziłyby bez blokady,
   * a `#answerViaHook` przepuszczałby plik. Polityka idzie na pełnej etykiecie, klucz `blocked` zostaje kanoniczny.
   */
  const DLUGA = `Zapis w katalogu ${'x'.repeat(190)}, for this session`;
  it.each([
    {
      gdzie: 'w pytaniu z ekranu',
      pytania: [{
        question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
        options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: DLUGA }],
      }],
      ekran: DIALOG.replace('3. Bita śmietana', `3. ${DLUGA}`),
      odpowiedz: [[DLUGA]],
      indeks: 0,
    },
    {
      gdzie: 'w pytaniu, którego ekran nie pokazuje',
      pytania: [
        {
          question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
          options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
        },
        {
          question: 'Gdzie zapisać zamówienie?', header: 'Zapis', multiSelect: false,
          options: [{ label: 'Do notatek' }, { label: DLUGA }],
        },
      ],
      ekran: DIALOG,
      odpowiedz: [['Polewa'], [DLUGA]],
      indeks: 1,
    },
  ])('marker eskalacji za 200. znakiem etykiety ($gdzie): `terminalOnly`, odmowa bez pliku', async (przypadek) => {
    expect(DLUGA.length).toBeGreaterThan(200);
    expect(DLUGA.indexOf('this session')).toBeGreaterThan(200);
    const answers = new FakeAnswers();
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        readPendingHook: () => hookDump({ toolInput: { questions: przypadek.pytania } }) as unknown as PendingHookTool,
        hookAnswers: answers,
        hookAnswerWaitMs: 20,
        hookAnswerPollMs: 1,
        screenAnswerRearmDelaysMs: [],
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = przypadek.ekran;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    const card = questions(fx.events)[0];
    expect(card?.channel).toBe('hook');
    expect(card?.questions).toHaveLength(przypadek.pytania.length);
    // Etykieta na karcie zostaje dosłowna i pełna; flaga z polityki na pełnej etykiecie.
    expect(card?.questions[przypadek.indeks]?.options.find((o) => o.label === DLUGA))
      .toEqual({ label: DLUGA, terminalOnly: true, role: 'answer' });
    const before = fx.client.mutations;

    await expect(fx.driver.answerQuestion(card?.reqId ?? '', przypadek.odpowiedz))
      .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
    expect(answers.written, 'plik odpowiedzi nie powstał').toEqual([]);
    expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
    expect(fx.audit.filter((e) => e.method === 'answer-hook' || e.method === 'approve')).toEqual([]);
  });

  /*
   * Odpowiedź niepełna (mniej grup niż pytań) omija kanał hooka i jego listę `blocked`: idzie prosto do bramki
   * cyfry, która ocenia uciętą etykietę z ekranu. Karta kanału hooka oznaczyła opcję `terminalOnly` na pełnej
   * etykiecie, więc bramka cyfry ma odmówić tak samo, pełną etykietą i samym prefiksem bez markera.
   */
  it.each([
    ['pełną etykietę', DLUGA],
    ['sam 200-znakowy prefiks bez markera', DLUGA.slice(0, 200)],
  ])('marker za 200. znakiem, odpowiedź niepełna na tor cyfry (klient wysyła %s): odmowa bez klawisza',
    async (_case, wyslana) => {
      const answers = new FakeAnswers();
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie o dodatki'),
        deps: {
          readPendingHook: () => hookDump({
            toolInput: {
              questions: [
                {
                  question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
                  options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: DLUGA }],
                },
                {
                  question: 'Gdzie zapisać zamówienie?', header: 'Zapis', multiSelect: false,
                  options: [{ label: 'Do notatek' }, { label: 'Do kalendarza' }],
                },
              ],
            },
          }) as unknown as PendingHookTool,
          hookAnswers: answers,
          hookAnswerWaitMs: 20,
          hookAnswerPollMs: 1,
          screenAnswerRearmDelaysMs: [],
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${DLUGA}`);
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

      const card = questions(fx.events)[0];
      expect(card?.channel).toBe('hook');
      expect(card?.questions).toHaveLength(2);
      expect(card?.questions[0]?.options.find((o) => o.label === DLUGA)?.terminalOnly).toBe(true);
      const before = fx.client.mutations;

      await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[wyslana]]))
        .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
      expect(answers.written, 'plik odpowiedzi nie powstał').toEqual([]);
      expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
      expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
      expect(fx.audit.filter((e) => e.method === 'answer-hook' || e.method === 'approve')).toEqual([]);
    });

  /*
   * Karta z hooka w kanale `keys` (zrzut `PreToolUse`, proces hooka już nie czeka) ma etykiety z ekranu, ucięte do
   * `OPTION_LABEL_MAX_CHARS` (200). Flagę `terminalOnly` liczy też na pełnej etykiecie z payloadu, jak karta kanału
   * hooka, więc marker za 200. znakiem zabiera przycisk, a bramka cyfry odmawia pełnej etykiety i prefiksu.
   */
  const zrzutKeys = (etykieta: string): PendingHookTool => hookDump({
    hookEventName: 'PreToolUse',
    toolInput: {
      questions: [{
        question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
        options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: etykieta }],
      }],
    },
  }) as unknown as PendingHookTool;

  it.each([
    ['pełną etykietę', DLUGA],
    ['sam 200-znakowy prefiks bez markera', DLUGA.slice(0, 200)],
  ])('karta z hooka w kanale `keys`: marker za 200. znakiem daje `terminalOnly` i odmowę cyfry (klient wysyła %s)',
    async (_case, wyslana) => {
      const answers = new FakeAnswers();
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie o dodatki'),
        deps: {
          readPendingHook: () => zrzutKeys(DLUGA),
          hookAnswers: answers,
          hookAnswerWaitMs: 20,
          hookAnswerPollMs: 1,
          screenAnswerRearmDelaysMs: [],
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${DLUGA}`);
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

      const card = questions(fx.events)[0];
      expect(card?.channel).toBe('keys');
      // Etykieta na karcie zostaje ta z ekranu (ucięta), flaga z pełnej etykiety payloadu.
      expect(card?.questions[0]?.options.find((o) => o.label === DLUGA.slice(0, 200))?.terminalOnly).toBe(true);
      const before = fx.client.mutations;

      await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[wyslana]]))
        .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
      expect(answers.written, 'plik odpowiedzi nie powstał').toEqual([]);
      expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
      expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
      expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
    });

  it('karta z hooka w kanale `keys`: długa etykieta BEZ markera eskalacji dalej idzie cyfrą', async () => {
    const DLUGA_ZWYKLA = `Zapis w katalogu ${'x'.repeat(190)}, z kopią zapasową`;
    const answers = new FakeAnswers();
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        readPendingHook: () => zrzutKeys(DLUGA_ZWYKLA),
        hookAnswers: answers,
        hookAnswerWaitMs: 20,
        hookAnswerPollMs: 1,
        screenAnswerRearmDelaysMs: [],
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${DLUGA_ZWYKLA}`);
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

    const card = questions(fx.events)[0];
    expect(card?.channel).toBe('keys');
    const opcja = card?.questions[0]?.options.find((o) => o.label === DLUGA_ZWYKLA.slice(0, 200));
    expect(opcja).toBeDefined();
    expect(opcja?.terminalOnly).toBeUndefined();
    const before = fx.client.mutations;

    fx.driver.answerQuestion(card?.reqId ?? '', [[opcja?.label ?? '']]);
    await waitFor(() => fx.client.mutations > before, 'cyfra długiej opcji');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['3']]);
    expect(answers.written).toEqual([]);
  });

  /*
   * Spacja na 200. pozycji etykiety: cięcie na sufit zostawiało ją na końcu klucza, a ponowna
   * kanonizacja etykiety już kanonicznej (opcja z ekranu → `terminalOnlyLabels`) ją ucinała. Klucz z karty miał
   * wtedy 199 znaków, klucz odpowiedzi 200, i bramka cyfry przepuszczała opcję oznaczoną `terminalOnly`.
   */
  const SPACJA_NA_SUFICIE = `${'x'.repeat(199)} for this session`;
  it.each([
    ['pełną etykietę', SPACJA_NA_SUFICIE],
    ['sam 200-znakowy prefiks ze spacją na końcu', SPACJA_NA_SUFICIE.slice(0, 200)],
  ])('karta z hooka w kanale `keys`: spacja na 200. pozycji nie rozjeżdża klucza karty i bramki (klient wysyła %s)',
    async (_case, wyslana) => {
      const answers = new FakeAnswers();
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie o dodatki'),
        deps: {
          readPendingHook: () => zrzutKeys(SPACJA_NA_SUFICIE),
          hookAnswers: answers,
          hookAnswerWaitMs: 20,
          hookAnswerPollMs: 1,
          screenAnswerRearmDelaysMs: [],
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${SPACJA_NA_SUFICIE}`);
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania');

      const card = questions(fx.events)[0];
      expect(card?.channel).toBe('keys');
      expect(card?.questions[0]?.options.find((o) => o.label === 'x'.repeat(199))?.terminalOnly).toBe(true);
      const before = fx.client.mutations;

      await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[wyslana]]))
        .resolves.toEqual({ kind: 'refused', reason: 'terminal-only' });
      expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
      expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
    });

  /*
   * Karta podmieniona w oknie czekania na plik: odpowiedź przyszła na kartę ze zwykłą opcją, a w
   * czasie czekania nowy zrzut i nowy ekran wystawiły kartę z opcją eskalującą o tym samym 200-znakowym początku
   * (ta sama cyfra, ta sama etykieta z ekranu). Fallback brał opcję i listę `terminalOnlyLabels` ze starej karty,
   * a świeży odczyt sprawdzał odcisk nowej, więc cyfra wychodziła w dialog, którego człowiek nie widział.
   */
  it('karta podmieniona w oknie czekania na plik: fallback odmawia jak przy nieaktualnej karcie, bez cyfry',
    async () => {
      const ZWYKLA = `${'x'.repeat(205)}, zwykła opcja`;
      const ESKALUJACA = `${'x'.repeat(205)}, for this session`;
      const pytanie = (etykieta: string): Record<string, unknown> => ({
        questions: [{
          question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
          options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: etykieta }],
        }],
      });
      const answers = new FakeAnswers();
      answers.stillPending = true;
      let dump = hookDump({ toolInput: pytanie(ZWYKLA) });
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie o dodatki'),
        deps: {
          readPendingHook: () => dump as unknown as PendingHookTool,
          hookAnswers: answers,
          hookAnswerWaitMs: 1500,
          hookAnswerPollMs: 5,
          blockedPollMs: 5,
          screenCacheMs: 0,
          screenAnswerRearmDelaysMs: [],
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${ZWYKLA}`);
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
      const card = questions(fx.events)[0];
      expect(card?.channel).toBe('hook');
      const before = fx.client.mutations;

      const decided = fx.driver.answerQuestion(card?.reqId ?? '', [[ZWYKLA]]);
      dump = hookDump({
        at: 22, answerKey: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee-ffffffffffffffff', toolInput: pytanie(ESKALUJACA),
      });
      fx.client.screenText = DIALOG.replace('3. Bita śmietana', `3. ${ESKALUJACA}`);
      await waitFor(() => questions(fx.events).length > 1, 'nowa karta w oknie czekania');
      const nowa = questions(fx.events).at(-1);
      expect(nowa?.reqId).not.toBe(card?.reqId);
      expect(nowa?.questions[0]?.options.find((o) => o.label === ESKALUJACA)?.terminalOnly).toBe(true);

      await expect(decided).resolves.toEqual({ kind: 'refused', reason: 'stale-card' });
      expect(fx.client.mutations, 'do panelu nie idzie ŻADEN klawisz').toBe(before);
      expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
      expect(fx.audit.filter((e) => e.method === 'approve')).toEqual([]);
      // Nowa karta zostaje: mówi prawdę o ekranie.
      expect(fx.events.filter((e) => e.type === 'permission-cleared' && e.reqId === nowa?.reqId)).toEqual([]);
    });

  /*
   * Odpowiedź Z NOTATKĄ, której pliku hook nie odebrał, a kartę podmieniono w oknie czekania: odmowa notatki gasiła
   * kartę BIEŻĄCĄ, czyli nową, a telefon dostawał `permission-cleared` dla karty, która mówi prawdę o ekranie.
   */
  it('notatka nieodebrana po podmianie karty: odmowa z notatką w transkrypcie, nowa karta zostaje', async () => {
    const pytanie = (trzecia: string): Record<string, unknown> => ({
      questions: [{
        question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
        options: [{ label: 'Posypka' }, { label: 'Polewa', preview: '(polewa)' }, { label: trzecia }],
      }],
    });
    const answers = new FakeAnswers();
    answers.stillPending = true;
    let dump = hookDump({ toolInput: pytanie('Bita śmietana') });
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        readPendingHook: () => dump as unknown as PendingHookTool,
        hookAnswers: answers,
        hookAnswerWaitMs: 1500,
        hookAnswerPollMs: 5,
        blockedPollMs: 5,
        screenCacheMs: 0,
        screenAnswerRearmDelaysMs: [],
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = DIALOG;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    const card = questions(fx.events)[0];
    expect(card?.channel).toBe('hook');
    const before = fx.client.mutations;

    const decided = fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']], ['bez orzechów']);
    dump = hookDump({
      at: 22, answerKey: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee-ffffffffffffffff', toolInput: pytanie('Karmel'),
    });
    fx.client.screenText = DIALOG.replace('3. Bita śmietana', '3. Karmel');
    await waitFor(() => questions(fx.events).length > 1, 'nowa karta w oknie czekania');
    const nowa = questions(fx.events).at(-1);
    expect(nowa?.reqId).not.toBe(card?.reqId);

    await expect(decided).resolves.toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(fx.client.mutations, 'cyfra zgubiłaby notatkę — nie poszła').toBe(before);
    expect(systemTexts(fx.events).some((text) => text.includes('“bez orzechów”'))).toBe(true);
    const refusals = fx.audit.filter((e) => e.method === 'refuse');
    expect(refusals.map((e) => [e.reason, e.toolName])).toEqual([['send-failed', 'AskUserQuestion']]);
    // Nowa karta zostaje: mówi prawdę o ekranie, a jej kanał hooka żyje.
    expect(fx.events.filter((e) => e.type === 'permission-cleared' && e.reqId === nowa?.reqId)).toEqual([]);
  });

  it('karta CZYSTO EKRANOWA (bez zrzutu) nie ma kanału — hook o niej nic nie wie', async () => {
    const answers = new FakeAnswers();
    const fx = await withCard(answers, null);
    const card = questions(fx.events)[0];

    await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

    expect(answers.written).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'approve')).toHaveLength(1);
  });

  it('ŻADNA karta pytania nie czyta historii panelu', async () => {
    /*
     * Od CLI 2.1.267 blok `text` z wypowiedzią agenta znad formularza stoi w pliku PRZED
     * dialogiem, więc wstęp z historii panelu (`pane.read`) dublowałby transkrypt — a odczyt historii
     * to dodatkowy ruch na cudzym panelu przy KAŻDEJ karcie pytania.
     */
    const fx = await withCard(new FakeAnswers(), hookDump());
    const card = questions(fx.events).at(-1);

    expect(card?.channel).toBe('hook');
    expect(fx.client.calls.filter((c) => c.method === 'history')).toEqual([]);
  });

  /*
   * WPIS `tool_use` NAD STOJĄCYM DIALOGIEM (CLI 2.1.267).
   *
   * Od tej wersji formularz pytania ma swój wpis w jsonl JESZCZE ZANIM dialog stanie — do
   * 2.1.266 wchodził tam dopiero po decyzji. Bramka „jest wpis = po decyzji" zgasiłaby kanał
   * odpowiedzi na wszystkich pytaniach naraz. Te trzy testy pilnują ścieżki, na której
   * OBA źródła stoją naraz.
   */
  const PYTANIE_JSONL = {
    questions: [{
      question: 'Które dodatki do lodów?',
      header: 'Dodatki',
      multiSelect: false,
      options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' }],
    }],
  };

  /** Panel z kartą pytania, przy KTÓRYM w jsonl stoi już `tool_use` (2.1.267). */
  async function withJsonl(opts: {
    answers: FakeAnswers;
    dump: () => Record<string, unknown> | null;
    /** Payload wpisu `tool_use` — domyślnie ten sam, co w zrzucie. */
    input?: unknown;
    deps?: Partial<HerdrDriverDeps>;
  }): Promise<Fixture> {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie o dodatki'),
      deps: {
        readPendingHook: () => opts.dump() as unknown as PendingHookTool,
        hookAnswers: opts.answers,
        hookAnswerWaitMs: 20,
        hookAnswerPollMs: 1,
        ...opts.deps,
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, {
      id: 'q-2267', tool: 'AskUserQuestion', input: opts.input ?? PYTANIE_JSONL, screen: DIALOG,
    });
    return fx;
  }

  it('wpis w jsonl NIE zamyka kanału: karta `keys` przechodzi na `hook`, gdy zrzut dojdzie', async () => {
    const answers = new FakeAnswers();
    let dump: Record<string, unknown> | null = null;
    const fx = await withJsonl({
      answers,
      dump: () => dump,
      // Zegar oceny chodzi (`blockedPollMs`), bo zrzut dochodzi BEZ mignięcia `agent_status`:
      // hook zapisuje plik ~0,1 s po wpisie, a herdr o tym nie wie.
      deps: { blockedPollMs: 5, screenCacheMs: 0, screenAnswerRearmDelaysMs: [] },
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta z samego jsonl');
    expect(questions(fx.events)[0]?.channel).toBe('keys');

    dump = hookDump();
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).at(-1);
    const before = fx.client.mutations;
    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');

    expect(answers.written)
      .toEqual([{ key: KEY, answers: { 'Które dodatki do lodów?': 'Polewa' } }]);
    expect(fx.client.mutations, 'odpowiedź poszła plikiem, nie klawiszem').toBe(before);
  });

  it('po odpowiedzi plikiem wpis z jsonl NIE wraca kartą, zanim dojdzie `tool_result`', async () => {
    /*
     * `allow` domyka całe wywołanie, ale `tool_result` ląduje w pliku z opóźnieniem — przez
     * kilka obrotów oceny `pending` opisuje formularz, na który człowiek właśnie odpowiedział,
     * a ekran jest w środku przemalowania. Bez osłony telefon dostawał w tym oknie kartę
     * z tymi samymi pytaniami albo fallback „odpowiedz w terminalu".
     */
    const answers = new FakeAnswers();
    const fx = await withJsonl({
      answers,
      dump: () => hookDump(),
      // Timery ponownej oceny AKTYWNE: to one po odpowiedzi wymuszają odczyt ekranu od nowa.
      deps: { blockedPollMs: 5, screenCacheMs: 0, screenAnswerRearmDelaysMs: [2, 6] },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).at(-1);
    const kartyPrzed = questions(fx.events).length;

    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');
    // CLI zamyka formularz; herdr dalej widzi `blocked`, a jsonl dalej ma `tool_use`.
    fx.client.screenText = DIALOG_MULTIQ_TAB2;
    await quiet();

    expect(questions(fx.events), 'żadnej nowej karty pytania w oknie').toHaveLength(kartyPrzed);
    expect(screenDialogs(fx.events), 'żadnego fallbacku „odpowiedz w terminalu"').toEqual([]);
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'))).toEqual([]);
  });

  it('osłona po odpowiedzi trzyma się WYWOŁANIA, na które odpowiedziano', async () => {
    /*
     * Czekanie na zużycie pliku trwa do kilku sekund i tura potrafi w nim pójść dalej: wynik
     * pytania A dochodzi do jsonl, a CLI dopisuje `tool_use` pytania B. Gdyby osłona składała
     * się PO czekaniu, złapałaby wpis B i to JEMU odebrała kartę.
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withJsonl({
      answers,
      dump: () => hookDump(),
      deps: {
        hookAnswerWaitMs: 3000,
        hookAnswerPollMs: 5,
        blockedPollMs: 5,
        screenCacheMs: 0,
        screenAnswerRearmDelaysMs: [2, 6],
      },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);
    const kartyPrzed = questions(fx.events).length;

    const decided = fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);
    // Tura idzie dalej JESZCZE PRZED zużyciem pliku: wynik A i nowe pytanie B w tej samej blokadzie.
    const wiadomosciPrzed = fx.events.filter((e) => e.type === 'message').length;
    const pytanieB = {
      questions: [{
        question: 'A jaki kubek?',
        header: 'Kubek',
        multiSelect: false,
        options: [{ label: 'Mały' }, { label: 'Duży' }],
      }],
    };
    await appendFile(
      fx.transcript,
      toolResultLine('q-2267') + toolUseLine('q-2268', 'AskUserQuestion', pytanieB),
    );
    await waitFor(
      () => fx.events.filter((e) => e.type === 'message').length > wiadomosciPrzed,
      'follower zobaczył pytanie B',
    );
    answers.stillPending = false;
    expect((await decided).kind).toBe('applied');

    // Pytanie B MUSI dostać kartę: osłona dotyczy wywołania A, nie „czegokolwiek w jsonl".
    await waitFor(
      () => questions(fx.events).length > kartyPrzed
        && questions(fx.events).at(-1)?.questions[0]?.question === 'A jaki kubek?',
      'karta pytania B',
    );
  });

  it('osłona wpisu z jsonl stoi JUŻ W OKNIE czekania na zużycie pliku', async () => {
    /*
     * Najkrótsza droga do fałszywej karty odmowy.
     *
     * Czekanie na zużycie pliku trwa do kilku sekund, a CLI zamyka formularz w jego środku.
     * Ocena trafiona w to okno ma `pending` z jsonl (od CLI 2.1.267 `tool_use` stoi tam od
     * chwili postawienia dialogu) i ekran w środku PRZEMALOWANIA, więc cross-check zrzutu
     * nie przechodzi. Dopóki osłona składała się dopiero po `await`, ocena mijała gałąź
     * `pending === null` z osłoną `answeredSeq` i kończyła kartą degradacji — telefon
     * dostawał „odpowiedz w terminalu", a dziennik wpis odmowy.
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withJsonl({
      answers,
      dump: () => hookDump(),
      deps: {
        hookAnswerWaitMs: 3000,
        hookAnswerPollMs: 5,
        blockedPollMs: 5,
        screenCacheMs: 0,
        screenAnswerRearmDelaysMs: [],
      },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);
    const kartyPrzed = questions(fx.events).length;
    const zgodPrzed = permissions(fx.events).length;

    const decided = fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);
    // Formularz w trakcie zamykania: ekran parsuje się jako zakładka WIELOKROTNA cudzego
    // formularza, więc zrzut hooka do niego nie pasuje — a wpis w jsonl stoi dalej.
    fx.client.screenText = DIALOG_MULTIQ_TAB2;
    await quiet();

    expect(questions(fx.events), 'żadnej nowej karty pytania w oknie czekania')
      .toHaveLength(kartyPrzed);
    expect(permissions(fx.events), 'żadnej karty degradacji w oknie czekania')
      .toHaveLength(zgodPrzed);
    expect(screenDialogs(fx.events), 'żadnego fallbacku „odpowiedz w terminalu"').toEqual([]);
    expect(fx.audit.filter((e) => (e.method === 'refuse' || e.method === 'degrade'))).toEqual([]);

    // Hook w końcu zużywa plik — wynik ten sam co zawsze.
    answers.stillPending = false;
    expect((await decided).kind).toBe('applied');
  });

  it('plik niezużyty do timeoutu ZDEJMUJE osłonę: cyfra jedzie, a wpis z jsonl wraca kartą', async () => {
    /*
     * Osłonę uzbrajamy na wiarę, że odpowiedź poszła plikiem. Gdy hook go nie odebrał, wiara
     * była płonna: odpowiada CYFRA, a wpis `tool_use` opisuje pytanie wciąż nierozstrzygnięte.
     * Osłona zostawiona na miejscu zwracałaby na nim `KEEP` do końca blokady — ani karty na
     * torze cyfry, ani kart dla zakładek 2..n.
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withJsonl({
      answers,
      dump: () => hookDump(),
      deps: {
        hookAnswerWaitMs: 20,
        hookAnswerPollMs: 1,
        blockedPollMs: 5,
        screenCacheMs: 0,
        screenAnswerRearmDelaysMs: [2, 6],
      },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);

    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');

    // Niezużyty plik skasowany, odpowiedź pojechała cyfrą z ekranu.
    expect(answers.cleared).toHaveLength(1);
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel))
      .toEqual(['Polewa']);
    // I dowód, że osłona nie została: ten sam wpis w TEJ SAMEJ blokadzie znów dostaje kartę —
    // tym razem na torze cyfry, bo `#deadAnswerKey` zamknął kanał dla tego zrzutu.
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'keys'), 'karta na torze cyfry',
    );
  });

  it('zrzut PRZED wpisem z jsonl: dochodzący `tool_use` NIE podmienia karty ani jej `reqId`', async () => {
    /*
     * Zrzut hooka bywa PIERWSZY: driver czyta go synchronicznie przy każdej ocenie, a wpis
     * z jsonl dojeżdża przez followera (debounce plus odczyt pliku). Baza identyfikatora karty
     * liczy się wtedy z GENERACJI ZRZUTU (`hookPending ?? pending`) i wpis nie ma prawa jej
     * przestawić: w PWA karty adresuje `qId`, a jego zmiana buduje kartę od nowa — z pustym
     * polem „Własna odpowiedź", w środku pisania.
     */
    const answers = new FakeAnswers();
    const fx = await withCard(answers, hookDump(), {
      blockedPollMs: 5, screenCacheMs: 0, screenAnswerRearmDelaysMs: [],
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const przed = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);
    const ileKart = questions(fx.events).length;

    await appendFile(fx.transcript, toolUseLine('q-2267', 'AskUserQuestion', PYTANIE_JSONL));
    await quiet();

    expect(questions(fx.events), 'wpis z jsonl nie stawia drugiej karty').toHaveLength(ileKart);
    expect(questions(fx.events).at(-1)?.reqId).toBe(przed?.reqId);
  });

  it('po odpowiedzi plikiem kasowany jest zrzut O TYM kluczu, a nie plik sesji', async () => {
    /*
     * Nazwa pliku zrzutu jest jedna na sesję, a hook zapisuje pytanie B tej samej tury
     * natychmiast po A. Bezwarunkowe kasowanie zabierało więc treść pytaniu, na które nikt
     * jeszcze nie odpowiedział — karta B spadała do „odpowiedz w terminalu".
     */
    const answers = new FakeAnswers();
    const skasowane: [string, string | undefined][] = [];
    const fx = await withCard(answers, hookDump(), {
      clearPendingHook: (sid, answerKey) => { skasowane.push([sid, answerKey]); },
    });
    const card = questions(fx.events)[0];

    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');

    expect(skasowane).toEqual([[SESSION, KEY]]);
  });

  it('formularz WIELOPYTANIOWY z jsonl: komplet na karcie, a cyfra idzie w zakładkę Z EKRANU', async () => {
    /*
     * Ścieżka „zrzut plus wpis" ma dziś ten sam kształt co sama ścieżka hooka: karta niesie
     * KOMPLET pytań (`allow` domyka całe wywołanie), a fallback cyfrą — wyłącznie zakładkę
     * stojącą na ekranie. Etykiety obu zakładek są tu IDENTYCZNE, więc wybór `answers[0]`
     * zapisałby odpowiedź na pytanie 1 jako odpowiedź na pytanie 2 i nikt by tego nie zauważył.
     */
    const answers = new FakeAnswers();
    answers.stillPending = true;
    const fx = await withJsonl({
      answers,
      dump: () => KOLIZJA_ETYKIET,
      input: KOLIZJA_ETYKIET['toolInput'],
      deps: { screenAnswerRearmDelaysMs: [] },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);
    expect(card?.questions.map((q) => q.question))
      .toEqual(['Co na pierwszą gałkę?', 'Które dodatki do lodów?']);

    // Pytanie 1 → „Posypka", pytanie 2 (to z ekranu) → „Bita śmietana".
    const outcome = await fx.driver.answerQuestion(
      card?.reqId ?? '', [['Posypka'], ['Bita śmietana']],
    );

    expect(outcome.kind).toBe('applied');
    expect(fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel))
      .toEqual(['Bita śmietana']);
  });

  it('DRUGIE, identyczne wywołanie tej samej tury dostaje kartę: osłonę kończy nowy zrzut', async () => {
    /*
     * Osłona po odpowiedzi plikiem rozpoznaje rozliczone wywołanie po TREŚCI pytań, bo
     * `tool_use.id` bierze się ze spóźnionego followera. Dwa identyczne pytania jednej tury
     * mają jednak tę samą treść I tę samą blokadę (dialogi idą pod rząd bez mignięcia
     * `agent_status`), więc bez rozróżnienia generacji drugie z nich nie dostałoby karty już nigdy —
     * telefon milczałby do końca blokady, a w dzienniku nie byłoby nawet odmowy. Granicą jest
     * GENERACJA zrzutu: hook zapisuje pytanie B z nowym noncem w `answerKey`.
     */
    const answers = new FakeAnswers();
    const KLUCZ_B = `${KEY}-pytanie-b`;
    let dump = hookDump();
    const fx = await withJsonl({
      answers,
      dump: () => dump,
      deps: { blockedPollMs: 5, screenCacheMs: 0, screenAnswerRearmDelaysMs: [2, 6] },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta pytania A',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);
    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');
    const kartyPrzed = questions(fx.events).length;

    // Tura idzie dalej: wynik A i DRUGIE pytanie o identycznej treści (inny `tool_use.id`).
    await appendFile(
      fx.transcript,
      toolResultLine('q-2267') + toolUseLine('q-2269', 'AskUserQuestion', PYTANIE_JSONL),
    );
    await quiet();
    expect(questions(fx.events), 'zanim dojdzie zrzut B, osłona trzyma').toHaveLength(kartyPrzed);

    // Zrzut pytania B ląduje ułamek sekundy po wpisie — i to on kończy osłonę.
    dump = hookDump({ answerKey: KLUCZ_B });
    await waitFor(() => questions(fx.events).length > kartyPrzed, 'karta pytania B');
    expect(questions(fx.events).at(-1)?.channel).toBe('hook');

    const kartaB = questions(fx.events).at(-1);
    expect((await fx.driver.answerQuestion(kartaB?.reqId ?? '', [['Posypka']])).kind)
      .toBe('applied');
    expect(answers.written.map((w) => w.key)).toEqual([KEY, KLUCZ_B]);
  });

  it('osłona po odpowiedzi plikiem WYGASA, gdy zrzut następnego wywołania nie powstanie', async () => {
    /*
     * Zrzut B jest normalnie granicą osłony, ale powstać nie musi (killswitch kanału, błąd
     * zapisu) — a osłona bez terminu trzymała telefon w ciszy do końca blokady. Po
     * `ANSWERED_HOOK_SHIELD_MS` znacznik gaśnie i ocena wraca do zwykłych gałęzi.
     */
    const answers = new FakeAnswers();
    const clock = fakeClock();
    let dump: Record<string, unknown> | null = hookDump();
    const fx = await withJsonl({
      answers,
      dump: () => dump,
      deps: {
        scheduler: clock.scheduler,
        blockedPollMs: 5,
        screenCacheMs: 0,
        screenAnswerRearmDelaysMs: [],
      },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);
    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');
    // Zrzut rozliczonego wywołania znika (tak robi `clearPendingHook`), nowy nie powstaje.
    dump = null;
    const kartyPrzed = questions(fx.events).length;
    await quiet();
    expect(questions(fx.events), 'w oknie osłony cisza').toHaveLength(kartyPrzed);

    clock.advance(ANSWERED_HOOK_SHIELD_MS);

    await waitFor(() => questions(fx.events).length > kartyPrzed, 'karta po wygaśnięciu osłony');
  });

  it('zrzut nadpisany między odczytami: karta NIE łączy pytań A z kluczem B', async () => {
    /*
     * Zrzut czytamy DOKŁADNIE RAZ na ocenę. Do tej daty odczyt surowego pliku
     * był leniwy i wypadał PO asynchronicznym odczycie ekranu: hook, który w tym oknie zapisał
     * nową generację zrzutu (ten sam payload, inny nonce w kluczu), dawał kartę z pytaniami
     * z generacji A i kluczem odpowiedzi z generacji B — czyli odpowiedź człowieka wysłaną
     * do pliku, na który nikt już nie czeka.
     */
    const answers = new FakeAnswers();
    const KEY_B = `${KEY}-druga-generacja`;
    let odczyty = 0;
    const fx = await withJsonl({
      answers,
      dump: () => {
        odczyty += 1;
        return odczyty === 1 ? hookDump() : hookDump({ answerKey: KEY_B });
      },
      deps: { screenAnswerRearmDelaysMs: [] },
    });
    await waitFor(
      () => questions(fx.events).some((q) => q.channel === 'hook'), 'karta kanału hooka',
    );
    const card = questions(fx.events).filter((q) => q.channel === 'hook').at(-1);

    expect((await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']])).kind).toBe('applied');

    expect(answers.written.map((w) => w.key), 'klucz z TEJ generacji, z której są pytania')
      .toEqual([KEY]);
  });

  /*
   * Odcisk bloku na karcie kanału: plik odpowiedzi odcisku nie czyta, cyfra-fallback czyta
   * go jak każda cyfra. Zakładka przełączona przy biurku (bez mignięcia statusu) zmienia blok, więc pierwszy
   * fallback dostaje `screen-changed` i karta odbudowuje się z pytaniem z ekranu. Bez odcisku ta cyfra szła
   * od razu: etykiety obu zakładek są te same, a odpowiedź na pytanie 1 trafiała w zakładkę 2.
   */
  describe('odcisk bloku na karcie kanału hooka', () => {
    const TAB1 = DIALOG.replace(' Które dodatki do lodów?\n', ' Co na pierwszą gałkę?\n');
    const approved = (fx: Fixture): (string | undefined)[] =>
      fx.audit.filter((e) => e.method === 'approve').map((e) => e.optionLabel);

    async function onTab1(answers: FakeAnswers): Promise<Fixture> {
      const fx = await makeDriver({
        transcript: userLine('zapytaj mnie o dodatki'),
        deps: {
          readPendingHook: () => KOLIZJA_ETYKIET as unknown as PendingHookTool,
          hookAnswers: answers, hookAnswerWaitMs: 20, hookAnswerPollMs: 1, screenAnswerRearmDelaysMs: [],
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = TAB1;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => questions(fx.events).length > 0, 'karta kanału');
      expect(questions(fx.events).at(-1)?.channel).toBe('hook');
      return fx;
    }

    it('plik przy nieaktualnym odcisku: odpowiedź plikiem przechodzi, odmowy nie ma', async () => {
      const answers = new FakeAnswers();
      const fx = await withCard(answers);
      const card = questions(fx.events)[0];
      fx.client.screenText = DIALOG.replace('      Kolorowa\n', '      Tęczowa\n');
      const before = fx.client.mutations;

      const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Polewa']]);

      expect(outcome.kind).toBe('applied');
      expect(answers.written).toEqual([{ key: KEY, answers: { 'Które dodatki do lodów?': 'Polewa' } }]);
      expect(fx.client.mutations).toBe(before);
      expect(fx.audit.filter((e) => e.method === 'refuse')).toEqual([]);
    });

    it('zakładka przełączona przy biurku, zapis pliku pada: fallback dostaje `screen-changed`, potem przechodzi', async () => {
      const answers = new FakeAnswers();
      answers.failWrite = true;
      const fx = await onTab1(answers);
      const card = questions(fx.events).at(-1);
      fx.client.screenText = DIALOG;

      const first = await fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka'], ['Bita śmietana']]);

      expect(first).toEqual({ kind: 'refused', reason: 'screen-changed' });
      expect(fx.client.mutations).toBe(0);
      await waitFor(() => questions(fx.events).length > 1, 'karta odbudowana');
      const rebuilt = questions(fx.events).at(-1);
      expect(rebuilt?.reqId).toBe(card?.reqId);
      expect(rebuilt?.channel).toBe('hook');

      const second = await fx.driver.answerQuestion(rebuilt?.reqId ?? '', [['Posypka'], ['Bita śmietana']]);

      expect(second.kind).toBe('applied');
      expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['3']]);
      expect(approved(fx)).toEqual(['Bita śmietana']);
    });

    it('plik niezużyty w terminie po przełączeniu zakładki: `screen-changed`, karta cyfrowa zakładki 2 przechodzi', async () => {
      const answers = new FakeAnswers();
      answers.stillPending = true;
      const fx = await onTab1(answers);
      const card = questions(fx.events).at(-1);
      fx.client.screenText = DIALOG;

      const first = await fx.driver.answerQuestion(card?.reqId ?? '', [['Posypka'], ['Bita śmietana']]);

      expect(first).toEqual({ kind: 'refused', reason: 'screen-changed' });
      expect(answers.cleared).toHaveLength(1);
      expect(fx.client.mutations).toBe(0);
      // Kanał tego zrzutu jest martwy (`#deadAnswerKey`): karta wraca na torze cyfry, z pytaniem z ekranu, więc
      // z `reqId` tej jednej zakładki, nie karty kanału.
      await waitFor(() => questions(fx.events).length > 1, 'karta odbudowana');
      const rebuilt = questions(fx.events).at(-1);
      expect(rebuilt?.channel).toBe('keys');
      expect(rebuilt?.reqId).not.toBe(card?.reqId);
      expect(rebuilt?.questions.map((q) => q.question)).toEqual(['Które dodatki do lodów?']);

      const second = await fx.driver.answerQuestion(rebuilt?.reqId ?? '', [['Bita śmietana']]);

      expect(second.kind).toBe('applied');
      expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['3']]);
      expect(approved(fx)).toEqual(['Bita śmietana']);
    });

    /*
     * Etykiety zawinięte przez wąski panel o WSPÓLNEJ pierwszej linii („1. Wariant / A”, „2. Wariant / B”): bez
     * podpowiedzi etykiet z payloadu parser widzi dwa razy „Wariant” i oddaje `null`, a karta kanału
     * powstaje z parsowania z podpowiedziami (`hookQuestionFrom`). Odcisk z parsowania bez podpowiedzi zostawiał
     * kartę bez odcisku, więc cyfra-fallback po przełączeniu zakładki szła z pytania 1 w zakładkę 2.
     */
    describe('etykiety zawinięte o wspólnym początku', () => {
      const OPTS = ' ❯ 1. Posypka\n      Kolorowa\n   2. Polewa\n      Czekoladowa\n   3. Bita śmietana\n'
        + '      Domowa\n   4. Type something\n      Submit\n';
      const WRAPPED = ' ❯ 1. Wariant\n      A\n   2. Wariant\n      B\n   3. Type something\n      Submit\n';
      const swap = (text: string, from: string, to: string): string => {
        if (!text.includes(from)) throw new Error(`brak kotwicy: ${from}`);
        return text.replace(from, to);
      };
      const TAB2 = swap(swap(DIALOG, OPTS, WRAPPED), '   5. Chat about this', '   4. Chat about this');
      const WRAPPED_TAB1 = swap(TAB2, ' Które dodatki do lodów?\n', ' Co na pierwszą gałkę?\n');
      const WARIANTY = hookDump({
        toolInput: {
          questions: ['Co na pierwszą gałkę?', 'Które dodatki do lodów?'].map((question) => ({
            question, header: 'Wariant', multiSelect: false, options: [{ label: 'Wariant A' }, { label: 'Wariant B' }],
          })),
        },
      });

      async function onWrappedTab1(): Promise<Fixture> {
        const answers = new FakeAnswers();
        answers.failWrite = true;
        const fx = await makeDriver({
          transcript: userLine('zapytaj mnie o warianty'),
          deps: {
            readPendingHook: () => WARIANTY as unknown as PendingHookTool,
            hookAnswers: answers, hookAnswerWaitMs: 20, hookAnswerPollMs: 1, screenAnswerRearmDelaysMs: [],
          },
        });
        await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
        fx.client.screenText = WRAPPED_TAB1;
        fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
        await waitFor(() => questions(fx.events).length > 0, 'karta kanału');
        expect(questions(fx.events).at(-1)?.channel).toBe('hook');
        return fx;
      }

      it('zakładka przełączona przy biurku, zapis pliku pada: `screen-changed`, zero klawiszy', async () => {
        const fx = await onWrappedTab1();
        const card = questions(fx.events).at(-1);
        fx.client.screenText = TAB2;

        const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Wariant A'], ['Wariant B']]);

        expect(outcome).toEqual({ kind: 'refused', reason: 'screen-changed' });
        expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
        expect(fx.client.mutations).toBe(0);
      });

      it('kontrola: ta sama zakładka, zapis pliku pada: cyfra pytania z ekranu idzie', async () => {
        const fx = await onWrappedTab1();
        const card = questions(fx.events).at(-1);

        const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Wariant A'], ['Wariant B']]);

        expect(outcome.kind).toBe('applied');
        expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['1']]);
        expect(approved(fx)).toEqual(['Wariant A']);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// `setMode` — pętla `shift+tab` → odczyt stopki
// ---------------------------------------------------------------------------

describe('setMode', () => {
  const cycles = (fx: Fixture): number => fx.client.calls.filter((c) => c.method === 'mode_cycle').length;

  /** Nadzorca oddaje kolejne odczyty stopki — jak żywy cykl CLI (auto → manual → … → plan). */
  const scripted = (reads: readonly HerdrFooterMode[]): (() => Promise<HerdrFooterMode>) => {
    const queue = [...reads];
    return () => Promise.resolve(queue.shift() ?? 'unknown');
  };

  it('naciska aż stopka pokaże cel i melduje liczbę naciśnięć', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { modeCycleSettleMs: 1, refreshMode: scripted(['manual', 'plan']) },
    });
    fx.driver.setMode?.('plan');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');

    expect(cycles(fx)).toBe(2);
    expect(systemTexts(fx.events)).toEqual(['✓ The pane switched to plan mode (2 shift+tab presses from Rarog).']);
    expect(systemCodes(fx.events)).toEqual(['commands.mode-cycle-done']);
    // Dziennik: KAŻDE naciśnięcie jako `send_keys` z nazwą klawisza — pytanie „kto przestawił
    // tryb panelu" ma mieć jeden grep.
    expect(fx.audit.map((e) => e.keys)).toEqual([['shift+tab'], ['shift+tab']]);
  });

  it('panel już w celu = zero klawiszy, ale zdanie w transkrypcie', async () => {
    const fx = await makeDriver({ agent: { mode: 'plan' }, deps: { modeCycleSettleMs: 1 } });
    fx.driver.setMode?.('plan');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');
    expect(cycles(fx)).toBe(0);
    expect(systemTexts(fx.events)[0]).toContain('(0 shift+tab presses');
  });

  it('stopka niewidoczna po klawiszu = STOP bez kolejnego naciśnięcia', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { modeCycleSettleMs: 1, refreshMode: scripted(['unknown']) },
    });
    fx.driver.setMode?.('plan');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');
    await quiet();
    expect(cycles(fx)).toBe(1);
    expect(systemCodes(fx.events)[0]).toBe('commands.mode-cycle-no-footer.mode-unknown');
  });

  it('pełny obrót bez celu kończy się na suficie naciśnięć', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { modeCycleSettleMs: 1, refreshMode: () => Promise.resolve('manual') },
    });
    fx.driver.setMode?.('plan');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');
    await quiet();
    expect(cycles(fx)).toBe(MODE_CYCLE_MAX_PRESSES);
    expect(systemCodes(fx.events)[0]).toBe('commands.mode-cycle-exhausted');
  });

  it('odmowa gniazda przerywa pętlę i mówi, gdzie panel stoi', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { modeCycleSettleMs: 1, refreshMode: scripted(['plan']) },
    });
    fx.client.sendModeCycle = () => Promise.reject(new Error('panel nie odpowiada'));
    fx.driver.setMode?.('plan');
    await waitFor(() => systemCodes(fx.events).includes('commands.mode-cycle-key-lost'), 'odmowa');
    expect(cycles(fx)).toBe(0);
    expect(systemTexts(fx.events).at(-1)).toContain('in auto mode');
  });

  it('tura, która ruszyła między klawiszami, ZATRZYMUJE pętlę — uprawnień nie zmienia się w turze', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: {
        modeCycleSettleMs: 1,
        refreshMode: () => {
          // Prompt z biurka w chwili odczytu stopki: herdr melduje `working`.
          fx.emit({ type: 'status', status: 'working', title: 'refaktor', stateChangeSeq: 8 });
          return Promise.resolve('manual');
        },
      },
    });
    fx.driver.setMode?.('plan');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');
    await quiet();
    expect(cycles(fx)).toBe(1);
    expect(systemCodes(fx.events)[0]).toBe('commands.mode-cycle-busy');
  });

  it('`accept edits` NIE jest celem `auto` — pętla naciska dalej', async () => {
    const fx = await makeDriver({
      agent: { mode: 'plan' }, transcript: userLine('start'),
      deps: { modeCycleSettleMs: 1, refreshMode: scripted(['acceptEdits', 'auto']) },
    });
    fx.driver.setMode?.('auto');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');
    expect(cycles(fx)).toBe(2);
    expect(systemTexts(fx.events)[0]).toContain('2 shift+tab presses');
  });

  it('bez nadzorcy czyta stopkę z ekranu sam i odświeża chip zdarzeniem', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { modeCycleSettleMs: 1 } });
    fx.client.screenText = '❯ \n\n⏸  plan mode on (shift+tab to cycle) · ← 1 agent';
    fx.driver.setMode?.('plan');
    await waitFor(() => systemTexts(fx.events).length > 0, 'zdanie o trybie');
    expect(cycles(fx)).toBe(1);
    const states = fx.events.filter((e): e is Extract<DriverEvent, { type: 'agent-state' }> =>
      e.type === 'agent-state');
    expect(states.at(-1)?.mode).toBe('plan');
  });
});

describe('restart sesji na nowym Claude Code', () => {
  const RULE = '─'.repeat(40);

  it('requestExit: `/exit` BEZ `wait` (bez stall-guarda), wpis `prompt` w dzienniku, zero Esc', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await expect(fx.driver.requestExit?.()).resolves.toBe(true);
    const prompts = fx.client.calls.filter((c) => c.method === 'prompt');
    expect(prompts).toEqual([{ method: 'prompt', paneId: PANE, text: '/exit' }]);
    expect(fx.audit.map((e) => [e.method, e.text])).toEqual([['prompt', '/exit']]);
    await quiet();
    // Stall-guard przy `/exit` posłałby parę Esc do POWŁOKI — tu nie idzie żaden klawisz.
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
  });

  it('requestExit: odmowa gniazda = `false`, panel poza zasięgiem = wyjątek bez wysyłki', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    fx.client.promptError = new Error('socket padł');
    await expect(fx.driver.requestExit?.()).resolves.toBe(false);

    const foreign = await makeDriver({ agent: { inScope: false } });
    expect(() => foreign.driver.requestExit?.()).toThrow();
    expect(foreign.client.mutations).toBe(0);
  });

  it('restartProbe: świeży status, CAŁE pole promptu i dokładny tryb — bez żadnej wysyłki', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { refreshMode: () => Promise.resolve('acceptEdits') },
    });
    fx.client.getAgent = (): Promise<HerdrAgentInfo> =>
      Promise.resolve({ status: 'working', agentSessionId: SESSION } as HerdrAgentInfo);
    // Szkic od pustej linii: stary parser widziałby tu puste pole.
    fx.client.screenAnsi = `${RULE}\n❯ \n  niewysłany szkic\n${RULE}`;
    await expect(fx.driver.restartProbe?.()).resolves.toEqual({
      agent: { agentSessionId: SESSION, status: 'working' }, composer: 'filled', mode: 'acceptEdits',
    });
    expect(fx.client.mutations).toBe(0);
  });

  it('restartProbe: błąd `agent.get` i odczytu ekranu to „nie wiem", nie wyjątek', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'),
      deps: { refreshMode: () => Promise.resolve('unknown') },
    });
    fx.client.readScreen = (): Promise<HerdrScreen> => Promise.reject(new Error('EIO'));
    await expect(fx.driver.restartProbe?.()).resolves.toEqual({
      agent: null, composer: 'unknown', mode: 'unknown',
    });
  });
});

/**
 * Echo odroczone: driver przekazuje token wysyłki do okna echa followera, przepuszcza wpis
 * promptu z pliku z `echoToken`, a każdą wysyłkę, która nie doszła do panelu, oddaje zdarzeniem
 * `echo-refused` PRZED swoim ostrzeżeniem (ostrzeżenie ma stać pod dymkiem).
 */
describe('echo odroczone', () => {
  /** Wpis `user` z czasem TERAZ: follower bierze token tylko od wpisu nie starszego niż rejestracja. */
  const freshUserLine = (text: string): string => `${JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, isSidechain: false,
    timestamp: new Date().toISOString(), sessionId: SESSION,
  })}\n`;
  const kinds = (events: readonly DriverEvent[]): string[] => events.map((e) =>
    (e.type === 'message' ? `message:${e.role}` : e.type));
  const userMessages = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'message' }>[] =>
    events.filter((e): e is Extract<DriverEvent, { type: 'message' }> => e.type === 'message' && e.role === 'user');

  it('`defersEcho`: tylko z plikiem rozmowy, bez slash-komend i pustego klucza echa', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.driver.defersEcho?.('zwykły prompt', null) === true, 'plik rozmowy znaleziony');
    // Komendę rozpoznaje manager: sam tekst „/compact” bez klasyfikacji nie jest dla drivera komendą.
    expect(fx.driver.defersEcho?.('/compact', { name: 'compact', kind: 'local' })).toBe(false);
    expect(fx.driver.defersEcho?.('   ', null)).toBe(false);

    const bare = await makeDriver({ noTranscript: true });
    expect(bare.driver.defersEcho?.('zwykły prompt', null)).toBe(false);
  });

  it('token wysyłki trafia do okna echa: wpis promptu z pliku wraca z `echoToken`', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.driver.defersEcho?.('dopisek', null) === true, 'plik rozmowy znaleziony');
    fx.driver.send('dopisek', undefined, undefined, { echo: 'tok-a' });
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await appendFile(fx.transcript, freshUserLine('dopisek'));
    await waitFor(() => userMessages(fx.events).length > 0, 'wpis promptu z pliku');
    expect(userMessages(fx.events)[0]?.echoToken).toBe('tok-a');
    expect(fx.events.some((e) => e.type === 'echo-refused')).toBe(false);
  });

  it('błąd gniazda: `echo-refused` PRZED ostrzeżeniem, a wpis znika z okna echa', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.driver.defersEcho?.('nie doszło', null) === true, 'plik rozmowy znaleziony');
    fx.client.promptError = new Error('gniazdo padło');
    fx.driver.send('nie doszło', undefined, undefined, { echo: 'tok-b' });
    await waitFor(() => systemTexts(fx.events).length > 0, 'ostrzeżenie');
    const order = kinds(fx.events);
    expect(order.indexOf('echo-refused')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('echo-refused')).toBeLessThan(order.indexOf('message:system'));
    expect(fx.events.find((e) => e.type === 'echo-refused')).toEqual({ type: 'echo-refused', token: 'tok-b' });

    // Sieroty nie ma: ten sam tekst wpisany potem w terminalu przechodzi jako zwykła wiadomość.
    await appendFile(fx.transcript, freshUserLine('nie doszło'));
    await waitFor(() => userMessages(fx.events).length > 0, 'prompt z terminala');
    expect(userMessages(fx.events)[0]?.echoToken).toBeUndefined();
  });

  it('watchdog: cisza po wysyłce z tokenem → `echo-refused` przed komunikatem o zawieszeniu', async () => {
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('wysłane w próżnię', undefined, undefined, { echo: 'tok-c' });
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'watchdog');
    const order = kinds(fx.events);
    expect(order.indexOf('echo-refused')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('echo-refused')).toBeLessThan(order.indexOf('message:system'));
  });

  it('wysyłka bez tokenu nie daje `echo-refused` także przy odmowie', async () => {
    const fx = await makeDriver();
    fx.client.promptError = new Error('gniazdo padło');
    fx.driver.send('zwykła wiadomość');
    await waitFor(() => systemTexts(fx.events).length > 0, 'ostrzeżenie');
    expect(fx.events.some((e) => e.type === 'echo-refused')).toBe(false);
  });
});

/*
 * Prompt wysłany w trakcie tury i zablokowany przez hook (`docs/dialogs.md`).
 * Hook biegnie od razu przy wysyłce, CLI nie zapisuje ŻADNEGO wpisu, a tekst wraca do pola i stoi tam po turze.
 * Odczyt pola po turze rozstrzyga po TREŚCI obszaru pola: zero klawiszy, a zgoda na parę Esc przed następną
 * wysyłką (`#heldLeftover`) tylko przy polu RÓWNYM naszemu tekstowi — i tylko póki pole dalej go trzyma.
 */
describe('odczyt pola po turze dla wstrzymanych promptów', () => {
  const RULE = '─'.repeat(40);
  const fieldWith = (text: string): string => `${RULE}\n❯ ${text}\n${RULE}`;
  const EMPTY = `${RULE}\n❯\n${RULE}`;
  const escs = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const reads = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'read');
  const freshUserLine = (text: string): string => `${JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, isSidechain: false,
    timestamp: new Date().toISOString(), sessionId: SESSION,
  })}\n`;
  const userMessages = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'message' }>[] =>
    events.filter((e): e is Extract<DriverEvent, { type: 'message' }> => e.type === 'message' && e.role === 'user');
  /** Pole z podanym tekstem; para Esc je czyści. */
  const field = (fx: Fixture, text: string): void => {
    fx.client.screenText = fieldWith(text);
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) fx.client.screenText = EMPTY;
      return raw(paneId, keys);
    };
  };
  const check = (
    fx: Fixture, items: { token: string; text: string }[], valid: () => boolean = () => true,
  ): ReturnType<NonNullable<SessionDriver['checkHeldLeftover']>> => {
    const run = fx.driver.checkHeldLeftover;
    if (run === undefined) throw new Error('driver bez odczytu pola');
    return run.call(fx.driver, items, valid);
  };
  /** Następna wysyłka: ile par Esc poszło przed jej `prompt`. */
  const nextSendEscs = async (fx: Fixture): Promise<(readonly string[] | undefined)[]> => {
    const before = escs(fx).length;
    const sent = fx.client.calls.filter((c) => c.method === 'prompt').length;
    fx.driver.send('następna wiadomość');
    await waitFor(() => fx.client.calls.filter((c) => c.method === 'prompt').length === sent + 1, 'wysyłka');
    return escs(fx).slice(before);
  };

  it('tekst wiadomości w polu → `not-taken`, jeden odczyt, zero klawiszy; następna wysyłka czyści pole', async () => {
    const fx = await makeDriver();
    field(fx, 'zablokowany w turze');
    const verdicts = await check(fx, [{ token: 't1', text: 'zablokowany w turze' }]);
    expect(verdicts?.get('t1')).toBe('not-taken');
    expect(reads(fx)).toEqual([{ method: 'read', paneId: PANE, source: 'visible' }]);
    expect(escs(fx)).toEqual([]);
    expect(await nextSendEscs(fx)).toEqual([['escape', 'escape']]);
    expect(fx.client.screenText).toBe(EMPTY);
  });

  it.each([
    ['szkic przy Macu', 'zupełnie inny tekst'],
    ['`[Pasted text #N +K lines]` długiego promptu', '[Pasted text #1 +40 lines]'],
  ])('pole z innym tekstem (%s) → `unconfirmed`, bez zgody na czyszczenie: cudzego tekstu nie ruszamy', async (_name, inField) => {
    const fx = await makeDriver();
    field(fx, inField);
    const verdicts = await check(fx, [{ token: 't1', text: `wstrzymany prompt ${'z wieloma liniami\n'.repeat(3)}` }]);
    expect(verdicts?.get('t1')).toBe('unconfirmed');
    expect(await nextSendEscs(fx)).toEqual([]);
  });

  it('puste pole pod historią z tym promptem → `empty`; ekran nieczytelny albo błąd odczytu → `unknown`', async () => {
    const fx = await makeDriver();
    fx.client.screenText = `❯ zablokowany w turze\n\n⏺ Odpowiedź.\n\n${EMPTY}`;
    expect((await check(fx, [{ token: 't1', text: 'zablokowany w turze' }]))?.get('t1')).toBe('empty');
    fx.client.screenText = 'Do you want to proceed?\n1. Yes\n2. No';
    expect((await check(fx, [{ token: 't2', text: 'zablokowany w turze' }]))?.get('t2')).toBe('unknown');
    fx.client.readScreen = () => Promise.reject(new Error('gniazdo'));
    expect((await check(fx, [{ token: 't3', text: 'zablokowany w turze' }]))?.get('t3')).toBe('unknown');
    expect(escs(fx)).toEqual([]);
    fx.client.screenText = fieldWith('zablokowany w turze');
    fx.client.readScreen = FakeClient.prototype.readScreen.bind(fx.client);
    // Żaden z tych werdyktów nie dał zgody na czyszczenie pola.
    expect(await nextSendEscs(fx)).toEqual([]);
  });

  it('dwa prompty sklejone w polu → oba `not-taken`', async () => {
    const fx = await makeDriver();
    field(fx, 'pierwszy promptdrugi prompt');
    const verdicts = await check(fx, [{ token: 'a', text: 'pierwszy prompt' }, { token: 'b', text: 'drugi prompt' }]);
    expect([verdicts?.get('a'), verdicts?.get('b')]).toEqual(['not-taken', 'not-taken']);
  });

  it('odczyt dołożony PRZED wysyłką → jej zadanie widzi zgodę i czyści pole, zanim napisze', async () => {
    const fx = await makeDriver();
    field(fx, 'zablokowany w turze');
    const pending = check(fx, [{ token: 't1', text: 'zablokowany w turze' }]);
    fx.driver.send('nowy prompt');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'wysyłka');
    await expect(pending).resolves.toEqual(new Map([['t1', 'not-taken']]));
    const order = fx.client.calls.map((c) => c.method);
    expect(escs(fx)).toEqual([['escape', 'escape']]);
    expect(order.indexOf('send_keys')).toBeLessThan(order.indexOf('prompt'));
    expect(fx.client.calls.find((c) => c.method === 'prompt')?.text).toBe('nowy prompt');
  });

  // Reguła „pole zawiera początek promptu” nie może brać cudzego szkicu za naszą pozostałość.
  it('krótki prompt wewnątrz cudzego szkicu → `unconfirmed`; następna wysyłka nie kasuje szkicu', async () => {
    const fx = await makeDriver();
    field(fx, 'Popraw dokumentację');
    expect((await check(fx, [{ token: 't1', text: 'ok' }]))?.get('t1')).toBe('unconfirmed');
    expect(await nextSendEscs(fx)).toEqual([]);
    expect(fx.client.screenText).toBe(fieldWith('Popraw dokumentację'));
  });

  // `#needsEscape` po `not-taken` nie może skasować szkicu wpisanego przy Macu PO wysłaniu pozostałości.
  it('po `not-taken` pozostałość wyszła z pola przy Macu, w polu nowy szkic → następna wysyłka go nie kasuje', async () => {
    const fx = await makeDriver();
    field(fx, 'zablokowany w turze');
    expect((await check(fx, [{ token: 't1', text: 'zablokowany w turze' }]))?.get('t1')).toBe('not-taken');
    fx.client.screenText = fieldWith('nowy szkic z Maca');
    expect(await nextSendEscs(fx)).toEqual([]);
    expect(fx.client.screenText).toBe(fieldWith('nowy szkic z Maca'));
  });

  it('pozostałość wysłana przy Macu (wpis `user` z tą treścią) gasi zgodę, nawet gdy pole znów ją trzyma', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.driver.defersEcho?.('zablokowany w turze', null) === true, 'plik rozmowy znaleziony');
    field(fx, 'zablokowany w turze');
    expect((await check(fx, [{ token: 't1', text: 'zablokowany w turze' }]))?.get('t1')).toBe('not-taken');
    await appendFile(fx.transcript, freshUserLine('zablokowany  w\nturze'));
    await waitFor(() => userMessages(fx.events).length > 0, 'prompt wysłany przy Macu');
    // Człowiek wpisuje przy Macu ten sam tekst jeszcze raz — to już jego szkic.
    expect(await nextSendEscs(fx)).toEqual([]);
  });

  it('`not-taken` wycofuje token z okna echa: identyczny prompt z pliku przychodzi jako zwykły wpis', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.driver.defersEcho?.('zablokowany w turze', null) === true, 'plik rozmowy znaleziony');
    fx.driver.send('zablokowany w turze', undefined, undefined, { echo: 'tok-n2' });
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    field(fx, 'zablokowany w turze');
    expect((await check(fx, [{ token: 'tok-n2', text: 'zablokowany w turze' }]))?.get('tok-n2')).toBe('not-taken');
    await appendFile(fx.transcript, freshUserLine('zablokowany w turze'));
    await waitFor(() => userMessages(fx.events).length > 0, 'prompt wysłany przy Macu');
    expect(userMessages(fx.events)[0]?.echoToken).toBeUndefined();
  });

  it('`unconfirmed` zostawia token: wpis z pliku dalej wskazuje wstrzymaną wiadomość', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    await waitFor(() => fx.driver.defersEcho?.('długi prompt', null) === true, 'plik rozmowy znaleziony');
    fx.driver.send('długi prompt', undefined, undefined, { echo: 'tok-n2' });
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    field(fx, '[Pasted text #1 +40 lines]');
    expect((await check(fx, [{ token: 'tok-n2', text: 'długi prompt' }]))?.get('tok-n2')).toBe('unconfirmed');
    await appendFile(fx.transcript, freshUserLine('długi prompt'));
    await waitFor(() => userMessages(fx.events).length > 0, 'wpis promptu');
    expect(userMessages(fx.events)[0]?.echoToken).toBe('tok-n2');
  });

  it('`valid()` po odczycie `false` → `null`, bez zgody na czyszczenie i bez ruszania okna echa', async () => {
    const fx = await makeDriver();
    field(fx, 'zablokowany w turze');
    let asked = 0;
    const result = await check(fx, [{ token: 't1', text: 'zablokowany w turze' }], () => {
      asked += 1;
      return false;
    });
    expect(result).toBeNull();
    expect(asked).toBe(1);
    expect(reads(fx)).toHaveLength(1);
    expect(await nextSendEscs(fx)).toEqual([]);
  });

  it('`RAROG_PROMPT_BLOCK=0` (`promptBlock: false`) → `null` od razu, zero odczytów', async () => {
    const fx = await makeDriver({ deps: { promptBlock: false } });
    field(fx, 'zablokowany w turze');
    expect(check(fx, [{ token: 't1', text: 'zablokowany w turze' }])).toBeNull();
    await quiet();
    expect(reads(fx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Kształt odmowy w dzienniku
// ---------------------------------------------------------------------------

/*
 * Każda karta bez decyzji (`degrade`) i każda odmowa wysyłki (`refuse`) zostawia w dzienniku KSZTAŁT
 * przypadku: tożsamość i źródło karty, podpowód rozjazdu z pierwszego rozpoznania, liczbę opcji, nagłówek
 * nad ramką i (przy `degrade`) liczbę wierszy panelu z herdr. Bez treści ekranu i bez etykiet opcji.
 * Testy sprawdzają KOŃCOWY wpis, tak jak trafia do `herdr-audit.log` przez lejek drivera.
 */
describe('kształt odmowy w dzienniku', () => {
  /** Dialog subagenta z całą ramką; ucięty od linii z końcem komendy = ramka nad krawędzią panelu. */
  const SUB = readFileSync(join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.txt'), 'utf8');
  const X = (JSON.parse(readFileSync(join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.command.json'), 'utf8')) as {
    command: string;
  }).command;
  const lines = SUB.split('\n');
  const CLIPPED = lines.slice(lines.findIndex((line) => line.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
  const HOOK_AT = Date.UTC(2026, 7, 22, 11, 59, 50);
  const subagentHook = (): PendingHookTool => ({
    toolName: 'Bash', toolInput: { command: X }, at: HOOK_AT, hookEventName: 'PermissionRequest',
    promptId: '7c1d9e2a-0b3f-4e5d-8a6b-1c2d3e4f5a6b', agentId: 'a7e5ec6c821818fae',
  });
  const degrades = (fx: Fixture): HerdrAuditEntry[] => fx.audit.filter((e) => e.method === 'degrade');

  it('sam zrzut hooka, ramka ucięta u góry → `mismatch` z podpowodem `operation` i bez nagłówka (incydent 10:17Z)', async () => {
    const dumps: RefusalDump[] = [];
    const fx = await makeDriver({
      transcript: userLine('wypuść build'),
      deps: { readPendingHook: () => subagentHook(), dumpRefusal: (d) => { dumps.push(d); } },
    });
    // Panel 62×29 z incydentu: herdr oddaje 28 wierszy widoku (`scroll.viewport_rows` w `pane.list`).
    const asked: string[] = [];
    fx.client.readPaneRows = (paneId: string): Promise<number> => {
      asked.push(paneId);
      return Promise.resolve(28);
    };
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');

    fx.client.screenText = CLIPPED;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => degrades(fx).length > 0, 'wpis degrade');

    expect(screenDialogs(fx.events).at(-1)?.reason).toBe('mismatch');
    const entry = degrades(fx)[0];
    expect(entry).toMatchObject({
      method: 'degrade', reason: 'mismatch', toolName: 'Bash',
      mismatchReason: 'operation', headerVisible: false, optionCount: 2, dialogTitle: null,
      source: 'hook', promptId: '7c1d9e2a-0b3f-4e5d-8a6b-1c2d3e4f5a6b', agentId: 'a7e5ec6c821818fae',
      paneRows: 28,
    });
    // Tożsamość karty z ekranu: baza ze zrzutu plus odcisk treści (bez treści w samym wpisie).
    expect(entry?.reqId).toMatch(new RegExp(`^hook:${String(HOOK_AT)}:f:[0-9a-f]{12}$`));
    // Czas zdarzenia, nie chwila zapisu po odczycie wierszy.
    expect(entry?.at).toBe(new Date(Date.UTC(2026, 7, 22, 12, 0, 0)).toISOString());
    // Bez treści: ani komendy, ani etykiet opcji, ani tekstu ekranu.
    expect(JSON.stringify(entry)).not.toContain('git -C');
    expect(entry?.optionLabel).toBeUndefined();
    expect(entry?.text).toBeUndefined();
    // Zrzut odmowy niesie ten sam kształt (razem z wierszami), dla tej samej chwili.
    expect(dumps).toHaveLength(1);
    expect(dumps[0]?.shape).toMatchObject({
      mismatchReason: 'operation', headerVisible: false, optionCount: 2, source: 'hook', paneRows: 28,
      reqId: entry?.reqId,
    });
    expect(dumps[0]?.at).toBe(Date.UTC(2026, 7, 22, 12, 0, 0));
    // Jeden odczyt wierszy na jedną kartę bez decyzji, o własny panel.
    expect(asked).toEqual([PANE]);
  });

  it('zrzut z geometrią strażnika → `degrade` niesie źródło budżetu i pty z chwili hooka obok `paneRows`', async () => {
    const dumps: RefusalDump[] = [];
    const fx = await makeDriver({
      transcript: userLine('wypuść build'),
      deps: {
        readPendingHook: () => ({ ...subagentHook(), budgetSource: 'phone', paneRows: 52, paneCols: 128 }),
        dumpRefusal: (d) => { dumps.push(d); },
      },
    });
    // Panel zmalał między hookiem (128×52) a oceną ekranu (28 wierszy z herdr): oba pomiary zostają.
    fx.client.readPaneRows = (): Promise<number> => Promise.resolve(28);
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = CLIPPED;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => degrades(fx).length > 0, 'wpis degrade');

    expect(degrades(fx)[0]).toMatchObject({
      mismatchReason: 'operation', headerVisible: false, source: 'hook', agentId: 'a7e5ec6c821818fae',
      paneRows: 28, budgetSource: 'phone', hookPaneRows: 52, hookPaneCols: 128,
    });
    expect(dumps[0]?.shape).toMatchObject({ budgetSource: 'phone', hookPaneRows: 52, hookPaneCols: 128 });
  });

  it('błąd odczytu wierszy panelu = wpis bez `paneRows`, karta i wpis i tak wychodzą', async () => {
    const fx = await makeDriver({
      transcript: userLine('wypuść build'),
      deps: { readPendingHook: () => subagentHook() },
    });
    fx.client.readPaneRows = (): Promise<number> => Promise.reject(new Error('herdr: timeout'));
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = CLIPPED;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => degrades(fx).length > 0, 'wpis degrade');
    expect(degrades(fx)[0]).toMatchObject({ mismatchReason: 'operation', source: 'hook' });
    expect(degrades(fx)[0]?.paneRows).toBeUndefined();
  });

  it('wiersze panelu nie przyszły w budżecie → wpis i zrzut bez `paneRows`, dokładnie raz', async () => {
    // Kolejka slotów gniazda albo wolny herdr nie mogą wstrzymać wpisu.
    const dumps: RefusalDump[] = [];
    let late: ((rows: number) => void) | null = null;
    const fx = await makeDriver({
      transcript: userLine('wypuść build'),
      deps: {
        readPendingHook: () => subagentHook(), dumpRefusal: (d) => { dumps.push(d); }, paneRowsWaitMs: 5,
      },
    });
    fx.client.readPaneRows = (): Promise<number> => new Promise((resolve) => { late = resolve; });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = CLIPPED;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => degrades(fx).length > 0, 'wpis degrade po budżecie');

    expect(degrades(fx)[0]).toMatchObject({ mismatchReason: 'operation', source: 'hook' });
    expect(degrades(fx)[0]?.paneRows).toBeUndefined();
    expect(dumps[0]?.shape?.paneRows).toBeUndefined();
    // Spóźniony wynik nie dopisuje drugiego wpisu ani zrzutu.
    expect(late).not.toBeNull();
    (late as unknown as (rows: number) => void)(28);
    await quiet();
    expect(degrades(fx)).toHaveLength(1);
    expect(dumps).toHaveLength(1);
  });

  it('konkurujące źródła pasujące oba → `mismatchReason: ambiguous-sources`, źródłem wpis jsonl', async () => {
    const EDIT = readFileSync(join(FIXTURES, 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8');
    // Dwie edycje tego samego pliku różniące się wyłącznie białymi znakami: dialog `Edit` potwierdza obie
    // (ścieżka z nagłówka i diff bez białych znaków), więc nie wiadomo, którą zatwierdzi cyfra.
    const PLIK = '/pomiar/pomiar-dialogow.txt';
    const fx = await makeDriver({
      transcript: userLine('popraw') + toolUseLine('toolu_old', 'Edit', {
        file_path: PLIK, old_string: 'stara wartosc', new_string: 'nowa wartosc',
      }),
      deps: {
        readPendingHook: () => ({
          toolName: 'Edit', toolInput: { file_path: PLIK, old_string: 'stara  wartosc', new_string: 'nowa wartosc' },
          at: Date.parse('2026-08-22T10:00:09.000Z'), hookEventName: 'PermissionRequest',
          promptId: '7c1d9e2a-0b3f-4e5d-8a6b-1c2d3e4f5a6b', cwd: '/pomiar',
        }),
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = EDIT;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => degrades(fx).length > 0, 'wpis degrade');

    const entry = degrades(fx)[0];
    expect(entry).toMatchObject({
      reason: 'mismatch', mismatchReason: 'ambiguous-sources', source: 'jsonl', toolUseId: 'toolu_old',
      headerVisible: true, optionCount: 3, dialogTitle: null,
    });
    // Zrzut obok INNEGO wywołania nie przypisuje wpisowi swojej tury.
    expect(entry?.promptId).toBeUndefined();
    // Ta karta zostaje przy gołej bazie oceny: oba identyfikatory źródeł.
    expect(entry?.reqId).toBe(`hook:${String(Date.parse('2026-08-22T10:00:09.000Z'))}~toolu_old`);
    expect(permissions(fx.events).at(-1)?.reqId).toBe(entry?.reqId);
  });

  it('zatwierdzenie karty z jsonl niesie jej tożsamość i źródło (`approve`)', async () => {
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    const card = permissions(fx.events)[0];

    fx.driver.respondPermission(card?.reqId ?? '', 'allow');
    await waitFor(() => fx.audit.some((e) => e.method === 'approve'), 'approve');
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({
      method: 'approve', reqId: card?.reqId, source: 'jsonl', toolUseId: 'toolu_bash',
    });
  });

  it('odmowa wysyłki niesie tożsamość karty, źródło i kształt ostatniego ekranu (`refuse`)', async () => {
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const network = readFileSync(join(FIXTURES, 'measured', 'zgoda-siec-2.1.293.txt'), 'utf8');
    fx.client.screenText = network;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events)[0];

    fx.client.screenText = network.replaceAll('example.org', 'other.example');
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
    const entry = fx.audit.find((e) => e.method === 'refuse');
    expect(entry).toMatchObject({
      reason: 'screen-changed', reqId: card?.reqId, source: 'screen', optionCount: 3, headerVisible: true,
      dialogTitle: null,
    });
    // Odmowa wysyłki nie czyta herdr po wiersze — to robi wyłącznie karta bez decyzji.
    expect(entry?.paneRows).toBeUndefined();
    expect(entry?.mismatchReason).toBeUndefined();
  });

  it('dialog zgody CLI → `degrade` ze źródłem `screen` i kształtem ekranu', async () => {
    const fx = await makeDriver({ transcript: userLine('start') });
    fx.client.screenText = readFileSync(join(FIXTURES, 'dialog-automode-teach-2.1.258.txt'), 'utf8');
    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await waitFor(() => degrades(fx).length > 0, 'wpis degrade');
    expect(degrades(fx)[0]).toMatchObject({
      reason: 'consent-dialog', source: 'screen', reqId: 'consent:auto-mode-teach:1', dialogTitle: null,
    });
    expect(typeof degrades(fx)[0]?.optionCount).toBe('number');
  });
});

describe('rozdzielacz warstw i pełny blok w dzienniku', () => {
  /*
   * Pola `route`, `routeReason`, `blockVisible` i `cliDialog` przy `approve`, `degrade` i `refuse`: werdykt
   * rozdzielacza (`dialogs/router.ts`) z klasy rejestru CLI, zrzutu hooka i ostatniego odczytu ekranu. Same
   * zamknięte listy i flagi, bez treści. Karta, przyciski i klawisze od tych pól nie zależą: te same scenariusze
   * w testach wyżej sprawdzają decyzję, a tu tylko wpis.
   */
  const SUB = readFileSync(join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.txt'), 'utf8');
  const X = (JSON.parse(readFileSync(join(FIXTURES, 'dialog-bash-subagent-naglowek-2.1.302.command.json'), 'utf8')) as {
    command: string;
  }).command;
  const lines = SUB.split('\n');
  const CLIPPED = lines.slice(lines.findIndex((line) => line.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
  const subagentHook = (): PendingHookTool => ({
    toolName: 'Bash', toolInput: { command: X }, at: Date.UTC(2026, 7, 22, 11, 59, 50),
    hookEventName: 'PermissionRequest', agentId: 'a7e5ec6c821818fae',
  });
  const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission' } as const;

  it('`degrade` ze zrzutem subagenta bez klasy w rejestrze → `none`/`dump-no-class`, blok niepełny; zrzut odmowy też', async () => {
    const dumps: RefusalDump[] = [];
    const fx = await makeDriver({
      transcript: userLine('wypuść build'),
      deps: { readPendingHook: () => subagentHook(), dumpRefusal: (d) => { dumps.push(d); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = CLIPPED;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => fx.audit.some((e) => e.method === 'degrade'), 'wpis degrade');

    const entry = fx.audit.find((e) => e.method === 'degrade');
    expect(entry).toMatchObject({ route: 'none', routeReason: 'dump-no-class', blockVisible: false });
    expect(entry?.cliDialog).toBeUndefined();
    expect(dumps[0]?.shape).toMatchObject({ route: 'none', routeReason: 'dump-no-class', blockVisible: false });
  });

  it('`approve` cyfrą przy klasie `permission` bez zrzutu → wpis mówi `terminal-only`, cyfra i tak idzie jak dziś', async () => {
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    const card = permissions(fx.events).at(-1);

    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    const entry = fx.audit.find((e) => e.method === 'approve');
    expect(entry).toMatchObject({
      method: 'approve', keys: ['1'], cliDialog: 'permission', route: 'terminal-only',
      routeReason: 'permission-no-dump', blockVisible: true, source: 'jsonl',
    });
  });

  it('`approve` bez rejestru i bez zrzutu → `none`/`no-class`, bez `cliDialog`', async () => {
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'allow');
    await waitFor(() => fx.audit.some((e) => e.method === 'approve'), 'approve');

    const entry = fx.audit.find((e) => e.method === 'approve');
    expect(entry).toMatchObject({ route: 'none', routeReason: 'no-class', blockVisible: true });
    expect(entry?.cliDialog).toBeUndefined();
  });

  it('`refuse` z kartą niesie klasę z rejestru (dotąd tylko `degrade`) i werdykt z ostatniego ekranu', async () => {
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const network = readFileSync(join(FIXTURES, 'measured', 'zgoda-siec-2.1.293.txt'), 'utf8');
    fx.client.screenText = network;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'sandbox' });
    const card = permissions(fx.events).at(-1);

    fx.client.screenText = network.replaceAll('example.org', 'other.example');
    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
    const entry = fx.audit.find((e) => e.method === 'refuse');
    expect(entry).toMatchObject({
      reason: 'screen-changed', cliDialog: 'sandbox', route: 'terminal-only', routeReason: 'sandbox',
      blockVisible: false,
    });
  });

  it('wyjątek czytnika zrzutu hooka przy wpisie: cyfra idzie dokładnie raz, wpis bez werdyktu zrzutu', async () => {
    // Wyjątek tylko w odczycie DO DZIENNIKA (`#readHookQuietly`): odczyty ścieżki cyfry są starsze i ich
    // wyjątek kończy się `stale` jeszcze przed wpisem — to osobne zachowanie, nie tego testu.
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
      deps: {
        readPendingHook: () => {
          if (new Error().stack?.includes('readHookQuietly') === true) throw new Error('EIO');
          return null;
        },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    const card = permissions(fx.events).at(-1);

    await expect(fx.driver.respondPermission(card?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    const sentKeys = fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys as string[]);
    expect(sentKeys).toEqual([['1']]);
    expect(fx.audit.filter((e) => e.method === 'approve')).toHaveLength(1);
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({ route: 'none', routeReason: 'no-class' });
  });

  it('wpis bez treści: werdykt i flagi, ani komendy, ani etykiet z ekranu', async () => {
    const fx = await makeDriver({
      transcript: userLine('wypuść build'),
      deps: { readPendingHook: () => subagentHook() },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = CLIPPED;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => fx.audit.some((e) => e.method === 'degrade'), 'wpis degrade');
    const entry = fx.audit.find((e) => e.method === 'degrade');
    expect(JSON.stringify(entry)).not.toContain('git -C');
    expect(entry?.optionLabel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dialogi z listy terminalowej
// ---------------------------------------------------------------------------

describe('dialogi z listy terminalowej', () => {
  const PAUZA = readFileSync(join(FIXTURES, 'dialog-session-paused-2.1.309.txt'), 'utf8');
  const WYJSCIE = readFileSync(join(FIXTURES, 'dialog-background-work-exit-2.1.309.txt'), 'utf8');
  /** Pauza z innym kompletem opcji (opcje wymyślone) — spoza listy, karta z wycinkiem. */
  const PAUZA_INNA = PAUZA.replace(
    '  ❯ 1. Switch to Opus 4.8\n    2. Edit prompt and retry with Opus 5.5 (1M context)',
    '  ❯ 1. Keep waiting\n    2. Switch to Opus 4.8',
  );
  const PAUZA_OPCJE = ['Switch to Opus 4.8', 'Edit prompt and retry with Opus 5.5 (1M context)'];
  const keys = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const refuses = (fx: Fixture): HerdrAuditEntry[] => fx.audit.filter((e) => e.method === 'refuse');
  const REFUSED = { kind: 'refused', reason: 'terminal-only' };

  /** Panel staje na dialogu spoza jsonl; czekamy na kartę, którą ocena z niego zbuduje. */
  async function blockedOn(text: string, card: 'question' | 'screen-dialog' = 'question'): Promise<Fixture> {
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = text;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => (card === 'question' ? questions(fx.events) : screenDialogs(fx.events)).length > 0, 'karta');
    return fx;
  }

  it('pauza: karta pytania z tytułem i opcjami `terminalOnly`, wpis `degrade` z `dialogTitle`', async () => {
    const fx = await blockedOn(PAUZA);
    const [pytanie] = questions(fx.events)[0]?.questions ?? [];
    expect(pytanie?.header).toBe('Session paused');
    expect(pytanie?.options.map((o) => [o.label, o.terminalOnly])).toEqual(PAUZA_OPCJE.map((l) => [l, true]));
    expect(screenDialogs(fx.events)).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([
      expect.objectContaining({
        reason: 'no-jsonl', source: 'screen', optionCount: 2, dialogTitle: 'session-paused-safeguards',
      }),
    ]);
  });

  it('pauza: `answerQuestion` odmawia cyfry dla KAŻDEJ opcji, `allow` też — zero klawiszy', async () => {
    const fx = await blockedOn(PAUZA);
    for (const [index, label] of PAUZA_OPCJE.entries()) {
      // Odmowa gasi kartę i każe ją odbudować — następna próba idzie w kartę odbudowaną.
      await waitFor(() => questions(fx.events).length > index, 'karta po odmowie');
      const card = questions(fx.events).at(-1);
      await expect(fx.driver.answerQuestion(card?.reqId ?? '', [[label]])).resolves.toEqual(REFUSED);
    }
    await waitFor(() => questions(fx.events).length > PAUZA_OPCJE.length, 'karta po odmowie');
    await expect(fx.driver.respondPermission(SESSION, 'allow')).resolves.toEqual(REFUSED);
    await waitFor(() => questions(fx.events).length > PAUZA_OPCJE.length + 1, 'karta po odmowie');
    await expect(fx.driver.respondPermission(SESSION, 'allow-always')).resolves.toEqual(REFUSED);
    await quiet();

    expect(keys(fx)).toEqual([]);
    expect(systemTexts(fx.events).filter((t) => t === TERMINAL_DIALOG_MESSAGE.text)).toHaveLength(4);
    expect(refuses(fx).map((e) => [e.reason, e.dialogTitle])).toEqual(
      Array.from({ length: 4 }, () => ['terminal-only', 'session-paused-safeguards']),
    );
  });

  it('pauza: „Odrzuć” czyta ŚWIEŻY ekran tuż przed klawiszem i odmawia — bez `escape`', async () => {
    const fx = await blockedOn(PAUZA);
    const before = reads(fx.client);

    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    expect(reads(fx.client)).toBe(before + 1);
    expect(keys(fx)).toEqual([]);
    expect(systemTexts(fx.events)).toContain(PAUSE_ESCAPE_MESSAGE.text);
    expect(refuses(fx)).toEqual([
      expect.objectContaining({ reason: 'terminal-only', dialogTitle: 'session-paused-safeguards' }),
    ]);
    // Karta wraca oceną — dialog dalej stoi w terminalu.
    await waitFor(() => questions(fx.events).length > 1, 'karta wraca');
  });

  it('pauza: przerwanie (Esc z klawiatury apki poza kartą) też odmawia, a karta wraca', async () => {
    const fx = await blockedOn(PAUZA);
    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await waitFor(() => questions(fx.events).length > 1, 'karta wraca');
    expect(keys(fx)).toEqual([]);
    expect(systemTexts(fx.events)).toContain(PAUSE_ESCAPE_MESSAGE.text);
  });

  it('pauza: ekranu nie da się przeczytać tuż przed klawiszem → odmowa (fail-closed)', async () => {
    const fx = await blockedOn(PAUZA);
    fx.client.readScreen = (): Promise<HerdrScreen> => Promise.reject(new Error('gniazdo'));
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    expect(keys(fx)).toEqual([]);
  });

  it('pauza zamknięta przy biurku, na ekranie już INNY dialog → „Odrzuć” wysyła `escape` jak dotąd', async () => {
    const fx = await blockedOn(PAUZA);
    fx.client.screenText = WYJSCIE;
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(keys(fx)).toEqual([['escape']]);
  });

  it('pauza spoza listy (inny komplet opcji) → karta z wycinkiem, a „Odrzuć” i tak odmawia', async () => {
    const fx = await blockedOn(PAUZA_INNA, 'screen-dialog');
    expect(screenDialogs(fx.events)[0]?.reason).toBe('no-jsonl');
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    expect(keys(fx)).toEqual([]);
    expect(refuses(fx)[0]?.dialogTitle).toBeNull();
  });

  it('wyjście z zadaniami w tle: karta bez przycisków, ale „Odrzuć” wysyła `escape` (stopka „Esc to cancel”)', async () => {
    const fx = await blockedOn(WYJSCIE);
    const [pytanie] = questions(fx.events)[0]?.questions ?? [];
    expect(pytanie?.header).toBe('Background work is running');
    expect(pytanie?.options.every((o) => o.terminalOnly === true)).toBe(true);
    expect(fx.audit.find((e) => e.method === 'degrade')?.dialogTitle).toBe('background-work-exit');
    const before = reads(fx.client);

    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual({ kind: 'applied' });
    // Przy blokadzie Esc idzie po świeżym odczycie (karta nie dowodzi, że pauzy nie ma).
    expect(reads(fx.client)).toBe(before + 1);
    expect(keys(fx)).toEqual([['escape']]);
  });

  // Trzy odtworzenia na atrapie klienta.

  it('stara karta z etykietą pauzy („Switch to Opus 4.8”), na ekranie już pauza → cyfra NIE wychodzi', async () => {
    const PYTANIE = [
      '────────────────────────────────────────',
      ' Change model?',
      '',
      '  ❯ 1. Switch to Opus 4.8',
      '    2. Keep current model',
    ].join('\n');
    const fx = await blockedOn(PYTANIE);
    const card = questions(fx.events)[0];
    expect(card?.questions[0]?.options.some((o) => o.terminalOnly === true)).toBe(false);

    fx.client.screenText = PAUZA;
    await expect(fx.driver.answerQuestion(card?.reqId ?? '', [['Switch to Opus 4.8']]))
      .resolves.toEqual({ kind: 'refused', reason: 'screen-changed' });
    expect(keys(fx)).toEqual([]);
  });

  it('karta wyjścia, a dialog podmienił się w miejscu na pauzę przed oceną → przerwanie i „Odrzuć” odmawiają', async () => {
    const fx = await blockedOn(WYJSCIE);
    fx.client.screenText = PAUZA;
    await expect(fx.driver.interrupt()).resolves.toBe(false);
    await waitFor(() => questions(fx.events).length > 1, 'karta pauzy');
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    expect(keys(fx)).toEqual([]);
  });

  it('ślad pauzy przeżywa odmowę i ekran bez dialogu (przemalowanie): drugie „Odrzuć” przed odbudową karty też odmawia', async () => {
    const fx = await blockedOn(PAUZA);
    fx.client.screenText = '';
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    await expect(fx.driver.interrupt()).resolves.toBe(false);
    expect(keys(fx)).toEqual([]);
  });

  it('pauza spoza listy z kartą z wycinkiem i pusty świeży odczyt → odmowa (ślad z odczytu oceny)', async () => {
    const fx = await blockedOn(PAUZA_INNA, 'screen-dialog');
    fx.client.screenText = '';
    await expect(fx.driver.respondPermission(SESSION, 'deny')).resolves.toEqual(REFUSED);
    expect(keys(fx)).toEqual([]);
  });

  it('po zejściu z blokady (pauza rozstrzygnięta, tura ruszyła) przerwanie idzie jak dotąd, bez odczytu', async () => {
    const fx = await blockedOn(PAUZA);
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await quiet();
    const before = reads(fx.client);
    await expect(fx.driver.interrupt()).resolves.toBe(true);
    expect(keys(fx)).toEqual([['escape']]);
    expect(reads(fx.client)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Blok dialogu
// ---------------------------------------------------------------------------

describe('blok dialogu', () => {
  /** Zgoda `Bash` z ramką operacji (CLI 2.1.293): opcje „1. Yes" … „4. No". */
  const BASH_293 = readFileSync(join(FIXTURES, 'measured/zgoda-bash-2.1.293.txt'), 'utf8');
  /** Opis wywołania z sygnaturą dialogu zmiany modelu — tekst, który pisze agent. */
  const BASH_SWITCH_MODEL = BASH_293.replace(' Create empty file in Caches directory\n', ' Switch model check\n');
  /** Dialog zmiany modelu z parą opcji „Yes"/„No" — ten sam kształt co `dialog-model-switch.txt`. */
  const MODEL_YES_NO = [
    '✻ Churned for 3s', '', '▔'.repeat(63), '   Switch model?',
    '   Your next response will be slower and use more tokens', '', '   ❯ 1. Yes', '     2. No', '',
  ].join('\n');
  const MCP_293 = readFileSync(join(FIXTURES, 'measured/zgoda-mcp-2.1.293.txt'), 'utf8');
  const QUESTION_293 = readFileSync(join(FIXTURES, 'measured/pytanie-jednokrotne-2.1.293.txt'), 'utf8');
  /**
   * Fixture `dialog-trust.txt` ma „Yes, I trust this folder”, czyli opcję eskalującą: `allow` odmawia jej
   * z `no-digit` jeszcze przed bramką. Stąd syntetyczny `TRUST_DIALOG` z „Yes, proceed”.
   */
  const TRUST = TRUST_DIALOG;
  /** Dwie pary „kreska + tytuł" nad opcjami — blok niejednoznaczny (`ambiguous`). */
  const TWO_PAIRS = `${'─'.repeat(40)}\n Bash command\n${'─'.repeat(40)}\n Read file\n`;
  const ambiguous = (text: string, after: string): string => {
    if (!text.includes(after)) throw new Error(`brak kotwicy: ${after}`);
    return text.replace(after, `${after}${TWO_PAIRS}`);
  };
  const keys = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const CHANGED = { kind: 'refused', reason: 'screen-changed' };

  async function blockedOn(text: string): Promise<Fixture> {
    const fx = await makeDriver({ transcript: userLine('pracuj') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = text;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    return fx;
  }

  it('test 2: `/effort high`, a na ekranie zgoda Bash z „Switch model" w opisie → zero klawiszy', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { modelConfirmPollMs: 5 } });
    fx.client.screenText = BASH_SWITCH_MODEL;
    fx.client.screenAnsi = EMPTY_FIELD;

    fx.driver.sendCommands?.(['/effort high']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-foreign-dialog'), 'ostrzeżenie');
    await quiet();

    expect(keys(fx)).toEqual([]);
  });

  it('test 5: karta `dialog:model`, a świeży ekran to zgoda Bash z tą samą etykietą → screen-changed', async () => {
    const fx = await blockedOn(MODEL_YES_NO);
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu');
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('model');

    fx.client.screenText = BASH_293;
    await expect(fx.driver.respondPermission(SESSION, 'allow')).resolves.toEqual(CHANGED);
    expect(keys(fx)).toEqual([]);
  });

  describe('kontrole bramki tożsamości: ten sam ekran → cyfra, ekran `ambiguous` → screen-changed', () => {
    it('zgoda MCP z jsonl (nazwa kanoniczna z wpisu, parser bez nazwy)', async () => {
      for (const fresh of [MCP_293, ambiguous(MCP_293, ' (ctrl+o to expand description)\n')]) {
        const fx = await makeDriver({ transcript: userLine('pracuj') });
        await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
        await blockOn(fx, {
          id: 't-mcp', tool: 'mcp__catalog__catalog_get_project_tree_layout', input: {}, screen: MCP_293,
        });
        await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
        expect(permissions(fx.events)[0]?.input).not.toBeNull();
        fx.client.screenText = fresh;
        const outcome = await fx.driver.respondPermission('t-mcp', 'allow');
        if (fresh === MCP_293) {
          expect(outcome.kind).toBe('applied');
          expect(keys(fx)).toEqual([['1']]);
        } else {
          expect(outcome).toEqual(CHANGED);
          expect(keys(fx)).toEqual([]);
        }
      }
    });

    it('formularz pytania z ekranu', async () => {
      const after = '  Truskawka. Nie pisz nic poza tym wywołaniem.\n';
      for (const fresh of [QUESTION_293, ambiguous(QUESTION_293, after)]) {
        const fx = await blockedOn(QUESTION_293);
        await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
        fx.client.screenText = fresh;
        const outcome = await fx.driver.answerQuestion(questions(fx.events)[0]?.reqId ?? '', [['Wanilia']]);
        if (fresh === QUESTION_293) {
          expect(outcome.kind).toBe('applied');
          expect(keys(fx)).toEqual([['1']]);
        } else {
          expect(outcome).toEqual(CHANGED);
          expect(keys(fx)).toEqual([]);
        }
      }
    });

    it('potwierdzenie z ekranu', async () => {
      const effort = readFileSync(join(FIXTURES, 'dialog-effort-change.txt'), 'utf8');
      for (const fresh of [effort, ambiguous(effort, '✻ Sautéed for 27s\n')]) {
        const fx = await blockedOn(effort);
        await waitFor(() => questions(fx.events).length > 0, 'karta potwierdzenia');
        fx.client.screenText = fresh;
        const card = questions(fx.events)[0];
        const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Yes, switch to high']]);
        if (fresh === effort) {
          expect(outcome.kind).toBe('applied');
          expect(keys(fx)).toEqual([['1']]);
        } else {
          expect(outcome).toEqual(CHANGED);
          expect(keys(fx)).toEqual([]);
        }
      }
    });

    it('znany dialog `trust`', async () => {
      for (const fresh of [TRUST, `${TWO_PAIRS}${TRUST}`]) {
        const fx = await blockedOn(TRUST);
        await waitFor(() => screenDialogs(fx.events).length > 0, 'karta dialogu');
        expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
        fx.client.screenText = fresh;
        const outcome = await fx.driver.respondPermission(SESSION, 'allow');
        if (fresh === TRUST) {
          expect(outcome.kind).toBe('applied');
          expect(keys(fx)).toEqual([['1']]);
        } else {
          expect(outcome).toEqual(CHANGED);
          expect(keys(fx)).toEqual([]);
        }
      }
    });
  });
});

/*
 * Odcisk BLOKU przed cyfrą: karta pytania, potwierdzenia i znanego dialogu niesie skrót bloku
 * dialogu, a `#digitStillHolds` porównuje go ze świeżym odczytem. Zmiana jednej linii bloku przy tych samych
 * etykietach (inne potwierdzenie z „Yes” pod cyfrą 1) daje odmowę i kartę od nowa. Zegar sterowany: odczytów
 * do chwili odmowy nie dokłada żaden obrót oceny.
 */
describe('odcisk bloku przed cyfrą: pytanie, potwierdzenie, znany dialog', () => {
  const EFFORT_LINE = 'Switching to high means the full history';
  const MODEL_LINE = 'Your next response will be slower';
  const QUESTION_INPUT = {
    questions: [{
      question: 'Który wariant zapisu wybrać?',
      header: 'Zapis pliku',
      multiSelect: false,
      options: [
        { label: 'Zapis atomowy (tmp + rename)', description: 'Bezpieczniejszy' },
        { label: 'Zapis w miejscu', description: 'Szybszy' },
      ],
    }],
  };
  const RESUME = readFileSync(join(FIXTURES, 'dialog-resume-summary-2.1.258.txt'), 'utf8');
  const CHANGED = { kind: 'refused', reason: 'screen-changed' };
  const keys = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const approves = (fx: Fixture): HerdrAuditEntry[] => fx.audit.filter((e) => e.method === 'approve');
  /** Ekran z jedną podmianą; rzuca, gdy kotwicy nie ma (test nie ma prawa przejść na niezmienionym ekranie). */
  const edited = (text: string, from: string, to: string): string => {
    if (!text.includes(from)) throw new Error(`brak kotwicy: ${from}`);
    return text.replace(from, to);
  };

  interface Rig { readonly fx: Fixture; readonly clock: ReturnType<typeof drivenClock> }

  /** Obroty zegara do spełnienia warunku; między nimi chwila realnego czasu dla followera na `fs/promises`. */
  async function until(rig: Rig, predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await rig.clock.advance(10);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`timeout: ${label}`);
  }

  async function blockedOn(text: string, transcript = userLine('pracuj')): Promise<Rig> {
    const clock = drivenClock();
    const fx = await makeDriver({ transcript, deps: { scheduler: clock.scheduler } });
    await waitFor(
      () => (['history', 'artifacts', 'background-tasks'] as const).every((type) => fx.events.some((e) => e.type === type)),
      'historia i pierwsze listy',
    );
    fx.client.screenText = text;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    const rig = { fx, clock };
    await until(rig, () => questions(fx.events).length > 0 || screenDialogs(fx.events).length > 0, 'karta');
    return rig;
  }

  /** Tapnięcie nad ekranem `fresh`: wynik i liczba odczytów herdr od tapnięcia do wyniku, bez obrotu zegara. */
  async function tap(
    rig: Rig, fresh: string, decide: () => Promise<DecisionOutcome>,
  ): Promise<{ outcome: DecisionOutcome; reads: number }> {
    rig.fx.client.screenText = fresh;
    const before = reads(rig.fx.client);
    const outcome = await decide();
    return { outcome, reads: reads(rig.fx.client) - before };
  }

  describe('zmiana jednej linii bloku przy tych samych etykietach', () => {
    const cases: readonly {
      name: string; screen: string; changed: string; transcript?: string; card: (rig: Rig) => Promise<DecisionOutcome>;
    }[] = [
      {
        name: 'karta `dialog:confirm` z `dialog-effort-change.txt` (answerQuestion)',
        screen: DIALOG_EFFORT,
        changed: edited(DIALOG_EFFORT, EFFORT_LINE, 'Switching to high means the whole history'),
        card: (rig) => rig.fx.driver.answerQuestion(questions(rig.fx.events)[0]?.reqId ?? '', [['Yes, switch to high']]),
      },
      {
        name: 'karta `dialog:model` z `dialog-model-switch.txt` (respondPermission allow)',
        screen: DIALOG_MODEL,
        changed: edited(DIALOG_MODEL, MODEL_LINE, 'Your next response will be faster'),
        card: (rig) => rig.fx.driver.respondPermission(SESSION, 'allow'),
      },
      {
        name: 'karta `AskUserQuestion` z jsonl (answerQuestion)',
        screen: DIALOG_QUESTION,
        changed: edited(DIALOG_QUESTION, 'Bezpieczniejszy, o jeden syscall więcej', 'Bezpieczniejszy, o dwa syscalle więcej'),
        transcript: userLine('zapytaj mnie') + toolUseLine('q-1', 'AskUserQuestion', QUESTION_INPUT),
        card: (rig) => rig.fx.driver.answerQuestion('q-1', [['Zapis atomowy (tmp + rename)']]),
      },
    ];

    it.each(cases)('$name: odmowa `screen-changed`, zero klawiszy, dokładnie jeden odczyt', async (c) => {
      const rig = await blockedOn(c.screen, c.transcript);
      if (c.name.includes('dialog:model')) expect(screenDialogs(rig.fx.events)[0]?.knownDialog).toBe('model');
      const { outcome, reads: count } = await tap(rig, c.changed, () => c.card(rig));
      expect(outcome).toEqual(CHANGED);
      expect(keys(rig.fx)).toEqual([]);
      expect(count).toBe(1);
      expect(rig.fx.audit.filter((e) => e.method === 'refuse').map((e) => e.reason)).toEqual(['screen-changed']);
    });

    it.each(cases)('$name, kontrola: bez zmiany linii cyfra idzie', async (c) => {
      const rig = await blockedOn(c.screen, c.transcript);
      const { outcome, reads: count } = await tap(rig, c.screen, () => c.card(rig));
      expect(outcome.kind).toBe('applied');
      expect(keys(rig.fx)).toEqual([['1']]);
      expect(count).toBe(1);
    });
  });

  it('karta pytania z ekranu i `blocked → working → blocked` nad tym samym blokiem: ten sam `reqId`, cyfra idzie', async () => {
    const rig = await blockedOn(DIALOG_QUESTION);
    const first = questions(rig.fx.events)[0];
    rig.fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await until(rig, () => cleared(rig.fx.events).length > 0, 'karta zgaszona');
    rig.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
    await until(rig, () => questions(rig.fx.events).length > 1, 'karta w nowej blokadzie');
    const second = questions(rig.fx.events).at(-1);
    expect(second?.reqId).toBe(first?.reqId);

    const outcome = await rig.fx.driver.answerQuestion(second?.reqId ?? '', [['Zapis w miejscu']]);

    expect(outcome.kind).toBe('applied');
    expect(keys(rig.fx)).toEqual([['2']]);
    expect(approves(rig.fx)).toHaveLength(1);
  });

  it('po odmowie za zmienione pytanie karta ma NOWY `reqId`, a tapnięcie na niej wysyła cyfrę', async () => {
    const rig = await blockedOn(DIALOG_EFFORT);
    const card = questions(rig.fx.events)[0];
    const changed = edited(DIALOG_EFFORT, EFFORT_LINE, 'Switching to high means the whole history');
    const { outcome } = await tap(rig, changed,
      () => rig.fx.driver.answerQuestion(card?.reqId ?? '', [['Yes, switch to high']]));
    expect(outcome).toEqual(CHANGED);

    await until(rig, () => questions(rig.fx.events).length > 1, 'karta od nowa');
    const next = questions(rig.fx.events).at(-1);
    expect(next?.reqId).not.toBe(card?.reqId);
    expect(next?.questions[0]?.question).toContain('the whole history');

    const second = await rig.fx.driver.answerQuestion(next?.reqId ?? '', [['Yes, switch to high']]);
    expect(second.kind).toBe('applied');
    expect(keys(rig.fx)).toEqual([['1']]);
  });

  describe('zmiana samego opisu opcji albo samej stopki — ten sam `reqId`, nowy odcisk', () => {
    const cases = [
      {
        name: 'opis opcji pytania z ekranu',
        screen: DIALOG_QUESTION,
        changed: edited(DIALOG_QUESTION, 'Bezpieczniejszy, o jeden syscall więcej', 'Bezpieczniejszy, o dwa syscalle więcej'),
        answer: 'Zapis atomowy (tmp + rename)',
      },
      {
        name: 'stopka potwierdzenia `dialog-resume-summary-2.1.258.txt`',
        screen: RESUME,
        changed: edited(RESUME, 'Enter to confirm · Esc to cancel', 'Enter to select · Esc to cancel'),
        answer: 'Resume from summary (recommended)',
      },
    ] as const;

    it.each(cases)('$name', async (c) => {
      const rig = await blockedOn(c.screen);
      const card = questions(rig.fx.events)[0];
      const { outcome } = await tap(rig, c.changed, () => rig.fx.driver.answerQuestion(card?.reqId ?? '', [[c.answer]]));
      expect(outcome).toEqual(CHANGED);
      expect(keys(rig.fx)).toEqual([]);

      await until(rig, () => questions(rig.fx.events).length > 1, 'karta od nowa');
      const again = questions(rig.fx.events).at(-1);
      expect(again?.reqId).toBe(card?.reqId);

      const second = await rig.fx.driver.answerQuestion(again?.reqId ?? '', [[c.answer]]);
      expect(second.kind).toBe('applied');
      expect(keys(rig.fx)).toEqual([['1']]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tryb cienia (`RAROG_CONSENT_CHANNEL=shadow`): plik cienia przed klawiszem, klawisz jak przy `off`
// ---------------------------------------------------------------------------

describe('tryb cienia: plik cienia przed klawiszem, klawisz bez zmian', { timeout: 5_000 }, () => {
  const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
  const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission' } as const;
  const KEY = `${'a'.repeat(8)}-${'0'.repeat(31)}1`;

  /** Zrzut per wywołanie hooka w `pending/<sesja>/` — tak, jak go zostawia `rarog-pending.mjs`. */
  async function writeDump(dataDir: string, toolInput: unknown = BASH_INPUT): Promise<void> {
    const dir = join(dataDir, HOOK_PENDING_DIRNAME, SESSION);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${KEY}.json`), JSON.stringify({
      key: KEY, sessionId: SESSION, promptId: 'p', pid: 4242, startedAt: NOW - 6_000, toolName: 'Bash',
      toolInput, cwd: '/projekt', at: NOW - 5_000, inputSha256: canonicalSha256(toolInput),
    }));
  }

  function realChannel(dataDir: string, alive: boolean | null = true): ShadowChannel {
    return createShadowChannel({
      dataDir, bootId: 'boot', now: () => NOW,
      liveness: (procs) => Promise.resolve(new Map(procs.map((p) => [p.pid, alive]))),
      schedule: () => {},
    });
  }

  /** Kanał-szpieg: przed oddaniem wyniku zapisuje, ile klawiszy już wyszło. */
  function spy(inner: ShadowConsentChannel, client: () => FakeClient | null) {
    const seen: { decision: string; keysBefore: number; fileBefore: boolean }[] = [];
    const sent: { result: string; sent: boolean }[] = [];
    const channel: ShadowConsentChannel = {
      async prepare(request, abandoned) {
        const outcome = await inner.prepare(request, abandoned);
        const fx = client();
        seen.push({
          decision: request.decision,
          keysBefore: fx === null ? -1 : fx.calls.filter((c) => c.method === 'send_keys').length,
          fileBefore: outcome.key !== undefined,
        });
        return outcome;
      },
      keySent(outcome, ok) {
        sent.push({ result: outcome.result, sent: ok });
        inner.keySent(outcome, ok);
      },
      release: (request) => inner.release(request),
    };
    return { channel, seen, sent };
  }

  async function blockedCard(deps: Partial<HerdrDriverDeps>): Promise<{ fx: Fixture; reqId: string }> {
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
      deps,
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    return { fx, reqId: permissions(fx.events).at(-1)?.reqId ?? '' };
  }

  const sentKeys = (fx: Fixture): string[][] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys as string[]);

  it('`shadow`: plik cienia `allow` leży PRZED cyfrą, cyfra i wynik jak przy `off`', async () => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    let client: FakeClient | null = null;
    const s = spy(realChannel(dataDir), () => client);
    const { fx, reqId } = await blockedCard({ shadow: s.channel });
    client = fx.client;

    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['1']]);
    expect(s.seen).toEqual([{ decision: 'allow', keysBefore: 0, fileBefore: true }]);
    expect(s.sent).toEqual([{ result: 'written', sent: true }]);
    const file = JSON.parse(readFileSync(join(dataDir, HOOK_SHADOW_DIRNAME, SESSION, `${KEY}.json`), 'utf8')) as {
      decision: string; key: string;
    };
    expect(file).toMatchObject({ decision: 'allow', key: KEY });
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'written', shadowKey: KEY });
    expect(fx.audit.find((e) => e.method === 'approve')?.shadowDetail).toBeUndefined();
    // Dziennik bez treści wywołania.
    expect(JSON.stringify(fx.audit)).not.toContain('state-machine.test.ts');
  });

  it('`off` (bez kanału): ta sama cyfra, zero plików cienia, wpis bez pól cienia', async () => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    const { fx, reqId } = await blockedCard({});

    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['1']]);
    await expect(readdir(join(dataDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
    const approve = fx.audit.find((e) => e.method === 'approve');
    expect(approve?.shadow).toBeUndefined();
    expect(approve?.shadowKey).toBeUndefined();
    expect(approve?.shadowDetail).toBeUndefined();
  });

  it('odmowa z telefonu: plik cienia `deny` przed `escape`, klawisz jak przy `off`', async () => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    let client: FakeClient | null = null;
    const s = spy(realChannel(dataDir), () => client);
    const { fx, reqId } = await blockedCard({ shadow: s.channel });
    client = fx.client;

    await expect(fx.driver.respondPermission(reqId, 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['escape']]);
    expect(s.seen).toEqual([{ decision: 'deny', keysBefore: 0, fileBefore: true }]);
    const file = JSON.parse(readFileSync(join(dataDir, HOOK_SHADOW_DIRNAME, SESSION, `${KEY}.json`), 'utf8')) as {
      decision: string;
    };
    expect(file.decision).toBe('deny');
    expect(fx.audit.find((e) => e.method === 'send_keys')).toMatchObject({ shadow: 'written', shadowKey: KEY });
  });

  it('wyjątek w kanale cienia: cyfra idzie dokładnie raz, wpis `shadow: error`', async () => {
    const channel: ShadowConsentChannel = {
      prepare: () => { throw new Error('EIO'); },
      keySent: () => { throw new Error('EIO'); },
      release: () => { throw new Error('EIO'); },
    };
    const { fx, reqId } = await blockedCard({ shadow: channel });

    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['1']]);
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'error', shadowDetail: 'blad' });
  });

  it('kanał, który nie odpowiada: po suficie czasu cyfra idzie, kanał dostaje „porzucone”', async () => {
    const seen: { abandoned: (() => boolean) | null } = { abandoned: null };
    const channel: ShadowConsentChannel = {
      prepare: (_request, abandoned) => {
        seen.abandoned = abandoned;
        return new Promise<ShadowOutcome>(() => {});
      },
      keySent: () => {},
      release: () => Promise.resolve(0),
    };
    const { fx, reqId } = await blockedCard({ shadow: channel });

    const started = Date.now();
    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(SHADOW_DEADLINE_MS - 20);
    expect(sentKeys(fx)).toEqual([['1']]);
    expect(seen.abandoned?.()).toBe(true);
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'error', shadowDetail: 'timeout' });
  });

  it('synchroniczna część kanału dłuższa niż sufit: „porzucone” bez timera, pliku cienia nie ma', async () => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    const inner = realChannel(dataDir);
    const asked: boolean[] = [];
    const channel: ShadowConsentChannel = {
      prepare: (request, abandoned) => {
        // Odczyty i dowód blokują pętlę: timer sufitu nie odpali przed pytaniem kanału „piszę?”.
        const end = Date.now() + SHADOW_DEADLINE_MS + 30;
        while (Date.now() < end) { /* zajęta pętla */ }
        asked.push(abandoned());
        return inner.prepare(request, abandoned);
      },
      keySent: (outcome, ok) => { inner.keySent(outcome, ok); },
      release: (request) => inner.release(request),
    };
    const { fx, reqId } = await blockedCard({ shadow: channel });

    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['1']]);
    expect(asked).toEqual([true]);
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'error' });
    await expect(readdir(join(dataDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bez zrzutu per wywołanie: wynik `no-dump`, cyfra bez zmian, zero plików cienia', async () => {
    const dataDir = join(base, 'dane');
    const { fx, reqId } = await blockedCard({ shadow: realChannel(dataDir) });

    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['1']]);
    expect(fx.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'no-dump' });
    expect(fx.audit.find((e) => e.method === 'approve')?.shadowDetail).toBeUndefined();
    await expect(readdir(join(dataDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [false, 'no-proof:hook-martwy'],
    [null, 'no-proof:hook-nieznany'],
  ] as const)('`ps` mówi o hooku %s: `no-proof`, powód w `shadowDetail`, cyfra bez zmian', async (alive, why) => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    const { fx, reqId } = await blockedCard({ shadow: realChannel(dataDir, alive) });

    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['1']]);
    const approve = fx.audit.find((e) => e.method === 'approve');
    expect(approve).toMatchObject({ shadow: 'no-proof', shadowDetail: why });
    expect(approve?.shadowKey).toBeUndefined();
    await expect(readdir(join(dataDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('odmowa z telefonu przy martwym hooku: `escape` jak przy `off`, wpis z `no-proof:hook-martwy`', async () => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    const { fx, reqId } = await blockedCard({ shadow: realChannel(dataDir, false) });

    await expect(fx.driver.respondPermission(reqId, 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(sentKeys(fx)).toEqual([['escape']]);
    expect(fx.audit.find((e) => e.method === 'send_keys'))
      .toMatchObject({ shadow: 'no-proof', shadowDetail: 'no-proof:hook-martwy' });
  });

  it('sierota po decyzji przy biurku: jeden odczyt rejestru `active` → `.revoked`; przy `off` nic', async () => {
    const ACTIVE = { kind: 'active' } as const;
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    const fx = await makeDriver({ deps: { shadow: realChannel(dataDir) } });
    fx.driver.noteCliWaiting?.(ACTIVE);
    const dir = join(dataDir, HOOK_SHADOW_DIRNAME, SESSION);
    await waitFor(() => {
      try {
        return readdirSync(dir).includes(`${KEY}.revoked`);
      } catch {
        return false;
      }
    }, 'znacznik .revoked');
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);

    const offDir = join(base, 'dane-off');
    await writeDump(offDir);
    const off = await makeDriver({});
    off.driver.noteCliWaiting?.(ACTIVE);
    await quiet();
    await expect(readdir(join(offDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /*
   * Karta bez przycisków nad widokiem `/status` (ekran bez opcji z cyframi, karta `dialog`): kanał cienia jej nie
   * pomija (nazwa bez `:`), ale zrzutu o nazwie `dialog` nie ma, więc pliku cienia nie pisze. Blok widoku na karcie
   * i tytuł bloku w `reqId` tego nie zmieniają — wynik ten sam co przy ogonie ekranu na karcie.
   */
  describe('karta `screen-dialog` `dialog` przy kanale cienia ze zrzutem `Bash`', () => {
    const raw = readFileSync(join(FIXTURES, 'refusals', 'widok-status-2.1.310.txt'), 'utf8');
    const STATUS = raw.slice(raw.indexOf('\n--- ekran ---\n') + '\n--- ekran ---\n'.length);

    async function statusCard(channel: ShadowConsentChannel): Promise<{ fx: Fixture; reqId: string }> {
      const fx = await makeDriver({ transcript: userLine('pracuj'), deps: { shadow: channel } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = STATUS;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => screenDialogs(fx.events).length > 0, 'karta bez przycisków');
      // Zdarzenie karty nie niesie `reqId`; wpis `degrade` dziennika niesie ten sam, którym apka ją adresuje.
      await waitFor(() => fx.audit.some((e) => e.method === 'degrade'), 'wpis degrade');
      const degrade = fx.audit.find((e) => e.method === 'degrade');
      expect(degrade).toMatchObject({ reason: 'unreadable' });
      return { fx, reqId: degrade?.reqId ?? '' };
    }

    it('„Odrzuć”: `escape` idzie, krok cienia bez pliku, katalog cienia pusty', async () => {
      const dataDir = join(base, 'dane');
      await writeDump(dataDir);
      let client: FakeClient | null = null;
      const s = spy(realChannel(dataDir), () => client);
      const { fx, reqId } = await statusCard(s.channel);
      client = fx.client;
      expect(screenDialogs(fx.events)[0]).toMatchObject({ reason: 'unreadable' });

      await expect(fx.driver.respondPermission(reqId, 'deny')).resolves.toEqual({ kind: 'applied' });
      expect(sentKeys(fx)).toEqual([['escape']]);
      expect(s.seen).toEqual([{ decision: 'deny', keysBefore: 0, fileBefore: false }]);
      await expect(readdir(join(dataDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('„Zezwól”: odmowa `no-digit` przed cyfrą, kanał cienia niewołany', async () => {
      const dataDir = join(base, 'dane');
      await writeDump(dataDir);
      let client: FakeClient | null = null;
      const s = spy(realChannel(dataDir), () => client);
      const { fx, reqId } = await statusCard(s.channel);
      client = fx.client;
      expect(reqId.startsWith('screen:')).toBe(true);

      await expect(fx.driver.respondPermission(reqId, 'allow'))
        .resolves.toEqual({ kind: 'refused', reason: 'no-digit' });
      expect(sentKeys(fx)).toEqual([]);
      expect(s.seen).toEqual([]);
      await expect(readdir(join(dataDir, HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('cyfra, której ekran już nie potwierdza: zero klawiszy, plik cienia odwołany', async () => {
    const dataDir = join(base, 'dane');
    await writeDump(dataDir);
    const { fx, reqId } = await blockedCard({ shadow: realChannel(dataDir) });
    fx.client.screenText = 'zwykły ekran bez dialogu';

    const outcome = await fx.driver.respondPermission(reqId, 'allow');
    expect(outcome.kind).toBe('refused');
    expect(sentKeys(fx)).toEqual([]);
    const dir = join(dataDir, HOOK_SHADOW_DIRNAME, SESSION);
    expect((await readdir(dir)).sort()).toEqual([`${KEY}.revoked`]);
  });
});

describe('karta bloku w dzienniku (`block-card`)', () => {
  const TRUST = readFileSync(join(FIXTURES, 'kontrolny', 'zaufanie-2.1.314.txt'), 'utf8');
  const blockCards = (fx: Fixture): HerdrAuditEntry[] => fx.audit.filter((e) => e.method === 'block-card');

  interface Rig { readonly fx: Fixture; readonly clock: ReturnType<typeof drivenClock> }

  async function until(rig: Rig, predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await rig.clock.advance(10);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`timeout: ${label}`);
  }

  /** Panel w `blocked` nad ekranem, bez wpisu jsonl: karta powstaje z samego ekranu. */
  async function blockedOn(text: string): Promise<Rig> {
    const clock = drivenClock();
    const fx = await makeDriver({ transcript: userLine('pracuj'), deps: { scheduler: clock.scheduler } });
    await waitFor(
      () => (['history', 'artifacts', 'background-tasks'] as const).every((type) => fx.events.some((e) => e.type === type)),
      'historia i pierwsze listy',
    );
    fx.client.screenText = text;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    const rig = { fx, clock };
    await until(rig, () => questions(fx.events).length > 0 || screenDialogs(fx.events).length > 0, 'karta');
    // Wpis `degrade` czeka na wiersze panelu (do 500 ms zegara drivera).
    await rig.clock.advance(600);
    return rig;
  }

  /** Pola wpisu, których `block-card` nie ma prawa nieść: treść, etykiety, klawisze, cyfra. */
  const CONTENT_FIELDS = ['text', 'optionLabel', 'keys', 'digit', 'shape', 'command'] as const;

  it('pytanie z samego ekranu: jeden wpis z odciskiem karty, liczbą opcji i werdyktem `buttons`, bez treści', async () => {
    const { fx } = await blockedOn(DIALOG_QUESTION);
    const card = questions(fx.events)[0]!;
    const entries = blockCards(fx);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      reqId: card.reqId, source: 'screen', toolName: 'dialog:question', optionCount: 2, verdict: 'buttons',
    });
    expect(entry.print).toMatch(/^[0-9a-f]{16}$/);
    for (const field of CONTENT_FIELDS) expect(entry).not.toHaveProperty(field);
    // Karta z przyciskami nie jest degradacją: wpisu `degrade` brak.
    expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
  });

  it('znany dialog `model` z samego ekranu: wpis z werdyktem `buttons` i odciskiem', async () => {
    const { fx } = await blockedOn(DIALOG_MODEL);
    // Zdarzenie `screen-dialog` nie niesie `reqId` (adresem decyzji jest sesja); tożsamość karty jest w dzienniku.
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('model');
    const entries = blockCards(fx);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'screen', toolName: 'dialog:model', optionCount: 2, verdict: 'buttons' });
    expect(entries[0]?.reqId).toMatch(/^screen:/);
    expect(entries[0]?.print).toMatch(/^[0-9a-f]{16}$/);
  });

  it('zaufanie bez cyfr (CLI 2.1.314): znany dialog `trust`, wpis bez cyfr z odciskiem parsera, bez `degrade`', async () => {
    const { fx } = await blockedOn(TRUST);
    expect(screenDialogs(fx.events)).toHaveLength(1);
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
    const entries = blockCards(fx);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'screen', toolName: 'dialog:trust', optionCount: 0, verdict: 'no-buttons',
      print: parseTrustArrowDialog(TRUST)?.bodyPrint,
    });
    expect(fx.audit.filter((e) => e.method === 'degrade')).toEqual([]);
  });

  it('ten sam dialog przy kolejnych obrotach zegara: nadal jeden wpis', async () => {
    const rig = await blockedOn(DIALOG_QUESTION);
    for (let i = 0; i < 5; i += 1) await rig.clock.advance(4_000);
    expect(blockCards(rig.fx)).toHaveLength(1);
  });

  it('karta z wpisu jsonl nie dostaje wpisu `block-card`', async () => {
    const fx = await makeDriver({ transcript: userLine('zrób to') });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await blockOn(fx, { id: 't-blok', tool: 'Bash', input: BASH_INPUT, screen: DIALOG_PERMISSION });
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    await quiet();
    expect(permissions(fx.events)[0]?.reqId).toBe('t-blok');
    expect(blockCards(fx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wysyłka w trakcie tury: wklejenie, sprawdzenie, osobny Enter (karta 0a)
// ---------------------------------------------------------------------------
