/**
 * Strażnik znaczników pytania: apka podświetla pytanie do użytkownika po znacznikach
 * `MarkdownQuestion.markers` w RarogUI, a model zna ich format wyłącznie z tekstu hooka `SessionStart`
 * (`scripts/hooks/rarog-context.mjs`, `CONTEXT_TEXT`). Znacznik dopisany w apce bez hooka (albo odwrotnie) dałby
 * pytania, których model nie umie napisać, albo instrukcję, której apka nie podświetla.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MARKERS_SOURCE = new URL(
  '../../native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownQuestion.swift', import.meta.url,
);
const HOOK_SOURCE = new URL('../../scripts/hooks/rarog-context.mjs', import.meta.url);

/** Bez komentarzy `//` (Swift i JS): literał w komentarzu nie jest ani listą, ani tekstem dla modelu. */
function withoutLineComments(source: string): string {
  return source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

/** Literały z `static let markers = [...]` w pliku Swift. */
function appMarkers(source: string): string[] {
  const lists = [...withoutLineComments(source).matchAll(/static\s+let\s+markers\s*=\s*\[([^\]]*)\]/g)];
  if (lists.length !== 1) throw new Error(`oczekiwana jedna lista znaczników, jest ${String(lists.length)}`);
  return [...(lists[0]?.[1] ?? '').matchAll(/"([^"\\]*)"/g)].map((match) => match[1] ?? '');
}

/** Tekst `CONTEXT_TEXT` hooka: sklejone literały `'…'` z deklaracji stałej. */
function hookContextText(source: string): string {
  const declaration = /const\s+CONTEXT_TEXT\s*=([\s\S]*?);/.exec(withoutLineComments(source));
  if (declaration === null) throw new Error('brak `const CONTEXT_TEXT` w hooku');
  return [...(declaration[1] ?? '').matchAll(/'([^'\\]*)'/g)].map((match) => match[1] ?? '').join('');
}

describe('znaczniki pytania: lista apki ↔ tekst hooka kontekstu', () => {
  const markers = appMarkers(readFileSync(MARKERS_SOURCE, 'utf8'));
  const text = hookContextText(readFileSync(HOOK_SOURCE, 'utf8'));

  it('apka zna oba znaczniki, polski i angielski', () => {
    expect(markers).toEqual(expect.arrayContaining(['Do Ciebie:', 'To you:']));
  });

  it('każdy znacznik apki stoi w tekście hooka pogrubiony, tak jak go podświetla renderer', () => {
    for (const marker of markers) expect(text).toContain(`**${marker}**`);
  });

  it('hook nie podaje modelowi znacznika, którego apka nie zna', () => {
    const inHook = [...text.matchAll(/\*\*([^*]+:)\*\*/g)].map((match) => match[1] ?? '');
    expect(inHook.length).toBeGreaterThan(0);
    expect(inHook.filter((marker) => !markers.includes(marker))).toEqual([]);
  });

  it('parsery: komentarz się nie liczy, literały stałej sklejają się w jeden tekst', () => {
    expect(appMarkers('// static let markers = ["X:"]\n  public static let markers = ["A:", "B:"]')).toEqual(['A:', 'B:']);
    expect(() => appMarkers('let other = ["A:"]')).toThrow();
    expect(hookContextText("// const CONTEXT_TEXT = 'zły';\nconst CONTEXT_TEXT = 'a **A:**'\n  + ' b';")).toBe('a **A:** b');
  });
});
