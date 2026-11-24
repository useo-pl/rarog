/**
 * Strażnik pracy apki natywnej w tle (`beginBackgroundTask`). Każde zadanie w tle idzie przez protokół
 * `BackgroundWork` (`RarogCore/PushSystem.swift`), a system woła wyłącznie adapter `UIKitBackgroundWork`
 * (`native/Rarog/Rarog/BackgroundWorkUIKit.swift`). Tylko przez adapter apka wie, które prace potrzebują serwera
 * (`needsServer`), więc wywołanie `UIApplication.beginBackgroundTask` z pominięciem adaptera to praca, o której
 * połączenie z serwerem się nie dowie.
 *
 * Drugi blok pilnuje flag `needsServer` w wywołaniach z RarogUI, których testy pakietu nie widzą (kod tylko na iOS):
 * zapis notatki idzie do serwera, kończenie nagrania dyktowania nie (dźwięk płynie prosto do dostawcy mowy).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NATIVE = 'native/Rarog';
const ADAPTER = 'native/Rarog/Rarog/BackgroundWorkUIKit.swift';
const UI = 'native/Rarog/Packages/RarogUI/Sources/RarogUI';

interface Source { file: string; text: string }

/** Kod bez komentarzy (`/* */`, `//`, `///`) — o `beginBackgroundTask` wolno pisać w komentarzu. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

function swiftFiles(dir: string): string[] {
  return readdirSync(path.join(REPO, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name.startsWith('.') || name === 'build' || name === 'DerivedData') return [];
    if (statSync(path.join(REPO, rel)).isDirectory()) return swiftFiles(rel);
    return name.endsWith('.swift') ? [rel] : [];
  });
}

/** Pliki, które wołają API zadań w tle systemu z pominięciem adaptera. */
function violations(sources: Source[]): string[] {
  return sources.filter(({ file, text }) => file !== ADAPTER && /\b(begin|end)BackgroundTask\b/.test(code(text)))
    .map(({ file }) => file);
}

/** Flagi `needsServer` wywołań `beginBackgroundWork("<nazwa>", needsServer: …)` w kolejności w pliku. */
function workCalls(text: string): string[] {
  return [...code(text).matchAll(/beginBackgroundWork\(\s*"([^"]+)"\s*,\s*needsServer:\s*(true|false)\s*\)/g)]
    .map((match) => `${match[1]}: ${match[2]}`);
}

const sources: Source[] = swiftFiles(NATIVE)
  .map((file) => ({ file, text: readFileSync(path.join(REPO, file), 'utf8') }));

describe('praca apki w tle tylko przez adapter BackgroundWork', () => {
  it('beginBackgroundTask i endBackgroundTask stoją tylko w BackgroundWorkUIKit.swift', () => {
    expect(sources.length).toBeGreaterThan(200);
    expect(violations(sources), 'zadanie w tle przez `store.beginBackgroundWork(_:needsServer:)` albo protokół '
      + '`BackgroundWork`, nie `UIApplication.beginBackgroundTask`').toEqual([]);
    const adapter = sources.find(({ file }) => file === ADAPTER)?.text ?? '';
    expect(code(adapter)).toMatch(/UIApplication\.shared\.beginBackgroundTask\(withName:/);
  });

  it('pada na sztucznym wywołaniu w pliku RarogUI; komentarz i adapter przechodzą', () => {
    const planted = `${UI}/Views/Planted.swift`;
    const call = 'let id = UIApplication.shared.beginBackgroundTask(withName: "x") {}';
    expect(violations([{ file: planted, text: call }])).toEqual([planted]);
    expect(violations([{ file: planted, text: 'UIApplication.shared.endBackgroundTask(id)' }])).toEqual([planted]);
    expect(violations([{ file: planted, text: `// ${call}\n/* ${call} */` }])).toEqual([]);
    expect(violations([{ file: ADAPTER, text: call }])).toEqual([]);
  });
});

describe('flagi needsServer w pracach w tle RarogUI', () => {
  const expected: Record<string, string[]> = {
    'Session/Voice/ComposerDictation.swift': ['dyktowanie: false'],
    'Views/Inbox/InboxDictation.swift': ['inbox dictation: false'],
    'Views/Notes/NoteDictation.swift': ['dyktowanie notatki: false', 'notatka: true'],
    'Views/Notes/NoteBackgroundSave.swift': ['notatka: true'],
  };

  for (const [file, calls] of Object.entries(expected)) {
    it(`${file}: ${calls.join(', ')}`, () => {
      const text = sources.find((source) => source.file === `${UI}/${file}`)?.text;
      expect(text, `brak pliku ${UI}/${file}`).toBeDefined();
      expect(workCalls(text ?? '').sort()).toEqual([...calls].sort());
    });
  }

  it('inne pliki RarogUI nie zaczynają pracy w tle bez wpisu powyżej', () => {
    const listed = new Set(Object.keys(expected).map((file) => `${UI}/${file}`));
    const others = sources.filter(({ file, text }) => file.startsWith(`${UI}/`) && !listed.has(file)
      && /\bbeginBackgroundWork\b/.test(code(text))).map(({ file }) => file);
    expect(others).toEqual([]);
  });
});
