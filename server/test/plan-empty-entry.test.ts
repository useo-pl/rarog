/**
 * `ExitPlanMode` z PUSTYM wejściem we wpisie transkryptu i planem w zrzucie hooka `PermissionRequest`.
 *
 * Kształty z przebiegu na CLI 2.1.314, zanonimizowane tylko w ścieżce domowej: model zapisał
 * plik planu narzędziem `Write`, potem wywołał `ExitPlanMode` z `{}`. CLI dokłada do `tool_input` hooka `plan`
 * i `planFilePath`, więc zrzut per sesja i zrzut per wywołanie niosą plan, a wpis `tool_use` w transkrypcie
 * zostaje `{}`. Ekrany to dosłowne odczyty panelu z tego przebiegu: „Ready to code?” z planem i stopką z nazwą
 * pliku planu oraz „Exit plan mode?” bez pliku planu.
 *
 * Reguła „plan dołożony przez CLI” (`planAddedByCli` w `settleCompeting`): wpis `{}` i zrzut z planem
 * to jedno wywołanie, więc przy nazwie pliku planu na ekranie kartę daje zrzut, z planem, przyciskami i odciskiem
 * zrzutu. Bez tej nazwy, przy wpisie z własnym planem albo ścieżką i przy zrzucie z inną resztą wejścia zostaje
 * karta bez przycisków. Sprawdzane: decyzja (`decideCard` z wejściem złożonym tą samą funkcją co driver,
 * `hookPendingFor`), budowa karty, dowód „dialog stoi” (`standingProofs`) i wybór zrzutu pod plik cienia
 * (`pickShadowTarget`), a na końcu ten sam przebieg przez prawdziwy driver z prawdziwym kanałem cienia.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { evaluationReqId, hookPendingFor, settleCompeting } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput, DecidedShield } from '../src/herdr/dialogs/decide/input.ts';
import {
  callPrint, competingHook, hookMatchesPending, hookMatchesScreen, hookPendingFrom, olderBashHook, planAddedByCli,
  screenConfirmsInput,
} from '../src/herdr/dialogs/cross-check.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { screenFormReqId } from '../src/herdr/dialogs/cards/ids.ts';
import { affirmativeOption } from '../src/herdr/dialogs/policy/options.ts';
import { DEGRADED_DISPLAY_TEXT } from '../src/herdr/dialogs/copy.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME, HOOK_SHADOW_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { pickShadowTarget, standingProofs } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { EvidenceInput, RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { createShadowChannel } from '../src/herdr/dialogs/shadow/channel.ts';
import type { ShadowConsentChannel, ShadowOutcome, ShadowRequest } from '../src/herdr/dialogs/shadow/channel.ts';
import { queueOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import { openToolUses, pendingToolUse } from '../src/herdr/jsonl-pending.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrAuditEntry, HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneEvent, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import type { SessionPulse } from '../src/herdr/session-pulse.ts';
import { projectSlug } from '../src/cli-store.ts';

const T = { timeout: 5_000 };
const PLAN_TOOL = 'ExitPlanMode';

// ---------------------------------------------------------------------------
// Kształty z przebiegu r4
// ---------------------------------------------------------------------------

const SESSION = 'e3c3e586-d795-482d-91bf-a2a2671c6735';
const PROMPT = '441578cf-5d51-42dc-ab17-bed029835438';
const PLAN_FILE_NAME = 'wywo-aj-teraz-narz-dzie-exitplanmode-sequential-reef.md';
const PLAN_FILE = `/Users/u/.claude/plans/${PLAN_FILE_NAME}`;
const PLAN_TEXT = '# Plan (s2c-pz-111714)\n\n1. Nic nie robić.\n';
/** `tool_input` w zrzucie hooka: plan i ścieżka pliku dołożone przez CLI. */
const HOOK_INPUT = { plan: PLAN_TEXT, planFilePath: PLAN_FILE };
/** Wpis `tool_use` z transkryptu (linia 59 pliku sesji): wejście modelu, puste. */
const JSONL_AT = '2026-10-30T10:24:47.429Z';
/** `at` zrzutu per sesja: 139 ms po wpisie. */
const HOOK_AT = 1_793_355_887_568;
const PLAN_ID = 'toolu_plan_pusty_r4';
const WRITE_ID = 'toolu_write_planu_r4';

const RULE = '─'.repeat(127);
const DASH = '╌'.repeat(127);

/** Ekran panelu przy dialogu „Ready to code?”, od wpisu `Write` w dół. */
const READY = [
  '⏺ Updated plan',
  '  ⎿  /plan to preview',
  '',
  RULE,
  ' Ready to code?',
  '',
  " Here is Claude's plan:",
  DASH,
  ' Plan (s2c-pz-111714)',
  '',
  ' 1. Nic nie robić.',
  DASH,
  '',
  RULE,
  ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
  '',
  ' ❯ 1. Yes, and use auto mode',
  '   2. Yes, manually approve edits',
  '   3. Tell Claude what to change',
  '      shift+tab to approve with this feedback',
  '',
  ` ctrl+g to edit in Nvim · ~/.claude/plans/${PLAN_FILE_NAME}`,
  '',
].join('\n');

/** Ten sam dialog bez stopki (np. wąski panel): ekran nie niesie nazwy pliku planu. */
const READY_NO_FOOTER = READY.split('\n').filter((line) => !line.includes('ctrl+g')).join('\n');

/** Ekran panelu przy dialogu „Exit plan mode?”, od promptu w dół. */
const EXIT = [
  '❯ Wywołaj teraz narzędzie ExitPlanMode z PUSTYM wejściem (bez żadnych parametrów). Nie używaj innych narzędzi i nie pisz',
  '  planu.',
  '',
  RULE,
  ' Exit plan mode?',
  '',
  '  Claude wants to exit plan mode',
  '',
  '  ❯ 1. Yes, and switch to default (ask each time) for this session',
  '    2. No',
  '',
].join('\n');

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const userLine = (text: string, timestamp: string): string => line({
  type: 'user', isSidechain: false, timestamp, sessionId: SESSION, message: { role: 'user', content: text },
});
const toolUseLine = (id: string, name: string, input: unknown, timestamp: string): string => line({
  type: 'assistant', isSidechain: false, timestamp, sessionId: SESSION,
  message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResultLine = (id: string, timestamp: string): string => line({
  type: 'user', isSidechain: false, timestamp, sessionId: SESSION,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

/** Transkrypt próby „plan nic nie rób”: prompt, `Write` pliku planu, `ExitPlanMode` z `{}`, wynik `Write`. */
const PLAN_PROMPT = userLine('Przygotuj plan w jednym punkcie: nic nie rób (znacznik s2c-pz-111714).', '2026-10-30T10:24:44.323Z');
const WRITE_USE = toolUseLine(WRITE_ID, 'Write', { file_path: PLAN_FILE, content: PLAN_TEXT }, '2026-10-30T10:24:47.414Z');
const PLAN_USE = toolUseLine(PLAN_ID, PLAN_TOOL, {}, JSONL_AT);
const WRITE_RESULT = toolResultLine(WRITE_ID, '2026-10-30T10:24:47.495Z');
const TRANSCRIPT_LINES = [PLAN_PROMPT, WRITE_USE, PLAN_USE, WRITE_RESULT];

/** Zrzut per sesja (`pending/<sesja>.json` w katalogu danych przebiegu), w kształcie `readPendingHook`. */
const HOOK_RAW: PendingHookTool = {
  toolName: PLAN_TOOL, toolInput: HOOK_INPUT, at: HOOK_AT, hookEventName: 'PermissionRequest',
  promptId: PROMPT, permissionMode: 'plan',
};

/** Zrzut per wywołanie: klucz i skrót jak w `shadow.jsonl` przebiegu (linia `czekam`). */
const CALL_DUMP: HookCallDump = {
  key: `${PROMPT}-cf29d4f14ddb8e80723a860f727f59ee`,
  sessionId: SESSION, promptId: PROMPT, pid: 53_662, startedAt: HOOK_AT - 60, permissionMode: 'plan',
  toolName: PLAN_TOOL, toolInput: HOOK_INPUT, cwd: '/Users/u/.cache/pomiar-hooka-zgod', at: HOOK_AT,
  inputSha256: canonicalSha256(HOOK_INPUT),
};

/** Wariant „Exit plan mode?”: wpis i zrzut niosą `{}` (sesja `885fcf9a`, próba `s2c-pb-111714`). */
const EMPTY_AT = '2026-10-30T10:26:13.348Z';
const EMPTY_HOOK_AT = 1_793_355_973_423;
const EMPTY_ID = 'toolu_plan_bez_pliku_r4';
/** `prompt_id` syntetyczny w kształcie UUID; klucz zrzutu ma kształt `HOOK_CALL_KEY_PATTERN` (`<prompt_id>-<32 hex>`). */
const EMPTY_PROMPT = 'c0ffee00-c0ff-ee00-c0ff-ee00c0ffee00';
const EMPTY_RAW: PendingHookTool = {
  toolName: PLAN_TOOL, toolInput: {}, at: EMPTY_HOOK_AT, hookEventName: 'PermissionRequest',
  promptId: EMPTY_PROMPT, permissionMode: 'plan',
};
const EMPTY_DUMP: HookCallDump = {
  key: `${EMPTY_PROMPT}-${'c0ffee00'.repeat(4)}`,
  sessionId: SESSION, promptId: EMPTY_PROMPT, pid: 62_290,
  startedAt: EMPTY_HOOK_AT - 40, permissionMode: 'plan', toolName: PLAN_TOOL, toolInput: {},
  cwd: '/Users/u/.cache/pomiar-hooka-zgod', at: EMPTY_HOOK_AT, inputSha256: canonicalSha256({}),
};

const NOW = HOOK_AT + 2_500;
const WAITING: RegistryEvidence = { kind: 'waiting', dialog: 'permission', at: NOW - 500 };

// ---------------------------------------------------------------------------
// Wejście decyzji złożone jak w driverze
// ---------------------------------------------------------------------------

const planEntry = (): PendingTool => {
  const pending = pendingToolUse(TRANSCRIPT_LINES);
  if (pending === null) throw new Error('brak wpisu');
  return pending;
};

/** Zrzut per sesja w kształcie `PendingTool` (`hookPendingFrom`). */
const hookOf = (raw: PendingHookTool): PendingTool => {
  const hook = hookPendingFrom(raw);
  if (hook === null) throw new Error('brak zrzutu');
  return hook;
};

/** `hookPending` tą samą funkcją co driver (`hookPendingFor`), `reqId` jak `evaluationReqId`. */
function input(text: string, pending: PendingTool | null, raw: PendingHookTool | null): DecideInput {
  const hookPending = hookPendingFor(pending, raw);
  return {
    pending, hookPending, text,
    reqId: evaluationReqId(pending, hookPending, raw, 7),
    active: null, blockedSeq: 7, answeredSeq: -1, answeredHookCall: null, decided: null,
    hookAnswersEnabled: true, deadAnswerKey: null, canRetry: false,
    resolve: resolveOptions, excerpt: (screenText: string) => screenText.trim(), hookRaw: raw,
  };
}

function card(action: DecideAction): Extract<DecideAction, { kind: 'card' }> {
  if (action.kind !== 'card') throw new Error(`oczekiwana karta, jest ${action.kind}`);
  return action;
}

function permission(action: DecideAction) {
  const built = card(action);
  const event = built.card.event;
  if (event.type !== 'permission-request') throw new Error(`oczekiwana zgoda, jest ${event.type}`);
  return { built, event, active: built.card.active };
}

function evidence(dumps: readonly HookCallDump[], lines: readonly string[], screen: string): EvidenceInput {
  return {
    now: NOW, dumps, alive: new Map(dumps.map((d) => [d.key, true])), registry: WAITING,
    queue: queueOnScreen(screen),
    transcript: openToolUses(lines).map((t) => ({ toolName: t.toolName, input: t.input })),
  };
}

// ---------------------------------------------------------------------------
// 1. Fakty z przebiegu
// ---------------------------------------------------------------------------

describe('kształty z przebiegu r4', T, () => {
  it('skrót wejścia: zrzut per wywołanie liczy plan, wpis transkryptu liczy `{}`', () => {
    // Wartości z `shadow.jsonl` przebiegu (linie `czekam` prób `s2c-pz` i `s2c-pp`); skrót z prawdziwą ścieżką
    // domową sprawdzony poza repo: `a8775486…` dla zrzutu z planem, `44136fa3…` dla `{}`.
    expect(canonicalSha256({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(CALL_DUMP.inputSha256).not.toBe(canonicalSha256(planEntry().input));
  });

  it('transkrypt przy stojącym dialogu: otwarty jest tylko `ExitPlanMode` z `{}`', () => {
    const open = openToolUses(TRANSCRIPT_LINES);
    expect(open.map((t) => [t.toolName, t.input])).toEqual([[PLAN_TOOL, {}]]);
    expect(planEntry()).toMatchObject({ id: PLAN_ID, toolName: PLAN_TOOL, input: {}, at: JSONL_AT });
  });

  it('oba ekrany to dialog `ExitPlanMode` dla parsera; stopka niesie nazwę pliku planu tylko w „Ready to code?”', () => {
    expect(parseOptions(READY)).toMatchObject({ kind: 'tool', toolName: PLAN_TOOL });
    expect(parseOptions(EXIT)).toMatchObject({ kind: 'tool', toolName: PLAN_TOOL });
    expect(resolveOptions(READY, { toolName: PLAN_TOOL }).status).toBe('ok');
    expect(resolveOptions(READY_NO_FOOTER, { toolName: PLAN_TOOL }).status).toBe('ok');
    expect(resolveOptions(EXIT, { toolName: PLAN_TOOL }).status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 2. „Ready to code?”: wpis `{}` + zrzut z planem
// ---------------------------------------------------------------------------

describe('„Ready to code?”: wpis `{}` i zrzut z planem — karta ze zrzutu, gdy ekran pokazuje plik planu', T, () => {
  it('driver podaje zrzut jako KONKURENTA wpisu (`competingHook`), tożsamość oceny niesie oba źródła', () => {
    const pending = planEntry();
    expect(hookMatchesPending(pending, HOOK_RAW)).toBe(false);
    expect(olderBashHook(pending, HOOK_RAW)).toBe(false);
    expect(competingHook(pending, HOOK_RAW)).toBe(true);
    const inp = input(READY, pending, HOOK_RAW);
    expect(inp.hookPending).toMatchObject({ id: `hook:${HOOK_AT}`, toolName: PLAN_TOOL, input: HOOK_INPUT });
    expect(inp.reqId).toBe(`hook:${HOOK_AT}~${PLAN_ID}`);
    expect(planAddedByCli(pending, hookOf(HOOK_RAW))).toBe(true);
  });

  it('`settleCompeting`: ze stopką wygrywa zrzut; bez stopki ekran nie potwierdza żadnego źródła — `ambiguous`', () => {
    const pending = planEntry();
    const hook = hookOf(HOOK_RAW);
    // Ze stopką: zrzut pasuje do ekranu treścią (nazwa pliku planu), a wpis to ten sam zrzut bez planu.
    expect(hookMatchesScreen(hook, READY)).toBe(true);
    expect(settleCompeting(input(READY, pending, HOOK_RAW), pending, hook))
      .toEqual({ pending: null, hookPending: hook, ambiguous: false, older: false });
    // Bez stopki: zrzut nie pasuje treścią, a wpis `{}` nie ma `planFilePath`, więc ekran go nie potwierdza.
    expect(hookMatchesScreen(hook, READY_NO_FOOTER)).toBe(false);
    expect(screenConfirmsInput(pending, READY)).toBe(false);
    expect(settleCompeting(input(READY_NO_FOOTER, pending, HOOK_RAW), pending, hook))
      .toMatchObject({ ambiguous: true, older: false });
  });

  it('ze stopką: karta z planem i przyciskami, „Zatwierdź” = opcja 2, odcisk zrzutu, pochodzenie `hook`', () => {
    const pending = planEntry();
    const { built, event, active } = permission(decideCard(input(READY, pending, HOOK_RAW)));
    expect(built.audit).toBeNull();
    expect(event).toMatchObject({ toolName: PLAN_TOOL, input: HOOK_INPUT, displayText: PLAN_TEXT });
    expect(active.options.map((o) => o.digit)).toEqual(['1', '2', '3']);
    expect(affirmativeOption(active.options)).toMatchObject({ digit: '2', label: 'Yes, manually approve edits' });
    expect(active.reqId).toBe(`hook:${HOOK_AT}~${PLAN_ID}`);
    expect(active.callPrint).toBe(callPrint(PLAN_TOOL, HOOK_INPUT));
    // Wpis obok zostaje materiałem osłony po decyzji (`pendingId`), ale nie jest źródłem karty (`callId`).
    expect(active.pendingId).toBe(PLAN_ID);
    expect(active.callId).toBeUndefined();
    // Generacja zrzutu, który dał treść: przed cyfrą zrzut musi być ten sam.
    expect(active.proofHookAt).toBe(HOOK_AT);
    expect(active.origin).toEqual({ source: 'hook', promptId: PROMPT });
  });

  it('bez stopki: karta bez przycisków, bez planu, odcisk wpisu `{}`, dziennik `mismatch/ambiguous-sources`', () => {
    const pending = planEntry();
    const { built, event, active } = permission(decideCard(input(READY_NO_FOOTER, pending, HOOK_RAW)));
    expect(built.audit).toBe('mismatch');
    expect(built.diagnosis?.mismatchReason).toBe('ambiguous-sources');
    expect(event).toMatchObject({ toolName: PLAN_TOOL, input: null, reason: 'mismatch', displayText: DEGRADED_DISPLAY_TEXT.text });
    expect(active.options).toEqual([]);
    expect(active.reqId).toBe(`hook:${HOOK_AT}~${PLAN_ID}`);
    expect(active.callPrint).toBe(callPrint(PLAN_TOOL, {}));
    expect(active.origin).toEqual({ source: 'jsonl', toolUseId: PLAN_ID });
  });

  it('cień: karta ze stopką trafia w zrzut (`one`); karta bez stopki ma odcisk `{}` — `none: no-match`', () => {
    const verdicts = standingProofs(evidence([CALL_DUMP], TRANSCRIPT_LINES, READY));
    // Transkrypt nie zabiera dowodu: nazwa jest otwarta (`transkrypt-brak` nie), a skrót nie jest porównywalny,
    // bo żaden żywy zrzut tej nazwy nie ma odpowiednika ze zgodnym skrótem (`transkrypt-skrot` nie).
    expect(verdicts).toEqual([{ key: CALL_DUMP.key, kind: 'stoi' }]);
    const ready = permission(decideCard(input(READY, planEntry(), HOOK_RAW))).active;
    expect(pickShadowTarget([CALL_DUMP], verdicts, { toolName: PLAN_TOOL, callPrint: ready.callPrint ?? null }))
      .toEqual({ kind: 'one', dump: CALL_DUMP });
    const bare = permission(decideCard(input(READY_NO_FOOTER, planEntry(), HOOK_RAW))).active;
    expect(pickShadowTarget([CALL_DUMP], verdicts, { toolName: PLAN_TOOL, callPrint: bare.callPrint ?? null }))
      .toEqual({ kind: 'none', why: 'no-match' });
  });

  it('kolejność: zrzut przed wpisem i zrzut z wpisem dają tę samą kartę, a tożsamość zmienia się raz', () => {
    const first = permission(decideCard(input(READY, null, HOOK_RAW)));
    expect(first.built.audit).toBeNull();
    expect(first.event).toMatchObject({ toolName: PLAN_TOOL, input: HOOK_INPUT, displayText: PLAN_TEXT });
    expect(first.active.reqId).toBe(`hook:${HOOK_AT}`);
    const second = permission(decideCard(input(READY, planEntry(), HOOK_RAW)));
    // Dojście wpisu zmienia tożsamość oceny (`<zrzut>~<wpis>`), więc driver wystawia kartę jeszcze raz: ta sama
    // treść, przyciski i odcisk, nowy `reqId`. Kolejne oceny kończą się na bramce „ta sama karta”.
    expect(second.active.reqId).toBe(`hook:${HOOK_AT}~${PLAN_ID}`);
    expect(second.event.input).toEqual(first.event.input);
    expect(second.event.displayText).toBe(first.event.displayText);
    expect(second.active.options).toEqual(first.active.options);
    expect(second.active.callPrint).toBe(first.active.callPrint);
    expect(input(READY, planEntry(), HOOK_RAW).reqId).toBe(second.active.reqId);
  });

  it('kolejność, wariant bez stopki: sam zrzut nie pasuje treścią do ekranu — karta ekranowa z przyciskami, bez planu', () => {
    const { built, event, active } = permission(decideCard(input(READY_NO_FOOTER, null, HOOK_RAW)));
    expect(built.audit).toBeNull();
    expect(event.input).toEqual({ screen: expect.any(String) as string });
    // Karta ekranowa niesie samo pytanie spod planu — treści planu z ramki nad nim nie ma.
    expect(event.displayText).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?');
    expect(active.options.map((o) => o.digit)).toEqual(['1', '2', '3']);
    expect(active.reqId.startsWith('screen:p:')).toBe(true);
    expect(active.callPrint).toBeUndefined();
  });

  it('osłona po „Pozwól”: skasowany zrzut zostawia wpis `{}`, a karta z niego nie wraca (ten sam dialog, ekran pusty)', () => {
    const decidedCard = permission(decideCard(input(READY, planEntry(), HOOK_RAW))).active;
    // Migawka osłony jak `#noteDecided` drivera: odcisk bloku i tożsamość dialogu z ekranu sprzed klawisza.
    const screen = resolveOptions(READY, null);
    const form = screen.status === 'no-jsonl' ? screen.questionForm : null;
    const decided: DecidedShield = {
      reqId: decidedCard.reqId, callPrint: decidedCard.callPrint ?? null, callId: decidedCard.callId ?? null,
      pendingId: decidedCard.pendingId ?? null, pendingYounger: false, bodyPrint: parseOptions(READY)?.bodyPrint ?? null,
      screenReqId: form === null ? null : screenFormReqId('p', form), hookAt: HOOK_AT, seq: 7,
    };
    // Po cyfrze driver kasuje zrzut per sesja: zostaje sam wpis `{}`.
    const after = (text: string | null): DecideAction => decideCard({ ...input(text ?? '', planEntry(), null), text, decided });
    expect(after(READY)).toEqual({ kind: 'keep', touchSeq: false });
    expect(after('✻ Working…\n')).toEqual({ kind: 'keep', touchSeq: false });
  });
});

// ---------------------------------------------------------------------------
// 2a. Granice reguły „plan dołożony przez CLI”
// ---------------------------------------------------------------------------

describe('granice reguły: wygrywa wyłącznie zrzut = wpis + plan i ścieżka od CLI, z nazwą pliku na ekranie', T, () => {
  const OTHER_FILE = '/Users/u/.claude/plans/inny-plan-quiet-river.md';
  const entryWith = (value: unknown, at = JSONL_AT): PendingTool => {
    const entry = pendingToolUse([PLAN_PROMPT, toolUseLine(PLAN_ID, PLAN_TOOL, value, at)]);
    if (entry === null) throw new Error('brak wpisu');
    return entry;
  };
  const rawWith = (toolInput: unknown, at = HOOK_AT): PendingHookTool => ({ ...HOOK_RAW, toolInput, at });
  const settled = (text: string, pending: PendingTool, raw: PendingHookTool) => {
    const inp = input(text, pending, raw);
    if (inp.hookPending === null) return null;
    return settleCompeting(inp, pending, inp.hookPending);
  };

  it.each([
    ['wpis z samym planem', { plan: PLAN_TEXT }],
    ['wpis z planem i inną ścieżką', { plan: PLAN_TEXT, planFilePath: OTHER_FILE }],
    ['wpis z samą ścieżką zrzutu', { planFilePath: PLAN_FILE }],
  ])('%s: zrzut z planem konkuruje, pasują oba — `ambiguous`, karta bez przycisków', (_name, value) => {
    const pending = entryWith(value);
    expect(planAddedByCli(pending, hookOf(HOOK_RAW))).toBe(false);
    expect(settled(READY, pending, HOOK_RAW)).toMatchObject({ ambiguous: true });
    const { built, active } = permission(decideCard(input(READY, pending, HOOK_RAW)));
    expect(built.diagnosis?.mismatchReason).toBe('ambiguous-sources');
    expect(active.options).toEqual([]);
  });

  it('reszta wejścia: równa — zrzut wygrywa; inna — `ambiguous`', () => {
    const extra = { allowedPrompts: [{ tool: 'Bash', prompt: 'uruchom testy' }] };
    const pending = entryWith(extra);
    expect(settled(READY, pending, rawWith({ ...extra, ...HOOK_INPUT })))
      .toMatchObject({ pending: null, ambiguous: false });
    const other = { allowedPrompts: [{ tool: 'Bash', prompt: 'usuń katalog' }] };
    expect(planAddedByCli(pending, hookOf(rawWith({ ...other, ...HOOK_INPUT })))).toBe(false);
    expect(settled(READY, pending, rawWith({ ...other, ...HOOK_INPUT }))).toMatchObject({ ambiguous: true });
    // Zrzut bez planu albo bez ścieżki to nie plan dołożony przez CLI.
    expect(planAddedByCli(planEntry(), hookOf(rawWith({ planFilePath: PLAN_FILE })))).toBe(false);
    expect(planAddedByCli(planEntry(), hookOf(rawWith({ plan: PLAN_TEXT })))).toBe(false);
  });

  it('stopka innego pliku planu niż w zrzucie: zrzut nie pasuje do ekranu — `ambiguous`', () => {
    const footer = READY.replace(PLAN_FILE_NAME, 'inny-plan-quiet-river.md');
    expect(settled(footer, planEntry(), HOOK_RAW)).toMatchObject({ ambiguous: true });
    expect(permission(decideCard(input(footer, planEntry(), HOOK_RAW))).active.options).toEqual([]);
  });

  it('zrzut starszy od wpisu w zapasie zaokrągleń (1,5 s): dalej konkuruje i wygrywa', () => {
    const raw = rawWith(HOOK_INPUT, Date.parse(JSONL_AT) - 1_500);
    expect(competingHook(planEntry(), raw)).toBe(true);
    expect(settled(READY, planEntry(), raw)).toMatchObject({ pending: null, ambiguous: false });
  });

  it('zrzut starszy od wpisu ponad zapas (2,5 s): nie konkuruje, karta z samego wpisu `{}`, bez planu', () => {
    const raw = rawWith(HOOK_INPUT, Date.parse(JSONL_AT) - 2_500);
    expect(competingHook(planEntry(), raw)).toBe(false);
    const inp = input(READY, planEntry(), raw);
    expect(inp.hookPending).toBeNull();
    // Ta sama droga co wpis bez zrzutu (sesja bez hooka): karta z wpisu, cyfry z ekranu, treści planu nie ma.
    const { event, active } = permission(decideCard(inp));
    expect(event).toMatchObject({ toolName: PLAN_TOOL, input: {} });
    expect(event.displayText).not.toContain('Nic nie robić');
    expect(active.callPrint).toBe(callPrint(PLAN_TOOL, {}));
  });

  it('dwa żywe zrzuty `ExitPlanMode` w cieniu: drugi z `{}` zabiera dowód zrzutowi z planem — bez pliku cienia', () => {
    // Stęchły hook pustego planu, którego dialog rozstrzygnięto przy biurku (sierota jeszcze nie zwolniona).
    const stale: HookCallDump = { ...EMPTY_DUMP, sessionId: SESSION, at: HOOK_AT - 5_000, startedAt: HOOK_AT - 5_040 };
    const card = permission(decideCard(input(READY, planEntry(), HOOK_RAW))).active;
    const verdicts = standingProofs(evidence([stale, CALL_DUMP], TRANSCRIPT_LINES, READY));
    // Otwarty wpis `{}` ma skrót zrzutu `{}`, więc skrót staje się porównywalny i zrzut z planem go nie ma.
    expect(verdicts).toContainEqual({ key: CALL_DUMP.key, kind: 'brak', why: 'transkrypt-skrot' });
    expect(pickShadowTarget([stale, CALL_DUMP], verdicts, { toolName: PLAN_TOOL, callPrint: card.callPrint ?? null }))
      .toEqual({ kind: 'none', why: 'no-proof', detail: 'transkrypt-skrot' });
    // Dwa zrzuty z różnymi planami: wpis `{}` nie pasuje do żadnego, ekran pokazuje jeden dialog — `kolejka`.
    const otherPlan = { plan: '# Inny plan\n', planFilePath: OTHER_FILE };
    const second: HookCallDump = {
      ...CALL_DUMP, key: `${PROMPT}-00000000000000000000000000000002`, toolInput: otherPlan,
      inputSha256: canonicalSha256(otherPlan), at: HOOK_AT - 3_000,
    };
    const twoPlans = standingProofs(evidence([second, CALL_DUMP], TRANSCRIPT_LINES, READY));
    expect(pickShadowTarget([second, CALL_DUMP], twoPlans, { toolName: PLAN_TOOL, callPrint: card.callPrint ?? null }))
      .toMatchObject({ kind: 'none', why: 'no-proof' });
  });
});

// ---------------------------------------------------------------------------
// 3. „Exit plan mode?”: wpis `{}` i zrzut `{}`
// ---------------------------------------------------------------------------

describe('„Exit plan mode?”: wpis i zrzut `{}` — karta z przyciskami, cień `one`', T, () => {
  const lines = [
    userLine('Wywołaj teraz narzędzie ExitPlanMode z PUSTYM wejściem.', '2026-10-30T10:26:10.519Z'),
    toolUseLine(EMPTY_ID, PLAN_TOOL, {}, EMPTY_AT),
  ];
  const pending = (): PendingTool => {
    const entry = pendingToolUse(lines);
    if (entry === null) throw new Error('brak wpisu');
    return entry;
  };

  it('zrzut nie konkuruje (to samo wejście): źródłem karty jest sam wpis', () => {
    expect(competingHook(pending(), EMPTY_RAW)).toBe(false);
    const inp = input(EXIT, pending(), EMPTY_RAW);
    expect(inp.hookPending).toBeNull();
    expect(inp.reqId).toBe(EMPTY_ID);
  });

  it('karta zgody z cyframi z ekranu, „Zatwierdź” = opcja 1, odcisk `{}` i plik cienia pod kluczem zrzutu', () => {
    const { built, event, active } = permission(decideCard(input(EXIT, pending(), EMPTY_RAW)));
    expect(built.audit).toBeNull();
    expect(event).toMatchObject({ toolName: PLAN_TOOL, input: {} });
    expect(active.options.map((o) => o.digit)).toEqual(['1', '2']);
    expect(affirmativeOption(active.options)?.digit).toBe('1');
    expect(active.callPrint).toBe(callPrint(PLAN_TOOL, {}));
    const verdicts = standingProofs(evidence([EMPTY_DUMP], lines, EXIT));
    expect(verdicts).toEqual([{ key: EMPTY_DUMP.key, kind: 'stoi' }]);
    expect(pickShadowTarget([EMPTY_DUMP], verdicts, { toolName: PLAN_TOOL, callPrint: active.callPrint ?? null }))
      .toEqual({ kind: 'one', dump: EMPTY_DUMP });
  });
});

// ---------------------------------------------------------------------------
// 4. Ten sam przebieg przez prawdziwy driver i prawdziwy kanał cienia
// ---------------------------------------------------------------------------

const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };

class FakeClient implements HerdrClient {
  readonly keys: string[][] = [];
  screenText = '';
  listAgents(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  getAgent(): Promise<HerdrAgentInfo> { return Promise.reject(new Error('nieużywane')); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: this.screenText }); }
  prompt(): Promise<void> { return Promise.resolve(); }
  sendKeys(_paneId: string, keys: readonly string[]): Promise<void> {
    this.keys.push([...keys]);
    return Promise.resolve();
  }
  sendFormSubmit(): Promise<void> { return Promise.resolve(); }
  sendModeCycle(): Promise<void> { return Promise.resolve(); }
  pasteText(): Promise<void> { return Promise.resolve(); }
  sendPromptSubmit(): Promise<void> { return Promise.resolve(); }
  sendTrustStep(): Promise<void> { return Promise.resolve(); }
  sendDialogKey(): Promise<void> { return Promise.resolve(); }
  sendTakeBackKey(): Promise<void> { return Promise.resolve(); }
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> { return Promise.resolve({ version: '0.8.2', protocol: 20 }); }
  readPaneHistory(): Promise<HerdrPaneHistory> { return Promise.resolve({ text: '', truncated: false }); }
}

const nullPulse = (): SessionPulse => ({
  start: () => {}, stop: () => {}, repoint: () => {}, relocated: () => {}, close: () => {},
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const permissions = (events: readonly DriverEvent[]) => events.filter(
  (e): e is Extract<DriverEvent, { type: 'permission-request' }> => e.type === 'permission-request',
);

let base = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'plan-pusty-'));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(base, { recursive: true, force: true });
});

interface Rig {
  client: FakeClient;
  events: DriverEvent[];
  audit: HerdrAuditEntry[];
  prepared: ShadowRequest[];
  outcomes: ShadowOutcome[];
  transcript: string;
  emit: (ev: HerdrPaneEvent) => void;
  driver: ReturnType<typeof createHerdrDriver>;
  /** Czy driver skasował zrzut per sesja (`clearPendingHook`). */
  hookCleared: () => boolean;
}

async function rig(opts: {
  lines: readonly string[]; screen: string; raw: PendingHookTool | null; dump: HookCallDump | null;
}): Promise<Rig> {
  const root = join(base, 'store');
  const cwd = join(base, 'projekt');
  const dataDir = join(base, 'dane');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  const transcript = join(storeDir, `${SESSION}.jsonl`);
  await writeFile(transcript, opts.lines.join(''));
  // Zrzut per wywołanie tak, jak go zostawia hook (`pending/<sesja>/<klucz>.json`).
  const dumpDir = join(dataDir, HOOK_PENDING_DIRNAME, SESSION);
  await mkdir(dumpDir, { recursive: true });
  if (opts.dump !== null) await writeFile(join(dumpDir, `${opts.dump.key}.json`), JSON.stringify(opts.dump));

  const inner = createShadowChannel({
    dataDir, bootId: 'boot', now: () => NOW,
    liveness: (procs) => Promise.resolve(new Map(procs.map((p) => [p.pid, true]))),
    schedule: () => {},
  });
  const prepared: ShadowRequest[] = [];
  const outcomes: ShadowOutcome[] = [];
  const shadow: ShadowConsentChannel = {
    async prepare(request, abandoned) {
      prepared.push(request);
      const outcome = await inner.prepare(request, abandoned);
      outcomes.push(outcome);
      return outcome;
    },
    keySent: (outcome, sent) => { inner.keySent(outcome, sent); },
    release: (request) => inner.release(request),
  };

  // Panel uruchomiony poza serwerem: pole „uruchomiony przez serwer” zostaje puste (fałsz), bo jego nazwa niesie
  // starą nazwę produktu, której zapadka starej nazwy nie przyjmuje w nowym pliku.
  const agent = {
    key: 'w9:p72', paneId: 'w9:p72', agentSessionId: SESSION, engine: 'claude', termId: null, cwd,
    status: 'idle', title: 'plan', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true,
    tabId: 'w9:t3', interactiveReady: true,
  } as HerdrAgent;
  const listeners = new Set<(ev: HerdrPaneEvent) => void>();
  const handle: HerdrAgentHandle = {
    agent,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = new FakeClient();
  client.screenText = opts.screen;
  // Zrzut per sesja, który driver kasuje po cyfrze albo Esc (`clearPendingHook`), jak `readPendingHook` serwera.
  let raw: PendingHookTool | null = opts.raw;
  const audit: HerdrAuditEntry[] = [];
  const deps: HerdrDriverDeps = {
    client,
    audit: { log: (entry) => audit.push(entry) },
    yoloRoots: [],
    now: () => NOW,
    pulse: nullPulse,
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    agentFiles: (o) => createAgentFileReader({ ...o, root }),
    readPendingHook: () => raw,
    clearPendingHook: () => { raw = null; },
    shadow,
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
  };
  const driver = createHerdrDriver(handle, deps);
  disposers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) events.push(event);
  })();
  await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
  return {
    client, events, audit, prepared, outcomes, transcript, driver,
    emit: (ev) => { for (const listener of listeners) listener(ev); },
    hookCleared: () => raw === null,
  };
}

describe('prawdziwy driver i kanał cienia (`shadow`)', T, () => {
  it('„Ready to code?”: karta z planem, „Zatwierdź” = cyfra 2 i plik cienia `written`; po cyfrze karta nie wraca', async () => {
    const r = await rig({ lines: TRANSCRIPT_LINES, screen: READY, raw: HOOK_RAW, dump: CALL_DUMP });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });

    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({
      toolName: PLAN_TOOL, input: HOOK_INPUT, displayText: PLAN_TEXT, reqId: `hook:${HOOK_AT}~${PLAN_ID}`,
    });
    expect(r.audit.find((e) => e.method === 'degrade')).toBeUndefined();

    await expect(r.driver.respondPermission(shown?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    // „Zatwierdź” bez eskalacji: opcja 2 „Yes, manually approve edits”, nie tryb auto z opcji 1.
    expect(r.client.keys).toEqual([['2']]);
    expect(r.prepared.map((p) => p.card)).toEqual([{ toolName: PLAN_TOOL, callPrint: callPrint(PLAN_TOOL, HOOK_INPUT) }]);
    expect(r.outcomes).toEqual([{ result: 'written', key: CALL_DUMP.key, sessionId: SESSION }]);
    expect(r.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'written', shadowKey: CALL_DUMP.key });
    expect(r.hookCleared()).toBe(true);

    // Po cyfrze zrzut jest skasowany, wpis `{}` stoi do wyniku, a ekran pokazuje jeszcze dialog: osłona po
    // decyzji nie wystawia karty z samego wpisu.
    const count = permissions(r.events).length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(permissions(r.events)).toHaveLength(count);
  });

  it('„Ready to code?” bez stopki: karta bez przycisków, „Zatwierdź” odmówione bez kroku cienia, „Odrzuć” = `no-match`', async () => {
    const r = await rig({ lines: TRANSCRIPT_LINES, screen: READY_NO_FOOTER, raw: HOOK_RAW, dump: CALL_DUMP });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });

    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({
      toolName: PLAN_TOOL, input: null, reason: 'mismatch', displayText: DEGRADED_DISPLAY_TEXT.text,
      reqId: `hook:${HOOK_AT}~${PLAN_ID}`,
    });
    expect(r.audit.find((e) => e.method === 'degrade')).toMatchObject({ reason: 'mismatch' });

    // „Zatwierdź” (manager i tak go nie pokaże: `canAllow: false` dla `input: null`) — odmowa przed cyfrą.
    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'no-digit' });
    expect(r.client.keys).toEqual([]);
    expect(r.prepared).toEqual([]);

    // Odmowa zdejmuje kartę i ocena wraca; nowa karta jest taka sama.
    await waitFor(() => permissions(r.events).length > 1, 'karta po odmowie');
    const again = permissions(r.events).at(-1);
    expect(again).toMatchObject({ input: null, reqId: shown?.reqId });

    const deny = await r.driver.respondPermission(again?.reqId ?? '', 'deny');
    expect(deny).toEqual({ kind: 'applied' });
    expect(r.client.keys).toEqual([['escape']]);
    expect(r.prepared.map((p) => p.card)).toEqual([{ toolName: PLAN_TOOL, callPrint: callPrint(PLAN_TOOL, {}) }]);
    expect(r.outcomes).toEqual([{ result: 'no-match', detail: 'no-match' }]);
    expect(r.audit.find((e) => e.method === 'send_keys')).toMatchObject({ shadow: 'no-match', shadowDetail: 'no-match' });
    await expect(readdir(join(base, 'dane', HOOK_SHADOW_DIRNAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('„Ready to code?”, wpis dochodzi PO zrzucie: karta z planem, po wpisie ta sama karta raz pod nowym `reqId`', async () => {
    // Transkrypt bez wpisu `ExitPlanMode` (follower jeszcze go nie przeczytał); `Write` już z wynikiem.
    const before = [PLAN_PROMPT, WRITE_USE, WRITE_RESULT];
    const r = await rig({ lines: before, screen: READY, raw: HOOK_RAW, dump: CALL_DUMP });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta ze zrzutu');
    expect(permissions(r.events)[0]).toMatchObject({
      toolName: PLAN_TOOL, input: HOOK_INPUT, displayText: PLAN_TEXT, reqId: `hook:${HOOK_AT}`,
    });

    await appendFile(r.transcript, PLAN_USE);
    await waitFor(() => permissions(r.events).length > 1, 'karta po wpisie');
    expect(permissions(r.events).at(-1)).toMatchObject({
      toolName: PLAN_TOOL, input: HOOK_INPUT, displayText: PLAN_TEXT, reqId: `hook:${HOOK_AT}~${PLAN_ID}`,
    });
    // Jedna podmiana: kolejne oceny kończą się na bramce „ta sama karta”.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(permissions(r.events)).toHaveLength(2);
    expect(r.audit.find((e) => e.method === 'degrade')).toBeUndefined();
  });

  it('„Exit plan mode?”: karta z przyciskami, „Zatwierdź” = cyfra 1 i plik cienia `written` pod kluczem zrzutu', async () => {
    const lines = [
      userLine('Wywołaj teraz narzędzie ExitPlanMode z PUSTYM wejściem.', '2026-10-30T10:26:10.519Z'),
      toolUseLine(EMPTY_ID, PLAN_TOOL, {}, EMPTY_AT),
    ];
    const r = await rig({ lines, screen: EXIT, raw: EMPTY_RAW, dump: EMPTY_DUMP });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: {}, reqId: EMPTY_ID });

    await expect(r.driver.respondPermission(shown?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(r.client.keys).toEqual([['1']]);
    expect(r.outcomes).toEqual([{ result: 'written', key: EMPTY_DUMP.key, sessionId: SESSION }]);
    expect(r.audit.find((e) => e.method === 'approve')).toMatchObject({ shadow: 'written', shadowKey: EMPTY_DUMP.key });
  });
});

// ---------------------------------------------------------------------------
// 5. Nazwa pliku planu wyłącznie z bloku dialogu
// ---------------------------------------------------------------------------

/*
 * Plan A rozstrzygnięty wcześniej klawiszem przy biurku: jego hook żyje dalej, więc zrzut per sesja z planem A
 * zostaje. Teraz stoi dialog planu B (plan z przebiegu: `HOOK_RAW`, stopka `PLAN_FILE_NAME`), a nad nim w scrollbacku
 * linia z nazwą pliku planu A. Nazwa A na ekranie POZA blokiem dialogu nie może dać karcie treści planu A ani
 * cyfry, która zatwierdziłaby plan B.
 */
const PLAN_A_NAME = 'plan-a-quiet-river.md';
const PLAN_A_INPUT = { plan: '# Plan A\n\n1. Usuń katalog build.\n', planFilePath: `/Users/u/.claude/plans/${PLAN_A_NAME}` };
const RAW_A: PendingHookTool = { ...HOOK_RAW, toolInput: PLAN_A_INPUT };
const DUMP_A: HookCallDump = {
  ...CALL_DUMP, key: `${PROMPT}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, toolInput: PLAN_A_INPUT,
  inputSha256: canonicalSha256(PLAN_A_INPUT),
};
/** Wpis planu B: `{}` sekundę PO zrzucie A, czyli w zapasie zaokrągleń — zrzut A dalej konkuruje. */
const B_ID = 'toolu_plan_b';
const B_LINES = [PLAN_PROMPT, toolUseLine(B_ID, PLAN_TOOL, {}, new Date(HOOK_AT + 1_000).toISOString())];
const SCROLLBACK_A = ['⏺ Updated plan', `  ⎿  ~/.claude/plans/${PLAN_A_NAME}`, ''];
/** Dialog planu B ze stopką B, nad nim scrollback z plikiem A. */
const READY_B = [...SCROLLBACK_A, READY].join('\n');
/** Dialog planu B, którego TREŚĆ wspomina plik planu A (treść stoi nad kreską bloku). */
const READY_B_MENTIONS_A = READY.replace(' 1. Nic nie robić.', ` 1. Nic nie robić, plan ~/.claude/plans/${PLAN_A_NAME} zostaje.`);
/** Dialog planu A z jego własną stopką. */
const READY_A = READY.replace(`~/.claude/plans/${PLAN_FILE_NAME}`, `~/.claude/plans/${PLAN_A_NAME}`);

const entryB = (): PendingTool => {
  const entry = pendingToolUse(B_LINES);
  if (entry === null) throw new Error('brak wpisu');
  return entry;
};

describe('nazwa pliku planu tylko z bloku dialogu: scrollback i treść planu nie dają tożsamości', T, () => {
  it('fixture’y: plan A stoi w scrollbacku albo w treści planu B, stopka mówi B', () => {
    expect(READY_B).toContain(PLAN_A_NAME);
    expect(READY_B_MENTIONS_A).toContain(PLAN_A_NAME);
    expect(READY_B_MENTIONS_A).not.toBe(READY);
    expect(READY_A).toContain(`plans/${PLAN_A_NAME}`);
    expect(READY_A).not.toContain(PLAN_FILE_NAME);
    expect(competingHook(entryB(), RAW_A)).toBe(true);
  });

  it('scenariusz: zrzut A, wpis B `{}` w zapasie, A w scrollbacku — karta bez przycisków, bez planu A', () => {
    expect(hookMatchesScreen(hookOf(RAW_A), READY_B)).toBe(false);
    const { built, event, active } = permission(decideCard(input(READY_B, entryB(), RAW_A)));
    expect(active.options).toEqual([]);
    expect(event.input).toBeNull();
    expect(active.callPrint).not.toBe(callPrint(PLAN_TOOL, PLAN_A_INPUT));
    expect(built.audit).toBe('mismatch');
  });

  it('ten sam ekran bez wpisu jsonl: sam zrzut A nie pasuje do bloku — karta nie niesie planu A ani jego odcisku', () => {
    const action = decideCard(input(READY_B, null, RAW_A));
    const { event, active } = permission(action);
    expect(JSON.stringify(event.input ?? null)).not.toContain('Plan A');
    expect(event.displayText).not.toContain('Plan A');
    expect(active.callPrint).not.toBe(callPrint(PLAN_TOOL, PLAN_A_INPUT));
    expect(active.origin?.source).not.toBe('hook');
  });

  it('treść planu B wspomina plik A: zrzut B pasuje (stopka B), zrzut A nie', () => {
    expect(hookMatchesScreen(hookOf(HOOK_RAW), READY_B_MENTIONS_A)).toBe(true);
    expect(hookMatchesScreen(hookOf(RAW_A), READY_B_MENTIONS_A)).toBe(false);
    const good = permission(decideCard(input(READY_B_MENTIONS_A, planEntry(), HOOK_RAW)));
    expect(good.event).toMatchObject({ input: HOOK_INPUT, displayText: PLAN_TEXT });
    expect(good.active.callPrint).toBe(callPrint(PLAN_TOOL, HOOK_INPUT));
    const stale = permission(decideCard(input(READY_B_MENTIONS_A, entryB(), RAW_A)));
    expect(stale.active.options).toEqual([]);
    expect(stale.event.input).toBeNull();
  });

  it('stopka A przy zrzucie A: przypadek dobry — karta z planem A i przyciskami', () => {
    expect(hookMatchesScreen(hookOf(RAW_A), READY_A)).toBe(true);
    const { event, active } = permission(decideCard(input(READY_A, entryB(), RAW_A)));
    expect(event).toMatchObject({ input: PLAN_A_INPUT });
    expect(affirmativeOption(active.options)?.digit).toBe('2');
    expect(active.callPrint).toBe(callPrint(PLAN_TOOL, PLAN_A_INPUT));
  });

  it('ścieżka A w linii pod opcją 3 (feedback) nie liczy się: tożsamość daje stopka B', () => {
    const hint = '      shift+tab to approve with this feedback';
    const typed = READY.replace(hint, `      ~/.claude/plans/${PLAN_A_NAME}\n${hint}`);
    expect(typed).not.toBe(READY);
    expect(hookMatchesScreen(hookOf(HOOK_RAW), typed)).toBe(true);
    expect(hookMatchesScreen(hookOf(RAW_A), typed)).toBe(false);
    // Ścieżka A w miejscu podpowiedzi CLI: granicy stopki nie widać, więc nie pasuje żaden zrzut.
    const noHint = READY.replace(hint, `      ~/.claude/plans/${PLAN_A_NAME}`);
    expect(hookMatchesScreen(hookOf(HOOK_RAW), noHint)).toBe(false);
    expect(hookMatchesScreen(hookOf(RAW_A), noHint)).toBe(false);
  });

  it('bez bloku dialogu (sam scrollback, bez opcji) nazwa nie potwierdza niczego', () => {
    const noDialog = [...SCROLLBACK_A, ` ctrl+g to edit in Nvim · ~/.claude/plans/${PLAN_FILE_NAME}`, '❯ '].join('\n');
    expect(hookMatchesScreen(hookOf(RAW_A), noDialog)).toBe(false);
    expect(hookMatchesScreen(hookOf(HOOK_RAW), noDialog)).toBe(false);
  });

  it('prawdziwy driver, scenariusz: karta bez przycisków, „Zatwierdź” nie wysyła cyfry', async () => {
    const r = await rig({ lines: B_LINES, screen: READY_B, raw: RAW_A, dump: DUMP_A });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: null, reason: 'mismatch' });
    expect(shown?.displayText).not.toContain('Plan A');

    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'no-digit' });
    expect(r.client.keys).toEqual([]);
    expect(r.prepared).toEqual([]);
  });

  it('prawdziwy driver bez wpisu jsonl: karta nie niesie planu A', async () => {
    const r = await rig({ lines: [PLAN_PROMPT], screen: READY_B, raw: RAW_A, dump: DUMP_A });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    const shown = permissions(r.events).at(-1);
    expect(shown?.toolName).toBe(PLAN_TOOL);
    expect(JSON.stringify(shown?.input ?? null)).not.toContain('Plan A');
    expect(shown?.displayText).not.toContain('Plan A');
  });
});

// ---------------------------------------------------------------------------
// 6. Tożsamość planu wyłącznie ze stopki CLI
// ---------------------------------------------------------------------------

/*
 * Wąski panel (59 kolumn) w układzie zmierzonym na CLI 2.1.293 (`measured/exitplanmode-2.1.293.txt`): stopka
 * `ctrl+g to edit in Nvim · ~/.claude/plans/<nazwa>.md` łamie się na kilka linii, a nazwa dłuższa niż linia łamie
 * się w środku. W polu opcji 3 („Tell Claude what to change”) człowiek wpisuje dowolny tekst, także pełną ścieżkę
 * innego planu. Tożsamość planu daje wyłącznie stopka pod opcjami.
 */
const NARROW = 59;
const NAME_HEAD = PLAN_FILE_NAME.slice(0, NARROW - '   ~/.claude/plans/'.length);
/** Stopka planu B złamana jak w panelu 59 kolumn: po `·` i w środku nazwy. */
const FOOTER_B_WRAPPED = [
  '   ctrl+g to edit in Nvim ·',
  `   ~/.claude/plans/${NAME_HEAD}`,
  `   ${PLAN_FILE_NAME.slice(NAME_HEAD.length)}`,
];
/** Feedback w opcji 3 z pełną ścieżką planu A, w linii pod etykietą. */
const FEEDBACK_A = [
  '   ❯ 3. Tell Claude what to change',
  `        ~/.claude/plans/${PLAN_A_NAME}`,
  '        shift+tab to approve with this feedback',
];
const OPTION_3 = [
  '     3. Tell Claude what to change',
  '        shift+tab to approve with this feedback',
];

function narrowPlan(option3: readonly string[], footer: readonly string[]): string {
  const rule = `  ${'─'.repeat(NARROW)}`;
  const dash = `  ${'╌'.repeat(NARROW)}`;
  return [
    '  ⎿  /plan to preview',
    '▔'.repeat(NARROW + 2),
    '',
    rule,
    '   Ready to code?',
    '',
    "   Here is Claude's plan:",
    dash,
    '   Plan (s2c-pz-111714): nic nie robić.',
    dash,
    '',
    rule,
    '   Claude has written up a plan and is ready to execute.',
    '   Would you like to proceed?',
    '',
    option3 === OPTION_3 ? '   ❯ 1. Yes, and use auto mode' : '     1. Yes, and use auto mode',
    '     2. Yes, manually approve edits',
    ...option3,
    '',
    ...footer,
  ].join('\n');
}

/** Scenariusz: pełna ścieżka A w feedbacku opcji 3, stopka B złamana. */
const FEEDBACK_A_FOOTER_B = narrowPlan(FEEDBACK_A, FOOTER_B_WRAPPED);
/** Przypadek dobry: stopka B złamana, bez feedbacku. */
const FOOTER_B_ONLY = narrowPlan(OPTION_3, FOOTER_B_WRAPPED);

const measured = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures/herdr', name), 'utf8');

describe('tożsamość planu wyłącznie ze stopki CLI: feedback i linie opcji nie dają nazwy', T, () => {
  it('fixture’y: ścieżka A w feedbacku, stopka B złamana w środku nazwy', () => {
    expect(FEEDBACK_A_FOOTER_B).toContain(`~/.claude/plans/${PLAN_A_NAME}`);
    expect(FEEDBACK_A_FOOTER_B).not.toContain(PLAN_FILE_NAME);
    expect(FOOTER_B_ONLY.split('\n').every((l) => l.length <= NARROW + 2)).toBe(true);
    expect(parseOptions(FEEDBACK_A_FOOTER_B)).toMatchObject({ kind: 'tool', toolName: PLAN_TOOL });
    expect(resolveOptions(FOOTER_B_ONLY, { toolName: PLAN_TOOL }).status).toBe('ok');
  });

  it('parser: nazwa ze stopki złożonej z kolejnych linii; ścieżka w feedbacku się nie liczy', () => {
    expect(parseOptions(FOOTER_B_ONLY)?.planFile).toBe(PLAN_FILE_NAME);
    expect(parseOptions(FEEDBACK_A_FOOTER_B)?.planFile).toBe(PLAN_FILE_NAME);
    expect(parseOptions(READY)?.planFile).toBe(PLAN_FILE_NAME);
    expect(parseOptions(READY_A)?.planFile).toBe(PLAN_A_NAME);
  });

  it('zmierzone ekrany: stopka w jednej linii i złamana po `·` dają tę samą nazwę', () => {
    for (const name of ['measured/exitplanmode-2.1.293.txt', 'measured/exitplanmode-2.1.258.txt',
      'measured/exitplanmode.txt', 'measured/exitplanmode-2.1.278.txt']) {
      expect(parseOptions(measured(name))?.planFile, name).toBe('<plan>.md');
    }
    expect(parseOptions(measured('dialog-exitplanmode.txt'))?.planFile).toBe('floofy-prancing-hejlsberg.md');
  });

  it('stopka niekompletna, nierozpoznana albo z dwiema ścieżkami: brak nazwy, choć pełna ścieżka stoi w feedbacku', () => {
    const cut = narrowPlan(FEEDBACK_A, FOOTER_B_WRAPPED.slice(0, 2));
    const glued = narrowPlan(FEEDBACK_A, [`   ctrl+g to edit in Nvim · ~/.claude/plans/${PLAN_A_NAME}`]).replace(
      `        shift+tab to approve with this feedback\n\n`, '        shift+tab to approve with this feedback\n',
    );
    const two = narrowPlan(OPTION_3, [...FOOTER_B_WRAPPED, `   ~/.claude/plans/${PLAN_A_NAME}`]);
    const foreign = narrowPlan(OPTION_3, [`   ctrl+g to edit in Nvim · ~/plany/${PLAN_FILE_NAME}`]);
    const noFooter = narrowPlan(FEEDBACK_A, []).trimEnd();
    for (const [label, screen] of [['ucięta', cut], ['sklejona z opcją', glued], ['dwie ścieżki', two],
      ['inny katalog', foreign], ['bez stopki', noFooter]] as const) {
      expect(parseOptions(screen)?.toolName, label).toBe(PLAN_TOOL);
      expect(parseOptions(screen)?.planFile, label).toBeNull();
      expect(hookMatchesScreen(hookOf(RAW_A), screen), label).toBe(false);
      expect(hookMatchesScreen(hookOf(HOOK_RAW), screen), label).toBe(false);
    }
  });

  it('scenariusz: zrzut A, wpis B `{}`, A w feedbacku, stopka B złamana — karta bez przycisków, bez planu A', () => {
    expect(hookMatchesScreen(hookOf(RAW_A), FEEDBACK_A_FOOTER_B)).toBe(false);
    const { built, event, active } = permission(decideCard(input(FEEDBACK_A_FOOTER_B, entryB(), RAW_A)));
    expect(active.options).toEqual([]);
    expect(event.input).toBeNull();
    expect(event.displayText).not.toContain('Plan A');
    expect(built.audit).toBe('mismatch');
  });

  it('przypadek dobry: stopka B złamana i zrzut B — karta z planem B i przyciskami, „Zatwierdź” = opcja 2', () => {
    expect(hookMatchesScreen(hookOf(HOOK_RAW), FOOTER_B_ONLY)).toBe(true);
    const { event, active } = permission(decideCard(input(FOOTER_B_ONLY, planEntry(), HOOK_RAW)));
    expect(event).toMatchObject({ input: HOOK_INPUT, displayText: PLAN_TEXT });
    expect(affirmativeOption(active.options)?.digit).toBe('2');
    expect(active.callPrint).toBe(callPrint(PLAN_TOOL, HOOK_INPUT));
  });

  it('prawdziwy driver, scenariusz: „Zatwierdź” nie wysyła cyfry do dialogu B', async () => {
    const r = await rig({ lines: B_LINES, screen: FEEDBACK_A_FOOTER_B, raw: RAW_A, dump: DUMP_A });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: null, reason: 'mismatch' });
    expect(shown?.displayText).not.toContain('Plan A');

    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'no-digit' });
    expect(r.client.keys).toEqual([]);
    expect(r.prepared).toEqual([]);
  });

  it('prawdziwy driver, przypadek dobry: stopka B złamana, „Zatwierdź” = cyfra 2 i plik cienia pod kluczem B', async () => {
    const r = await rig({ lines: TRANSCRIPT_LINES, screen: FOOTER_B_ONLY, raw: HOOK_RAW, dump: CALL_DUMP });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: HOOK_INPUT, displayText: PLAN_TEXT });

    await expect(r.driver.respondPermission(shown?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(r.client.keys).toEqual([['2']]);
    expect(r.outcomes).toEqual([{ result: 'written', key: CALL_DUMP.key, sessionId: SESSION }]);
  });
});

// ---------------------------------------------------------------------------
// 7. Tożsamość planu tuż przed cyfrą
// ---------------------------------------------------------------------------

/*
 * Karta dialogu planu zapamiętuje nazwę pliku planu ze stopki (odcisk `bodyPrint`), a cyfra wychodzi tylko wtedy,
 * gdy świeży ekran tuż przed klawiszem pokazuje tę samą nazwę. Dialog planu nie ma ramki operacji, więc do tej
 * zmiany nie miał odcisku: dialog podmieniony w miejscu (plan A → plan B, te same opcje) przechodził kontrolę
 * etykiety, cyfry i tożsamości bloku, a karta ekranowa obu dialogów miała ten sam `reqId`.
 */
/** Wpis `tool_use` planu B z pełnym wejściem (model podał plan sam): karta z jsonl, bez hooka. */
const B_FULL_ID = 'toolu_plan_b_pelny';
const B_FULL_LINES = [PLAN_PROMPT, toolUseLine(B_FULL_ID, PLAN_TOOL, HOOK_INPUT, JSONL_AT)];

describe('tożsamość planu tuż przed cyfrą: nazwa pliku planu ze stopki w odcisku karty', T, () => {
  it('odcisk dialogu planu: ta sama nazwa daje ten sam odcisk (także po złamaniu stopki), inna nazwa inny', () => {
    const b = parseOptions(READY)?.bodyPrint;
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(parseOptions(READY_A)?.bodyPrint).toMatch(/^[0-9a-f]{16}$/);
    expect(parseOptions(READY_A)?.bodyPrint).not.toBe(b);
    expect(parseOptions(FOOTER_B_ONLY)?.bodyPrint).toBe(b);
    expect(parseOptions(READY_NO_FOOTER)?.bodyPrint).toBeNull();
    expect(parseOptions(EXIT)?.bodyPrint).toBeNull();
  });

  it('karta z ekranu: plan A i plan B z tym samym pytaniem i opcjami dostają różne `reqId` i odciski', () => {
    const a = permission(decideCard(input(READY_A, null, null)));
    const b = permission(decideCard(input(READY, null, null)));
    expect(a.active.options.map((o) => o.label)).toEqual(b.active.options.map((o) => o.label));
    expect(a.event.reqId).toMatch(/^screen:p:/);
    expect(b.event.reqId).not.toBe(a.event.reqId);
    expect(a.active.bodyPrint).toBe(parseOptions(READY_A)?.bodyPrint);
    expect(b.active.bodyPrint).toBe(parseOptions(READY)?.bodyPrint);
  });

  it('karta z hooka i karta z jsonl niosą odcisk planu ze stopki', () => {
    const hook = permission(decideCard(input(READY, planEntry(), HOOK_RAW)));
    expect(hook.active.bodyPrint).toBe(parseOptions(READY)?.bodyPrint);
    const entry = pendingToolUse(B_FULL_LINES);
    expect(entry).toMatchObject({ id: B_FULL_ID, input: HOOK_INPUT });
    const jsonl = permission(decideCard(input(READY, entry, null)));
    expect(jsonl.event).toMatchObject({ input: HOOK_INPUT });
    expect(jsonl.active.bodyPrint).toBe(parseOptions(READY)?.bodyPrint);
  });

  it('prawdziwy driver, karta z hooka: dialog A podmieniony na B przy tej samej generacji zrzutu — bez cyfry', async () => {
    const r = await rig({ lines: [PLAN_PROMPT], screen: READY_A, raw: RAW_A, dump: DUMP_A });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: PLAN_A_INPUT, reqId: `hook:${HOOK_AT}` });

    r.client.screenText = READY;
    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
    expect(r.client.keys).toEqual([]);
    expect(r.audit.find((e) => e.method === 'approve')).toBeUndefined();
  });

  it('prawdziwy driver, karta z jsonl: dialog B podmieniony na A — bez cyfry', async () => {
    const r = await rig({ lines: B_FULL_LINES, screen: READY, raw: null, dump: null });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: HOOK_INPUT, reqId: B_FULL_ID });

    r.client.screenText = READY_A;
    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
    expect(r.client.keys).toEqual([]);
  });

  it('prawdziwy driver, karta z ekranu: plan podmieniony pod kartą, pytanie i opcje te same — bez cyfry', async () => {
    const r = await rig({ lines: [PLAN_PROMPT], screen: READY_A, raw: null, dump: null });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    const shown = permissions(r.events).at(-1);
    expect(shown?.toolName).toBe(PLAN_TOOL);
    expect(shown?.reqId).toMatch(/^screen:p:/);

    r.client.screenText = READY;
    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'screen-changed' });
    expect(r.client.keys).toEqual([]);
    // Ocena po odmowie wystawia kartę planu B pod nowym `reqId`.
    await waitFor(() => permissions(r.events).length > 1, 'karta planu B');
    expect(permissions(r.events).at(-1)?.reqId).not.toBe(shown?.reqId);
  });

  it('prawdziwy driver, ten sam plan pod kartą z ekranu: cyfra 2 wychodzi', async () => {
    const r = await rig({ lines: [PLAN_PROMPT], screen: READY_A, raw: null, dump: null });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    const shown = permissions(r.events).at(-1);
    await expect(r.driver.respondPermission(shown?.reqId ?? '', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(r.client.keys).toEqual([['2']]);
  });
});

// ---------------------------------------------------------------------------
// 8. Stopka tylko za podpowiedzią CLI opcji 3
// ---------------------------------------------------------------------------

/*
 * Odczyt ekranu urwany w wieloliniowym feedbacku: człowiek wpisał w opcji 3 pustą linię i pełną imitację stopki
 * planu A, a prawdziwa podpowiedź `shift+tab …` i stopka planu B są pod dolną krawędzią odczytu. Ostatnia grupa linii
 * to wtedy imitacja; od stopki odróżnia ją miejsce (nie stoi za podpowiedzią CLI) i wcięcie (feedback stoi w polu
 * opcji, głębiej niż cyfra opcji, a stopka płycej).
 */
const FAKE_FOOTER_A = `        ctrl+g to edit in Nvim · ~/.claude/plans/${PLAN_A_NAME}`;
/** Scenariusz: feedback z imitacją stopki A po pustej linii, odczyt urwany przed podpowiedzią i stopką B. */
const CUT_FAKE_FOOTER = narrowPlan(['   ❯ 3. Tell Claude what to change', '        zmień plan', '', FAKE_FOOTER_A], []);
/** Ten sam feedback z przepisaną podpowiedzią CLI nad imitacją (tekst człowieka, wcięcie pola opcji). */
const CUT_FAKE_HINT_FOOTER = narrowPlan(
  ['   ❯ 3. Tell Claude what to change', '        shift+tab to approve with this feedback', '', FAKE_FOOTER_A], [],
);
/** Feedback wpisany normalnie (bez imitacji), pod nim podpowiedź CLI i prawdziwa stopka B. */
const TYPED_FEEDBACK_FOOTER_B = narrowPlan(
  ['   ❯ 3. Tell Claude what to change', '        zmień plan na prostszy', '        shift+tab to approve with this feedback'],
  FOOTER_B_WRAPPED,
);

describe('stopka planu tylko za podpowiedzią CLI opcji 3 i płycej niż cyfra opcji', T, () => {
  it('fixture’y: imitacja stopki A jest ostatnią grupą linii, prawdziwej podpowiedzi i stopki brak', () => {
    for (const screen of [CUT_FAKE_FOOTER, CUT_FAKE_HINT_FOOTER]) {
      expect(screen.trimEnd().split('\n').at(-1)).toBe(FAKE_FOOTER_A);
      expect(screen).not.toContain(PLAN_FILE_NAME.slice(0, 20));
      expect(parseOptions(screen)).toMatchObject({ kind: 'tool', toolName: PLAN_TOOL });
    }
  });

  it('zmierzone ekrany: podpowiedź CLI nad stopką, stopka płycej niż cyfra opcji', () => {
    // Ekran z przebiegu r4 (CLI 2.1.314) jest tu jako `READY`.
    const screens: [string, string][] = ['measured/exitplanmode-2.1.258.txt', 'measured/exitplanmode-2.1.278.txt',
      'measured/exitplanmode-2.1.293.txt', 'measured/exitplanmode.txt', 'dialog-exitplanmode.txt']
      .map((name) => [name, measured(name)]);
    for (const [name, text] of [...screens, ['r4 2.1.314', READY] as [string, string]]) {
      const lines = text.trimEnd().split('\n');
      const hint = lines.findIndex((l) => l.trim() === 'shift+tab to approve with this feedback');
      const footer = lines.findIndex((l) => l.trim().startsWith('ctrl+g to edit in'));
      const option3 = lines.find((l) => l.includes('3. Tell Claude what to change')) ?? '';
      const indent = (l: string): number => l.length - l.trimStart().length;
      expect(hint, name).toBeGreaterThan(0);
      expect(lines[hint + 1], name).toBe('');
      expect(footer, name).toBe(hint + 2);
      expect(indent(lines[footer] ?? ''), name).toBeLessThan(option3.indexOf('3.'));
      expect(indent(lines[hint] ?? ''), name).toBeGreaterThan(option3.indexOf('3.'));
    }
  });

  it('parser: imitacja stopki w feedbacku nie daje nazwy, z przepisaną podpowiedzią też nie', () => {
    expect(parseOptions(CUT_FAKE_FOOTER)?.planFile).toBeNull();
    expect(parseOptions(CUT_FAKE_HINT_FOOTER)?.planFile).toBeNull();
    expect(parseOptions(TYPED_FEEDBACK_FOOTER_B)?.planFile).toBe(PLAN_FILE_NAME);
  });

  it('scenariusz: zrzut A, wpis B `{}`, imitacja stopki A w urwanym odczycie — karta bez przycisków', () => {
    for (const screen of [CUT_FAKE_FOOTER, CUT_FAKE_HINT_FOOTER]) {
      expect(hookMatchesScreen(hookOf(RAW_A), screen)).toBe(false);
      const { event, active } = permission(decideCard(input(screen, entryB(), RAW_A)));
      expect(active.options).toEqual([]);
      expect(event.input).toBeNull();
      expect(event.displayText).not.toContain('Plan A');
    }
  });

  it('przypadek dobry: feedback wpisany normalnie, prawdziwa stopka B i zrzut B — karta z planem B i przyciskami', () => {
    expect(hookMatchesScreen(hookOf(HOOK_RAW), TYPED_FEEDBACK_FOOTER_B)).toBe(true);
    const { event, active } = permission(decideCard(input(TYPED_FEEDBACK_FOOTER_B, planEntry(), HOOK_RAW)));
    expect(event).toMatchObject({ input: HOOK_INPUT, displayText: PLAN_TEXT });
    expect(affirmativeOption(active.options)?.digit).toBe('2');
  });

  it('prawdziwy driver, scenariusz: „Zatwierdź” nie wysyła cyfry', async () => {
    const r = await rig({ lines: B_LINES, screen: CUT_FAKE_FOOTER, raw: RAW_A, dump: DUMP_A });
    r.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(r.events).length > 0, 'karta');
    r.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'permission' });
    const shown = permissions(r.events).at(-1);
    expect(shown).toMatchObject({ toolName: PLAN_TOOL, input: null });
    expect(shown?.displayText).not.toContain('Plan A');
    const allow = await r.driver.respondPermission(shown?.reqId ?? '', 'allow');
    expect(allow).toMatchObject({ kind: 'refused', reason: 'no-digit' });
    expect(r.client.keys).toEqual([]);
    expect(r.prepared).toEqual([]);
  });
});
