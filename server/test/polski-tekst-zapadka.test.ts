/**
 * Strażnik polskiego tekstu w repo publicznym: w dokumencie publicznym, w komendzie `rarog` i w publicznym
 * skrypcie (`grupa` w `polski-tekst.ts`) nie ma polskiej linii poza zamkniętą listą `WYJATKI` z powodem. Bazy
 * nie ma: nowa polska linia przewraca test od razu, a wyjątek, który nie trafia polskiej linii, też. Mechanizm,
 * reguła słowa i co w pliku jest tekstem: `polski-tekst.ts`.
 *
 * Liczy się tylko widok eksportu (`inExportView`), więc wynik jest ten sam w repo źródłowym i w eksporcie; test nie
 * czyta plików prywatnych (słownika ani mapy nazw). Log serwera wchodzi tu tylko z `server/src/index.ts` (start
 * `rarog serve`). Tekst logu całego `server/src/**` liczy osobna zapadka, `polski-log-zapadka.test.ts`:
 * wywołania mają kilka kształtów, a zdania powstają w zmiennych przed wywołaniem, więc mierzy ją drzewo składni,
 * nie linie napisów.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SLOWA_LISTA, grupa, kawalki, polski, polskieLinie, polskieSlowa, policz, PLIKI_CLI, rodzaj, type Wyjatek,
} from './polski-tekst.ts';
import { REPO, inExportView } from './private-guard.ts';
import { repoTextFiles, scan, unbalanced } from './source-scan.ts';

/**
 * Linie, które zostają polskie, z powodem. Lista zamknięta: wpis to cała linia po `trim()` (jeden wpis zdejmuje
 * każdą taką linię pliku), a wpis, który nie trafia polskiej linii, przewraca test. Powód nazywa producenta tekstu:
 * dosłowny cytat wartości, którą kod porównuje, zapisuje albo wysyła (także tekst zastępczy przekaźnika dla buildu
 * apki bez kluczy katalogu). Zdania serwera dla apki są po angielsku z kodem rejestru, a etykiety apki dokument
 * cytuje po angielsku, z angielskiego katalogu apki.
 */
const WYJATKI: readonly Wyjatek[] = [
  {
    plik: 'server/src/cli/io.ts',
    linia: "return answer !== null && ['t', 'tak', 'y', 'yes'].includes(answer.trim().toLowerCase());",
    powod: '`isYes` przyjmuje polskie `t` i `tak` obok `y` i `yes`: odpowiedź po polsku działa także w angielskim CLI',
  },
  {
    plik: 'scripts/hooks/consent.mjs',
    linia: "const CEILING = 'sufit';",
    powod: 'wartość pola `powod` w `shadow.jsonl` ze słownika `HOOK_SHADOW_REASONS` kontraktu hooka (sufit '
      + '`--answer-wait` czekania przez restart); wartości maszynowe logów wewnętrznych zostają',
  },
  ...[
    "if (!sessions.includes(sessionId)) return { veto: 'sesja', seen };",
    "if (Date.now() >= deadline) return { powod: 'sufit' };",
    "if (key === null) return skipWaiting('klucz');",
    "return skipWaiting('zrzut');",
    "skipWaiting('straznik');",
    "finishCycle('blad');",
  ].map((linia): Wyjatek => ({
    plik: 'scripts/hooks/rarog-pending.mjs',
    linia,
    powod: 'wartość pola `powod` w `shadow.jsonl` ze słownika `HOOK_SHADOW_REASONS` kontraktu hooka; wartości '
      + 'maszynowe logów wewnętrznych zostają',
  })),
  {
    plik: 'docs/dialogs.md',
    linia: "transition: `start` (the process's first write), `zmiana` (a change: `mode`, `send` or the session set "
      + 'differ from',
    powod: 'dosłowna wartość `ev` w `alive.jsonl` (`ALIVE_LOG_EVENTS` w `server/src/herdr/dialogs/shadow/alive-log.ts`); '
      + 'wartości maszynowe logów wewnętrznych zostają',
  },
  {
    plik: 'docs/dialogs.md',
    linia: "screen, the literal `brak` = `null`); the time in the name is the event time, the same as the entry's `ts`.",
    powod: 'dosłowny zapis wartości `null` w zrzucie odmowy (`server/src/herdr/dialogs/refusals.ts`); wartość '
      + 'maszynowa zostaje',
  },
  {
    plik: 'docs/implementation-spec.md',
    linia: '`pytanie`, `czerwone`, `limit`, `błąd` or `blad` (XCUITest sends them).',
    powod: 'dosłowne wyzwalacze promptu atrapy demo (`server/src/drivers/mock-driver.ts` porównuje je z tekstem '
      + 'promptu, testy XCUITest apki je wysyłają)',
  },
  {
    plik: 'relay/README.md',
    linia: '`Rarog`, `body` `Nowe powiadomienie`) or as its keys (`title-loc-key` `push.placeholder.title`, `loc-key`',
    powod: 'dosłowny tekst zastępczy banera `ALERT_PLACEHOLDER` z `relay/src/alert-policy.ts` (i fixture\'ów '
      + '`shared/fixtures/apns*/`), który przekaźnik wysyła buildowi apki bez kluczy katalogu',
  },
  ...[
    "aps: { alert: { title: 'Rarog', body: 'Nowe powiadomienie' }, 'mutable-content': 1, sound: 'default' },",
    "? `check the banner „Rarog / Nowe powiadomienie” on ${label}` : '');",
    '? `check on ${label} the fallback banner in the device language: „Rarog / Nowe powiadomienie” in Polish,`',
  ].map((linia) => ({
    plik: 'relay/scripts/smoke.mjs',
    linia,
    powod: 'the literal fallback banner text `ALERT_PLACEHOLDER` of `relay/src/alert-policy.ts`: the only alert body '
      + 'the relay policy lets through, and the text the operator looks for on the phone',
  })),
  ...[
    '- `<tekst poza fixture>`: prompts, model replies and command output (the out-of-fixture placeholder);',
    '- `<komenda poza fixture>` and `opis N (treść poza fixture)`: commands and task descriptions in `tasks/incydent-*`;',
    '- `prompt człowieka N (treść poza fixture)`: human prompts in `tasks/incydent-gotowe-po-postoju-2.1.301/`;',
    '- `✻ <status pracy — gaszony przy zapisie>`: the blanked status line in dialog measurement captures;',
    '- `<email>` and `<sesja>`: the email and session ID in the copies of refusal dumps (`refusals/`).',
  ].map((linia): Wyjatek => ({
    plik: 'server/test/fixtures/herdr/README.md',
    linia,
    powod: 'placeholdery fixture\'ów: dosłowne napisy w plikach zrzutów, które piszą skrypty pomiarów '
      + '(`scripts/measure-*-extract.ts`) i czytają testy fixture\'ów',
  })),
  ...[
    '"source": "pomiar:katalog-komend", "date": "YYYY-MM-DD", "cli": "2.1.302", "anonymizer": 2',
    '- `source`: `pomiar:<category>`, `ręcznie:zrzut`, `ręcznie:wycinek`, `ręcznie:rekonstrukcja` or a test path. The',
  ].map((linia): Wyjatek => ({
    plik: 'server/test/fixtures/herdr/README.md',
    linia,
    powod: 'dosłowne wartości pola `source` manifestu fixture\'ów (`manifest.json`; reguła w '
      + '`server/test/herdr-fixtures.test.ts`, kategorie `KATEGORIE_POMIARU`)',
  })),
];

const RADA = [
  'Polska linia w widoku eksportu: napisz tekst po angielsku. Polska fraza, która musi zostać (dosłowny cytat',
  'wartości, którą kod porównuje, zapisuje albo wysyła), idzie do',
  'WYJATKI z powodem i całą linią po trim().',
].join(' ');

/** Pliki repo w zakresie zapadki (widok eksportu), ścieżka → treść. */
const plikiZakresu = (): Map<string, string> =>
  repoTextFiles(REPO, undefined, (plik) => !inExportView(plik) || grupa(plik) === null);

const linie = (plik: string, tresc: string): number[] => polskieLinie(plik, tresc).map((l) => l.linia);

/** Polskie linie plików (ścieżka → treść) poza `WYJATKI`, jako `plik:linia [dowód] treść`. */
const naruszenia = (pliki: ReadonlyMap<string, string>): string[] =>
  [...pliki].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([plik, tresc]) => polskieLinie(plik, tresc)
    .filter((l) => !WYJATKI.some((w) => w.plik === plik && w.linia === l.zrodlo))
    .map((l) => `${plik}:${String(l.linia)} [${l.dowod}] ${l.zrodlo}`));

describe('zapadka polskiego tekstu: reguła słowa', () => {
  it('polski znak albo słowo z listy; zdanie angielskie nie', () => {
    expect(polski('Błąd konfiguracji', false)).toBe(true);
    expect(polski('Serwer nie odpowiada, sprawdz konfiguracje', false)).toBe(true);
    expect(polski('rarog: wymaga Node 22.15 albo nowszego', true)).toBe(true);
    expect(polski('The server does not respond; check the config file and run rarog doctor.', false)).toBe(false);
    expect(polski('Pair the phone: scan the QR code, then open the link.', true)).toBe(false);
  });

  it('forma: małe, Wielka pierwsza, WIELKIE; mieszana (identyfikator camelCase) nie', () => {
    expect(polskieSlowa('nie Nie NIE nIe', false)).toEqual(['nie', 'Nie', 'NIE']);
    expect(polskieSlowa('UWAGA: brak', false)).toEqual(['UWAGA', 'brak']);
    expect(polskieSlowa('listaPlikow plikNie', false)).toEqual([]);
  });

  it('nazwa przyklejona do `-`, `_`, `.`, `/`, `$`, `@` albo cyfry to nie słowo prozy', () => {
    expect(polskieSlowa('bez-czekania alive-brak .przejecie docs/plik.md brak_pliku $nie nie2 tym@example.com', true))
      .toEqual([]);
    expect(polskieSlowa('rarog-sprawdzany.service <katalog> (plik) „brak”, nie.', true))
      .toEqual(['katalog', 'plik', 'brak', 'nie']);
  });

  it('`jest` liczy się tylko poza dokumentami (Jest to framework testów)', () => {
    expect(polski('curl: jest', true)).toBe(true);
    expect(polski('Jest matchers and jest snapshots', false)).toBe(false);
  });

  it('lista słów: małe litery ASCII, od dwóch liter, posortowana, bez powtórzeń', () => {
    for (const slowo of SLOWA_LISTA) expect(slowo, slowo).toMatch(/^[a-z]{2,}$/u);
    expect([...SLOWA_LISTA].sort()).toEqual(SLOWA_LISTA);
    expect(new Set(SLOWA_LISTA).size).toBe(SLOWA_LISTA.length);
  });
});

describe('zapadka polskiego tekstu: co jest tekstem w pliku (dane syntetyczne)', () => {
  it('kod: napisy i szablony; komentarz, import, wzorzec i interpolacja nie; napis przez kilka linii po liniach', () => {
    const kod = [
      "import { a } from './nie-ma-pliku.ts';",
      '// Komentarz: serwer nie odpowiada',
      '/* serwer nie odpowiada */',
      "const re = /nie wiem/u;",
      'const t = `ok ${nieZnany} done`;',
      "const p = 'serwer nie odpowiada';",
      'const w = `pierwsza linia',
      'druga: brak pliku`;',
      "const e = 'line one\\nbrak pliku';",
    ].join('\n');
    expect(linie('server/src/cli/a.ts', kod)).toEqual([6, 7, 8, 9]);
    expect(kawalki('server/src/cli/a.ts', "const e = 'x\\u0142y';")).toEqual([{ linia: 1, tekst: 'xły' }]);
  });

  it('powłoka: napisy bez rozwinięć, heredoc tekstowy; komentarz i rozwinięcie nie', () => {
    const skrypt = [
      '#!/usr/bin/env bash',
      '# serwer nie odpowiada',
      'stan="$katalog"',
      'echo "port: $PORT, katalog: ${DIR:-x} $(printf brak)"',
      "die 'serwer nie odpowiada'",
      'echo "${#arr[@]} ok"  # brak pliku',
      'cat <<EOF',
      'Uwaga: $HOME',
      'EOF',
      'echo "przez dwie',
      'linie"',
    ].join('\n');
    expect(linie('scripts/a.sh', skrypt)).toEqual([4, 5, 8, 10, 11]);
  });

  it('heredoc dla node czyta się jak kod JavaScript, dla python jak Python (komentarze odpadają)', () => {
    const skrypt = [
      "\"$NODE\" --input-type=module - <<'EOF'",
      '// serwer nie odpowiada',
      "console.error('brak paczki');",
      'EOF',
      "python3 - <<'PY'",
      '# serwer nie odpowiada',
      "print('brak pliku')",
      'PY',
      'echo done',
    ].join('\n');
    expect(linie('scripts/b.sh', skrypt)).toEqual([3, 7]);
  });

  it('Python: napisy z ucieczkami; docstring i komentarz nie', () => {
    const py = ['"""Opis: serwer nie odpowiada', 'i brak pliku."""', '# brak pliku', "print('it\\'s brak')"].join('\n');
    expect(linie('scripts/lib/a.py', py)).toEqual([4]);
  });

  it('powłoka: `<<<` to here-string, nie heredoc (słowo w `"…"`, w `\'…\'` i bez cudzysłowu)', () => {
    for (const slowo of ['"English"', "'English'", 'English']) {
      expect(linie('scripts/check.sh', `grep -q x <<<${slowo}\necho "Serwer nie odpowiada"\n`), slowo).toEqual([2]);
    }
    expect(linie('scripts/check.sh', 'grep -q x <<<"brak pliku"\necho done\n')).toEqual([1]);
  });

  it('powłoka: statyczna wartość domyślna `${x:-…}` (i `:=`, `:+`, `:?`, bez dwukropka) to tekst; samo `${x}` nie', () => {
    const skrypt = [
      'echo "Dead gate (pid ${now:-brak})"',
      'echo "pid ${now}"',
      'echo "${x:=brak} ${y+pusto}"',
      'echo "${z:?brak pliku}"',
      'echo "${#arr[@]} ${x%%brak} ${x/brak/x} ${x:1:2}"',
      'echo "${x-${y:-brak}}"',
    ].join('\n');
    expect(linie('scripts/a.sh', skrypt)).toEqual([1, 3, 4, 6]);
  });

  it('Python: docstring modułu, klasy i funkcji odpada; inne napisy w potrójnych cudzysłowach zostają', () => {
    const py = [
      '"""Opis modułu: brak pliku."""',
      'import sys',
      'def f(',
      '    a,',
      '):',
      '    """Opis funkcji: brak pliku."""',
      '    print("""brak pliku""")',
      '    x = """pierwsza',
      'druga: brak pliku"""',
      'class A:',
      '    r"""Opis klasy: brak pliku."""',
      '    y = 1',
      '    """brak pliku po kodzie"""',
    ].join('\n');
    expect(linie('scripts/lib/a.py', py)).toEqual([7, 8, 9, 13]);
    const heredoc = ["python3 - <<'PY'", '"""Opis: brak pliku."""', 'print("""brak pliku""")', 'PY', 'echo done'];
    expect(linie('scripts/c.sh', heredoc.join('\n'))).toEqual([3]);
  });

  it('dokument: każda linia, także blok kodu; szablon pliku i JSON: każda linia', () => {
    const md = ['# Title', 'English prose.', '```bash', 'rarog setup --data-dir <katalog>', '```', 'Akapit, ktory zostal bez tlumaczenia.'].join('\n');
    expect(linie('docs/x.md', md)).toEqual([4, 6]);
    expect(linie('server/src/cli/templates/x.service', '# Usługa Raroga\n[Unit]\nDescription=x')).toEqual([1]);
    expect(rodzaj('server/src/install/sdk-lock.json')).toBe('caly');
  });

  it('zakres: dokumenty `.md`, pliki CLI, publiczne skrypty bez deklaracji typów', () => {
    expect(['README.md', 'docs/dialogs.md', 'relay-vps/README.md'].map(grupa)).toEqual(['dokument', 'dokument', 'dokument']);
    expect(['bin/rarog.mjs', 'server/src/cli/setup.ts', 'server/src/cli/templates/rarog.service',
      'server/src/install/sdk.ts', 'server/src/index.ts', 'shared/src/data-dir.mjs'].map(grupa))
      .toEqual(['cli', 'cli', 'cli', 'cli', 'cli', 'cli']);
    expect(['scripts/restart.sh', 'scripts/hooks/tall-dialog.mjs', 'scripts/lib/toml-check.py', 'relay-vps/install.sh',
      'relay-vps/relay-watch.mjs', 'relay/scripts/smoke.mjs'].map(grupa))
      .toEqual(['skrypt', 'skrypt', 'skrypt', 'skrypt', 'skrypt', 'skrypt']);
    expect(['scripts/relay-canary.d.mts', 'server/src/router.ts', 'relay/src/index.ts', 'server/test/a.test.ts',
      'relay-vps/test/skrypty.test.ts', 'relay-vps/test/fixtures/zepsuta-skladnia.sh', 'relay-vps/relay-watch.d.mts']
      .map(grupa)).toEqual([null, null, null, null, null, null, null]);
  });

  it('wyjątek zdejmuje swoją linię; wyjątek bez polskiej linii jest martwy', () => {
    const pliki = new Map([['server/src/cli/a.ts', "const a = 'tak';\nconst b = 'brak';\n"]]);
    const wyjatki: Wyjatek[] = [
      { plik: 'server/src/cli/a.ts', linia: "const a = 'tak';", powod: 'x' },
      { plik: 'server/src/cli/a.ts', linia: "const c = 'yes';", powod: 'y' },
    ];
    const wynik = policz(pliki, wyjatki);
    expect([...wynik.liczby]).toEqual([['server/src/cli/a.ts', 1]]);
    expect(wynik.martwe.map((w) => w.linia)).toEqual(["const c = 'yes';"]);
  });
});

describe('zapadka polskiego tekstu: tekst angielski nie daje trafień', () => {
  it('angielskie pliki wejścia: zero polskich linii', () => {
    for (const plik of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/README.md']) {
      expect(polskieLinie(plik, readFileSync(path.join(REPO, plik), 'utf8')), plik).toEqual([]);
    }
  });

  it('dokumentacja zależności (`node_modules/.pnpm/*/node_modules/*/*.md`): zero polskich słów', () => {
    const korzen = path.join(REPO, 'node_modules', '.pnpm');
    expect(existsSync(korzen), 'brak node_modules: pnpm install').toBe(true);
    const pliki: string[] = [];
    for (const paczka of readdirSync(korzen)) {
      const nm = path.join(korzen, paczka, 'node_modules');
      if (!existsSync(nm)) continue;
      // Własny katalog paczki; zależności to dowiązania do innych wpisów `.pnpm`, więc odpadają.
      for (const wpis of readdirSync(nm, { withFileTypes: true })) {
        if (wpis.isSymbolicLink() || !wpis.isDirectory()) continue;
        const katalogi = wpis.name.startsWith('@')
          ? readdirSync(path.join(nm, wpis.name), { withFileTypes: true }).filter((w) => w.isDirectory())
            .map((w) => path.join(nm, wpis.name, w.name))
          : [path.join(nm, wpis.name)];
        for (const katalog of katalogi) {
          pliki.push(...readdirSync(katalog).filter((w) => /\.md$/iu.test(w)).map((w) => path.join(katalog, w)));
        }
      }
    }
    expect(pliki.length).toBeGreaterThan(50);
    const trafienia = pliki.flatMap((plik) => readFileSync(plik, 'utf8').split('\n')
      .filter((l) => polskieSlowa(l, false).length > 0)
      .map((l) => `${path.relative(korzen, plik)}: [${polskieSlowa(l, false).join(', ')}] ${l.trim().slice(0, 120)}`));
    expect(trafienia, 'słowo z SLOWA_LISTA trafia angielski tekst: usuń je z listy').toEqual([]);
  });
});

describe('zapadka polskiego tekstu: repo', () => {
  const pliki = plikiZakresu();

  it('zakres jest pełny: dokumenty publiczne, pliki CLI, skrypty publiczne, hooki', () => {
    for (const plik of [
      'README.md', 'docs/dialogs.md', 'server/test/fixtures/herdr/README.md', 'relay-auth/README.md',
      'server/src/cli/main.ts', 'server/src/cli/templates/launchd.plist', 'scripts/restart.sh', 'scripts/check.sh',
      'scripts/hooks/rarog-pending.mjs', 'scripts/package.mjs', 'relay-vps/install.sh', 'relay/scripts/smoke.mjs',
      ...PLIKI_CLI,
    ]) expect(pliki.has(plik), plik).toBe(true);
    expect([...pliki.keys()].filter((plik) => grupa(plik) === 'dokument').length).toBeGreaterThanOrEqual(21);
  });

  it('skaner kodu domyka nawiasy każdego pliku kodu w zakresie', () => {
    for (const [plik, tresc] of pliki) {
      if (rodzaj(plik) === 'kod') expect(unbalanced(scan(tresc).skeleton), plik).toBeNull();
    }
  });

  it('mutacje na każdym pliku: polskie zdanie ASCII w tekście +1 linia; angielskie i polski komentarz +0', () => {
    const zdanie = {
      kod: ["const proba = 'Serwer nie odpowiada, sprawdz konfiguracje';", "const proba = 'The server does not respond';",
        '// Serwer nie odpowiada, sprawdz konfiguracje'],
      powloka: ['echo "Serwer nie odpowiada: $PORT"', 'echo "The server does not respond: $PORT"',
        '# Serwer nie odpowiada, sprawdz konfiguracje'],
      python: ["print('Serwer nie odpowiada')", "print('The server does not respond')", '# Serwer nie odpowiada'],
      dokument: ['Serwer nie odpowiada, sprawdz konfiguracje.', 'The server does not respond; check the config.', null],
      caly: ['# Serwer nie odpowiada, sprawdz konfiguracje', '# The server does not respond', null],
    } as const;
    const slepe: string[] = [];
    for (const [plik, tresc] of pliki) {
      const [pl, en, komentarz] = zdanie[rodzaj(plik)];
      const przed = linie(plik, tresc).length;
      const po = (dopisek: string): number => linie(plik, `${tresc.replace(/\n?$/u, '\n')}${dopisek}\n`).length - przed;
      if (po(pl) !== 1) slepe.push(`${plik}: polskie zdanie daje ${String(po(pl))}`);
      if (po(en) !== 0) slepe.push(`${plik}: angielskie zdanie daje ${String(po(en))}`);
      if (komentarz !== null && po(komentarz) !== 0) slepe.push(`${plik}: polski komentarz daje ${String(po(komentarz))}`);
    }
    expect(slepe).toEqual([]);
  });

  it('mutacja: polskie zdanie w literale CLI, w dokumencie i obok wyjątku przewraca test; angielskie nie', () => {
    // Sam zmieniony plik: reszta widoku eksportu jest czysta (test niżej), a skan całości pięć razy nie mieści się
    // w limicie czasu testu przy obciążonej maszynie.
    const zmien = (plik: string, dopisek: string): Map<string, string> => {
      expect(pliki.has(plik), plik).toBe(true);
      return new Map([[plik, `${pliki.get(plik) ?? ''}\n${dopisek}\n`]]);
    };
    expect(naruszenia(zmien('server/src/cli/doctor.ts', "const x = 'katalog danych nie istnieje, uruchom rarog setup';")))
      .toEqual([expect.stringMatching(/^server\/src\/cli\/doctor\.ts:\d+ /u)]);
    expect(naruszenia(zmien('SECURITY.md', 'Zgloszenia bezpieczenstwa wysylaj przez prywatny formularz.')))
      .toEqual([expect.stringMatching(/^SECURITY\.md:\d+ /u)]);
    // Plik z wyjątkami nie ma przydziału: nowa polska linia obok nich też przewraca test.
    expect(naruszenia(zmien('server/src/config.ts', "const x = 'Nie ma takiego projektu.';")))
      .toEqual([expect.stringMatching(/^server\/src\/config\.ts:\d+ /u)]);
    expect(naruszenia(zmien('server/src/cli/doctor.ts', "const x = 'data directory missing; run rarog setup';"))).toEqual([]);
    expect(naruszenia(zmien('SECURITY.md', 'Report security issues through the private form.'))).toEqual([]);
  });

  it('zero polskich linii poza wyjątkami; wyjątki żyją', () => {
    expect(naruszenia(pliki), RADA).toEqual([]);
    expect(policz(pliki, WYJATKI).martwe.map((w) => `${w.plik}: „${w.linia}”`), 'martwe wyjątki').toEqual([]);
  });
});
