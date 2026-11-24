/**
 * Bramka na FIXTURE'Y herdr — nie na kod.
 *
 * Fixture'y herdr są wejściem dla testów wielu modułów, których autorzy nie mają jak zauważyć,
 * że plik jest uszkodzony, zanonimizowany za mocno albo że przestał nieść własność,
 * dla której powstał. Ten plik pilnuje dokładnie tych własności — i nic poza nimi.
 *
 * Zasada: każda asercja odpowiada zdaniu z `fixtures/herdr/README.md`. Jeśli któraś padnie,
 * fixture i README rozjechały się, a nie „test jest za ostry".
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPrivateLiterals, maskPath, type PrivateLiterals } from '../../scripts/lib/private-literals.mjs';
import { REPO, describePrivate, isFixture, privateContext, privateCounts, ratchet, ratchetMessage } from './private-guard.ts';
import { SYNTHETIC_LITERALS_FILE } from './synthetic-literals.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');

/** Anonimizator spod `scripts/`: import dynamiczny po ścieżce (moduł nie należy do projektu `server`). */
const ANONYMIZER = pathToFileURL(join(REPO, 'scripts/anonymize-fixture.ts')).href;
const { ANONYMIZER_VERSION, anonymizeText, migratePlaceholders } = await import(ANONYMIZER) as {
  ANONYMIZER_VERSION: number;
  migratePlaceholders: (text: string) => string;
  anonymizeText: (text: string, ctx: {
    tool: string; literals: PrivateLiterals; home: string; roots: readonly string[]; ids: Map<string, string>;
  }) => string;
};

function readLines(name: string): Record<string, unknown>[] {
  return readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Suma zużycia kontekstu: wejście, odczyt i zapis cache'u oraz wyjście z `usage` wpisu asystenta. */
function usageSum(entry: Record<string, unknown>): number {
  const message = entry['message'] as { usage?: Record<string, unknown> } | undefined;
  const usage = message?.usage ?? {};
  return ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
    .reduce((sum, key) => {
      const value = usage[key];
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);
}

/**
 * Prywatne literały (klienci, projekty i infrastruktura właściciela, login w kontekście ścieżki) w KAŻDYM pliku
 * katalogów fixture'ów repo (`fixtures/`, `Fixtures/`: herdr, złote ramki `shared/fixtures/`, fixture'y Swift).
 * Lista literałów żyje w pliku poza repo (`docs/publishing.md`, „Private literals file”); bez niego test się pomija
 * z komunikatem, a `RAROG_REQUIRE_PRIVATE_LITERALS=1` robi z pominięcia porażkę. Reszta repo: ta sama zapadka
 * w `distribution-guard.test.ts`.
 *
 * Zapadka: liczba trafień per plik nie rośnie wobec {@link FIXTURES_BASELINE}, a w bramce publikacji
 * (`RAROG_PUBLISH_GATE=1`) musi być zerem. Fixture spoza tabeli ma bazę 0: nowy zrzut z żywej sesji z nazwą
 * klienta przewraca test, zanim wejdzie commit. Anonimizacja fixture'ów obniża tabelę.
 */
const PRIVATE = privateContext();

/**
 * Baza zapadki: zamaskowana ścieżka → liczba trafień. Ścieżki i liczby
 * nie są prywatne; ścieżka z literałem w nazwie stoi zamaskowana (`‹forbidden[i]›`). Skracać wolno zawsze, podnosić
 * tylko po zmianie pliku literałów (komunikat czerwonego testu podaje gotową tabelę).
 */
const FIXTURES_BASELINE: Readonly<Record<string, number>> = {};

describePrivate('anonimizacja fixture’ów: prywatne literały (zapadka)', PRIVATE, (literals) => {
  const { counts, errors, files } = privateCounts(literals, isFixture);

  it('skan widzi katalogi fixture’ów i czyta każdy plik', () => {
    expect(files).toBeGreaterThan(400);
    expect(errors).toEqual([]);
  });

  it('liczba trafień per plik nie rośnie wobec bazy (w bramce publikacji: zero)', () => {
    const report = ratchet(counts, FIXTURES_BASELINE, PRIVATE.gate);
    expect(report, ratchetMessage('fixture’y', report, counts)).toEqual({ grown: [], stale: [] });
  });
});

/*
 * Pochodzenie fixture'ów: `provenance.json` mówi o każdym pliku, skąd jest (kategoria pomiaru `pomiar:…`,
 * `ręcznie:zrzut|wycinek|rekonstrukcja` albo test, który plik złoty produkuje), z którego dnia i z której wersji CLI,
 * i czy przeszedł końcowy przebieg anonimizatora (`anonymizer`: wersja reguł `scripts/anonymize-fixture.ts`, `null` =
 * sprzed niego). Manifest, nie nagłówek w pliku: nagłówek zmieniałby liczbę wierszy zrzutu ekranu. Opis pól: README
 * fixture'ów, sekcja `provenance.json`.
 */
describe('pochodzenie fixture’ów (`provenance.json`)', () => {
  interface Provenance { source: string; date: string; cli: string | null; anonymizer: number | null }
  const manifest = JSON.parse(readFileSync(join(DIR, 'provenance.json'), 'utf8')) as {
    version: number; files: Record<string, Provenance>;
  };
  const files = (readdirSync(DIR, { recursive: true }) as string[])
    .filter((name) => statSync(join(DIR, name)).isFile())
    // Manifest zestawu kontrolnego opisuje zrzuty obok, sam zrzutem nie jest (test `dialogi-zestaw-kontrolny-*`).
    .filter((name) => !['README.md', 'provenance.json', 'kontrolny/manifest.json'].includes(name)
      && !basename(name).startsWith('.'))
    .sort();
  const versionOf = (name: string): string | null => /(?:^|[-/])(\d+\.\d+\.\d+)(?=[./-])/.exec(name)?.[1] ?? null;
  /*
   * Kategorie pomiaru (`source`: `pomiar:<kategoria>`): zamknięta lista rodzajów pomiaru, bez nazw narzędzi.
   * Każda kategoria ma co najmniej jeden plik. Plik z nowego rodzaju pomiaru: nowa kategoria na tej liście.
   */
  const KATEGORIE_POMIARU: readonly string[] = ['artefakty', 'blokada-promptu', 'dialogi', 'katalog-komend', 'kolejka',
    'komendy-na-żywo', 'komendy-z-docs', 'schemat-api', 'ultracode', 'zabranie-kolejki', 'zadania-w-tle',
    'zestaw-kontrolny', 'zgody', 'zgody-bez-hooka'];
  const kategoriaPomiaru = (source: string): string | null => /^pomiar:(.+)$/u.exec(source)?.[1] ?? null;

  /*
   * Nazwa pliku z prywatnym literałem stoi w manifeście zamaskowana (`‹forbidden[i]›`, jak w bazie zapadki): wpis
   * nie może powielić literału. Bez pliku literałów taki klucz pasuje jako wzorzec do dokładnie jednego pliku.
   */
  const keyOf = (name: string): string => (PRIVATE.literals === null ? name : maskPath(name, PRIVATE.literals));
  const wildcard = (key: string): RegExp => new RegExp(`^${key.split(/‹[^›]+›/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
  const entryOf = (name: string): Provenance | undefined => manifest.files[keyOf(name)]
    ?? (PRIVATE.literals === null ? Object.entries(manifest.files)
      .find(([key]) => key.includes('‹') && wildcard(key).test(name))?.[1] : undefined);

  it('każdy plik ma wpis i każdy wpis ma plik', () => {
    const missing = files.filter((name) => entryOf(name) === undefined);
    const entry = (name: string): string => JSON.stringify({ source: '<pomiar:… albo ręcznie:…>',
      date: new Date().toISOString().slice(0, 10), cli: versionOf(name), anonymizer: ANONYMIZER_VERSION });
    const hint = missing.map((name) => `    ${JSON.stringify(keyOf(name))}: ${entry(name)}`).join(',\n');
    expect(missing.map(keyOf), `dopisz do provenance.json:\n${hint}`).toEqual([]);
    const orphans = Object.keys(manifest.files).filter((key) => !files.some((name) => keyOf(name) === key
      || (PRIVATE.literals === null && key.includes('‹') && wildcard(key).test(name))));
    expect(orphans, 'wpis bez pliku').toEqual([]);
  });

  it('wpis: źródło z zamkniętej listy, data, wersja CLI zgodna z nazwą pliku, wersja anonimizatora', () => {
    expect(manifest.version).toBe(1);
    for (const [name, entry] of Object.entries(manifest.files)) {
      // Wersja z nazwy: zamaskowany fragment nie niesie cyfr wersji, więc wzorzec działa także na kluczu.
      const manual = /^ręcznie:(?:zrzut|wycinek|rekonstrukcja)$/.test(entry.source);
      // Plik złoty z wyniku kodu na korpusie: źródłem jest test, który go pisze (`RAROG_FIXTURES_WRITE=1`).
      const producer = /^server\/test\/[\w.-]+\.test\.ts$/.test(entry.source) && existsSync(join(REPO, entry.source));
      const measured = KATEGORIE_POMIARU.includes(kategoriaPomiaru(entry.source) ?? '');
      expect(measured || manual || producer, `${name}: źródło ${entry.source}`).toBe(true);
      expect(entry.date, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (entry.cli !== null) expect(entry.cli, name).toMatch(/^\d+\.\d+\.\d+$/);
      if (versionOf(name) !== null) expect(entry.cli, name).toBe(versionOf(name));
      expect(entry.anonymizer === null || (Number.isInteger(entry.anonymizer) && entry.anonymizer >= 1
        && entry.anonymizer <= ANONYMIZER_VERSION), name).toBe(true);
    }
  });

  it('każda kategoria pomiaru z listy ma plik (lista bez martwych wpisów)', () => {
    const used = new Set(Object.values(manifest.files).map((entry) => kategoriaPomiaru(entry.source)));
    expect(KATEGORIE_POMIARU.filter((kategoria) => !used.has(kategoria)), 'kategoria bez pliku: usuń ją z listy')
      .toEqual([]);
  });

  it('plik po anonimizatorze jest punktem stałym jego reguł (bez pliku literałów i ścieżek tej maszyny)', () => {
    const literals = loadPrivateLiterals({ file: SYNTHETIC_LITERALS_FILE });
    if (literals === null) throw new Error('brak syntetycznego pliku literałów');
    const ctx = { tool: 'test', literals, home: '', roots: [], ids: new Map<string, string>() };
    const done = files.filter((name) => (entryOf(name)?.anonymizer ?? null) !== null);
    expect(done.length).toBeGreaterThan(0);
    for (const name of done) {
      const text = readFileSync(join(DIR, name), 'utf8');
      expect(anonymizeText(text, ctx) === text, `${name}: przebieg anonimizatora coś by zmienił`).toBe(true);
    }
  });

  it('żaden fixture nie niesie zastępnika poprzedniej wersji reguł (także plik sprzed anonimizatora)', () => {
    const stale = files.filter((name) => migratePlaceholders(readFileSync(join(DIR, name), 'utf8'))
      !== readFileSync(join(DIR, name), 'utf8'));
    expect(stale, 'zastępnik starszej wersji anonimizatora: przebieg `scripts/anonymize-fixture.ts` na pliku '
      + '(albo sama migracja zastępników przy pliku ręcznym)').toEqual([]);
  });
});

describe('pane-list.json', () => {
  const panes = (JSON.parse(readFileSync(join(DIR, 'pane-list.json'), 'utf8')) as {
    result: { panes: Record<string, unknown>[] };
  }).result.panes;

  it('ma 27 paneli i 14 różnych katalogów (zmierzone)', () => {
    expect(panes).toHaveLength(27);
    expect(new Set(panes.map((p) => p['cwd'])).size).toBe(14);
  });

  it('każdy panel niesie cwd, pane_id, tab_id i workspace_id', () => {
    for (const pane of panes) {
      for (const key of ['cwd', 'pane_id', 'tab_id', 'workspace_id']) {
        expect(typeof pane[key]).toBe('string');
      }
    }
  });

  /*
   * To jest cała podstawa reguły „workspace z panelem o `cwd` == katalog docelowy; brak →
   * `workspace.create`"). Gdyby ten sam katalog żył w dwóch workspace'ach, reguła byłaby
   * niedookreślona i launcher musiałby zgadywać, do którego dopiąć nowy tab.
   */
  it('żaden cwd nie występuje w dwóch workspace’ach', () => {
    const byCwd = new Map<string, Set<string>>();
    for (const pane of panes) {
      const cwd = String(pane['cwd']);
      const set = byCwd.get(cwd) ?? new Set<string>();
      set.add(String(pane['workspace_id']));
      byCwd.set(cwd, set);
    }
    expect([...byCwd].filter(([, ws]) => ws.size > 1)).toEqual([]);
  });

  it('workspace NIE jest równy katalogowi — wN ma dwa', () => {
    const wn = new Set(panes.filter((p) => p['workspace_id'] === 'wN').map((p) => p['cwd']));
    expect(wn.size).toBe(2);
  });

  it('są panele bez agenta (goła powłoka) — launcher nie może liczyć ich jako sesji', () => {
    expect(panes.filter((p) => p['agent'] === undefined).length).toBeGreaterThan(0);
  });

  /*
   * Zapis znaleziska, nie życzenie. `pane.list` w zrzucie nie zwrócił pola `tokens` dla ANI
   * JEDNEGO panelu, mimo że metadane Raroga mają tam mieszkać. Gdy kod oprze
   * `launchedByRarog` na tym polu, ten test upadnie — i to będzie właściwy moment, żeby
   * sprawdzić, czy znacznik naprawdę wraca z serwera, zamiast założyć, że wraca.
   */
  it('ZNALEZISKO: pane.list nie niesie `tokens` — brak pola musi znaczyć „nie mój panel"', () => {
    expect(panes.every((p) => p['tokens'] === undefined)).toBe(true);
  });
});

describe('transcript-pending.jsonl', () => {
  const rows = readLines('transcript-pending.jsonl');

  /*
   * Jedyny sygnał z pliku, że agent na coś czeka: `tool_use` bez pary. `working` vs `blocked`
   * w jsonl nie istnieje — stan MUSI przyjść z herdr.
   */
  it('kończy się `tool_use` BEZ `tool_result` (niedomknięta tura)', () => {
    const toolUseIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const row of rows) {
      const content = (row['message'] as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Record<string, unknown>[]) {
        if (block['type'] === 'tool_use') toolUseIds.add(String(block['id']));
        if (block['type'] === 'tool_result') resultIds.add(String(block['tool_use_id']));
      }
    }
    expect(toolUseIds.size).toBe(1);
    expect(resultIds.size).toBe(0);
  });

  it('czekające narzędzie niesie PEŁNY input AskUserQuestion (treść karty zgody)', () => {
    const last = rows.find((row) => row['type'] === 'assistant');
    const content = (last?.['message'] as { content?: unknown[] } | undefined)?.content ?? [];
    const call = content.find((b) => (b as Record<string, unknown>)['type'] === 'tool_use') as
      { name?: string; input?: { questions?: { options?: unknown[] }[] } } | undefined;
    expect(call?.name).toBe('AskUserQuestion');
    expect(call?.input?.questions?.[0]?.options).toHaveLength(2);
  });
});

describe('transcript-usage.jsonl', () => {
  const rows = readLines('transcript-usage.jsonl');
  const assistants = rows.filter((row) => row['type'] === 'assistant');
  const boundary = rows.find((row) => row['subtype'] === 'compact_boundary');
  const meta = boundary?.['compactMetadata'] as { trigger?: string; preTokens?: number } | undefined;

  it('ma 8 wpisów assistant o rosnącym zużyciu przed granicą', () => {
    const before = assistants.slice(0, 8).map(usageSum);
    expect(before).toHaveLength(8);
    for (let i = 1; i < before.length; i += 1) {
      expect(before[i]!).toBeGreaterThan(before[i - 1]!);
    }
  });

  /* Zweryfikowane liczbowo w researchu: 461 495 + 1187 = 462 682 = `preTokens` granicy. */
  it('preTokens granicy == suma ostatniego wpisu assistant przed nią', () => {
    expect(meta?.preTokens).toBe(462_682);
    expect(usageSum(assistants[7]!)).toBe(462_682);
  });

  it('granica ma trigger `auto` — tylko taka dowodzi realnego okna kontekstu', () => {
    expect(meta?.trigger).toBe('auto');
  });

  it('po kompakcji suma spada natychmiast w TYM SAMYM pliku', () => {
    expect(usageSum(assistants[8]!)).toBe(14_002);
  });

  it('każdy wpis assistant niesie model i effort (źródło pigułki modelu)', () => {
    for (const row of assistants) {
      expect((row['message'] as { model?: string }).model).toBe('claude-fable-5');
      expect(row['effort']).toBe('high');
    }
  });
});

describe('transcript-foreign-cwd.jsonl', () => {
  const rows = readLines('transcript-foreign-cwd.jsonl');

  it('cały plik ma JEDEN cwd i jest to katalog spoza korzeni Raroga', () => {
    expect(new Set(rows.map((row) => row['cwd']))).toEqual(
      new Set(['/Users/u/Desktop/inne']),
    );
  });

  it('ma sessionId inny niż pozostałe transkrypty (test wznowienia go szuka po uuid)', () => {
    const ids = new Set(rows.map((row) => row['sessionId']));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe('7d2dd80f-012c-5c17-b97d-cf436a305158');
  });
});

describe('dialogi z zamkniętej listy sygnatur', () => {
  /*
   * ZRZUT ŻYWEGO PANELU (integrator, `rarog-spike`, claude 3.1.6) — nie rekonstrukcja.
   *
   * Poprzednia wersja tego testu (i sygnatura, której pilnował) wymagała zdania „Do you trust
   * the files in this folder?”. Żywy dialog NIE MA go wcale: pyta „Quick safety check: Is this
   * a project you created or one you trust?” pod nagłówkiem „Accessing workspace:”, a opcja
   * twierdząca brzmi „Yes, I trust this folder”, nie „Yes, proceed”. Test pilnuje teraz
   * ŻYWEGO brzmienia — na nim stoi jedyny przycisk, który Rarog wystawia do dialogu zaufania.
   */
  it('dialog-trust ma żywe pytanie o zaufanie i dwie ponumerowane opcje', () => {
    const text = readFileSync(join(DIR, 'dialog-trust.txt'), 'utf8');
    expect(/Is this a project you created or one you trust\?/i.test(text)).toBe(true);
    expect(text).toMatch(/1\. Yes/);
    expect(text).toMatch(/2\. No/);
    // Dialog zaufania jest BEZRAMKOWY — parser nie ma prawa polegać na `│`/`╭`.
    expect(text).not.toMatch(/[╭╰│]/);
  });

  /*
   * ZRZUT ŻYWEGO PANELU (`rarog-spike`, claude 2.1.241) — nie rekonstrukcja.
   *
   * Poprzednia wersja tego testu wymagała w dialogu frazy „default model for new sessions".
   * Żywy dialog jej NIE MA: ostrzega wyłącznie o koszcie (cache i tokeny), a o zapisie do
   * ustawień konta CLI mówi dopiero w linii WYNIKU, czyli PO potwierdzeniu. To jest dowód,
   * że `MODEL_CHANGE_WARNING` w arkuszu Raroga nie dubluje ostrzeżenia CLI, tylko niesie
   * jedyną informację o skutku globalnym, jaką użytkownik dostanie PRZED decyzją.
   */
  it('dialog-model-switch: nagłówek „Switch model?" i para Yes/No z nazwą modelu', () => {
    const text = readFileSync(join(DIR, 'dialog-model-switch.txt'), 'utf8');
    expect(text).toContain('Switch model?');
    expect(text).toMatch(/1\. Yes, switch to /);
    expect(text).toMatch(/2\. No/);
    // Sam dialog ostrzega o koszcie, nie o skutku globalnym.
    expect(text.toLowerCase()).toContain('slower and use more tokens');
  });

  it('dialog-model-switch: o zapisie do ustawień konta CLI mówi dopiero PO potwierdzeniu', () => {
    const text = readFileSync(join(DIR, 'dialog-model-switch.txt'), 'utf8').toLowerCase();
    const dialogStart = text.indexOf('switch model?');
    const savedAt = text.indexOf('saved as your default for new sessions');
    expect(savedAt).toBeGreaterThanOrEqual(0);
    // Zdanie o domyślnym modelu stoi w linii WYNIKU poprzedniej zmiany, PRZED tym dialogiem —
    // nigdy w jego treści. Gdyby CLI zaczęło ostrzegać samo, ten test upadnie i o tym powie.
    expect(savedAt).toBeLessThan(dialogStart);
  });
});
