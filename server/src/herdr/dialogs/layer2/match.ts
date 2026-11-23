/**
 * Dopasowanie bloku warstwy 2 do kształtu z rejestru (`shapeOf`): jedyny dowód, że blok jest cały i że jego cyfry
 * wolno pokazać jako przyciski. Stopka niczego tu nie dowodzi. Serwer woła ten moduł przez regułę warstwy 2
 * (`verdict.ts`, dowód końca `shape`) i wprost z potwierdzenia „Switch model?” po `/model`
 * (`drivers/herdr/commands.ts`).
 *
 * Reguły (wszystkie muszą przejść, inaczej `null`):
 *
 * - góra bloku rodzaju z `tops` kształtu, a nad nią nie stoi druga kreska;
 * - tytuł dosłownie, ten sam tryb zatwierdzania, żadnej niepustej linii między opcjami, linie pod opcjami dokładnie
 *   jak w kształcie;
 * - treść pasuje do wzorca kształtu w CAŁOŚCI (`bodyText`, linie sklejone spacją, więc zawinięcie treści na granicy
 *   słowa niczego nie zmienia);
 * - opcje: tyle samo linii co par kształtu, w tej samej kolejności. Z surowej linii wolno zdjąć wyłącznie wcięcie
 *   i marker fokusu `❯`; reszta to `N. ` i ogon, który pasuje do wzorca etykiety w CAŁOŚCI. Glif ramki, checkbox,
 *   `↓`, `↑` i każda niezużyta końcówka linii łamią dopasowanie;
 * - para cyfra–etykieta: cyfra z surowej linii równa cyfrze pary kształtu i cyfrze z `optionRegion`, więc zamienione
 *   cyfry przy tych samych etykietach dają brak kształtu;
 * - wartość (grupa `value`) ta sama w treści i w każdej etykiecie, która ją niesie.
 *
 * Przycisk dostaje cyfra z `buttons` kształtu, której etykiety nie blokuje polityka opcji w kanale cyfry
 * (`optionPolicy`, `policy/option-policy.ts`).
 */
import { optionPolicy } from '../policy/option-policy.ts';
import type { OptionBlock } from '../policy/option-policy.ts';
import type { Block } from './read-block.ts';
import { BLOCK_SHAPES, SHAPE_OPTION_LINE } from './shapes.ts';
import type { BlockShape } from './shapes.ts';

/** Para z ekranu w dopasowanym kształcie: cyfra, etykieta (ogon surowej linii) i werdykt przycisku. */
export interface ShapePair {
  readonly digit: string;
  readonly label: string;
  /** Cyfra z `buttons` kształtu, a polityka opcji jej nie blokuje. */
  readonly button: boolean;
  /** Powód blokady z polityki opcji w kanale cyfry; `null` = opcja wolna. */
  readonly why: OptionBlock | null;
}

/** Wynik dopasowania bloku do kształtu. */
export interface ShapeMatch {
  readonly shape: BlockShape;
  /** Wartość z grupy `value` (nazwa modelu); `null`, gdy kształt jej nie przechwytuje. */
  readonly value: string | null;
  /** Wszystkie pary bloku w kolejności ekranu. */
  readonly pairs: readonly ShapePair[];
  /** Cyfry z przyciskiem. */
  readonly buttons: readonly string[];
  /** Zweryfikowana para roli „zatwierdź” (`shape.allow`); `null`, gdy jej cyfra nie ma przycisku. */
  readonly allow: { readonly digit: string; readonly label: string } | null;
}

/** Kształt z rejestru, do którego pasuje blok, albo `null` (blok bez dowodu końca, karta bez przycisków). */
export function shapeOf(block: Block | null): ShapeMatch | null {
  if (block === null) return null;
  for (const shape of BLOCK_SHAPES) {
    const match = matchShape(shape, block);
    if (match !== null) return match;
  }
  return null;
}

/**
 * Kompletność bloku do karty: `shape` przy dopasowaniu kształtu (dowód końca), `footer` przy stopce klawiszowej bez
 * kształtu (tylko informacja: stopka nie mówi, czy lista pokazuje wszystkie opcje), `null` poza tym.
 */
export function completeness(block: Block): 'shape' | 'footer' | null {
  if (shapeOf(block) !== null) return 'shape';
  return block.footer === null ? null : 'footer';
}

/** Dopasowanie bloku do jednego kształtu według reguł z nagłówka modułu. */
export function matchShape(shape: BlockShape, block: Block): ShapeMatch | null {
  if (!shape.tops.includes(block.top.kind) || block.ruleAbove) return null;
  if (block.title !== shape.title || block.submit !== shape.submit) return null;
  if (block.between.length > 0 || !sameLines(block.below, shape.below)) return null;
  const body = whole(shape.body, block.bodyText);
  if (body === null) return null;
  if (block.optionLines.length !== shape.options.length || block.options.length !== shape.options.length) {
    return null;
  }

  const values = [body.groups?.['value']];
  const read: { digit: string; label: string }[] = [];
  for (const [i, expected] of shape.options.entries()) {
    const raw = SHAPE_OPTION_LINE.pattern.exec(block.optionLines[i] ?? '');
    const digit = raw?.[1];
    const label = raw?.[2] ?? '';
    if (digit === undefined || digit !== expected.digit || digit !== block.options[i]?.digit) return null;
    const hit = whole(expected.label, label);
    if (hit === null) return null;
    values.push(hit.groups?.['value']);
    read.push({ digit, label });
  }
  const captured = values.filter((value) => value !== undefined);
  if (new Set(captured).size > 1) return null;

  const pairs = read.map(({ digit, label }): ShapePair => {
    // Kształt przypina etykiety, więc formularza wielokrotnego ani notatki tu nie ma; dialogów tylko z terminala
    // rejestr nie zawiera.
    const policy = optionPolicy({ label, terminalDialog: null, multiSelect: false, notesEditing: false }, 'digit');
    return { digit, label, button: shape.buttons.includes(digit) && !policy.digitBlocked, why: policy.why };
  });
  const allow = pairs.find((pair) => pair.digit === shape.allow && pair.button);
  return {
    shape,
    value: captured[0] ?? null,
    pairs,
    buttons: pairs.filter((pair) => pair.button).map((pair) => pair.digit),
    allow: allow === undefined ? null : { digit: allow.digit, label: allow.label },
  };
}

/** Dopasowanie wzorca do CAŁEGO tekstu (kotwice dokłada ta funkcja, nie rejestr). */
function whole(pattern: RegExp, text: string): RegExpExecArray | null {
  return new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/gu, '')).exec(text);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
