/**
 * Karta bloku bez cyfr warstwy 2 i flaga `RAROG_DIALOG_LAYER2` (opis:
 * `docs/dialogs.md`, „Block card without digits”).
 *
 * Zdania, których pilnuje plik:
 *
 * - przy fladze `1` widok `/skills` (CLI 2.1.310, 44 linie, ponad sufit wycinka bez flagi) dostaje na kartę cały blok
 *   od tytułu, tytuł w tożsamości karty i ślad warstwy 2 (`block-no-digits`); powód na karcie zostaje `unreadable`;
 * - przy fladze `1` zmieniają się wyłącznie karty z listy {@link LAYER2_CHANGED}, i tylko tożsamość, wycinek i ślad
 *   warstwy 2: rodzaj akcji, opcje, powód, wpis do dziennika i kształt przypadku zostają;
 * - przy fladze `0` (pole nieobecne albo `false`) decyzja nigdy nie zwraca `refresh`, a przy fladze `1` zwraca go
 *   dokładnie dla tej samej tożsamości karty z innym odciskiem bloku;
 * - zakładki `/status` pod tą samą kartą odświeżają wycinek przez driver i managera do podsumowania sesji, także
 *   przy tekście tej samej długości, bez `permission-cleared` i bez drugiego wpisu `block-card`;
 * - przy fladze `0` linie dziennika driver pisze bajt w bajt jak przed flagą ({@link FLAG0_AUDIT}, zapisane
 *   z kodu sprzed zmiany), a karta wychodzi ta sama.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrStatus, ServerEvent, SessionSummary } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createHerdrAuditLog, herdrAuditPath } from '../src/herdr/audit.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import type { ActiveReq, DecisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import {
  LAYER2_EXCERPT_MAX_CHARS, LAYER2_EXCERPT_MAX_LINES, blockNoDigitsExcerpt,
} from '../src/herdr/dialogs/layer2/card.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';
import { trimmedLines } from '../src/herdr/dialogs/screen/text.ts';
import { sessionIdFor } from '../src/herdr/identity.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrClient, HerdrLifecycleEvent, HerdrPaneEvent, HerdrScreen, HerdrSupervisor,
} from '../src/herdr/types.ts';
import type { NotifierLike } from '../src/notify/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

/** Korpus ekranów jak w pełnym pliku złotym (`dialogs-full-cards.test.ts`). */
const DIRS = ['', 'measured/', 'refusals/', 'queue/measured/', 'kontrolny/'] as const;
const CORPUS = DIRS.flatMap((sub) => readdirSync(join(DIR, sub))
  .filter((name) => name.endsWith('.txt'))
  .map((name) => `${sub}${name}`))
  .sort();

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek `klucz: wartość`. */
function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

const SKILLS = screenOf('refusals/widok-skills-2.1.310.txt');
/** Zakładka „Status” widoku `/status` (CLI 2.1.310). */
const STATUS_TAB = screenOf('refusals/widok-status-2.1.310.txt');
/** Zakładka „Usage” tego samego widoku (CLI 2.1.316): ten sam tytuł bloku, inna treść. */
const USAGE_TAB = screenOf('kontrolny/usage-klucz-api-2.1.316.txt');
/** Ta sama zakładka sekundę później: licznik czasu `11s` → `12s`, wycinek tej samej długości. */
const USAGE_TAB_LATER = USAGE_TAB.replace('Total duration (wall): 11s', 'Total duration (wall): 12s');

/**
 * Ekrany korpusu, których karta przy fladze `1` niesie ślad warstwy 2 (`block-no-digits`): blok bez opcji z cyframi
 * w sufitcie warstwy 2. Lista z przebiegu korpusu; nowy ekran w korpusie albo zmiana decyzji, która ją rusza, wymaga
 * przeglądu i wpisu tutaj. Dialogu zaufania bez cyfr tu nie ma: to znany dialog `trust`, jak `model`.
 */
const LAYER2_BLOCKS: readonly string[] = [
  'dialog-askuserquestion-linia-nazwy-luka-2.1.281.txt',
  'dialog-automode-teach-2.1.258.txt',
  'ekran-login-2.1.293.txt',
  'kontrolny/auto-bez-kontroli-bash-2.1.322.txt',
  // Bash consent after Enter on "Auto mode can't check actions": the options No and Yes stand without digits.
  'kontrolny/auto-bez-kontroli-bash-po-enter-2.1.322.txt',
  // Start dialog about external imports of the project memory file: the options No and Yes stand without digits.
  'kontrolny/importy-zewnetrzne-2.1.332.txt',
  'kontrolny/importy-zewnetrzne-po-down-2.1.332.txt',
  'kontrolny/importy-zewnetrzne-po-zaufaniu-2.1.332.txt',
  'kontrolny/picker-effort-2.1.314.txt',
  'kontrolny/picker-effort-2.1.316.txt',
  'kontrolny/picker-effort-2.1.319.txt',
  'kontrolny/picker-effort-2.1.322.txt',
  'kontrolny/picker-effort-po-prawo-2.1.322.txt',
  'kontrolny/picker-effort-po-tab-2.1.322.txt',
  'kontrolny/picker-effort-ultracode-on-2.1.317.txt',
  'kontrolny/picker-effort-ultracode-status-2.1.318.txt',
  // Dialog startowy `--permission-mode bypassPermissions`: opcje bez cyfr.
  'kontrolny/tryb-bypass-2.1.319.txt',
  'kontrolny/usage-klucz-api-2.1.314.txt',
  'kontrolny/usage-klucz-api-2.1.316.txt',
  'kontrolny/usage-klucz-api-2.1.319.txt',
  'kontrolny/usage-klucz-api-2.1.322.txt',
  'kontrolny/widok-help-2.1.322.txt',
  // Workflow approval in auto mode: the phase list stands above a choice without digits, so the block has none.
  'kontrolny/zatwierdzenie-workflow-auto-bez-kontroli-2.1.322.txt',
  // `Edit` consent after Enter on "Auto mode can't check actions": the options No and Yes stand without digits.
  'kontrolny/zgoda-bez-hooka-claude-md-auto-2.1.330.txt',
  'kontrolny/zgoda-bez-hooka-claude-md-auto-link-2.1.330.txt',
  'measured/picker-effort-2.1.312-26kol.txt',
  'refusals/widok-help-2.1.310.txt',
  'refusals/widok-skills-2.1.310.txt',
  'refusals/widok-status-2.1.310.txt',
  'refusals/widok-status-stechly-zrzut-2.1.310.txt',
];

/**
 * Podzbiór {@link LAYER2_BLOCKS}, którego KARTA się zmienia (tożsamość albo wycinek), bo blok przekracza sufit
 * wycinka bez flagi (5.8). Reszta dostaje tylko ślad warstwy 2: ten sam wycinek i ta sama tożsamość.
 */
const LAYER2_CARD_CHANGES: readonly string[] = [
  // Formularz z luką w numeracji opcji (parser go nie czyta): blok 59 linii od „5. Chat about this” ze stopką
  // zamiast ogona ekranu, który pokazywał samą kreskę pola promptu.
  'dialog-askuserquestion-linia-nazwy-luka-2.1.281.txt',
  // `/skills`: 44 linie i ok. 3300 znaków, cały widok z tytułem zamiast ogona ekranu.
  'refusals/widok-skills-2.1.310.txt',
];

/** Wejście decyzji bez jsonl i bez hooka, jak w pliku złotym; `layer2` i `active` z parametrów. */
function input(text: string, layer2: boolean | undefined, active: ActiveReq | null = null): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: evaluationReqId(null, null, null, 1),
    active,
    blockedSeq: 1,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    excerpt: (value: string) => snippet(value)?.text ?? null,
    hookRaw: null,
    ...(layer2 === undefined ? {} : { layer2 }),
  };
}

/** Karta, jaką driver wystawiłby nad ekranem; `null` = ocena bez karty. */
function cardOf(action: DecideAction): DecisionCard | null {
  if (action.kind === 'card') return action.card;
  if (action.kind !== 'screen-dialog') return null;
  return screenDialogCard(action.reqId, action.resolved, action.reason, action.screen, null, action.origin,
    action.layer2 ?? null);
}

type ScreenDialogAction = Extract<DecideAction, { kind: 'screen-dialog' }>;

function screenDialogOf(text: string, layer2: boolean | undefined): ScreenDialogAction {
  const action = decideCard(input(text, layer2));
  if (action.kind !== 'screen-dialog') throw new Error(`oczekiwano screen-dialog, jest ${action.kind}`);
  return action;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('blok bez cyfr przy fladze `1`: `/skills` (CLI 2.1.310)', () => {
  it('cały blok od tytułu na kartę, tytuł w tożsamości, ślad `block-no-digits`; powód karty bez zmian', () => {
    const block = readBlock(SKILLS);
    expect(block).not.toBeNull();
    const fromTitle = trimmedLines(SKILLS).slice(block?.titleLine ?? 0).join('\n');
    // Ponad sufit wycinka bez flagi (40 linii, 2000 znaków), pod sufitem warstwy 2.
    expect(fromTitle.split('\n').length).toBe(44);
    expect(fromTitle.length).toBeGreaterThan(2000);
    expect(fromTitle.split('\n').length).toBeLessThanOrEqual(LAYER2_EXCERPT_MAX_LINES);
    expect(fromTitle.length).toBeLessThanOrEqual(LAYER2_EXCERPT_MAX_CHARS);

    const on = screenDialogOf(SKILLS, true);
    expect(on.screen).toBe(fromTitle);
    expect(on.layer2).toEqual({ why: 'block-no-digits', print: block?.print });
    expect(on.reason).toBe('unreadable');
    expect(on.audit).toBe('unreadable');
    const off = screenDialogOf(SKILLS, false);
    expect(on.resolved).toEqual(off.resolved);
    expect(on.resolved?.options).toEqual([]);
    // Bez flagi: ogon ekranu, tożsamość bez tytułu, bez śladu warstwy 2.
    expect(off.screen).toBe(snippet(SKILLS)?.text);
    expect(off).not.toHaveProperty('layer2');
    expect(on.reqId).not.toBe(off.reqId);
    // Tytuł bloku zmienia tożsamość: ten sam ekran z innym tytułem to inna karta.
    const retitled = SKILLS.replace(block?.title ?? '', 'Inny widok');
    expect(screenDialogOf(retitled, true).reqId).not.toBe(on.reqId);
  });

  it('karta niesie ślad w `ActiveReq.layer2`, zdarzenie bez niego (apka dostaje tę samą kartę)', () => {
    const on = screenDialogOf(SKILLS, true);
    const card = cardOf(on);
    expect(card?.active.layer2).toEqual(on.layer2);
    expect(card?.event).toEqual({ type: 'screen-dialog', reason: 'unreadable', screen: on.screen });
  });

  it('sufit warstwy 2: blok ponad 60 linii albo 4000 znaków wraca do dzisiejszego wycinka', () => {
    const block = readBlock(SKILLS);
    const lines = trimmedLines(SKILLS);
    const titleLine = block?.titleLine ?? 0;
    const extra = Array.from({ length: 60 }, (_, i) => `   wiersz ${String(i)}`);
    const tooLong = [...lines.slice(0, titleLine + 1), ...extra, ...lines.slice(titleLine + 1)].join('\n');
    expect(blockNoDigitsExcerpt(tooLong)).toBeNull();
    const tooWide = lines.map((line, i) => (i === titleLine + 2 ? `${line} ${'x'.repeat(1000)}` : line)).join('\n');
    expect(blockNoDigitsExcerpt(tooWide)).toBeNull();
    const fallback = screenDialogOf(tooLong, true);
    expect(fallback).not.toHaveProperty('layer2');
    expect(fallback.screen).toBe(screenDialogOf(tooLong, false).screen);
  });

  it('blok z opcjami z cyframi nie jest kartą bloku bez cyfr', () => {
    expect(blockNoDigitsExcerpt(screenOf('kontrolny/pytanie-2.1.316.txt'))).toBeNull();
    expect(blockNoDigitsExcerpt(screenOf('kontrolny/potwierdzenie-model-opus-2.1.316.txt'))).toBeNull();
  });
});

describe('korpus przy fladze `1`: zmiany tylko z listy', () => {
  interface Shot {
    readonly kind: DecideAction['kind'];
    readonly reqId: string | null;
    readonly screen: string | null;
    readonly layer2: unknown;
    /** Reszta karty i akcji: opcje, powód, wpis do dziennika, kształt przypadku, pochodzenie. */
    readonly rest: string;
  }

  function shotOf(name: string, layer2: boolean | undefined): Shot {
    const action = decideCard(input(screenOf(name), layer2));
    const card = cardOf(action);
    const event = card?.event;
    const screen = event !== undefined && 'screen' in event && typeof event.screen === 'string' ? event.screen : null;
    const active = card === null ? null : { ...card.active, reqId: undefined, layer2: undefined };
    const restEvent = event === undefined ? null : { ...event, screen: undefined };
    const audit = action.kind === 'card' || action.kind === 'screen-dialog' ? action.audit : null;
    const diagnosis = action.kind === 'card' || action.kind === 'screen-dialog' ? action.diagnosis ?? null : null;
    return {
      kind: action.kind,
      reqId: card?.active.reqId ?? null,
      screen,
      layer2: card?.active.layer2 ?? null,
      rest: JSON.stringify({ active, restEvent, audit, diagnosis }),
    };
  }

  const changed = CORPUS.filter((name) => JSON.stringify(shotOf(name, true)) !== JSON.stringify(shotOf(name, false)));
  const cardChanged = CORPUS.filter((name) => {
    const on = shotOf(name, true);
    const off = shotOf(name, false);
    return on.reqId !== off.reqId || on.screen !== off.screen;
  });

  it('flaga nieobecna i `false` dają to samo na każdym ekranie korpusu', () => {
    for (const name of CORPUS) expect(shotOf(name, undefined), name).toEqual(shotOf(name, false));
  });

  it('ślad warstwy 2 mają karty z `LAYER2_BLOCKS`, kartę zmienia lista `LAYER2_CARD_CHANGES`', () => {
    expect(changed).toEqual([...LAYER2_BLOCKS]);
    expect(cardChanged).toEqual([...LAYER2_CARD_CHANGES]);
  });

  it.each(LAYER2_BLOCKS)('%s: zmienia się tylko tożsamość, wycinek i ślad warstwy 2', (name) => {
    const on = shotOf(name, true);
    const off = shotOf(name, false);
    expect(on.kind).toBe('screen-dialog');
    expect(on.rest).toBe(off.rest);
    expect(on.layer2).toMatchObject({ why: 'block-no-digits' });
    expect(off.layer2).toBeNull();
    // Wycinek warstwy 2 to blok od tytułu: kończy się tak samo jak ekran.
    expect(trimmedLines(screenOf(name)).join('\n').endsWith(on.screen ?? '\u0000')).toBe(true);
  });
});

describe('`refresh`: ta sama karta, inny blok', () => {
  /** Ekrany bez opcji z cyframi z korpusu i zakładki `/status`: pary z tą samą i z inną tożsamością karty. */
  const NO_DIGITS = [
    ...CORPUS.map(screenOf).filter((text) => decideCard(input(text, true)).kind === 'screen-dialog'
      && readBlock(text)?.options.length === 0),
    STATUS_TAB, USAGE_TAB, USAGE_TAB_LATER,
  ];

  /** Stojąca karta z ekranu `text` przy fladze `layer2`. */
  function standing(text: string, layer2: boolean | undefined): ActiveReq | null {
    return cardOf(decideCard(input(text, layer2)))?.active ?? null;
  }

  it('zakładki `/status`: ta sama tożsamość karty, inny odcisk bloku, wycinki tej samej długości', () => {
    const status = screenDialogOf(STATUS_TAB, true);
    const usage = screenDialogOf(USAGE_TAB, true);
    const later = screenDialogOf(USAGE_TAB_LATER, true);
    expect(new Set([status.reqId, usage.reqId, later.reqId]).size).toBe(1);
    expect(new Set([status.layer2?.print, usage.layer2?.print, later.layer2?.print]).size).toBe(3);
    expect(later.screen?.length).toBe(usage.screen?.length);
    expect(later.screen).not.toBe(usage.screen);
  });

  it('flaga `1`: `refresh` z nowym wycinkiem i odciskiem; ten sam blok = `keep`', () => {
    const active = standing(USAGE_TAB, true);
    const action = decideCard(input(USAGE_TAB_LATER, true, active));
    expect(action).toEqual({
      kind: 'refresh', reqId: active?.reqId, screen: screenDialogOf(USAGE_TAB_LATER, true).screen,
      layer2: screenDialogOf(USAGE_TAB_LATER, true).layer2,
    });
    expect(decideCard(input(USAGE_TAB, true, active))).toEqual({ kind: 'keep', touchSeq: true });
  });

  it('flaga `0`: zakładka pod tą samą kartą to `keep`, wycinek zostaje stary', () => {
    for (const layer2 of [undefined, false]) {
      const active = standing(STATUS_TAB, layer2);
      expect(decideCard(input(USAGE_TAB, layer2, active))).toEqual({ kind: 'keep', touchSeq: true });
    }
  });

  it('każda para ekranów: flaga `0` nigdy `refresh`, flaga `1` `refresh` dokładnie przy tej samej karcie i innym '
    + 'odcisku', () => {
    let refreshes = 0;
    for (const a of NO_DIGITS) {
      const activeOff = standing(a, false);
      const activeAbsent = standing(a, undefined);
      const activeOn = standing(a, true);
      for (const b of NO_DIGITS) {
        expect(decideCard(input(b, false, activeOff)).kind).not.toBe('refresh');
        expect(decideCard(input(b, undefined, activeAbsent)).kind).not.toBe('refresh');
        const fresh = decideCard(input(b, true));
        const fallbackId = fresh.kind === 'screen-dialog' ? fresh.reqId : null;
        const freshPrint = fresh.kind === 'screen-dialog' ? fresh.layer2?.print : undefined;
        const expected = fallbackId === activeOn?.reqId && freshPrint !== undefined
          && freshPrint !== activeOn?.layer2?.print;
        const kind = decideCard(input(b, true, activeOn)).kind;
        expect(kind === 'refresh', `${a.slice(-40)} → ${b.slice(-40)}`).toBe(expected);
        if (kind === 'refresh') refreshes += 1;
      }
    }
    // Pary zakładek `/status` (i kopie tych samych widoków w korpusie) dają `refresh`; zero znaczyłoby pusty test.
    expect(refreshes).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Driver nad prawdziwym dziennikiem: flaga `0` bajt w bajt jak przed flagą
// ---------------------------------------------------------------------------------------------------------------

const PANE = 'w9:p73';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
/** Driver w testach: krótkie okna oceny, ponowna ocena stojącego dialogu co 15 ms, ekran zawsze świeży. */
const FAST: Partial<HerdrDriverDeps> = {
  pendingDebounceMs: 10, pendingRetryMs: 4, blockedPollMs: 15, screenCacheMs: 0, readAgentFiles: false,
};

/** Gniazdo herdr z ekranem ustawianym przez test; poza odczytem ekranu niczego nie robi. */
class ScreenClient implements HerdrClient {
  screenText = '';
  listAgents(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  getAgent(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: this.screenText }); }
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }
  prompt(): Promise<void> { return Promise.resolve(); }
  sendFormSubmit(): Promise<void> { return Promise.resolve(); }
  sendModeCycle(): Promise<void> { return Promise.resolve(); }
  pasteText(): Promise<void> { return Promise.resolve(); }
  sendPromptSubmit(): Promise<void> { return Promise.resolve(); }
  sendTrustStep(): Promise<void> { return Promise.resolve(); }
  sendDialogKey(): Promise<void> { return Promise.resolve(); }
  sendTakeBackKey(): Promise<void> { return Promise.resolve(); }
  sendKeys(): Promise<void> { return Promise.resolve(); }
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> { return Promise.resolve({ version: '0.8.2', protocol: 20 }); }
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Cisza dłuższa niż kilka ponownych ocen stojącego dialogu (15 ms) — dowód, że czegoś NIE ma. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

const userLine = `${JSON.stringify({
  type: 'user', message: { role: 'user', content: 'pracuj' }, isSidechain: false,
  timestamp: '2026-11-01T10:00:00.000Z', sessionId: SESSION,
})}\n`;

const CARD_TYPES = new Set<DriverEvent['type']>(['screen-dialog', 'question-request', 'permission-request']);

function makeAgent(cwd: string): HerdrAgent {
  return {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
}

/**
 * Linie dziennika driver nad ekranem fixture'u przy fladze `0` — zapisane z kodu sprzed flagi, przed
 * zmianą. Katalog projektu zamaskowany jako `<cwd>`. Klucz `card` to sha256 zdarzeń kart drivera. Dialogu zaufania
 * bez cyfr tu nie ma: jego karta zmieniła się z powodem, a równość przy fladze `0` i `1` sprawdza korpus.
 */
const FLAG0_AUDIT: Readonly<Record<string, { lines: readonly string[]; card: string }>> = {
  'refusals/widok-skills-2.1.310.txt': {
    lines: [
      '{"ts":"2026-11-01T12:00:00.000Z","sessionId":"sesja-testowa","key":"w9:p73","paneId":"w9:p73","cwd":"<cwd>","method":"degrade","mode":"auto","reason":"unreadable","reqId":"screen:1:f:30db357025d1","source":"screen","optionCount":0,"blockVisible":false,"dialogTitle":null,"route":"none","routeReason":"no-class"}',
      '{"ts":"2026-11-01T12:00:00.000Z","sessionId":"sesja-testowa","key":"w9:p73","paneId":"w9:p73","cwd":"<cwd>","method":"block-card","mode":"auto","reqId":"screen:1:f:30db357025d1","source":"screen","optionCount":0,"dialogTitle":null,"verdict":"no-buttons","toolName":"dialog"}',
    ],
    card: 'b414a892558887f8e065284d91a02da75a138e63b31cbf109817f2f7dc8cf89f',
  },
  'refusals/widok-status-2.1.310.txt': {
    lines: [
      '{"ts":"2026-11-01T12:00:00.000Z","sessionId":"sesja-testowa","key":"w9:p73","paneId":"w9:p73","cwd":"<cwd>","method":"degrade","mode":"auto","reason":"unreadable","reqId":"screen:1:f:9f71e2ee8c47","source":"screen","optionCount":0,"blockVisible":false,"dialogTitle":null,"route":"none","routeReason":"no-class"}',
      '{"ts":"2026-11-01T12:00:00.000Z","sessionId":"sesja-testowa","key":"w9:p73","paneId":"w9:p73","cwd":"<cwd>","method":"block-card","mode":"auto","reqId":"screen:1:f:9f71e2ee8c47","source":"screen","optionCount":0,"dialogTitle":null,"verdict":"no-buttons","toolName":"dialog"}',
    ],
    card: 'ce6cfb1f710ea7ae673fc212775d9e30f46ccf9a7991ee92b879994d23c69bb1',
  },
  'kontrolny/potwierdzenie-model-opus-2.1.316.txt': {
    lines: [
      '{"ts":"2026-11-01T12:00:00.000Z","sessionId":"sesja-testowa","key":"w9:p73","paneId":"w9:p73","cwd":"<cwd>","method":"block-card","mode":"auto","reqId":"screen:1:f:65306adcea92","source":"screen","optionCount":2,"dialogTitle":null,"print":"11ca01645d6b42e9","verdict":"buttons","toolName":"dialog:model"}',
    ],
    card: '4eaf4b27652f8dfa6344764946377dc0c2b301af509f90aac393b6fda18dc9da',
  },
  'kontrolny/pytanie-2.1.316.txt': {
    lines: [
      '{"ts":"2026-11-01T12:00:00.000Z","sessionId":"sesja-testowa","key":"w9:p73","paneId":"w9:p73","cwd":"<cwd>","method":"block-card","mode":"auto","reqId":"screen:q:32b9d44d62bf","source":"screen","optionCount":5,"dialogTitle":null,"print":"4e501ab7d9dee32e","verdict":"buttons","toolName":"dialog:question"}',
    ],
    card: 'bc4142b69430e670efb5a08f15f917758158dda1b3e42ef0b85a66235e085914',
  },
};

/** Driver nad ekranem `name` w `blocked`: linie dziennika (prawdziwy plik) i skrót zdarzeń kart. */
async function driverRun(
  name: string, deps: Partial<HerdrDriverDeps>,
): Promise<{ lines: string[]; card: string; events: DriverEvent[] }> {
  const base = await mkdtemp(join(tmpdir(), 'rarog-warstwa2-'));
  try {
    const root = join(base, 'store');
    const cwd = join(base, 'projekt');
    const dataDir = join(base, 'data');
    await mkdir(join(root, projectSlug(cwd)), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, projectSlug(cwd), `${SESSION}.jsonl`), userLine);
    const listeners = new Set<(ev: HerdrPaneEvent) => void>();
    const handle: HerdrAgentHandle = {
      agent: makeAgent(cwd),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const client = new ScreenClient();
    const log = createHerdrAuditLog({ dataDir, now: () => new Date(NOW) });
    const driver = createHerdrDriver(handle, {
      client,
      audit: { log: (entry) => { log.log(entry); } },
      yoloRoots: [],
      now: () => NOW,
      sessionId: 'sesja-testowa',
      follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
      ...FAST,
      ...deps,
    });
    const events: DriverEvent[] = [];
    void (async () => { for await (const event of driver.events) events.push(event); })();
    try {
      await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
      client.screenText = screenOf(name);
      for (const listener of listeners) listener({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => events.some((e) => CARD_TYPES.has(e.type)), 'karta');
      await quiet();
      await log.flush();
      const text = await readFile(herdrAuditPath(dataDir), 'utf8');
      return {
        lines: text.split('\n').filter((line) => line !== '').map((line) => line.replaceAll(cwd, '<cwd>')),
        card: sha256(JSON.stringify(events.filter((e) => CARD_TYPES.has(e.type)))),
        events,
      };
    } finally {
      driver.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

describe('driver i dziennik: flaga `0` bajt w bajt jak przed flagą', () => {
  it.each(Object.keys(FLAG0_AUDIT))('%s: pole nieobecne i `false` dają te same linie i tę samą kartę', async (name) => {
    const expected = FLAG0_AUDIT[name];
    for (const deps of [{}, { dialogLayer2: false }]) {
      const run = await driverRun(name, deps);
      expect(run.lines).toEqual(expected?.lines);
      expect(run.card).toBe(expected?.card);
      expect(run.events.map((e) => e.type)).not.toContain('dialog-screen');
    }
  });

  it('flaga `1`: karta bez cyfr dopisuje `layer2` i `layer2Why` na końcu kształtu, bez wycinka i tytułu', async () => {
    const run = await driverRun('refusals/widok-status-2.1.310.txt', { dialogLayer2: true });
    const card = run.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['method'] === 'block-card');
    expect(card).toMatchObject({ verdict: 'no-buttons', layer2: true, layer2Why: 'block-no-digits' });
    const keys = Object.keys(card ?? {});
    expect(keys.slice(keys.indexOf('verdict'))).toEqual(['verdict', 'layer2', 'layer2Why', 'toolName']);
    // Blok widoku `/status` mieścił się w sufitcie bez flagi: tożsamość i wycinek karty bez zmian, różnią się
    // tylko pola warstwy 2 w dzienniku.
    const off = FLAG0_AUDIT['refusals/widok-status-2.1.310.txt'];
    expect(run.lines.map((line) => line.replace(',"layer2":true,"layer2Why":"block-no-digits"', '')))
      .toEqual(off?.lines);
    expect(run.card).toBe(off?.card);
  });

  it('flaga `1` przy blokach z cyframi: dziennik i karta jak przy fladze `0`', async () => {
    for (const name of ['kontrolny/potwierdzenie-model-opus-2.1.316.txt', 'kontrolny/pytanie-2.1.316.txt']) {
      const run = await driverRun(name, { dialogLayer2: true });
      expect(run.lines, name).toEqual(FLAG0_AUDIT[name]?.lines);
      expect(run.card, name).toBe(FLAG0_AUDIT[name]?.card);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Zakładki `/status`: driver → manager → podsumowanie sesji
// ---------------------------------------------------------------------------------------------------------------

describe('zakładki `/status` pod tą samą kartą: driver → manager → podsumowanie sesji', () => {
  let base = '';
  let manager: Manager | null = null;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-warstwa2-int-'));
  });

  afterEach(async () => {
    if (manager !== null) await manager.dispose();
    manager = null;
    await rm(base, { recursive: true, force: true });
  });

  /** Panel w managerze z prawdziwym driverem; zdarzenia drivera i podsumowania sesji zbierane po drodze. */
  async function rig(dialogLayer2: boolean): Promise<{
    client: ScreenClient; driverEvents: DriverEvent[]; summaries: () => SessionSummary[];
    audit: () => Promise<string[]>; block: () => void; id: string; mgr: Manager;
  }> {
    const root = join(base, 'store');
    const cwd = join(base, 'projekt');
    const dataDir = join(base, 'data');
    await mkdir(join(root, projectSlug(cwd)), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(root, projectSlug(cwd), `${SESSION}.jsonl`), userLine);
    const client = new ScreenClient();
    const auditDir = join(base, 'audit');
    const log = createHerdrAuditLog({ dataDir: auditDir, now: () => new Date(NOW) });
    const lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
    const listeners = new Set<(ev: HerdrPaneEvent) => void>();
    const agent = makeAgent(cwd);
    const driverEvents: DriverEvent[] = [];

    /** Driver widziany przez managera: te same metody, a strumień zdarzeń kopiowany do `driverEvents`. */
    const teed = (driver: SessionDriver): SessionDriver => new Proxy(driver, {
      get(target, prop) {
        if (prop === 'events') {
          return (async function* tee() {
            for await (const event of target.events) {
              driverEvents.push(event);
              yield event;
            }
          })();
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const supervisor: HerdrSupervisor = {
      events: lifecycle,
      status: (): HerdrStatus => ({ available: true, agentCount: 1, readOnly: false, canLaunch: false }),
      attach: (): SessionDriver => teed(createHerdrDriver({
        agent,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      }, {
        client,
        audit: { log: (entry) => { log.log(entry); } },
        guard: assertSendable,
        yoloRoots: [],
        now: () => NOW,
        sessionId: sessionIdFor(agent.key),
        follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
        ...FAST,
        dialogLayer2,
      })),
      markSent: () => undefined,
      ensureFreshMode: () => Promise.resolve(agent.mode),
      focus: () => Promise.resolve(),
      launch: () => Promise.reject(new Error('launch: nieużywane')),
      closeTab: () => Promise.reject(new Error('closeTab: nieużywane')),
      rarogPaneCount: () => 0,
      liveEngineSessions: () => Promise.resolve(new Set([agent.agentSessionId])),
      dispose: () => { lifecycle.close(); },
    };
    const notifier: NotifierLike = {
      note: () => undefined, seen: () => undefined, forget: () => undefined, quiet: () => undefined,
    };
    const herdrDeps: HerdrManagerDeps = {
      sessionIdFor, aliasFor: () => undefined, rememberAlias: () => undefined,
      assertSendable: (text) => ({ text, slash: null }), takeSendSlot: () => true,
      writeUploads: () => Promise.resolve([]), writeUploadFiles: () => Promise.resolve([]),
      sweepUploads: () => Promise.resolve(),
    };
    const mgr = await createManager({
      demo: false, dataDir, projects: [{ path: cwd, name: 'projekt' }], projectRoots: [], gitStatus: null,
      gitWatcher: null, liveSessionsReader: () => Promise.resolve(null),
      herdrSupervisor: supervisor, herdrRoots: [cwd], herdrSend: false, herdrDeps, notifier,
    });
    manager = mgr;
    await mgr.ready;
    const events: ServerEvent[] = [];
    mgr.onEvent((_scope, _seq, event) => { events.push(event); });
    lifecycle.push({ type: 'appeared', agent });
    await waitFor(() => mgr.list().some((s) => s.paneId === PANE), 'sesja w managerze');
    const id = mgr.list().find((s) => s.paneId === PANE)?.id ?? '';
    await waitFor(() => driverEvents.some((e) => e.type === 'history'), 'historia');
    return {
      client, driverEvents, id, mgr,
      summaries: () => events.flatMap((event) => (
        event.type === 'session-changed' && event.session.id === id ? [event.session] : [])),
      audit: async () => {
        await log.flush();
        const text = await readFile(herdrAuditPath(auditDir), 'utf8');
        return text.split('\n').filter((line) => line !== '');
      },
      block: () => {
        for (const listener of listeners) listener({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      },
    };
  }

  const excerpt = (text: string): string => blockNoDigitsExcerpt(text)?.text ?? '';

  it('flaga `1`: Status → Usage → Usage sekundę później odświeża wycinek pod tym samym `reqId`', async () => {
    const r = await rig(true);
    r.client.screenText = STATUS_TAB;
    r.block();
    await waitFor(() => r.mgr.get(r.id)?.herdrDialogScreen === excerpt(STATUS_TAB), 'karta Status');
    expect(r.mgr.get(r.id)?.state).toBe('waiting-permission');
    expect(r.mgr.get(r.id)?.herdrDialogReason).toBe('unreadable');

    r.client.screenText = USAGE_TAB;
    await waitFor(() => r.mgr.get(r.id)?.herdrDialogScreen === excerpt(USAGE_TAB), 'zakładka Usage');
    // Tekst tej samej długości: porównanie pełnego tekstu, nie długości, i nowe podsumowanie sesji.
    const before = r.summaries().length;
    r.client.screenText = USAGE_TAB_LATER;
    expect(excerpt(USAGE_TAB_LATER).length).toBe(excerpt(USAGE_TAB).length);
    await waitFor(() => r.mgr.get(r.id)?.herdrDialogScreen === excerpt(USAGE_TAB_LATER), 'Usage sekundę później');
    const after = r.summaries().slice(before);
    expect(after.at(-1)?.herdrDialogScreen).toBe(excerpt(USAGE_TAB_LATER));
    await quiet();

    const types = r.driverEvents.map((e) => e.type);
    expect(types.filter((type) => type === 'screen-dialog')).toHaveLength(1);
    expect(types).not.toContain('permission-cleared');
    expect(r.driverEvents.filter((e) => e.type === 'dialog-screen'))
      .toEqual([{ type: 'dialog-screen', screen: excerpt(USAGE_TAB) },
        { type: 'dialog-screen', screen: excerpt(USAGE_TAB_LATER) }]);
    // Karta stoi dalej: stan i powód bez zmian, jeden wpis `block-card` (odświeżenie to nie nowa karta).
    expect(r.mgr.get(r.id)?.state).toBe('waiting-permission');
    expect(r.mgr.get(r.id)?.herdrDialogReason).toBe('unreadable');
    const cards = (await r.audit()).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['method'] === 'block-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ layer2: true, layer2Why: 'block-no-digits' });
  });

  it('flaga `0`: ta sama karta trzyma pierwszy wycinek, `dialog-screen` nie wychodzi', async () => {
    const r = await rig(false);
    r.client.screenText = STATUS_TAB;
    r.block();
    await waitFor(() => r.mgr.get(r.id)?.herdrDialogScreen !== undefined, 'karta Status');
    const first = r.mgr.get(r.id)?.herdrDialogScreen;
    r.client.screenText = USAGE_TAB;
    await quiet();
    r.client.screenText = USAGE_TAB_LATER;
    await quiet();
    expect(r.mgr.get(r.id)?.herdrDialogScreen).toBe(first);
    const types = r.driverEvents.map((e) => e.type);
    expect(types).not.toContain('dialog-screen');
    expect(types).not.toContain('permission-cleared');
    const cards = (await r.audit()).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['method'] === 'block-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).not.toHaveProperty('layer2');
    expect(cards[0]).not.toHaveProperty('layer2Why');
  });
});
