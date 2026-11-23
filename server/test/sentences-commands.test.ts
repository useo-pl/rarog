/**
 * Zdania komend: odmowy slash-komend (`shape.ts`), bramka tekstu (`guard.ts`), notka o prompcie
 * zablokowanym przez hook (`transcript.ts`), zdania wysyłki i przerwania z drivera (`drivers/herdr/commands.ts`)
 * i cykl trybów (`mode-cycle.ts`). Każde zdanie wywołane swoją drogą produkcyjną to `say()` z kodem z rejestru,
 * a `text` to angielski szablon z argumentami. Podkod wskazówki (`hint:code`) nie ma własnej emisji: jego przypadek
 * to zdanie rodzica z podkodem w `ref.args`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_HERDR_PROMPT_BYTES } from '@rarog/shared';
import { SENTENCES, foreign, isServerSentence } from '@rarog/shared/sentences';
import type { AnyText, SentenceCode } from '@rarog/shared/sentences';
import { assertSendable, HerdrPromptRejectedError } from '../src/herdr/commands/guard.ts';
import type { SendableOptions } from '../src/herdr/commands/guard.ts';
import { classifySlashText } from '../src/herdr/commands/shape.ts';
import { buildCatalog, registryCatalog } from '../src/herdr/commands/catalog.ts';
import type { CommandCatalog, KnownName } from '../src/herdr/commands/catalog.ts';
import { ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';
import {
  COMMAND_OUTPUT_CLIP, COMMAND_OUTPUT_MAX_BYTES, promptBlockedText,
} from '../src/herdr/commands/transcript.ts';
import {
  CLI_DIALOG_SEND_MESSAGE, CONSENT_DIALOG_SEND_MESSAGE, FORM_STANDS_SEND_MESSAGE, INTERRUPT_DONE_MESSAGE,
  STALLED_PROMPT_MESSAGE, modelOutcomeMessage, quietCommandMessage,
} from '../src/drivers/herdr/commands.ts';
import { assertModeCycleKeys, modeCycleDoneMessage, modeCycleStoppedMessage } from '../src/herdr/mode-cycle.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import {
  HerdrBlockedError, HerdrError, HerdrGoneError, HerdrReadOnlyError,
} from '../src/herdr/types.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { SessionPulse } from '../src/herdr/session-pulse.ts';
import { projectSlug } from '../src/cli-store.ts';

// ---------------------------------------------------------------------------
// Oczekiwane brzmienie z rejestru
// ---------------------------------------------------------------------------

type Vars = Readonly<Record<string, string | number>>;

const EN_PLURAL = new Intl.PluralRules('en');

/** Angielski tekst zdania z rejestru z podstawionymi argumentami (podkod: jego `en`). */
function render(code: SentenceCode, vars: Vars = {}): string {
  const def = SENTENCES[code];
  const specs: readonly string[] = 'args' in def ? def.args : [];
  let template: string;
  if (typeof def.en === 'string') {
    template = def.en;
  } else {
    const plural = specs.find((spec) => spec.endsWith(':plural'))?.split(':')[0] ?? '';
    template = EN_PLURAL.select(Number(vars[plural])) === 'one' ? def.en.one : def.en.other;
  }
  return template.replace(/\{([a-zA-Z0-9]+)\}/gu, (_m, name: string) => {
    const spec = specs.find((s) => s.startsWith(`${name}:`)) ?? '';
    const value = vars[name];
    if (value === undefined) throw new Error(`${code}: brak argumentu ${name}`);
    if (spec.endsWith(':code')) return render(String(value) as SentenceCode);
    return String(value);
  });
}

/** Argumenty na drucie w kolejności deklaracji rejestru. */
function wireArgs(code: SentenceCode, vars: Vars): string[] | undefined {
  const def = SENTENCES[code];
  const specs: readonly string[] = 'args' in def ? def.args : [];
  if (specs.length === 0) return undefined;
  return specs.map((spec) => String(vars[spec.split(':')[0] ?? '']));
}

/** Zdanie z `say()`: kod, argumenty w `ref.args` i angielski tekst rejestru. */
function expectSay(value: AnyText | undefined, code: SentenceCode, vars: Vars = {}): void {
  expect(isServerSentence(value), `${code}: zdanie ma powstać przez say()`).toBe(true);
  if (value === undefined || !isServerSentence(value)) return;
  const args = wireArgs(code, vars);
  expect(value.ref).toEqual(args === undefined ? { code } : { code, args });
  expect(value.text).toBe(render(code, vars));
}

/** Zdanie wyjątku bramki (`HerdrError.sentence`). */
function rejection(run: () => unknown): AnyText | undefined {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(HerdrPromptRejectedError);
    return (err as HerdrError).sentence;
  }
  throw new Error('bramka miała odmówić');
}

// ---------------------------------------------------------------------------
// Bramka tekstu i odmowy slash-komend
// ---------------------------------------------------------------------------

const PROJECT_CATALOG: CommandCatalog = buildCatalog('/projekt', {
  commands: [
    { name: 'plug:thing', source: 'plugin', origin: 'plugin-command' },
    { name: 'foo:bar', source: 'plugin', origin: 'plugin-command' },
  ],
  hidden: [{ name: 'hidden-one', reason: 'user-invocable' }],
  synced: ['synced-one'],
  skippedPlugins: [], notes: [], stamps: new Map(),
} as never);

const base = (catalog: CommandCatalog = PROJECT_CATALOG): SendableOptions => ({
  mode: 'manual', cwd: '/projekt', yoloRoots: [], realPath: (p) => p, exists: () => false, catalog,
});

const refuse = (text: string, opts: SendableOptions = base()): AnyText | undefined =>
  rejection(() => assertSendable(text, opts));

/** Katalog z jedną znaną nazwą poza allow-listą — wskazówka, której katalog z rejestru nie wytwarza. */
function catalogWith(word: string, known: KnownName): CommandCatalog {
  const names = new Map(registryCatalog().names);
  names.set(word, known);
  return { ...registryCatalog(), names };
}

describe('bramka tekstu (`guard.ts`)', () => {
  it('prefiks `!` → commands.prefix-blocked z prefiksem w argumencie', () => {
    expectSay(refuse('!ls'), 'commands.prefix-blocked', { prefix: '!' });
  });

  it('tekst spoza kształtu ścieżki wewnętrznej → commands.not-internal', () => {
    const opts: SendableOptions = {
      mode: 'manual', cwd: '/projekt', yoloRoots: [], realPath: (p) => p, internalCommand: true,
    };
    expectSay(rejection(() => assertSendable('/login', opts)), 'commands.not-internal');
  });

  it('wiadomość ponad limit → commands.too-large z bajtami i limitem w KB', () => {
    const text = 'a'.repeat(MAX_HERDR_PROMPT_BYTES + 1);
    expectSay(refuse(text), 'commands.too-large', {
      bytes: MAX_HERDR_PROMPT_BYTES + 1, limitKb: Math.round(MAX_HERDR_PROMPT_BYTES / 1024),
    });
  });

  it('panel w bypass poza RAROG_YOLO_ROOTS → commands.bypass-outside-yolo', () => {
    expectSay(refuse('hej', { ...base(), mode: 'bypass' }), 'commands.bypass-outside-yolo');
  });

  it('pusta wiadomość → commands.empty', () => {
    expectSay(refuse('   '), 'commands.empty');
  });
});

describe('odmowy slash-komend (`shape.ts`) przez bramkę', () => {
  const cases: readonly [string, SentenceCode, Vars, (() => SendableOptions)?][] = [
    ['quit', 'commands.exit-word', { command: 'quit' }],
    ['/', 'commands.bare-slash', {}],
    ['/foo (MCP)', 'commands.mcp-prompt.marked', { token: '/foo' }],
    ['/mcp__srv__p', 'commands.mcp-prompt', { token: '/mcp__srv__p' }],
    ['/code-review ultra', 'commands.redirect-blocked', { token: '/code-review', word: 'ultra', target: 'ultrareview' }],
    ['/review', 'commands.alias-use-canonical', { token: '/review', canonical: 'code-review' }],
    ['/settings', 'commands.refused-alias',
      { token: '/settings', canonical: 'config', hint: 'commands.hint.run-in-terminal' }],
    ['/quit', 'commands.refused-alias', { token: '/quit', canonical: 'exit', hint: 'commands.hint.end-session-button' }],
    ['/login', 'commands.refused-known.run-in-terminal', { token: '/login' }],
    ['/model', 'commands.refused-known.use-model-button', { token: '/model' }],
    ['/exit', 'commands.refused-known.end-session', { token: '/exit' }],
    ['/artifact-design', 'commands.refused-claude-skill', { token: '/artifact-design' }],
    ['/synced-one', 'commands.refused-synced-skill',
      { token: '/synced-one', hint: 'commands.hint.run-skill-in-terminal' }],
    ['/hidden-one', 'commands.refused-hidden-skill',
      { token: '/hidden-one', hint: 'commands.hint.rarog-blocks-skill' }],
    ['/foo bar', 'commands.use-joined', { token: '/foo', name: 'foo:bar' }],
    ['/thing', 'commands.namespaced', { token: '/thing', names: '/plug:thing' }],
    ['/compa', 'commands.incomplete-name', { token: '/compa', names: '/compact' }],
    ['/logi', 'commands.completes-to-blocked', { token: '/logi', names: '/login', count: 1 }],
    ['/setup-', 'commands.completes-to-blocked',
      { token: '/setup-', names: '/setup-bedrock, /setup-vertex', count: 2 }],
    ['/artifact-de', 'commands.completes-to-blocked.claude-only',
      { token: '/artifact-de', names: '/artifact-design', count: 1 }],
    ['/zzzz', 'commands.unknown', { token: '/zzzz' }],
    ['/foo.bar', 'commands.not-in-catalog', { token: '/foo.bar' }],
    ['/comp', 'commands.path-completes', { token: '/comp' }, () => ({ ...base(), exists: () => true })],
  ];

  it.each(cases)('%s → %s', (text, code, vars, opts) => {
    expectSay(refuse(text, opts?.() ?? base()), code, vars);
  });

  it('wskazówka „przycisk modelu” jako podkod aliasu → commands.hint.use-model-button w ref.args', () => {
    const catalog = catalogWith('m', { canonical: 'model', origin: 'builtin', alias: true, allowed: false });
    const result = classifySlashText('/m', catalog, { exists: () => false });
    expect(result.type).toBe('refused');
    if (result.type !== 'refused') return;
    expectSay(result.message, 'commands.refused-alias',
      { token: '/m', canonical: 'model', hint: 'commands.hint.use-model-button' });
  });

  it('wskazówka skilla claude-only przy skillu ukrytym → commands.hint.write-plain-message w ref.args', () => {
    const catalog = catalogWith('keybindings-help',
      { canonical: 'keybindings-help', origin: 'hidden', alias: false, allowed: false });
    const result = classifySlashText('/keybindings-help', catalog, { exists: () => false });
    expect(result.type).toBe('refused');
    if (result.type !== 'refused') return;
    expectSay(result.message, 'commands.refused-hidden-skill',
      { token: '/keybindings-help', hint: 'commands.hint.write-plain-message' });
  });

  it('argument `token` jedzie dosłownie, bez tłumaczenia (polskie znaki zostają)', () => {
    expectSay(refuse('/zażółć'), 'commands.not-in-catalog', { token: '/zażółć' });
  });
});

// ---------------------------------------------------------------------------
// Notka o prompcie zablokowanym przez hook
// ---------------------------------------------------------------------------

describe('prompt zablokowany przez hook (`transcript.ts`)', () => {
  it('bez powodu i cytatu → commands.prompt-blocked', () => {
    expectSay(promptBlockedText(''), 'commands.prompt-blocked');
  });

  it('z powodem → commands.prompt-blocked.reason', () => {
    expectSay(promptBlockedText('hook mówi nie'), 'commands.prompt-blocked.reason', { reason: 'hook mówi nie' });
  });

  it('z cytatem → commands.prompt-blocked.prompt', () => {
    expectSay(promptBlockedText('', 'zrób to'), 'commands.prompt-blocked.prompt', { prompt: 'zrób to' });
  });

  it('z powodem i cytatem → commands.prompt-blocked.reason-and-prompt', () => {
    expectSay(promptBlockedText('zły powód', '/tmp/zażółć'), 'commands.prompt-blocked.reason-and-prompt',
      { reason: 'zły powód', prompt: '/tmp/zażółć' });
  });

  it('powód 9 KiB: `text` i `ref.args` ucięte tak samo, ze znacznikiem ucięcia', () => {
    const reason = 'r'.repeat(9 * 1024);
    const note = promptBlockedText(reason);
    expect(isServerSentence(note)).toBe(true);
    if (!isServerSentence(note)) return;
    const clipped = note.ref.args?.[0] ?? '';
    expect(Buffer.byteLength(clipped, 'utf8')).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_BYTES);
    expect(clipped.endsWith(COMMAND_OUTPUT_CLIP)).toBe(true);
    expect(note.text).toBe(render('commands.prompt-blocked.reason', { reason: clipped }));
  });
});

// ---------------------------------------------------------------------------
// Zdania wysyłki, przerwania i wyniku komend sterujących
// ---------------------------------------------------------------------------

describe('zdania drivera (`drivers/herdr/commands.ts`)', () => {
  /*
   * Stałe wysyłki i przerwania z błędem herdr sprawdzają testy ich dróg niżej (`expectSay` na wyniku drogi).
   * Cztery pierwsze wiersze zostają: testy dróg tych zdań (`herdr-driver.test.ts`, `form-reserve.test.ts`,
   * `cli-reserve.test.ts`) czytają sam tekst albo `ref.code`, więc nie złapią zdania bez marki `say()`,
   * które `wireText` wysyła bez `ref` (apka go wtedy nie tłumaczy).
   */
  it.each([
    [INTERRUPT_DONE_MESSAGE, 'commands.interrupt-done'],
    [CONSENT_DIALOG_SEND_MESSAGE, 'commands.send-held.consent-dialog'],
    [FORM_STANDS_SEND_MESSAGE, 'commands.send-held.form'],
    [CLI_DIALOG_SEND_MESSAGE, 'commands.send-held.cli-dialog'],
    [STALLED_PROMPT_MESSAGE, 'commands.send-stalled'],
  ] as const)('stała zdania → %#', (value, code) => {
    expectSay(value, code);
  });

  it('komenda bez tury → commands.quiet-command z komendą', () => {
    expectSay(quietCommandMessage('/context'), 'commands.quiet-command', { command: '/context' });
  });

  it.each([
    ['confirmed', 'model.change-confirmed'],
    ['inline', 'model.change-inline'],
    ['no-dialog', 'model.change-no-dialog'],
    ['foreign', 'model.change-foreign-dialog'],
  ] as const)('/model: wynik %s → %s', (outcome, code) => {
    expectSay(modelOutcomeMessage('/model opus', outcome), code, { command: '/model opus' });
  });

  it('ultracode: włączone, wyłączone, odmowa, wynik niewidoczny i dialog obcy', () => {
    expectSay(modelOutcomeMessage(ULTRACODE_COMMANDS.on, 'inline'), 'model.ultracode-on');
    expectSay(modelOutcomeMessage(ULTRACODE_COMMANDS.on, 'confirmed'), 'model.ultracode-on');
    expectSay(modelOutcomeMessage(ULTRACODE_COMMANDS.off, 'inline'), 'model.ultracode-off');
    expectSay(modelOutcomeMessage(ULTRACODE_COMMANDS.on, 'refused'), 'model.ultracode-refused');
    expectSay(modelOutcomeMessage(ULTRACODE_COMMANDS.off, 'no-dialog'), 'model.ultracode-unseen',
      { command: ULTRACODE_COMMANDS.off });
    expectSay(modelOutcomeMessage(ULTRACODE_COMMANDS.on, 'foreign'), 'model.change-foreign-dialog',
      { command: ULTRACODE_COMMANDS.on });
  });
});

// ---------------------------------------------------------------------------
// Cykl trybów
// ---------------------------------------------------------------------------

describe('cykl trybów (`mode-cycle.ts`)', () => {
  it('klawisz spoza ścieżki cyklu → commands.mode-cycle-keys w wyjątku', () => {
    let sentence: AnyText | undefined;
    try {
      assertModeCycleKeys(['enter']);
    } catch (err) {
      sentence = (err as HerdrError).sentence;
    }
    expectSay(sentence, 'commands.mode-cycle-keys');
  });

  it('tryb ustawiony → commands.mode-cycle-done, liczba naciśnięć jako plural', () => {
    expectSay(modeCycleDoneMessage('plan', 1), 'commands.mode-cycle-done', { target: 'plan', presses: 1 });
    expectSay(modeCycleDoneMessage('auto', 3), 'commands.mode-cycle-done', { target: 'auto', presses: 3 });
  });

  it.each([
    ['busy', 'commands.mode-cycle-busy', 'commands.mode-cycle-busy.mode-unknown'],
    ['unknown', 'commands.mode-cycle-no-footer', 'commands.mode-cycle-no-footer.mode-unknown'],
    ['send-failed', 'commands.mode-cycle-key-lost', 'commands.mode-cycle-key-lost.mode-unknown'],
    ['exhausted', 'commands.mode-cycle-exhausted', 'commands.mode-cycle-exhausted.mode-unknown'],
  ] as const)('stop „%s” → %s, a przy trybie nieznanym %s', (reason, code, unknownCode) => {
    expectSay(modeCycleStoppedMessage('auto', reason, 'acceptEdits', 2), code,
      { presses: 2, mode: 'accept edits', target: 'auto' });
    expectSay(modeCycleStoppedMessage('plan', reason, 'manual', 1), code,
      { presses: 1, mode: 'manual', target: 'plan' });
    expectSay(modeCycleStoppedMessage('plan', reason, 'unknown', 1), unknownCode, { presses: 1, target: 'plan' });
  });
});

// ---------------------------------------------------------------------------
// Przez driver: zdanie wchodzi do transkryptu jako blok `text` z `ref`
// ---------------------------------------------------------------------------

const SESSION = '5b1c0b7e-3f2a-4c55-9a1e-e2300c0a0e23';

class FakeClient implements HerdrClient {
  promptError: Error | null = null;
  escapeError: Error | null = null;
  listAgents(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  getAgent(): Promise<HerdrAgentInfo> { return Promise.reject(new Error('nieużywane')); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: '' }); }
  prompt(): Promise<void> {
    return this.promptError === null ? Promise.resolve() : Promise.reject(this.promptError);
  }
  sendKeys(_paneId: string, keys: readonly string[]): Promise<void> {
    if (keys[0] === 'escape' && this.escapeError !== null) return Promise.reject(this.escapeError);
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

let dir = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarog-sentences-commands-'));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Panel z driverem. `status` panelu: przerwanie potrzebuje tury (`working`); wysyłka idzie poza turą (`idle`), bo tam
 * tekst niesie `agent.prompt`, a w turze panel Claude dostaje wklejenie z osobnym Enterem.
 */
async function rig(
  status: 'working' | 'idle' = 'working',
): Promise<{ client: FakeClient; events: DriverEvent[]; driver: ReturnType<typeof createHerdrDriver> }> {
  const root = join(dir, 'store');
  const cwd = join(dir, 'projekt');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${SESSION}.jsonl`), `${JSON.stringify({
    type: 'user', isSidechain: false, timestamp: '2026-08-22T10:00:00.000Z', sessionId: SESSION,
    message: { role: 'user', content: 'start' },
  })}\n`);
  const agent = {
    key: 'w1:p1', paneId: 'w1:p1', agentSessionId: SESSION, engine: 'claude', termId: null, cwd,
    status, title: 'praca', stateChangeSeq: 7, mode: 'manual', modeReadAt: 0, inScope: true,
    tabId: 'w1:t1', interactiveReady: true,
  } as HerdrAgent;
  const handle: HerdrAgentHandle = { agent, subscribe: () => () => {} };
  const client = new FakeClient();
  const driver = createHerdrDriver(handle, {
    client,
    audit: { log: () => {} },
    yoloRoots: [],
    now: () => Date.now(),
    pulse: nullPulse,
    follow: (o) => createJsonlFollower({
      ...o, root, watch: false,
      timing: { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 },
    }),
    escSettleMs: 5,
  });
  disposers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) events.push(event);
  })();
  await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
  return { client, events, driver };
}

/** Bloki `text` notek systemowych drivera. */
const systemBlocks = (events: readonly DriverEvent[]): AnyText[] => events
  .filter((e): e is Extract<DriverEvent, { type: 'message' }> => e.type === 'message' && e.role === 'system')
  .flatMap((e) => e.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])));

describe('przez driver — notka systemowa to blok `text` z `ref`', () => {
  it.each([
    [() => new HerdrReadOnlyError(foreign('feature_disabled')), 'commands.interrupt-read-only'],
    [() => new HerdrGoneError(foreign('agent_gone')), 'commands.interrupt-panel-gone'],
    [() => new HerdrBlockedError(foreign('agent_blocked')), 'commands.interrupt-blocked'],
  ] as const)('przerwanie z błędem herdr → %#', async (error, code) => {
    const r = await rig();
    r.client.escapeError = error();
    await expect(r.driver.interrupt()).resolves.toBe(false);
    await waitFor(() => systemBlocks(r.events).length > 0, 'notka');
    expectSay(systemBlocks(r.events)[0], code);
  });

  it.each([
    [() => new HerdrReadOnlyError(foreign('feature_disabled')), 'commands.send-read-only'],
    [() => new HerdrBlockedError(foreign('agent_blocked')), 'commands.send-blocked'],
  ] as const)('wysyłka z błędem herdr → %#', async (error, code) => {
    const r = await rig('idle');
    r.client.promptError = error();
    r.driver.send('cokolwiek');
    await waitFor(() => systemBlocks(r.events).length > 0, 'notka');
    expectSay(systemBlocks(r.events)[0], code);
  });
});
