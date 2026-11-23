/**
 * Bramka tekstu wysyłanego do cudzego panelu i allow-lista slash-komend.
 *
 * Rzeczy, których ten test pilnuje najmocniej, bo ich złamanie jest ciche:
 * 1. limit liczy się w BAJTACH (endpoint `/messages` przyjmuje 12 MB ciała),
 * 2. bramka działa też wtedy, gdy prefiks albo komenda są schowane za bajtem sterującym,
 * 3. odrzucenie jest JAWNE — nigdy „ciche filtrowanie", bo użytkownik ma wiedzieć,
 *    że jego zdanie nie poszło,
 * 4. komenda przechodzi WYŁĄCZNIE nazwą kanoniczną z katalogu sesji: CLI wykonuje prefiks, alias
 *    i inną wielkość liter (CLI 2.1.302), więc każda z tych dróg ma odmowę.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HERDR_PROMPT_BYTES } from '@rarog/shared';
import { isServerSentence } from '@rarog/shared/sentences';
import type { AnyText } from '@rarog/shared/sentences';
import {
  HERDR_SEND_MIN_INTERVAL_MS, HerdrCommandRefusedError, HerdrPromptRejectedError,
  assertSendable, createSendThrottle,
} from '../src/herdr/commands/guard.ts';
import { buildCatalog, commandListOf, registryCatalog } from '../src/herdr/commands/catalog.ts';
import type { DiscoverResult } from '../src/herdr/commands/discover.ts';
import { classifySlashText } from '../src/herdr/commands/shape.ts';
import { ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';

const YOLO = ['/Users/u/Projects/yolo'];

/**
 * Wynik skanu dysku: skill użytkownika, komenda pluginu, skill ukryty i skill z claude.ai. Skille użytkownika
 * i plugin `example-plugin` są zmyślone; `pr-review-toolkit` i `docx` to nazwy publiczne.
 */
const DISK: DiscoverResult = {
  commands: [
    { name: 'przekazanie', source: 'skill', origin: 'user-skill' },
    { name: 'example-plugin:review', source: 'plugin', origin: 'plugin-skill' },
    { name: 'example-plugin:shape', source: 'plugin', origin: 'plugin-skill' },
    { name: 'pr-review-toolkit:review-pr', source: 'plugin', origin: 'plugin-command' },
  ],
  hidden: [{ name: 'ukryty-skill', origin: 'user-skill', reason: 'skill-overrides' }],
  synced: ['docx'],
  skippedPlugins: [],
  notes: [],
  stamps: new Map(),
};
const CATALOG = buildCatalog('/Users/u/Projects/demo', DISK);
/** Ścieżki „istniejące” w teście: katalogi z pomiaru i jeden zmyślony, będący prefiksem `/usage`. */
const EXISTING = new Set(['/tmp', '/var', '/Users', '/us']);
const exists = (path: string): boolean => EXISTING.has(path);
const base = {
  mode: 'auto' as const, cwd: '/Users/u/Projects/demo', yoloRoots: YOLO, catalog: CATALOG, exists,
};

/** Zdanie odmowy dla tekstu (wymusza, że odmowa JEST). */
function refusalSentence(text: string): AnyText {
  try {
    assertSendable(text, base);
  } catch (error) {
    expect(error).toBeInstanceOf(HerdrCommandRefusedError);
    return (error as HerdrCommandRefusedError).sentence;
  }
  throw new Error(`${JSON.stringify(text)} przeszedł strażnika`);
}

/** Angielski tekst odmowy (zdanie z `say()`, apka tłumaczy kod). */
const refusal = (text: string): string => refusalSentence(text).text;

/** Kod zdania odmowy (`ref.code`). */
function refusalCode(text: string): string {
  const sentence = refusalSentence(text);
  return isServerSentence(sentence) ? sentence.ref.code : '';
}

describe('assertSendable — rozmiar', () => {
  it('przepuszcza tekst dokładnie na limicie', () => {
    const text = 'a'.repeat(MAX_HERDR_PROMPT_BYTES);
    expect(assertSendable(text, base).text).toHaveLength(MAX_HERDR_PROMPT_BYTES);
  });

  it('odrzuca limit + 1 bajt', () => {
    const text = 'a'.repeat(MAX_HERDR_PROMPT_BYTES + 1);
    expect(() => assertSendable(text, base)).toThrow(HerdrPromptRejectedError);
  });

  it('liczy BAJTY, nie znaki (UTF-8)', () => {
    const text = 'ł'.repeat(MAX_HERDR_PROMPT_BYTES / 2 + 1);
    expect(text.length).toBeLessThan(MAX_HERDR_PROMPT_BYTES);
    expect(() => assertSendable(text, base)).toThrow(/limit for sending to the pane/);
  });
});

describe('assertSendable — prefiks `!`', () => {
  it('odrzuca tryb powłoki, także za spacją i za bajtem sterującym', () => {
    for (const text of ['!echo x', '  !rm -rf /tmp/x', '\u001b[0m!echo x']) {
      expect(() => assertSendable(text, base), text).toThrow(HerdrPromptRejectedError);
    }
  });

  it('przepuszcza `#` na początku i wykrzyknik w środku', () => {
    for (const text of ['# Plan\n\nKrok 1', '#notatka', 'wykrzyknik na końcu zdania!']) {
      expect(assertSendable(text, base)).toEqual({ text: text.trimEnd(), slash: null });
    }
  });
});

describe('allow-lista komend — komendy, które przechodzą', () => {
  it.each([
    ['/compact', 'compact', 'local'], ['/CLEAR', 'clear', 'local'], ['/context', 'context', 'local'],
    ['/plan', 'plan', 'local'], ['/recap', 'recap', 'local'], ['/rename', 'rename', 'local'],
    ['/rename pomiar-e1', 'rename', 'local'], ['/init', 'init', 'prompt'], ['/insights', 'insights', 'prompt'],
    ['/code-review', 'code-review', 'prompt'], ['/doctor', 'doctor', 'prompt'], ['/simplify x', 'simplify', 'prompt'],
    ['/przekazanie dalej', 'przekazanie', 'prompt'], ['/example-plugin:review 12', 'example-plugin:review', 'prompt'],
    ['  /compact --force', 'compact', 'local'],
  ] as const)('%s → /%s (%s)', (text, name, kind) => {
    expect(assertSendable(text, base)).toEqual({ text: text.trimEnd(), slash: { name, kind } });
  });

  it('goły `/rename` przechodzi: nazwa z rozmowy albo „Could not generate”, bez panelu', () => {
    expect(assertSendable('/rename', base).slash).toEqual({ name: 'rename', kind: 'local' });
  });

  it('klasyfikacja jest tekstu PO sanityzacji: `<ESC>/compact` to komenda', () => {
    expect(assertSendable('\u001b[0m/compact', base)).toEqual({ text: '/compact', slash: { name: 'compact', kind: 'local' } });
  });
});

describe('allow-lista komend — odmowy z podpowiedzią', () => {
  it('prefiks z Enterem wykonałby podpowiedź CLI: `/usa`, `/perm`', () => {
    expect(refusal('/usa')).toMatch(/\/usa.*\/usage.*terminal/);
    expect(refusal('/perm')).toMatch(/\/permissions/);
  });

  it('prefiks dozwolonej komendy podpowiada pełną nazwę', () => {
    expect(refusal('/comp')).toMatch(/full name: \/compact/);
  });

  it('inna wielkość liter komendy spoza listy: `/Usage`', () => {
    expect(refusal('/Usage')).toMatch(/\/Usage doesn't go through Rarog: run it in the terminal/);
  });

  it('alias komendy spoza listy podaje kanoniczną: `/settings x` → „to alias /config”', () => {
    expect(refusal('/settings x=1')).toMatch(/is an alias of \/config, which Rarog doesn't let through/);
  });

  it('alias komendy dozwolonej podpowiada kanoniczną: `/new` → „napisz /clear”, `/checkup` → `/doctor`', () => {
    expect(refusal('/new')).toMatch(/is an alias of \/clear\. Type \/clear instead/);
    expect(refusalCode('/new')).toBe('commands.alias-use-canonical');
    expect(refusal('/reset')).toMatch(/Type \/clear instead/);
    expect(refusal('/name x')).toMatch(/Type \/rename instead/);
    expect(refusal('/checkup')).toMatch(/is an alias of \/doctor\. Type \/doctor instead/);
  });

  it.each([
    '/plugins', '/plugin install x@y', '/config', '/cd /x', '/add-dir /x', '/permissions add Bash', '/hooks',
    '/mcp', '/login', '/logout', '/install-github-app', '/status', '/usage', '/statusline', '/team-onboarding',
    '/resume', '/help', '/memory', '/export', '/rc', '/remote-control',
  ])('%s nie przechodzi (panel, konfiguracja albo poza listą v1)', (text) => {
    expect(refusal(text)).toContain(text.split(' ')[0] ?? '');
  });

  it('`/model` i `/effort` z wolnego tekstu odsyłają do PRZYCISKU MODELU', () => {
    for (const text of ['/model x', '/MODEL', '/effort high', '\u001b[0m/model opus']) {
      expect(refusalCode(text), text).toBe('commands.refused-known.use-model-button');
      expect(refusal(text), text).toMatch(/model button/);
    }
  });

  /*
   * Pomiar żywy na CLI 2.1.310: CLI odpowiada człowiekowi „This skill can only be invoked by Claude”, bez tury,
   * także w terminalu. Dlatego poza allow-listą, odmowa bez „terminalu”.
   */
  it('`/artifact-design` i `/keybindings-help` wywołuje sam Claude: odmowa z podpowiedzią i poza listą dla apki', () => {
    for (const [text, token] of [
      ['/artifact-design', '/artifact-design'], ['/keybindings-help', '/keybindings-help'],
      ['/Artifact-Design', '/Artifact-Design'], ['/KEYBINDINGS-HELP', '/KEYBINDINGS-HELP'],
      ['/artifact-design strona o pogodzie', '/artifact-design'], ['/keybindings-help rebind ctrl+s', '/keybindings-help'],
      ['\u001b[0m/keybindings-help', '/keybindings-help'],
    ] as const) {
      expect(refusalCode(text), text).toBe('commands.refused-claude-skill');
      expect(refusal(text), text)
        .toBe(`The command ${token} is a skill that only Claude invokes: describe what you need in a plain message.`);
    }
    // Prefiks, który CLI dopełniłby tylko do takiego skilla: ta sama podpowiedź.
    for (const text of ['/keybindings-hel', '/artifact-desig', '/ARTIFACT-DE x']) {
      expect(refusalCode(text), text).toBe('commands.completes-to-blocked.claude-only');
      expect(refusal(text), text).toMatch(/CLI would complete it to \/(keybindings-help|artifact-design), which Rarog doesn't/);
      expect(refusal(text), text).toMatch(/Describe what you need in a plain message\.$/);
    }
    // Prefiks z komendą, która w terminalu działa (`/keybindings`), dalej odsyła do terminala.
    expect(refusalCode('/keyb')).toBe('commands.completes-to-blocked');
    expect(refusal('/keyb')).toMatch(/\/keybindings, \/keybindings-help, none of which Rarog lets through\. Run it in the terminal/);
    for (const catalog of [CATALOG, registryCatalog()]) {
      const names = commandListOf(catalog).commands.map((entry) => entry.name);
      expect(names).toContain('artifact-diagramming');
      expect(names).not.toContain('artifact-design');
      expect(names).not.toContain('keybindings-help');
    }
  });

  it('`/exit` i alias `/quit` odsyłają do przycisku sesji, nie wychodzą z wolnego tekstu', () => {
    expect(refusal('/exit')).toMatch(/end the session with the button in Rarog or in the terminal/);
    expect(refusal('/quit')).toMatch(/is an alias of \/exit.*end the session/);
  });

  it('słowa wyjścia jako CAŁY tekst kończą proces CLI (pomiar żywy 2.1.310, każde słowo) — odmowa', () => {
    for (const text of ['quit', 'QUIT', ' exit ', ':q', ':wq!', '\u001b[0mquit']) {
      expect(refusalCode(text), text).toBe('commands.exit-word');
      expect(refusal(text), text).toMatch(/End the session with the button in Rarog or in the terminal/);
    }
    // Słowo wyjścia w zdaniu jest zwykłym promptem.
    expect(assertSendable('quit smoking', base).slash).toBeNull();
    expect(assertSendable('exit code 1 w testach', base).slash).toBeNull();
  });

  it('prompt MCP odsyła do terminala — także nazwa z katalogu ze znacznikiem `(MCP)`', () => {
    expect(refusal('/mcp__a__b')).toMatch(/Run MCP prompts in the terminal/);
    expect(refusalCode('/przekazanie (MCP)')).toBe('commands.mcp-prompt.marked');
    expect(refusal('/przekazanie (MCP)')).toMatch(/Run MCP prompts in the terminal/);
    expect(refusal('/przekazanie (MCP) dalej')).toMatch(/MCP prompt/);
    expect(assertSendable('/przekazanie (MCP)x', base).slash).toEqual({ name: 'przekazanie', kind: 'prompt' });
  });

  it('nieznana nazwa: `/rarogxyz x` (CLI połknąłby ją bez śladu dla modelu)', () => {
    expect(refusal('/rarogxyz x')).toMatch(/Rarog doesn't know the command \/rarogxyz/);
  });

  it('`/example-plugin review x` przy `/example-plugin:review` w katalogu podpowiada nazwę z dwukropkiem', () => {
    expect(refusal('/example-plugin review x')).toMatch(/Type \/example-plugin:review instead/);
  });

  it('goła nazwa komendy pluginu podpowiada nazwę z przedrostkiem', () => {
    expect(refusal('/shape 12')).toMatch(/Type \/example-plugin:shape instead/);
    expect(refusal('/review-pr')).toMatch(/Type \/pr-review-toolkit:review-pr instead/);
  });

  it('`/review` to alias wbudowanego `/code-review` (menu „/” pomiaru żywego), nie goła nazwa pluginu', () => {
    expect(refusal('/review 12')).toMatch(/is an alias of \/code-review\. Type \/code-review instead/);
  });

  it('skill z claude.ai i skill ukryty w ustawieniach nie przechodzą', () => {
    expect(refusal('/docx')).toMatch(/skill from claude\.ai/);
    expect(refusal('/anthropic-skills:docx')).toMatch(/skill from claude\.ai/);
    expect(refusalCode('/docx')).toBe('commands.refused-synced-skill');
    expect(refusal('/ukryty-skill')).toMatch(/hidden in settings/);
    expect(refusalCode('/ukryty-skill')).toBe('commands.refused-hidden-skill');
  });

  it('sam ukośnik wykonałby pierwszą podpowiedź — odmowa', () => {
    expect(refusalCode('/')).toBe('commands.bare-slash');
    expect(refusalCode('/ coś')).toBe('commands.bare-slash');
  });

  it('`<ESC>/usa` odpada po sanityzacji', () => {
    expect(refusal('\u001b[0m/usa')).toMatch(/\/usa/);
  });

  it('odmowa niesie sam token do dziennika, nie resztę tekstu', () => {
    try {
      assertSendable('/settings sekret=1', base);
    } catch (error) {
      expect((error as HerdrCommandRefusedError).command).toBe('/settings');
      return;
    }
    throw new Error('brak odmowy');
  });
});

describe('allow-lista komend — przekierowanie pierwszego argumentu (`subcommands`)', () => {
  it('argument przekierowujący do komendy spoza listy: odmowa, choć nazwa jest dozwolona', () => {
    expect(refusal('/code-review ultra')).toMatch(/redirects to \/ultrareview, which Rarog doesn't let through/);
    expect(refusal('/code-review ULTRA 123')).toMatch(/\/ultrareview/);
    expect(refusal('/design login')).toMatch(/redirects to \/design-login/);
    expect(refusal('/design consent')).toMatch(/\/design-consent/);
  });

  it('przekierowanie do komendy z listy daje komendę docelową', () => {
    expect(assertSendable('/design sync', base).slash).toEqual({ name: 'design-sync', kind: 'prompt' });
  });

  /*
   * Przekierowanie liczy się też przy dalszych argumentach. Jak CLI wykonuje `/design login x`, niezmierzone,
   * więc Rarog ostrożnie bierze cel przekierowania.
   */
  it('przekierowanie liczy się też przy dalszych argumentach: cel spoza listy to odmowa, z listy — cel', () => {
    expect(refusal('/design login teraz')).toMatch(/redirects to \/design-login/);
    expect(refusal('/design REVOKE x y')).toMatch(/\/design-revoke/);
    expect(assertSendable('/design sync teraz', base).slash).toEqual({ name: 'design-sync', kind: 'prompt' });
  });

  it('zwykły argument i klucz z prototypu obiektu nie są przekierowaniem', () => {
    expect(assertSendable('/code-review 123', base).slash).toEqual({ name: 'code-review', kind: 'prompt' });
    expect(assertSendable('/code-review constructor', base).slash).toEqual({ name: 'code-review', kind: 'prompt' });
  });
});

/*
 * Rejestr trzyma wyłącznie nazwy z dowodem (docs, menu „/”
 * pomiaru żywego, fixture z wersją CLI). Nazwa bez dowodu jest dla Raroga nieznana: reguła 6 zamiast odmowy
 * z nazwą kanoniczną. Nazwy w tym bloku są zmyślone. Alias `proactive` ma dowód z docs i menu (`/loop (proactive)`).
 */
describe('allow-lista komend — nazwa bez dowodu jest nieznana', () => {
  const UNKNOWN = ['zmyslona', 'brak-dowodu', 'foo-bar', 'nieznana:komenda', 'zmyslony-alias'];

  it.each(UNKNOWN)('/%s nie jest nazwą z katalogu ani aliasem', (name) => {
    expect(CATALOG.names.has(name), name).toBe(false);
    expect(CATALOG.commands.has(name), name).toBe(false);
  });

  it('nazwa bez prefiksu wśród znanych dostaje odmowę reguły 6', () => {
    for (const text of ['/zmyslona', '/brak-dowodu x', '/foo-bar', '/nieznana:komenda add x', '/zmyslony-alias']) {
      expect(refusalCode(text), text).toBe('commands.unknown');
    }
  });

  it('nazwa, która jest prefiksem znanej, dostaje podpowiedź tej znanej', () => {
    expect(refusal('/update-conf')).toMatch(/Type the full name: \/update-config/);
    expect(refusal('/inst')).toMatch(/complete it to \/install-github-app, \/install-slack-app/);
  });

  it('reguła 5: istniejąca ścieżka o nazwie spoza rejestru jest promptem', () => {
    const withPath = { ...base, exists: (path: string): boolean => path === '/zmyslona' || exists(path) };
    expect(assertSendable('/zmyslona przeczytaj', withPath)).toEqual({ text: '/zmyslona przeczytaj', slash: null });
  });

  it('alias `/proactive` → `/loop` z docs i menu: odmowa z nazwą kanoniczną', () => {
    expect(refusal('/proactive 5m')).toMatch(/is an alias of \/loop\. Type \/loop instead/);
  });
});

describe('allow-lista komend — nazwa spoza kształtu Raroga', () => {
  // Takie komendy mogą istnieć (docs skilli), a jak CLI traktuje ich nazwę, niezmierzone.
  it('kropka albo dwukropek z ukośnikiem to odmowa', () => {
    for (const text of ['/p:deploy.prod', '/moj.skill x', '/apps/web:deploy', '/compact.']) {
      expect(refusalCode(text), text).toBe('commands.not-in-catalog');
    }
    expect(refusal('/moj.skill x')).toMatch(/isn't a name from the Rarog catalog/);
  });

  it('ścieżka z ukośnikiem i bez dwukropka zostaje promptem', () => {
    expect(assertSendable('/tmp/x.log przeczytaj', base).slash).toBeNull();
    expect(assertSendable('/Users/u/notatki.md streść', base).slash).toBeNull();
    expect(assertSendable('/us/ zobacz', base).slash).toBeNull();
  });
});

describe('allow-lista komend — ścieżki (reguła 5)', () => {
  it('istniejąca ścieżka, która nie jest prefiksem komendy, jest promptem', () => {
    expect(assertSendable('/tmp przeczytaj log', base)).toEqual({ text: '/tmp przeczytaj log', slash: null });
    expect(assertSendable('/var/log/x.log streść', base).slash).toBeNull();
    expect(assertSendable('/Users/u zobacz', base).slash).toBeNull();
    expect(assertSendable('/tmp/x.log przeczytaj', base).slash).toBeNull();
  });

  it('ścieżka będąca prefiksem komendy dostaje „dopisz ukośnik” (CLI dopełniłby ją do /usage)', () => {
    expect(refusal('/us zobacz')).toMatch(/Add a slash: \/us\//);
    expect(assertSendable('/us/ zobacz', base).slash).toBeNull();
  });

  it('nieistniejąca ścieżka nie jest promptem: CLI połyka ją jako nieznaną komendę', () => {
    expect(refusalCode('/rarognieistnieje plik')).toBe('commands.unknown');
  });

  it('domyślne `exists` pyta prawdziwy dysk (`/tmp` istnieje na każdym macOS)', () => {
    expect(classifySlashText('/tmp x', registryCatalog())).toEqual({ type: 'prompt' });
  });
});

describe('allow-lista komend — zwykłe prompty', () => {
  it.each([
    'napraw testy w server/test', 'to nie #hashtag', 'zmień model na opusa i napisz dlaczego',
    'ścieżka /tmp w środku zdania',
  ])('%j przechodzi bez klasyfikacji komendy', (text) => {
    expect(assertSendable(text, base)).toEqual({ text, slash: null });
  });
});

describe('assertSendable — ścieżka wewnętrzna `/model` i `/effort`', () => {
  const internal = {
    mode: 'auto' as const, cwd: '/Users/u/Projects/demo', yoloRoots: YOLO, internalCommand: true as const,
  };

  it('przepuszcza komendę zbudowaną przez managera — bez katalogu komend', () => {
    expect(assertSendable('/model opus', internal).text).toBe('/model opus');
    expect(assertSendable('/model opus[1m]', internal).text).toBe('/model opus[1m]');
    expect(() => assertSendable('/model opus[2m]', internal)).toThrow(HerdrPromptRejectedError);
    expect(assertSendable('/effort high', internal).text).toBe('/effort high');
  });

  it('ta sama komenda BEZ flagi dalej odpada — allow-lista wolnego tekstu stoi', () => {
    /*
     * TEST OBOWIĄZKOWY. Cała ścieżka wewnętrzna `/model` stoi na tym, że `/model` da się wysłać wyłącznie
     * endpointem z ostrzeżeniem: gdyby flaga zdejmowała komendę z listy „przy okazji", arkusz
     * z ostrzeżeniem o skutku globalnym dałoby się ominąć jednym zdaniem w composerze.
     */
    expect(() => assertSendable('/model opus', base)).toThrow(HerdrPromptRejectedError);
    expect(() => assertSendable('/effort high', base)).toThrow(HerdrPromptRejectedError);
  });

  it('flaga NIE przepuszcza niczego poza tymi dwiema komendami', () => {
    for (const text of ['/permissions add Bash', '/hooks', '/login', '!echo x', '/compact']) {
      expect(() => assertSendable(text, internal), text).toThrow(HerdrPromptRejectedError);
    }
  });

  it('odrzuca wszystko, co nie ma KSZTAŁTU komendy — także z flagą', () => {
    const REJECTED = [
      '/model opus; rm -rf /tmp/x',
      '/model opus\n/permissions add Bash',
      '/model opus i jeszcze coś',
      'zrób coś',
      '/model "opus"',
    ];
    for (const text of REJECTED) {
      expect(() => assertSendable(text, internal), text).toThrow(HerdrPromptRejectedError);
    }
  });

  it('obie formy ultracode przechodzą W CAŁOŚCI, a nic podobnego nie przechodzi', () => {
    expect(assertSendable(ULTRACODE_COMMANDS.on, internal).text).toBe(ULTRACODE_COMMANDS.on);
    expect(assertSendable(ULTRACODE_COMMANDS.off, internal).text).toBe(ULTRACODE_COMMANDS.off);
    /*
     * Forma `off` ma dwie wartości, a wzorzec jednej wartości jej nie przepuszcza. Furtka to dokładnie dwie formy
     * z rejestru, nie „druga wartość wolno”: inna druga wartość, druga wartość przy innym poziomie albo przy
     * `/model`, doklejone polecenie i inna wielkość liter dalej odpadają.
     */
    for (const text of [
      `${ULTRACODE_COMMANDS.on} on`, '/effort high off', '/model fable off', `${ULTRACODE_COMMANDS.off}; x`,
      `${ULTRACODE_COMMANDS.off} x`, `${ULTRACODE_COMMANDS.off}\n/hooks`, ` ${ULTRACODE_COMMANDS.off}`,
      ULTRACODE_COMMANDS.off.toUpperCase(), `${ULTRACODE_COMMANDS.on}  off`,
    ]) {
      expect(() => assertSendable(text, internal), text).toThrow(HerdrPromptRejectedError);
    }
  });

  it('formy ultracode z wolnego tekstu dalej odsyłają do przycisku modelu', () => {
    for (const text of Object.values(ULTRACODE_COMMANDS)) {
      expect(() => assertSendable(text, base), text).toThrow(/model button/);
    }
  });

  it('sama komenda bez wartości przechodzi kształtem (odrzuca ją manager, nie guard)', () => {
    expect(assertSendable('/model', internal).text).toBe('/model');
  });
});

describe('assertSendable — tryb panelu', () => {
  it('odrzuca `bypass` poza RAROG_YOLO_ROOTS', () => {
    expect(() => assertSendable('zrób to', { ...base, mode: 'bypass' })).toThrow(
      /RAROG_YOLO_ROOTS/,
    );
  });

  it('przepuszcza `bypass` wewnątrz RAROG_YOLO_ROOTS', () => {
    // Ścieżki są zmyślone, więc realpath to tożsamość — produkcja rozwiązuje dowiązania.
    const opts = {
      mode: 'bypass' as const, cwd: '/Users/u/Projects/yolo/app', yoloRoots: YOLO, catalog: CATALOG,
      realPath: (p: string) => p,
    };
    expect(assertSendable('zrób to', opts).text).toBe('zrób to');
  });

  it('bramka yolo liczy przynależność po REALPATH, nie po stringach', () => {
    // Dowiązanie wewnątrz yolo-roota wskazujące POZA niego: leksykalnie „w środku",
    // fizycznie cudze repo — wysyłka do panelu w bypass ma odpaść.
    const opts = {
      mode: 'bypass' as const, cwd: '/Users/u/Projects/yolo/skrot', yoloRoots: YOLO, catalog: CATALOG,
      realPath: (p: string) => p.replace('/Users/u/Projects/yolo/skrot', '/Users/u/Projects/klient'),
    };
    expect(() => assertSendable('zrób to', opts)).toThrow(/RAROG_YOLO_ROOTS/);
  });

  it('bramka yolo odpada, gdy ścieżki nie da się rozwiązać (fail-closed)', () => {
    const opts = {
      mode: 'bypass' as const, cwd: '/Users/u/Projects/yolo/app', yoloRoots: YOLO, catalog: CATALOG,
      realPath: () => { throw new Error('ENOENT'); },
    };
    expect(() => assertSendable('zrób to', opts)).toThrow(/RAROG_YOLO_ROOTS/);
  });

  it('przepuszcza `manual`, `plan`, `auto` i `unknown`', () => {
    for (const mode of ['manual', 'plan', 'auto', 'unknown'] as const) {
      expect(assertSendable('zrób to', { ...base, mode }).text).toBe('zrób to');
    }
  });
});

describe('assertSendable — sanityzacja', () => {
  it('wycina ESC/CSI i inne C0, zachowuje `\\n` i `\\t`', () => {
    const text = 'linia jeden\u0007\u001b[31m\nlinia\tdwa\u0000';
    expect(assertSendable(text, base).text).toBe('linia jeden\nlinia\tdwa');
  });

  it('normalizuje CRLF i ucina końcowe białe znaki', () => {
    expect(assertSendable('a\r\nb\r\n   \n', base).text).toBe('a\nb');
  });

  it('drops trailing backslashes, so the Enter after the paste submits instead of adding a new line', () => {
    expect(assertSendable('what comes next?\\', base).text).toBe('what comes next?');
    expect(assertSendable('what comes next? \\\\ \n', base).text).toBe('what comes next?');
    expect(assertSendable('a \\ b\\nc', base).text).toBe('a \\ b\\nc');
    expect(() => assertSendable('\\', base)).toThrow(/The message is empty/);
  });

  it('odrzuca tekst, z którego po sanityzacji nic nie zostaje', () => {
    expect(() => assertSendable('\u001b[2J\u0007  \n', base)).toThrow(/The message is empty/);
  });

  it('pusty tekst z załącznikami przechodzi jako prompt', () => {
    expect(assertSendable('', { ...base, withAttachments: true })).toEqual({ text: '', slash: null });
    expect(assertSendable('\u001b[2J  \n', { ...base, withAttachments: true }).text).toBe('');
  });

  it('załączniki nie zdejmują reszty reguł: bypass poza RAROG_YOLO_ROOTS i prefiks `!` dalej odpadają', () => {
    expect(() => assertSendable('', { ...base, withAttachments: true, mode: 'bypass' })).toThrow(/bypass/);
    expect(() => assertSendable('!ls', { ...base, withAttachments: true })).toThrow(/The prefix “!” is blocked/);
  });
});

describe('createSendThrottle', () => {
  it('przepuszcza pierwszą wysyłkę, blokuje drugą w pół sekundy, przepuszcza po odstępie', () => {
    let clock = 1_000;
    const throttle = createSendThrottle({ now: () => clock });
    expect(throttle.takeSendSlot('w9:p72')).toBe(true);
    clock += 500;
    expect(throttle.takeSendSlot('w9:p72')).toBe(false);
    clock += HERDR_SEND_MIN_INTERVAL_MS;
    expect(throttle.takeSendSlot('w9:p72')).toBe(true);
  });

  it('drugi prompt człowieka sekundę po pierwszym przechodzi (bez 429)', () => {
    let clock = 0;
    const throttle = createSendThrottle({ now: () => clock });
    expect(throttle.takeSendSlot('w9:p72')).toBe(true);
    clock += 1_000;
    expect(throttle.takeSendSlot('w9:p72')).toBe(true);
  });

  it('limit jest per sesja — inny panel nie czeka na cudzy odstęp', () => {
    let clock = 0;
    const throttle = createSendThrottle({ now: () => clock });
    expect(throttle.takeSendSlot('w9:p72')).toBe(true);
    expect(throttle.takeSendSlot('wA:p2T')).toBe(true);
  });

  it('sufit godzinny obejmuje wszystkie sesje razem i zwalnia się po godzinie', () => {
    let clock = 0;
    const throttle = createSendThrottle({ now: () => clock, hourlyCap: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.takeSendSlot(`pane-${i}`)).toBe(true);
    }
    expect(throttle.takeSendSlot('pane-3')).toBe(false);
    clock += 60 * 60 * 1000 + 1;
    expect(throttle.takeSendSlot('pane-3')).toBe(true);
  });

  it('a prompt skips the per-pane interval but counts toward the hourly cap', () => {
    let clock = 0;
    const throttle = createSendThrottle({ now: () => clock, hourlyCap: 3 });
    expect(throttle.takeSendSlot('a', { spaced: false })).toBe(true);
    expect(throttle.takeSendSlot('a', { spaced: false })).toBe(true);
    // A background command right after a prompt still waits out the interval.
    expect(throttle.takeSendSlot('a')).toBe(false);
    clock += HERDR_SEND_MIN_INTERVAL_MS;
    expect(throttle.takeSendSlot('a')).toBe(true);
    expect(throttle.takeSendSlot('b', { spaced: false })).toBe(false);
  });

  it('odrzucenie NIE zużywa slotu godzinnego', () => {
    let clock = 0;
    const throttle = createSendThrottle({ now: () => clock, hourlyCap: 2 });
    expect(throttle.takeSendSlot('a')).toBe(true);
    expect(throttle.takeSendSlot('a')).toBe(false); // odstęp
    clock += HERDR_SEND_MIN_INTERVAL_MS;
    expect(throttle.takeSendSlot('a')).toBe(true);
    expect(throttle.takeSendSlot('b')).toBe(false); // dopiero teraz sufit
  });
});
