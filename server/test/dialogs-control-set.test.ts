/**
 * Zestaw kontrolny bloków dialogu (`fixtures/herdr/kontrolny/manifest.json`).
 *
 * Manifest wymienia kształty bloków, które silnik warstwy 2 zna z pomiaru: plik zrzutu, wersję CLI, oczekiwany blok
 * (góra, tytuł, opcje z cyframi, stopka, czy cały blok stoi na ekranie), dzisiejszą kartę i werdykt polityki
 * przycisków. Dialog spoza zestawu dostaje kartę bez przycisków. Kształt, który w pomiarze nie stanął, stoi w liście
 * `missing` z powodem. Opis pól: README fixture'ów, sekcja `kontrolny/`.
 *
 * Test pilnuje, że manifest mówi prawdę o plikach: plik istnieje, wersja zgadza się z nazwą i z `provenance.json`,
 * tytuł, opcje i stopka stoją na ekranie, `today` to karta z dzisiejszego kodu, a werdykt polityki zgadza się z jej
 * przyciskami. Klasa rejestru CLI z pomiaru (`waitingFor`) ma wartość z zamkniętej listy czytnika rejestru, zrzut
 * najnowszej wersji CLI w `kontrolny/` ją ma, a kształt z przyciskami nie ma klasy zgody (`permission`, `sandbox`)
 * poza zmierzonym dialogiem zgody (tam tylko cyfra „Yes” pod klasą tego kształtu). Zrzuty przechodzą wzorce
 * strukturalne i skan prywatnych literałów.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPrivateHits } from '../../scripts/lib/private-literals.mjs';
import { structuralHits } from '../../scripts/lib/private-patterns.mjs';
import { CLI_STATUS_WAITING, compareCliVersions, parseCliRegistryFile } from '../src/cli-version.ts';
import { BLOCK_CARD_VERDICTS, blockCardRecord, screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import type { ActiveReq, BlockCardVerdict } from '../src/herdr/dialogs/cards/build.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import { measuredConsentOf } from '../src/herdr/dialogs/policy/measured-consent.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';
import { describePrivate, privateContext } from './private-guard.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const SET = 'kontrolny';
const MARK = '\n--- ekran ---\n';
const INPUT = '.input.json';

interface Option { readonly digit: string; readonly label: string }
interface Shape {
  readonly id: string;
  readonly file: string;
  readonly cli: string;
  readonly columns: number;
  readonly billing: 'api-key' | 'plan';
  /**
   * Klasa rejestru procesów CLI w chwili zrzutu: `status` i `waitingFor` (`value`) pliku `<pid>.json` sesji; `status`
   * `null`, gdy rejestr nie miał wpisu sesji. Całe pole `null`: zrzut sprzed pomiaru klasy.
   */
  readonly waitingFor: { readonly status: string | null; readonly value: string | null } | null;
  readonly block: {
    readonly top: 'bare-rule' | 'status-rule';
    readonly title: string;
    readonly options: readonly Option[];
    readonly footer: string | null;
    readonly complete: boolean;
  };
  readonly today: {
    readonly event: string;
    readonly reason: string | null;
    readonly knownDialog: string | null;
    readonly buttons: readonly string[];
    readonly bodyPrint: string | null;
  };
  readonly policy: { readonly verdict: BlockCardVerdict; readonly buttons: readonly string[]; readonly why: string };
}
interface Missing { readonly id: string; readonly title: string; readonly cli: string; readonly nearest: string;
  readonly why: string }

const manifest = JSON.parse(readFileSync(join(DIR, SET, 'manifest.json'), 'utf8')) as {
  version: number; shapes: Shape[]; missing: Missing[];
};
const provenance = JSON.parse(readFileSync(join(DIR, 'provenance.json'), 'utf8')) as {
  files: Record<string, { cli: string | null }>;
};

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek `klucz: wartość`. */
function screenOf(file: string): string {
  const raw = readFileSync(join(DIR, file), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** Wejście decyzji bez jsonl i bez hooka, jak w driverze po ponowionym odczycie (wzór: test pliku złotego). */
function input(text: string): DecideInput {
  return {
    pending: null, hookPending: null, text, reqId: evaluationReqId(null, null, null, 1), active: null, blockedSeq: 1,
    answeredSeq: -1, hookAnswersEnabled: true, deadAnswerKey: null, canRetry: false, answeredHookCall: null,
    decided: null, resolve: resolveOptions, excerpt: (value: string) => snippet(value)?.text ?? null, hookRaw: null,
  };
}

/** Karta, jaką driver wystawiłby nad ekranem bez jsonl i bez hooka. */
function cardOf(text: string): { active: ActiveReq; event: string; reason: string | null; knownDialog: string | null } {
  const action = decideCard(input(text));
  if (action.kind === 'card') {
    return { active: action.card.active, event: action.card.event.type, reason: null, knownDialog: null };
  }
  if (action.kind !== 'screen-dialog') throw new Error(`ocena bez karty: ${action.kind}`);
  const card = screenDialogCard(action.reqId, action.resolved, action.reason, action.screen, null, action.origin);
  return { active: card.active, event: card.event.type, reason: action.reason, knownDialog: card.knownDialog };
}

/** Werdykt z przycisków wobec opcji bloku: ta sama reguła co `blockCardRecord`. */
const verdictOf = (buttons: number, options: number): BlockCardVerdict =>
  buttons === 0 ? 'no-buttons' : (buttons === options ? 'buttons' : 'partial');

const versionOf = (file: string): string | null => /-(\d+\.\d+\.\d+)(?=[.-])/.exec(file)?.[1] ?? null;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BARE_RULE = /^(?:─{8,}|▔{8,})$/;
const STATUS_RULE = /^▔{8,} [^▔]+ ▔+$/;

describe('zestaw kontrolny: manifest', () => {
  it('schemat: wersja, niepuste listy, unikalne identyfikatory i pliki', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.shapes.length).toBeGreaterThan(0);
    const ids = [...manifest.shapes.map((shape) => shape.id), ...manifest.missing.map((entry) => entry.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const files = manifest.shapes.map((shape) => shape.file);
    expect(new Set(files).size).toBe(files.length);
    for (const shape of manifest.shapes) {
      expect(shape.cli, shape.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Number.isInteger(shape.columns) && shape.columns > 0, shape.id).toBe(true);
      expect(['api-key', 'plan'], shape.id).toContain(shape.billing);
      expect(['bare-rule', 'status-rule'], shape.id).toContain(shape.block.top);
      expect(shape.block.title.length, shape.id).toBeGreaterThan(0);
      expect(shape.block.options.map((option) => option.digit), shape.id)
        .toEqual(shape.block.options.map((_, index) => String(index + 1)));
      expect(BLOCK_CARD_VERDICTS, shape.id).toContain(shape.policy.verdict);
      expect(shape.policy.why.length, shape.id).toBeGreaterThan(0);
      expect(shape.today.bodyPrint === null || /^[0-9a-f]{16}$/.test(shape.today.bodyPrint), shape.id).toBe(true);
    }
    for (const entry of manifest.missing) {
      expect(entry.cli, entry.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.title.length * entry.why.length, entry.id).toBeGreaterThan(0);
      expect(() => readFileSync(join(DIR, entry.nearest)), entry.id).not.toThrow();
    }
  });

  it('każdy plik katalogu `kontrolny/` stoi w manifeście, każdy plik manifestu istnieje', () => {
    const own = readdirSync(join(DIR, SET)).filter((name) => name !== 'manifest.json').map((name) => `${SET}/${name}`);
    const listed = manifest.shapes.map((shape) => shape.file);
    // The exact tool input of a capture (`<capture>.input.json`) stands next to a listed capture.
    const input = (file: string): string | null => (file.endsWith(INPUT) ? file.replace(INPUT, '.txt') : null);
    expect(own.filter((file) => !listed.includes(input(file) ?? file)), 'plik bez wpisu').toEqual([]);
    for (const file of listed) expect(() => readFileSync(join(DIR, file)), file).not.toThrow();
  });

  it.each(manifest.shapes.map((shape) => [shape.id, shape] as const))(
    '%s: klasa rejestru CLI z zamkniętej listy czytnika; kształt z przyciskami bez klasy zgody', (_, shape) => {
      expect(Object.hasOwn(shape, 'waitingFor'), 'pole `waitingFor` (null = sprzed pomiaru)').toBe(true);
      if (shape.waitingFor === null) return;
      const { status, value } = shape.waitingFor;
      if (status === null) {
        expect(value, 'bez wpisu rejestru nie ma klasy').toBeNull();
        return;
      }
      // Ten sam czytnik co serwer: plik rejestru z tymi polami daje wpis, a znana klasa nie trafia do `onUnknownClass`.
      const unknown: string[] = [];
      const parsed = parseCliRegistryFile(1, JSON.stringify({
        pid: 1, sessionId: '00000000-0000-4000-9000-000000000001', version: shape.cli, status,
        ...(value === null ? {} : { waitingFor: value }),
      }), (raw) => unknown.push(raw));
      expect(parsed, 'wpis rejestru').not.toBeNull();
      expect(unknown, 'klasa spoza zamkniętej listy').toEqual([]);
      if (value !== null) expect(status, 'klasa tylko przy dialogu').toBe(CLI_STATUS_WAITING);
      const cliClass = parsed?.[1].waitingFor;
      // Exception: a measured consent dialog has only its "Yes" digit, under its own class.
      const measured = measuredConsentOf(screenOf(shape.file));
      if (measured !== null) {
        expect(shape.policy.buttons, 'N4: only the "Yes" digit').toEqual([measured.allow]);
        expect(cliClass, 'N4: the class of the measured shape').toBe(measured.cliDialog);
      } else if (shape.policy.verdict !== 'no-buttons') {
        expect(['permission', 'sandbox']).not.toContain(cliClass);
      }
    });

  it('zrzut najnowszej wersji CLI w `kontrolny/` ma zmierzoną klasę rejestru', () => {
    const own = manifest.shapes.filter((shape) => shape.file.startsWith(`${SET}/`));
    const newest = own.map((shape) => shape.cli).sort(compareCliVersions).at(-1);
    const latest = own.filter((shape) => shape.cli === newest);
    expect(latest.length).toBeGreaterThan(0);
    expect(latest.filter((shape) => shape.waitingFor === null).map((shape) => shape.id)).toEqual([]);
  });

  it.each(manifest.shapes.map((shape) => [shape.id, shape] as const))(
    '%s: wersja CLI z nazwy i z `provenance.json`, szerokość panelu', (_, shape) => {
      expect(versionOf(shape.file)).toBe(shape.cli);
      expect(provenance.files[shape.file]?.cli).toBe(shape.cli);
      const widest = Math.max(...screenOf(shape.file).split('\n').map((line) => [...line].length));
      expect(widest).toBeLessThanOrEqual(shape.columns);
    });
});

describe('zestaw kontrolny: oczekiwany blok stoi na ekranie', () => {
  it.each(manifest.shapes.map((shape) => [shape.id, shape] as const))('%s', (_, shape) => {
    const lines = screenOf(shape.file).split('\n').map((line) => line.trimEnd());
    const title = lines.findLastIndex((line) => line.trim() === shape.block.title);
    if (!shape.block.complete && title === -1) {
      // The top of the block (rule and title) is above the pane edge: only the part under it stands on screen.
      expect(shape.block.options, 'a cut block lists no digit options').toEqual([]);
      expect(lines.some((line) => line.trim() === shape.block.footer), 'stopka').toBe(true);
      return;
    }
    expect(title, 'tytuł').toBeGreaterThan(0);
    const rule = lines.slice(0, title).findLastIndex((line) => BARE_RULE.test(line.trim())
      || STATUS_RULE.test(line.trim()));
    expect(rule, 'kreska nad tytułem').toBeGreaterThanOrEqual(0);
    expect(STATUS_RULE.test((lines[rule] ?? '').trim()) ? 'status-rule' : 'bare-rule', 'góra bloku')
      .toBe(shape.block.top);
    let at = title;
    for (const option of shape.block.options) {
      const pattern = new RegExp(`^\\s*(?:❯\\s+)?${option.digit}\\.\\s+${escape(option.label)}(?:\\s|$)`);
      const found = lines.findIndex((line, index) => index > at && pattern.test(line));
      expect(found, `opcja ${option.digit}`).toBeGreaterThan(at);
      at = found;
    }
    if (shape.block.footer !== null) {
      const footer = lines.findIndex((line, index) => index > at && line.trim() === shape.block.footer);
      expect(footer, 'stopka pod ostatnią opcją').toBeGreaterThan(at);
    }
  });
});

describe('zestaw kontrolny: dzisiejsza karta i werdykt polityki', () => {
  it.each(manifest.shapes.map((shape) => [shape.id, shape] as const))(
    '%s: `today` to karta z kodu bez jsonl i bez hooka', (_, shape) => {
      const card = cardOf(screenOf(shape.file));
      const buttons = card.active.options.filter((option) => option.terminalOnly !== true)
        .map((option) => option.digit);
      expect({
        event: card.event, reason: card.reason, knownDialog: card.knownDialog, buttons,
        bodyPrint: card.active.bodyPrint ?? null,
      }).toEqual(shape.today);
      // Wpis `block-card` dziennika liczy werdykt tą samą regułą z opcji karty.
      expect(blockCardRecord(card.active)?.verdict).toBe(verdictOf(buttons.length, card.active.options.length));
    });

  it.each(manifest.shapes.map((shape) => [shape.id, shape] as const))(
    '%s: werdykt polityki zgadza się z przyciskami i z kompletnością bloku', (_, shape) => {
      const digits = shape.block.options.map((option) => option.digit);
      for (const digit of shape.policy.buttons) expect(digits).toContain(digit);
      expect(shape.policy.verdict).toBe(verdictOf(shape.policy.buttons.length, digits.length));
      if (!shape.block.complete) expect(shape.policy.buttons).toEqual([]);
    });
});

describe('zestaw kontrolny: prywatność zrzutów', () => {
  const inputs = readdirSync(join(DIR, SET)).filter((name) => name.endsWith(INPUT)).map((name) => `${SET}/${name}`);
  const files = [`${SET}/manifest.json`, ...manifest.shapes.map((shape) => shape.file), ...inputs];

  it.each(files)('%s: bez trafień wzorców strukturalnych', (file) => {
    expect(structuralHits(readFileSync(join(DIR, file), 'utf8'), `server/test/fixtures/herdr/${file}`)).toEqual([]);
  });

  describePrivate('zestaw kontrolny: prywatne literały', privateContext(), (literals) => {
    it.each(files)('%s: zero trafień', (file) => {
      expect(findPrivateHits(readFileSync(join(DIR, file), 'utf8'), literals, file)).toEqual([]);
    });
  });
});
