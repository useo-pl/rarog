/**
 * Golden file of the corpus cards with the layer 2 flag on (`RAROG_DIALOG_LAYER2=1`, `docs/dialog-card.md`).
 *
 * For every committed screen the file records what the driver would show over it after two equal reads: today's
 * decision (`decideCard` with the flag), then layer 2 (`judgeLayer2`: today's buttons first, then the gate and rule
 * `layer2Verdict` with the registry class of the screen from the truth manifest `warstwa2-prawda.json`). A verdict with
 * choices replaces today's card with the layer 2 question card. The file carries hashes and metadata only: option
 * labels as in `karty-korpusu-pelne.json`, the block title and the question as hashes.
 *
 * Checks besides the screen by screen comparison: the coverage table of the manifest (layer 2 screens with a decision
 * card and with Esc alone), no screen with fewer buttons than the flag `0` golden file, no consent or form screen with
 * a layer 2 card, and the question of every layer 2 card is the whole block from its title to the footer.
 *
 * `RAROG_FIXTURES_WRITE=1` rewrites `fixtures/herdr/karty-korpusu-warstwa2.json`; without it the test compares.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliDialogClass } from '../../shared/src/protocol.ts';
import { TEMP_DIR } from '../../scripts/lib/private-patterns.mjs';
import { judgeLayer2, LAYER2_ID_PREFIX } from '../src/drivers/herdr/layer2-card.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import { layer2QuestionCard, screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import type { DecisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { blockTitleSha, episodeVerdictOf } from '../src/herdr/dialogs/layer2/card.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { TERMINAL_DIALOGS } from '../src/herdr/dialogs/policy/terminal.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const GOLDEN = join(DIR, 'karty-korpusu-warstwa2.json');
const FLAG0 = join(DIR, 'karty-korpusu-pelne.json');
const MANIFEST = join(DIR, 'warstwa2-prawda.json');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const MARK = '\n--- ekran ---\n';

/** Corpus directories relative to `fixtures/herdr/`, the same as the truth manifest. */
const DIRS = ['', 'measured/', 'refusals/', 'queue/measured/', 'kontrolny/', 'ultracode/'] as const;

const CORPUS = DIRS.flatMap((sub) => readdirSync(join(DIR, sub))
  .filter((name) => name.endsWith('.txt'))
  .map((name) => `${sub}${name}`))
  .sort();

interface ManifestEntry {
  readonly category: 'layer2' | 'consent' | 'form' | 'non-dialog';
  readonly class: CliDialogClass | null;
  readonly today?: 'buttons' | 'unreadable' | 'no-jsonl' | 'terminal-only';
  readonly terminalDialog?: string;
  readonly v2: { readonly kind: 'none' | 'choices'; readonly why?: string };
  readonly v2Confirmed?: { readonly kind: 'none' | 'choices'; readonly why?: string };
}
const manifest = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { screens: Record<string, ManifestEntry> }).screens;

/** `TERMINAL_DIALOGS` entries the code confirms (`keysMeasured`): their screens follow `v2Confirmed`. */
const CONFIRMED: ReadonlySet<string> = new Set(
  TERMINAL_DIALOGS.filter((dialog) => dialog.keysMeasured !== null).map((dialog) => dialog.id),
);

function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** Context of the evaluation, written in the file header; the input below stands exactly on it. */
const CONTEXT = {
  layer2: 1,
  engine: 'claude',
  cliDialogClass: 'class of the screen from warstwa2-prawda.json',
  reads: 'two equal reads of the same screen (stable block)',
  consentChannel: 'off',
  hook: 'none',
  jsonl: 'none',
  input: 'decideCard: blockedSeq 1, answeredSeq -1, active null, decided null, canRetry false, '
    + 'hookAnswersEnabled true, layer2 true; then judgeLayer2; occurrence id l2:000000000000',
} as const;

const OCCURRENCE_ID = `${LAYER2_ID_PREFIX}000000000000`;

function input(text: string): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: evaluationReqId(null, null, null, 1),
    active: null,
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
    layer2: true,
  };
}

type Layer2Kind = 'existing' | 'choices' | 'esc-only' | 'none';

/** Record of one screen. Field order = order in the file. */
interface Shot {
  readonly class: CliDialogClass | null;
  /** Kind of today's action (`decideCard` with the flag). */
  readonly action: DecideAction['kind'];
  /** What layer 2 did: kept today's card with buttons, gave a card (choices, Esc alone) or none. */
  readonly layer2: Layer2Kind | null;
  /** Reason of `none` from the closed list. */
  readonly why: string | null;
  readonly event: string | null;
  readonly reqId: string | null;
  readonly toolName: string | null;
  /** Buttons of the card: today's options with a digit, or the layer 2 choices with what they send. */
  readonly options: readonly Record<string, string | number | boolean>[];
  /** Block title of a layer 2 card (`blockTitleSha`). */
  readonly titleSha: string | null;
  /** Question of a layer 2 card: sha256 and line count. */
  readonly question: { readonly sha256: string; readonly lines: number } | null;
  /** sha256 of the whole card (`active` and the event, sorted keys). */
  readonly card: string | null;
}

const SHOT_KEYS: readonly (keyof Shot)[] = [
  'class', 'action', 'layer2', 'why', 'event', 'reqId', 'toolName', 'options', 'titleSha', 'question', 'card',
];

interface Golden {
  readonly context: typeof CONTEXT;
  readonly summary: Readonly<Record<string, number>>;
  readonly screens: Readonly<Record<string, Shot>>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const goldenLabel = (label: string): string => label.replace(TEMP_DIR, '/var/<folders>/');

/** Today's card the driver would show over the screen at flag `1`; `null` = no card. */
function todayCard(action: DecideAction): DecisionCard | null {
  if (action.kind === 'card') return action.card;
  if (action.kind !== 'screen-dialog') return null;
  return screenDialogCard(
    action.reqId, action.resolved, action.reason, action.screen, null, action.origin, action.layer2 ?? null,
  );
}

function shotOf(name: string): Shot {
  const text = screenOf(name);
  const cliClass = manifest[name]?.class ?? null;
  const action = decideCard(input(text));
  const block = readBlock(text);
  const judged = action.kind === 'card' || action.kind === 'screen-dialog'
    ? judgeLayer2(action, block, { enabled: true, engine: 'claude', cliClass })
    : null;
  const layer2Card = judged?.kind === 'choices' ? layer2QuestionCard(OCCURRENCE_ID, judged.verdict, 1) : null;
  const card = layer2Card ?? todayCard(action);
  const question = layer2Card?.event.type === 'question-request' ? layer2Card.event.questions[0]?.question : undefined;
  return {
    class: cliClass,
    action: action.kind,
    layer2: judged === null ? null : judged.kind === 'choices' ? episodeVerdictOf(judged.verdict) : judged.kind,
    why: judged?.kind === 'none' ? judged.why : null,
    event: card?.event.type ?? null,
    reqId: card?.active.reqId ?? null,
    toolName: card?.active.toolName ?? null,
    options: judged?.kind === 'choices'
      ? judged.verdict.choices.map((choice) => ({ label: goldenLabel(choice.label), ...choice.send }))
      : (card?.active.options ?? []).map((option) => ({
        digit: option.digit,
        label: goldenLabel(option.label),
        ...(option.terminalOnly === true ? { terminalOnly: true } : {}),
      })),
    titleSha: judged?.kind === 'choices' ? blockTitleSha(judged.verdict.title) : null,
    question: question === undefined ? null : { sha256: sha256(question), lines: question.split('\n').length },
    card: card === null ? null : sha256(canonical({ active: card.active, event: card.event })),
  };
}

/** Buttons of a record: layer 2 choices, or today's options without `terminalOnly`. */
const buttonsOf = (shot: { readonly layer2?: Layer2Kind | null; readonly options: readonly object[] }): number => (
  shot.options.filter((option) => !('terminalOnly' in option)).length
);

function produce(): Golden {
  const screens: Record<string, Shot> = {};
  for (const name of CORPUS) screens[name] = shotOf(name);
  const shots = Object.values(screens);
  const count = (kind: Layer2Kind): number => shots.filter((shot) => shot.layer2 === kind).length;
  return {
    context: CONTEXT,
    summary: {
      screens: shots.length,
      cards: shots.filter((shot) => shot.event !== null).length,
      existing: count('existing'),
      choices: count('choices'),
      escOnly: count('esc-only'),
      none: count('none'),
    },
    screens,
  };
}

const produced = produce();
if (WRITE) writeFileSync(GOLDEN, `${JSON.stringify(produced, null, 2)}\n`);
const stored = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
const flag0 = (JSON.parse(readFileSync(FLAG0, 'utf8')) as {
  screens: Record<string, { options: readonly object[] }>;
}).screens;

describe('layer 2 golden file: header and corpus', () => {
  it('context in the header: flag 1, engine claude, class from the manifest, two equal reads', () => {
    expect(stored.context).toEqual(CONTEXT);
  });

  it('the same screens as the truth manifest, in file name order', () => {
    expect(Object.keys(stored.screens)).toEqual([...CORPUS]);
    expect(CORPUS).toEqual(Object.keys(manifest).sort());
  });

  it('the same summary as the golden file', () => {
    expect(produced.summary).toEqual(stored.summary);
  });

  it('a record has the listed fields only: hashes and metadata, no screen text', () => {
    for (const [name, shot] of Object.entries(stored.screens)) expect(Object.keys(shot), name).toEqual(SHOT_KEYS);
  });
});

describe('layer 2 golden file against the truth manifest', () => {
  const layer2Screens = Object.keys(manifest).filter((name) => manifest[name]?.category === 'layer2');

  it('coverage with terminal dialogs: 39 of 55 layer 2 screens with a decision card, 47 with Esc alone', () => {
    expect(layer2Screens).toHaveLength(55);
    const kind = (name: string): Layer2Kind | null => produced.screens[name]?.layer2 ?? null;
    // Today's card with buttons (a known screen dialog, the trust step) counts as a decision card, as in the manifest.
    const decision = layer2Screens.filter((name) => kind(name) === 'choices' || kind(name) === 'existing');
    const escOnly = layer2Screens.filter((name) => kind(name) === 'esc-only');
    expect([decision.length, decision.length + escOnly.length]).toEqual([39, 47]);
    expect(layer2Screens.filter((name) => kind(name) === 'existing'))
      .toEqual(layer2Screens.filter((name) => manifest[name]?.today === 'buttons'));
  });

  it('where today has no buttons, the layer 2 verdict is the manifest verdict (v2Confirmed if confirmed)', () => {
    const differ = layer2Screens.flatMap((name) => {
      const entry = manifest[name];
      const shot = produced.screens[name];
      if (entry === undefined || shot === undefined || shot.layer2 === 'existing') return [];
      const got = shot.layer2 === 'none' ? `none:${shot.why ?? ''}` : 'choices';
      const v2 = entry.v2Confirmed !== undefined && CONFIRMED.has(entry.terminalDialog ?? '')
        ? entry.v2Confirmed : entry.v2;
      const want = v2.kind === 'none' ? `none:${v2.why ?? ''}` : 'choices';
      return got === want ? [] : [`${name}: ${got} != ${want}`];
    });
    expect(differ).toEqual([]);
  });

  it('no screen has fewer buttons than with the flag 0 (golden karty-korpusu-pelne.json)', () => {
    const fewer = Object.entries(flag0).flatMap(([name, shot]) => {
      const now = produced.screens[name];
      return now !== undefined && buttonsOf(now) < buttonsOf(shot) ? [name] : [];
    });
    expect(Object.keys(flag0).length).toBeGreaterThan(200);
    expect(fewer).toEqual([]);
  });

  it('a consent or form screen never gets a layer 2 card (permission and sandbox blocks stay layer 1)', () => {
    const taken = Object.entries(produced.screens)
      .filter(([name, shot]) => manifest[name]?.category !== 'layer2' && shot.toolName?.endsWith(':layer2') === true)
      .map(([name]) => name);
    expect(taken).toEqual([]);
  });

  it('a screen without a registry class gets no layer 2 card (class-unknown)', () => {
    const unknown = Object.entries(produced.screens).filter(([, shot]) => shot.class === null && shot.layer2 !== null
      && shot.layer2 !== 'existing');
    expect(unknown.length).toBeGreaterThan(0);
    for (const [name, shot] of unknown) expect([name, shot.layer2, shot.why]).toEqual([name, 'none', 'class-unknown']);
  });

  it('the question of a layer 2 card is the whole block, from the title line to the footer', () => {
    const cards = Object.entries(produced.screens).filter(([, shot]) => shot.question !== null);
    expect(cards.length).toBeGreaterThan(0);
    for (const [name] of cards) {
      const text = screenOf(name);
      const block = readBlock(text);
      const judged = judgeLayer2(decideOrThrow(text), block, {
        enabled: true, engine: 'claude', cliClass: manifest[name]?.class ?? null,
      });
      if (judged.kind !== 'choices' || block === null) throw new Error(name);
      const card = layer2QuestionCard(OCCURRENCE_ID, judged.verdict, 1);
      const question = card.event.type === 'question-request' ? card.event.questions[0]?.question ?? '' : '';
      const lines = question.split('\n');
      const bottom = block.rows[block.rows.length - 1]?.text ?? '';
      expect(lines[0]?.trim(), name).toBe(block.title);
      expect(lines[lines.length - 1], name).toBe(bottom);
      expect(lines.length, name).toBe(block.rows.filter((row) => row.index >= block.titleLine).length);
    }
  });
});

function decideOrThrow(text: string): Extract<DecideAction, { kind: 'card' | 'screen-dialog' }> {
  const action = decideCard(input(text));
  if (action.kind !== 'card' && action.kind !== 'screen-dialog') throw new Error(action.kind);
  return action;
}

describe('layer 2 golden file: screen by screen (refresh: RAROG_FIXTURES_WRITE=1)', () => {
  it.each(Object.keys(stored.screens))('%s', (name) => {
    expect(produced.screens[name]).toEqual(stored.screens[name]);
  });
});
