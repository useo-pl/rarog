/**
 * Strażnik czekania na element w XCUITest apki natywnej (`native/Rarog/docs/tests.md`, „Tests”).
 * `XCUIElement.waitForExistence(timeout:)` sprawdza element pierwszy raz dopiero po ≥ 1 s, także gdy element już jest:
 * w pełnej bramce 993 z 1103 czekań kończyło się na tym pierwszym sprawdzeniu, ~15 min na przebieg. Testy czekają więc
 * przez `waitForAppearance(timeout:)` z `DemoServer.swift` (najpierw `exists`, dopiero potem `waitForExistence`). Nowe
 * `waitForExistence` w teście nic nie psuje, tylko po cichu dokłada sekundę, więc pilnujemy tego tutaj: jedno
 * wywołanie, w helperze, zero w testach.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_TESTS = path.join(REPO, 'native/Rarog/RarogUITests');
const HELPER_FILE = 'DemoServer.swift';

/** Kod bez komentarzy (`/* */`, `//`, `///`) — o `waitForExistence` wolno pisać w komentarzu. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

/** Liczba użyć `waitForExistence` w kodzie: samo słowo, bo Swift dopuszcza odstęp przed nawiasem wywołania. */
function waits(text: string): number {
  return text.match(/\bwaitForExistence\b/g)?.length ?? 0;
}

describe('XCUITest czeka na element bez stałej sekundy', () => {
  const sources = readdirSync(UI_TESTS).filter((file) => file.endsWith('.swift'))
    .map((file) => ({ file, text: code(readFileSync(path.join(UI_TESTS, file), 'utf8')) }));

  it('testy wołają waitForAppearance, nie waitForExistence', () => {
    expect(sources.length).toBeGreaterThan(30);
    const outside = sources.filter(({ file, text }) => file !== HELPER_FILE && waits(text) > 0)
      .map(({ file }) => file);
    expect(outside, 'zamiast waitForExistence(timeout:) użyj waitForAppearance(timeout:) z DemoServer.swift — '
      + 'waitForExistence sprawdza element pierwszy raz dopiero po ≥ 1 s').toEqual([]);
  });

  it('liczy wywołanie z odstępem albo komentarzem przed nawiasem, pomija komentarze', () => {
    expect(waits(code('e.waitForExistence (timeout: 5)'))).toBe(1);
    expect(waits(code('e.waitForExistence/* x */(timeout: 5)'))).toBe(1);
    expect(waits(code('/* e.waitForExistence(timeout: 5) */\n// e.waitForExistence(timeout: 5)'))).toBe(0);
  });

  it('jedyne waitForExistence stoi w helperze waitForAppearance', () => {
    const helper = sources.find(({ file }) => file === HELPER_FILE)?.text ?? '';
    expect(waits(helper), 'w DemoServer.swift waitForExistence( tylko w waitForAppearance').toBe(1);
    expect(helper).toMatch(
      /func waitForAppearance\(timeout: TimeInterval\) -> Bool \{\n\s*exists \|\| waitForExistence\(timeout: timeout\)\n\s*\}/);
  });
});
