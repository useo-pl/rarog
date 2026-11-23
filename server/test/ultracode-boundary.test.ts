/**
 * Granica słów Claude Code o ultracode: literał stoi w JEDNYM module (`herdr/ultracode.ts`, formy komendy
 * w rejestrze komend), a każde słowo ma dowód z wersją i datą.
 *
 * Wzór: `herdr-commands-boundary.test.ts` (strażnik grepowy na kodzie bez komentarzy, `source-scan.ts`). Drugi
 * czytnik znacznika albo drugi zapis nazwy załącznika zaczyna się od przepisania literału w cudzym pliku. Łańcuch
 * dowodu: stała w kodzie = wartość w pliku dowodu `EVIDENCE.ultracode` = słowo w wycinku z pomiaru.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVIDENCE, ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';
import {
  ULTRACODE_ATTACHMENTS, ULTRACODE_FLAG_VALUE, ULTRACODE_MIN_CLI, ULTRACODE_REFUSAL, ULTRACODE_RESULT,
} from '../src/herdr/ultracode.ts';
import { scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const FIXTURES = join(REPO, 'server/test/fixtures/herdr');
const MODULE = 'server/src/herdr/ultracode.ts';
const REGISTRY = 'server/src/herdr/commands/registry.ts';

const read = (file: string): string => readFileSync(file, 'utf8');
/** Kod (bez komentarzy) każdego pliku `server/src/**`, pod ścieżką względem korzenia repo. */
const CODE = new Map(tsFiles(SRC).map((file) => [relative(REPO, file), scan(read(file)).code]));

interface Evidence {
  readonly cli: string;
  readonly fixtures: readonly string[];
  readonly docs: {
    readonly source: string;
    readonly fetched: string;
    readonly commands: { readonly on: string; readonly off: string };
    readonly flagValue: string;
    readonly flagEffort: string;
    readonly flagSince: string;
    readonly offFormSince: string;
  };
  readonly observed: {
    readonly commandArgs: { readonly on: string; readonly off: string };
    readonly attachments: { readonly enter: string; readonly exit: string };
    readonly reminderTypes: readonly string[];
    readonly stdout: { readonly on: string; readonly off: string; readonly unavailable: string };
  };
}

const evidence = JSON.parse(read(join(FIXTURES, 'commands', EVIDENCE.ultracode.file))) as Evidence;

describe('ultracode: literał stoi w jednym module', () => {
  const quoted = (text: string): string[] => [`'${text}'`, `"${text}"`];
  /** Słowa CLI o ultracode jako fragmenty kodu. Formy komendy pilnuje strażnik rejestru komend. */
  const GUARDED: readonly { name: string; needles: readonly string[] }[] = [
    { name: 'ULTRACODE_FLAG_VALUE', needles: quoted(ULTRACODE_FLAG_VALUE) },
    { name: 'ULTRACODE_ATTACHMENTS', needles: ['ultra_effort_'] },
    { name: 'ULTRACODE_RESULT.on', needles: [ULTRACODE_RESULT.on] },
    { name: 'ULTRACODE_RESULT.off', needles: [ULTRACODE_RESULT.off] },
    { name: 'ULTRACODE_REFUSAL', needles: [ULTRACODE_REFUSAL] },
    { name: 'ULTRACODE_MIN_CLI', needles: quoted(ULTRACODE_MIN_CLI) },
  ];
  const HOME = [MODULE, REGISTRY];

  it('strażnik widzi literały w module (inaczej zakaz byłby pusty)', () => {
    const code = CODE.get(MODULE) ?? '';
    for (const { name, needles } of GUARDED) {
      expect(needles.some((needle) => code.includes(needle)), `${name} nie stoi w ${MODULE}`).toBe(true);
    }
  });

  it('żaden inny plik `server/src/**` nie powtarza słowa CLI o ultracode', () => {
    const repeated: string[] = [];
    for (const [file, code] of CODE) {
      if (HOME.includes(file)) continue;
      for (const { name, needles } of GUARDED) {
        const hit = needles.find((needle) => code.includes(needle));
        if (hit !== undefined) repeated.push(`${file}: ${name} (${hit})`);
      }
    }
    expect(repeated, `słowo CLI o ultracode poza ${MODULE} — weź je stamtąd`).toEqual([]);
  });
});

describe('ultracode: każde słowo ma dowód z wersją i datą', () => {
  const fixtureText = new Map(evidence.fixtures.map((name) => [name, read(join(FIXTURES, name))]));
  const anywhere = (needle: string): boolean => [...fixtureText.values()].some((text) => text.includes(needle));

  it('metadane pliku dowodu zgadzają się z `EVIDENCE.ultracode`', () => {
    expect(evidence.cli).toBe(EVIDENCE.ultracode.cli);
    expect([evidence.docs.source, evidence.docs.fetched])
      .toEqual([EVIDENCE.ultracode.source, EVIDENCE.ultracode.fetched]);
    expect(EVIDENCE.ultracode.file).toBe(`measured/ultracode-${EVIDENCE.ultracode.cli}.json`);
  });

  it('stałe kodu = wartości pliku dowodu (docs: formy komendy, flaga, wersja; pomiar: załączniki, wynik)', () => {
    expect(ULTRACODE_COMMANDS).toEqual(evidence.docs.commands);
    expect(ULTRACODE_FLAG_VALUE).toBe(evidence.docs.flagValue);
    expect(ULTRACODE_MIN_CLI).toBe(evidence.docs.offFormSince);
    expect(ULTRACODE_ATTACHMENTS).toEqual(evidence.observed.attachments);
    expect(evidence.observed.stdout.on.startsWith(ULTRACODE_RESULT.on)).toBe(true);
    expect(evidence.observed.stdout.off.startsWith(ULTRACODE_RESULT.off)).toBe(true);
    // Odmowa przy niedostępnym ultracode zaczyna się tym samym słowem, ale żadnym z prefiksów wyniku.
    for (const prefix of Object.values(ULTRACODE_RESULT)) {
      expect(evidence.observed.stdout.unavailable.startsWith(prefix)).toBe(false);
    }
    // Sygnatura odmowy to początek zmierzonego zdania odmowy, nie żadnego z wyników.
    expect(evidence.observed.stdout.unavailable.startsWith(ULTRACODE_REFUSAL)).toBe(true);
    expect(evidence.observed.stdout.on.startsWith(ULTRACODE_REFUSAL)).toBe(false);
    expect(evidence.observed.stdout.off.startsWith(ULTRACODE_REFUSAL)).toBe(false);
    // Forma komendy = komenda i argumenty, które CLI zapisało w pliku rozmowy.
    expect(ULTRACODE_COMMANDS.on).toBe(`/effort ${evidence.observed.commandArgs.on}`);
    expect(ULTRACODE_COMMANDS.off).toBe(`/effort ${evidence.observed.commandArgs.off}`);
  });

  it('każde słowo z pomiaru stoi w wycinku z listy `fixtures`', () => {
    const { attachments, commandArgs, reminderTypes, stdout } = evidence.observed;
    const needles = [
      ...Object.values(attachments).map((type) => `"type":"${type}"`),
      ...reminderTypes.map((type) => `"reminderType":"${type}"`),
      ...Object.values(commandArgs).map((args) => `<command-args>${args}</command-args>`),
      ...Object.values(stdout).map((text) => `<local-command-stdout>${text}</local-command-stdout>`),
    ];
    for (const needle of needles) expect(anywhere(needle), needle).toBe(true);
  });

  it('lista `fixtures` = wszystkie wycinki `ultracode/*.jsonl`, z wersji dowodu, z jednego pomiaru', () => {
    const files = readdirSync(join(FIXTURES, 'ultracode')).filter((name) => name.endsWith('.jsonl'))
      .map((name) => `ultracode/${name}`).sort();
    expect([...evidence.fixtures].sort()).toEqual(files);
    const provenance = JSON.parse(read(join(FIXTURES, 'provenance.json'))) as {
      files: Record<string, { source: string; cli: string | null }>;
    };
    for (const name of evidence.fixtures) expect(provenance.files[name]?.cli, name).toBe(EVIDENCE.ultracode.cli);
    // Jeden przebieg jednego pomiaru: wycinek złożony ręcznie albo z innego pomiaru nie jest dowodem tej wersji.
    const sources = new Set(evidence.fixtures.map((name) => provenance.files[name]?.source));
    expect([...sources]).toEqual(['pomiar:ultracode']);
  });
});
