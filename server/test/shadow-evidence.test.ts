/**
 * Dowód „dialog stoi” trybu cienia (`server/src/herdr/dialogs/shadow/evidence.ts`), licznik kolejki z ekranu
 * (`screen/queue.ts`) i otwarte `tool_use` z transkryptu (`openToolUses`). Czyste funkcje, więc testy są tablicą
 * przypadków bez dysku i bez zegara. Reguły: `docs/dialogs.md`, „Server in shadow mode”.
 */
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { callPrint } from '../src/herdr/dialogs/cross-check.ts';
import { queueOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import type { QueueOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import {
  ORPHAN_TRANSCRIPT_MIN_AGE_MS, REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS, orphanHooks, pickShadowTarget,
  registryEvidenceFromSignal, registryEvidenceOf, standingProofs,
} from '../src/herdr/dialogs/shadow/evidence.ts';
import type { EvidenceInput, OpenToolUse, RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { openToolUses } from '../src/herdr/jsonl-pending.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const NOW = 1_800_000_000_000;
const T = { timeout: 2_000 };

let nonce = 0;
function dump(over: Partial<HookCallDump> = {}): HookCallDump {
  nonce += 1;
  const toolInput = over.toolInput ?? { command: 'ls -la', description: 'List' };
  return {
    key: `${PROMPT}-${nonce.toString(16).padStart(32, '0')}`,
    sessionId: SESSION,
    promptId: PROMPT,
    pid: 4_000 + nonce,
    startedAt: NOW - 20_000,
    toolName: 'Bash',
    toolInput,
    cwd: '/projekt',
    at: NOW - 10_000,
    inputSha256: canonicalSha256(toolInput),
    ...over,
  };
}

const WAITING: RegistryEvidence = { kind: 'waiting', dialog: 'permission', at: NOW - 500 };
const SINGLE: QueueOnScreen = { kind: 'single' };

function input(dumps: readonly HookCallDump[], over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    now: NOW,
    dumps,
    alive: new Map(dumps.map((d) => [d.key, true])),
    registry: WAITING,
    queue: SINGLE,
    transcript: dumps.filter((d) => d.agentId === undefined).map((d) => ({ toolName: d.toolName, input: d.toolInput })),
    ...over,
  };
}

const kinds = (inp: EvidenceInput): string[] => standingProofs(inp)
  .map((v) => (v.kind === 'brak' ? `brak:${v.why}` : v.kind));

/** Ekran dialogu zgody o kształcie zmierzonym przy dwóch równoległych prośbach o odczyt (CLI 2.1.302). */
function readDialog(counter: string | null): string {
  const title = counter === null ? ' Read file' : ` Read file${' '.repeat(60)}${counter}`;
  return [
    '⏺ Reading 2 files… (ctrl+o to expand)',
    '',
    '─'.repeat(80),
    title,
    '╌'.repeat(80),
    ' Read(/projekt/zewn/a.txt)',
    '╌'.repeat(80),
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, allow reading from /projekt/zewn during this session',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
}

describe('licznik kolejki z ekranu', T, () => {
  it('„1 of 2”: stoją dwie prośby; „2 of 2” po prośbie niewidocznej: stoi jedna', () => {
    expect(queueOnScreen(readDialog('1 of 2'))).toEqual({ kind: 'counter', index: 1, total: 2, standing: 2 });
    expect(queueOnScreen(readDialog('2 of 2'))).toEqual({ kind: 'counter', index: 2, total: 2, standing: 1 });
    expect(queueOnScreen(readDialog('1 of 3'))).toMatchObject({ standing: 3 });
  });

  it('cały blok bez licznika = jedna prośba', () => {
    expect(queueOnScreen(readDialog(null))).toEqual({ kind: 'single' });
  });

  it('niewiadoma niczego nie mówi: brak ekranu, brak dialogu, blok ucięty u góry, licznik bez sensu', () => {
    expect(queueOnScreen(null)).toEqual({ kind: 'unknown' });
    expect(queueOnScreen('⏺ Gotowe.\n\n> ')).toEqual({ kind: 'unknown' });
    const cut = readDialog('1 of 2').split('\n').slice(4).join('\n');
    expect(queueOnScreen(cut)).toEqual({ kind: 'unknown' });
    expect(queueOnScreen(readDialog('3 of 2'))).toEqual({ kind: 'unknown' });
    expect(queueOnScreen(readDialog('1 of 1'))).toEqual({ kind: 'unknown' });
  });
});

describe('sygnał rejestru sesji CLI', T, () => {
  it('wpisy rejestru → sygnał z chwilą odczytu', () => {
    const entry = { pid: 1, version: '2.1.311' };
    expect(registryEvidenceOf(null, NOW)).toEqual({ kind: 'unknown', why: 'no-registry' });
    expect(registryEvidenceOf(undefined, NOW)).toEqual({ kind: 'unknown', why: 'no-entry' });
    expect(registryEvidenceOf([], NOW)).toEqual({ kind: 'unknown', why: 'no-entry' });
    expect(registryEvidenceOf([{ ...entry, status: 'busy' }, { ...entry, pid: 2, status: 'waiting' }], NOW))
      .toEqual({ kind: 'unknown', why: 'writers' });
    expect(registryEvidenceOf([{ ...entry, status: 'busy' }], NOW)).toEqual({ kind: 'active', at: NOW });
    expect(registryEvidenceOf([{ ...entry, status: 'idle' }], NOW)).toEqual({ kind: 'active', at: NOW });
    expect(registryEvidenceOf([{ ...entry, status: 'waiting', waitingFor: 'permission' }], NOW))
      .toEqual({ kind: 'waiting', dialog: 'permission', at: NOW });
    expect(registryEvidenceOf([{ ...entry, status: 'waiting' }], NOW))
      .toEqual({ kind: 'waiting', dialog: 'other', at: NOW });
  });

  it('sygnał managera → ten sam kształt', () => {
    expect(registryEvidenceFromSignal(null, NOW)).toEqual({ kind: 'unknown', why: 'unread' });
    expect(registryEvidenceFromSignal({ kind: 'unknown' }, NOW)).toEqual({ kind: 'unknown', why: 'unread' });
    expect(registryEvidenceFromSignal({ kind: 'active' }, NOW)).toEqual({ kind: 'active', at: NOW });
    expect(registryEvidenceFromSignal({ kind: 'waiting', dialog: 'input' }, NOW))
      .toEqual({ kind: 'waiting', dialog: 'input', at: NOW });
  });
});

describe('dowód „dialog stoi”: komplet daje, niewiadoma nie daje', T, () => {
  it('żywy hook, rejestr `waiting: permission`, jeden blok, otwarty `tool_use` = dowód', () => {
    expect(kinds(input([dump()]))).toEqual(['stoi']);
  });

  it('transkrypt i ekran nieznane niczego nie zabierają: dowód z rejestru i życia hooka', () => {
    expect(kinds(input([dump()], { transcript: null, queue: { kind: 'unknown' } }))).toEqual(['stoi']);
  });

  it('proces hooka martwy albo nieznany: brak dowodu', () => {
    const a = dump();
    const b = dump();
    expect(kinds(input([a, b], { alive: new Map([[a.key, false]]) })))
      .toEqual(['brak:hook-martwy', 'brak:hook-nieznany']);
  });

  it('prośba subagenta i zrzut przycięty (skrót niezgodny z treścią) nie mają dowodu', () => {
    const sub = dump({ agentId: 'agent-1' });
    const cut = dump({ toolInput: { rarogTruncated: true, preview: 'rm -rf' }, inputSha256: 'f'.repeat(64) });
    expect(kinds(input([sub, cut]))).toEqual(['brak:subagent', 'brak:skrot']);
  });
});

describe('dowód „dialog stoi”: rejestr', T, () => {
  it('`busy` po zrzucie zabiera dowód; `busy` tuż po zrzucie (zapas na zapis rejestru) też go nie daje', () => {
    const old = dump({ at: NOW - 10_000 });
    const fresh = dump({ at: NOW - REGISTRY_SLACK_MS + 500, toolInput: { command: 'pwd' } });
    const busy: RegistryEvidence = { kind: 'active', at: NOW - 200 };
    expect(kinds(input([old, fresh], { registry: busy })))
      .toEqual(['brak:rejestr-nie-czeka', 'brak:rejestr-nie-czeka']);
  });

  it('`idle` przy żywym subagencie: zrzut subagenta poza wariantem widocznym, zrzut główny traci dowód', () => {
    const sub = dump({ agentId: 'agent-7', toolName: 'Read', toolInput: { file_path: '/x' } });
    const main = dump();
    expect(kinds(input([sub, main], { registry: { kind: 'active', at: NOW - 100 } })))
      .toEqual(['brak:subagent', 'brak:rejestr-nie-czeka']);
  });

  it('brak wpisu, dwóch pisarzy, odczyt nieświeży: nie wiem = brak dowodu', () => {
    for (const registry of [
      { kind: 'unknown', why: 'no-entry' },
      { kind: 'unknown', why: 'writers' },
      { kind: 'unknown', why: 'no-registry' },
      { kind: 'waiting', dialog: 'permission', at: NOW - REGISTRY_MAX_AGE_MS - 1 },
    ] as const) {
      expect(kinds(input([dump()], { registry })), JSON.stringify(registry)).toEqual(['brak:rejestr-nieznany']);
    }
  });

  it('nieświeży `busy` niczego nie zabiera, ale dowodu też nie daje', () => {
    const stale: RegistryEvidence = { kind: 'active', at: NOW - REGISTRY_MAX_AGE_MS - 1 };
    expect(kinds(input([dump()], { registry: stale }))).toEqual(['brak:rejestr-nieznany']);
  });

  it('`waiting` z klasą inną niż zgoda (nieznana, pytanie, sieć) nie daje dowodu', () => {
    for (const dialog of ['other', 'input', 'sandbox', 'dialog'] as const) {
      expect(kinds(input([dump()], { registry: { kind: 'waiting', dialog, at: NOW } })), dialog)
        .toEqual(['brak:rejestr-klasa']);
    }
  });
});

describe('dowód „dialog stoi”: licznik kolejki', T, () => {
  const a = dump({ toolName: 'Read', toolInput: { file_path: '/projekt/zewn/a.txt' } });
  const b = dump({ toolName: 'Read', toolInput: { file_path: '/projekt/zewn/b.txt' } });

  it('„1 of 2” przy dwóch żywych zrzutach: oba stoją', () => {
    expect(kinds(input([a, b], { queue: queueOnScreen(readDialog('1 of 2')) }))).toEqual(['stoi', 'stoi']);
  });

  it('„2 of 2” (stoi jedna) przy dwóch żywych zrzutach: nie wiadomo, który jest sierotą — oba bez dowodu', () => {
    expect(kinds(input([a, b], { queue: queueOnScreen(readDialog('2 of 2')) })))
      .toEqual(['brak:kolejka', 'brak:kolejka']);
  });

  it('zrzut, któremu dowód zabrał transkrypt, nie liczy się do kolejki', () => {
    // `a` rozstrzygnięty przy biurku: `tool_result` jest, otwarty został tylko `b`.
    const transcript: OpenToolUse[] = [{ toolName: 'Read', input: b.toolInput }];
    expect(kinds(input([a, b], { queue: SINGLE, transcript }))).toEqual(['brak:transkrypt-skrot', 'stoi']);
  });
});

describe('dowód „dialog stoi”: transkrypt', T, () => {
  it('zero otwartych `tool_use` tej nazwy zabiera dowód', () => {
    const d = dump();
    expect(kinds(input([d], { transcript: [] }))).toEqual(['brak:transkrypt-brak']);
    expect(kinds(input([d], { transcript: [{ toolName: 'Write', input: {} }] }))).toEqual(['brak:transkrypt-brak']);
  });

  it('skrót rozróżnia dwa żywe zrzuty tej nazwy: bez odpowiednika traci dowód', () => {
    const x = dump({ toolInput: { command: 'echo x' } });
    const y = dump({ toolInput: { command: 'echo y' } });
    const transcript: OpenToolUse[] = [{ toolName: 'Bash', input: { command: 'echo y' } }];
    expect(kinds(input([x, y], { transcript, queue: { kind: 'unknown' } }))).toEqual(['brak:transkrypt-skrot', 'stoi']);
  });

  it('skrót nieporównywalny (wejście hooka inne niż w transkrypcie, jak plan) niczego nie zabiera', () => {
    const plan = dump({ toolName: 'ExitPlanMode', toolInput: { plan: '# Plan', planFilePath: '/p.md' } });
    const transcript: OpenToolUse[] = [{ toolName: 'ExitPlanMode', input: { plan: '# Plan' } }];
    expect(kinds(input([plan], { transcript }))).toEqual(['stoi']);
  });

  it('sygnały negatywne nigdy nie dają dowodu: komplet negatywów bez rejestru = brak', () => {
    expect(kinds(input([dump()], { registry: { kind: 'unknown', why: 'no-entry' } })))
      .toEqual(['brak:rejestr-nieznany']);
  });
});

describe('dwa identyczne wywołania są jawnie niejednoznaczne', T, () => {
  const same = { command: 'npm test', description: 'Run tests' };

  it('kolejno: pierwsze rozstrzygnięte przy biurku (hook-sierota żyje), drugie stoi', () => {
    const first = dump({ toolInput: same, at: NOW - 30_000 });
    const second = dump({ toolInput: same, at: NOW - 3_000 });
    const transcript: OpenToolUse[] = [{ toolName: 'Bash', input: same }];
    const inp = input([first, second], { transcript, queue: SINGLE });
    expect(kinds(inp)).toEqual(['niejednoznaczny', 'niejednoznaczny']);
    const card = { toolName: 'Bash', callPrint: callPrint('Bash', same) };
    expect(pickShadowTarget(inp.dumps, standingProofs(inp), card))
      .toEqual({ kind: 'ambiguous', keys: [first.key, second.key] });
  });

  it('równolegle: oba w kolejce („1 of 2”), oba otwarte w transkrypcie', () => {
    const one = dump({ toolInput: same });
    const two = dump({ toolInput: same });
    const transcript: OpenToolUse[] = [{ toolName: 'Bash', input: same }, { toolName: 'Bash', input: same }];
    const inp = input([one, two], { transcript, queue: { kind: 'counter', index: 1, total: 2, standing: 2 } });
    expect(kinds(inp)).toEqual(['niejednoznaczny', 'niejednoznaczny']);
    expect(pickShadowTarget(inp.dumps, standingProofs(inp), { toolName: 'Bash', callPrint: null }).kind)
      .toBe('ambiguous');
  });

  it('bliźniak z martwym hookiem nie robi niejednoznaczności', () => {
    const dead = dump({ toolInput: same });
    const live = dump({ toolInput: same });
    const inp = input([dead, live], { alive: new Map([[dead.key, false], [live.key, true]]) });
    expect(kinds(inp)).toEqual(['brak:hook-martwy', 'stoi']);
  });
});

describe('wybór zrzutu pod plik cienia', T, () => {
  it('brak zrzutów, brak pasującego, pasujący bez dowodu, dokładnie jeden z dowodem', () => {
    expect(pickShadowTarget([], [], { toolName: 'Bash', callPrint: null })).toEqual({ kind: 'none', why: 'no-dump' });
    const d = dump();
    const ok = input([d]);
    const verdicts = standingProofs(ok);
    expect(pickShadowTarget([d], verdicts, { toolName: 'Edit', callPrint: null }))
      .toEqual({ kind: 'none', why: 'no-match' });
    expect(pickShadowTarget([d], verdicts, { toolName: 'Bash', callPrint: callPrint('Bash', { command: 'inne' }) }))
      .toEqual({ kind: 'none', why: 'no-match' });
    expect(pickShadowTarget([d], verdicts, { toolName: 'Bash', callPrint: callPrint('Bash', d.toolInput) }))
      .toEqual({ kind: 'one', dump: d });
    // Karta z samego ekranu: dopasowanie po nazwie.
    expect(pickShadowTarget([d], verdicts, { toolName: 'Bash', callPrint: null })).toEqual({ kind: 'one', dump: d });
    const dead = input([d], { alive: new Map([[d.key, false]]) });
    expect(pickShadowTarget([d], standingProofs(dead), { toolName: 'Bash', callPrint: null }))
      .toEqual({ kind: 'none', why: 'no-proof', detail: 'hook-martwy' });
  });

  it('dwa różne zrzuty z dowodem, karta z odciskiem wskazuje jeden', () => {
    const a = dump({ toolName: 'Read', toolInput: { file_path: '/a' } });
    const b = dump({ toolName: 'Read', toolInput: { file_path: '/b' } });
    const inp = input([a, b], { queue: { kind: 'counter', index: 1, total: 2, standing: 2 } });
    const verdicts = standingProofs(inp);
    expect(pickShadowTarget([a, b], verdicts, { toolName: 'Read', callPrint: callPrint('Read', { file_path: '/b' }) }))
      .toEqual({ kind: 'one', dump: b });
    // Bez odcisku (karta z ekranu) dwa kandydaty to niejednoznaczność, nie zgadywanie.
    expect(pickShadowTarget([a, b], verdicts, { toolName: 'Read', callPrint: null }))
      .toEqual({ kind: 'ambiguous', keys: [a.key, b.key] });
  });
});

describe('otwarte `tool_use` z linii transkryptu', T, () => {
  const assistant = (blocks: unknown[]): string => JSON.stringify({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: blocks },
  });
  const user = (content: unknown): string => JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const use = (id: string, name: string, input: unknown): unknown => ({ type: 'tool_use', id, name, input });

  it('wszystkie niesparowane w kolejności bloków; wynik zamyka swój; wypowiedź człowieka zamyka resztę', () => {
    const lines = [
      assistant([use('t1', 'Read', { file_path: '/a' }), use('t2', 'Read', { file_path: '/b' })]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      assistant([use('t3', 'Bash', { command: 'ls' })]),
    ];
    expect(openToolUses(lines).map((tool) => [tool.id, tool.toolName])).toEqual([['t2', 'Read'], ['t3', 'Bash']]);
    expect(openToolUses([...lines, user('dalej')])).toEqual([]);
  });
});

describe('sieroty: hook czeka na dialog, którego już nie ma', T, () => {
  const INPUT = { command: 'ls -la', description: 'List' };
  const ACTIVE_LATE: RegistryEvidence = { kind: 'active', at: NOW - 500 };
  const orphans = (inp: EvidenceInput): string[] => orphanHooks(inp).map((o) => `${o.key}:${o.why}`);

  it('rejestr `active` odczytany po zrzucie z zapasem: żywy hook to sierota; martwy, „nie wiem” i subagent nie', () => {
    const live = dump();
    const dead = dump({ toolInput: { command: 'pwd' } });
    const unknown = dump({ toolInput: { command: 'id' } });
    const agent = dump({ toolInput: { command: 'date' }, agentId: 'a-1' });
    const inp = input([live, dead, unknown, agent], {
      registry: ACTIVE_LATE,
      alive: new Map([[live.key, true], [dead.key, false], [unknown.key, null], [agent.key, true]]),
    });
    expect(orphans(inp)).toEqual([`${live.key}:rejestr-nie-czeka`]);
  });

  it('rejestr `active` w zapasie po zrzucie albo nieświeży, rejestr nieznany bez transkryptu: nic', () => {
    const d = dump({ at: NOW - 1_000 });
    expect(orphans(input([d], { registry: { kind: 'active', at: NOW - 500 } }))).toEqual([]);
    const old = dump();
    expect(orphans(input([old], { registry: { kind: 'active', at: NOW - REGISTRY_MAX_AGE_MS - 1 } }))).toEqual([]);
    expect(orphans(input([old], { registry: { kind: 'unknown', why: 'unread' }, transcript: null }))).toEqual([]);
    expect(orphans(input([old], { registry: WAITING }))).toEqual([]);
  });

  it('transkrypt bez otwartego `tool_use` tej nazwy: sierota dopiero po zapasie na czytnik transkryptu', () => {
    const old = dump({ at: NOW - ORPHAN_TRANSCRIPT_MIN_AGE_MS });
    const young = dump({ toolName: 'Read', toolInput: { file_path: '/a' }, at: NOW - 1_000 });
    const inp = input([old, young], { registry: { kind: 'unknown', why: 'unread' }, transcript: [] });
    expect(orphans(inp)).toEqual([`${old.key}:transkrypt-brak`]);
  });

  it('kolejka: rejestr dalej `waiting`, sierotą staje się prośba, której narzędzie dało wynik (inny skrót)', () => {
    const first = dump({ toolInput: { command: 'ls a' } });
    const second = dump({ toolInput: { command: 'ls b' } });
    const inp = input([first, second], { transcript: [{ toolName: 'Bash', input: { command: 'ls b' } }] });
    expect(orphans(inp)).toEqual([`${first.key}:transkrypt-skrot`]);
    // Póki oba `tool_use` są otwarte, nikt nie jest sierotą.
    expect(orphans(input([first, second]))).toEqual([]);
  });

  it('bliźniaki: otwartych mniej niż żywych zrzutów — sierotą najstarszy; tyle samo albo zero porównywalnych: nic', () => {
    const older = dump({ at: NOW - 30_000 });
    const newer = dump({ at: NOW - 10_000 });
    const one = [{ toolName: 'Bash', input: INPUT }];
    expect(orphans(input([newer, older], { transcript: one }))).toEqual([`${older.key}:transkrypt-nadmiar`]);
    expect(orphans(input([newer, older], { transcript: [...one, ...one] }))).toEqual([]);
    // Wejście w transkrypcie innej postaci niż w hooku (skróty nieporównywalne): liczba nic nie mówi.
    expect(orphans(input([newer, older], { transcript: [{ toolName: 'Bash', input: { command: 'inne' } }] })))
      .toEqual([]);
  });
});
