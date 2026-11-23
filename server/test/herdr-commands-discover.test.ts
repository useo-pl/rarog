/**
 * Odkrywanie skilli i komend z dysku (`herdr/commands/discover.ts`) i migawka katalogu (`catalog.ts`).
 *
 * Każdy test buduje WŁASNY katalog domowy i projekt w katalogu tymczasowym — prawdziwego `~/.claude` test
 * nie czyta. Reguły nazw wg dokumentacji CLI („How a skill gets its command name”): katalog skilla = nazwa
 * katalogu, `name` z frontmattera to druga nazwa tylko bez kolizji, `commands/<plik>.md` = nazwa pliku.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';
import { COMMAND_TEXT_MAX, commandListSchema } from '@rarog/shared';
import {
  COMMAND_CATALOG_SKIP_FILE_LOG, discoverCommands, frontmatterOf, frontmatterText,
} from '../src/herdr/commands/discover.ts';
import type { DiscoverOptions, DiscoverResult } from '../src/herdr/commands/discover.ts';
import {
  buildCatalog, commandListOf, createCommandCatalogs, reservedNames,
} from '../src/herdr/commands/catalog.ts';
import { classifySlashText } from '../src/herdr/commands/shape.ts';

let root: string;
let home: string;
let projects: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-komendy-discover-'));
  home = join(root, 'home');
  projects = join(root, 'Projects');
  repo = join(projects, 'atlas');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const skillMd = (front: Record<string, string> = {}): string => {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return ['---', ...lines, 'description: test', '---', '', '# Skill', ''].join('\n');
};

function discover(cwd = repo, extra: Partial<DiscoverOptions> = {}): DiscoverResult {
  return discoverCommands({ home, cwd, roots: [projects], reserved: reservedNames(), ...extra });
}

const names = (result: DiscoverResult): string[] => result.commands.map((entry) => entry.name).sort();
const hidden = (result: DiscoverResult): string[] => result.hidden.map((entry) => `${entry.name}:${entry.reason}`).sort();

/** Instalacja pluginu w `~/.claude/plugins/cache/…` i wpis w `installed_plugins.json` (wersja 2). */
async function plugin(
  key: string, entry: Record<string, unknown>, files: Record<string, string>, installed: Record<string, unknown[]>,
): Promise<string> {
  const installPath = join(home, '.claude', 'plugins', 'cache', key.replace('@', '-'));
  for (const [path, text] of Object.entries(files)) await put(join(installPath, path), text);
  await mkdir(installPath, { recursive: true });
  installed[key] = [{ installPath, version: '1.0.0', ...entry }];
  await put(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }));
  return installPath;
}

describe('skille i komendy użytkownika', () => {
  it('katalog skilla = nazwa katalogu; `name` niekolidujące to druga nazwa', async () => {
    await put(join(home, '.claude/skills/deploy-staging/SKILL.md'), skillMd({ name: 'deploy' }));
    expect(names(discover())).toEqual(['deploy', 'deploy-staging']);
  });

  it('`name` kolidujące z komendą wbudowaną: tylko nazwa katalogu (inaczej CLI wykonałby /permissions)', async () => {
    await put(join(home, '.claude/skills/uprawnienia/SKILL.md'), skillMd({ name: 'permissions' }));
    await put(join(home, '.claude/skills/kopia/SKILL.md'), skillMd({ name: 'Settings' }));
    expect(names(discover())).toEqual(['kopia', 'uprawnienia']);
  });

  it('`name` kolidujące z nazwą innego skilla albo z drugą nazwą innego skilla: żadne', async () => {
    await put(join(home, '.claude/skills/atlas/SKILL.md'), skillMd({ name: 'birch' }));
    await put(join(home, '.claude/skills/birch/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/dunes/SKILL.md'), skillMd({ name: 'wspolny' }));
    await put(join(home, '.claude/skills/cedar/SKILL.md'), skillMd({ name: 'wspolny' }));
    expect(names(discover())).toEqual(['atlas', 'birch', 'cedar', 'dunes']);
  });

  it('katalog skilla o nazwie komendy wbudowanej jest ukryty (ostrożność Raroga)', async () => {
    await put(join(home, '.claude/skills/config/SKILL.md'), skillMd());
    const result = discover();
    expect(names(result)).toEqual([]);
    expect(hidden(result)).toEqual(['config:reserved-name']);
    expect(result.notes.join('\n')).toMatch(/config.*built-in command name/);
  });

  /*
   * Rejestr trzyma wyłącznie nazwy z dowodem, więc skill z dysku
   * o nazwie spoza rejestru wchodzi do katalogu. Ryzyko u użytkownika, którego CLI ma komendę o tej nazwie bez
   * dowodu w rejestrze: `docs/slash-commands.md`, „Known gaps”. Nazwy w teście są zmyślone.
   */
  it('skill z dysku o nazwie spoza rejestru wchodzi do katalogu jako prompt', async () => {
    await put(join(home, '.claude/skills/zmyslona/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/kopia/SKILL.md'), skillMd({ name: 'bez-dowodu' }));
    const result = discover();
    expect(names(result)).toEqual(['bez-dowodu', 'kopia', 'zmyslona']);
    expect(hidden(result)).toEqual([]);
    const catalog = buildCatalog(repo, result);
    expect(classifySlashText('/zmyslona x', catalog)).toEqual({
      type: 'command', command: { name: 'zmyslona', kind: 'prompt' },
    });
    expect(classifySlashText('/bez-dowodu', catalog)).toEqual({
      type: 'command', command: { name: 'bez-dowodu', kind: 'prompt' },
    });
  });

  it('`.trash` i `.staging` pod `skills/` skan pomija (nazwa spoza kształtu członu), `synced` też', async () => {
    await put(join(home, '.claude/skills/.trash/stary/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/.trash/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/.staging/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/synced/SKILL.md'), skillMd());
    await put(join(repo, '.claude/skills/.staging/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/zwykly/SKILL.md'), skillMd());
    const result = discover();
    expect(names(result)).toEqual(['zwykly']);
    expect(hidden(result)).toEqual([]);
    expect(result.synced).toEqual([]);
  });

  it('`commands/x.md` z `name: permissions` daje komendę `/x` — frontmatter nie zmienia nazwy', async () => {
    await put(join(home, '.claude/commands/x.md'), skillMd({ name: 'permissions' }));
    await put(join(home, '.claude/commands/podkatalog/y.md'), skillMd());
    await put(join(home, '.claude/commands/notatka.txt'), 'nie komenda');
    expect(names(discover())).toEqual(['x']);
    expect(discover().commands[0]).toMatchObject({ name: 'x', source: 'skill', origin: 'user-command' });
  });

  it('`user-invocable: false` i `skillOverrides: off` chowają skill (obie nazwy)', async () => {
    await put(join(home, '.claude/skills/tylko-model/SKILL.md'), skillMd({ 'user-invocable': 'false' }));
    await put(join(home, '.claude/skills/wylaczony/SKILL.md'), skillMd({ name: 'wyl' }));
    await put(join(home, '.claude/skills/widoczny/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/tylko-czlowiek/SKILL.md'), skillMd());
    await put(join(home, '.claude/settings.json'), JSON.stringify({
      skillOverrides: { wylaczony: 'off', 'tylko-czlowiek': 'user-invocable-only' },
    }));
    const result = discover();
    expect(names(result)).toEqual(['tylko-czlowiek', 'widoczny']);
    expect(hidden(result)).toEqual([
      'tylko-model:user-invocable', 'wyl:skill-overrides', 'wylaczony:skill-overrides',
    ]);
  });

  // Pole logiczne: docs skilli, „Frontmatter reference”; wartość spoza zbioru chowa skill (ostrożność Raroga).
  it('pole `user-invocable`: tylko wartość prawdziwa zostawia skill, każda inna go chowa', async () => {
    const cases: Record<string, string> = {
      zero: '0', cytat: '"false" # tylko model', nieznana: 'maybe', pusta: '""', falsz: 'False',
      prawda: 'true', tak: 'Yes', jeden: '1', cytatprawda: "'on'",
    };
    for (const [dir, value] of Object.entries(cases)) {
      await put(join(home, `.claude/skills/${dir}/SKILL.md`), skillMd({ 'user-invocable': value }));
    }
    const result = discover();
    expect(names(result)).toEqual(['cytatprawda', 'jeden', 'prawda', 'tak']);
    expect(hidden(result)).toEqual([
      'cytat:user-invocable', 'falsz:user-invocable', 'nieznana:user-invocable', 'pusta:user-invocable',
      'zero:user-invocable',
    ]);
  });

  it('nazwa spoza kształtu Raroga i katalog bez SKILL.md: poza katalogiem', async () => {
    await put(join(home, '.claude/skills/z.kropka/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/ze spacja/SKILL.md'), skillMd());
    await mkdir(join(home, '.claude/skills/pusty'), { recursive: true });
    await put(join(home, '.claude/skills/ok/SKILL.md'), skillMd({ name: '"Ładna nazwa"' }));
    expect(names(discover())).toEqual(['ok']);
  });

  it('skille z claude.ai (`skills/synced/<konto>/`) nie wchodzą do katalogu, ale ich nazwy są znane', async () => {
    await put(join(home, '.claude/skills/synced/a_b/docx/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/synced/c_d/pdf/SKILL.md'), skillMd());
    const result = discover();
    expect(names(result)).toEqual([]);
    expect(result.synced).toEqual(['docx', 'pdf']);
    const catalog = buildCatalog(repo, result);
    expect(classifySlashText('/docx', catalog)).toMatchObject({ type: 'refused' });
    expect(classifySlashText('/anthropic-skills:pdf x', catalog)).toMatchObject({ type: 'refused' });
  });

  it('dowiązanie do katalogu komend jest czytane (tak jest na Macu użytkownika)', async () => {
    await put(join(root, 'dotfiles/commands/zrob.md'), skillMd());
    await symlink(join(root, 'dotfiles/commands'), join(home, '.claude/commands'));
    expect(names(discover())).toEqual(['zrob']);
  });

  it('dowiązany `SKILL.md` dalej jest czytany (dowiązanie w skillach to funkcja, nie wektor)', async () => {
    await put(join(root, 'dotfiles/skill.md'), skillMd({ name: 'wdroz' }));
    await mkdir(join(home, '.claude/skills/deploy'), { recursive: true });
    await symlink(join(root, 'dotfiles/skill.md'), join(home, '.claude/skills/deploy/SKILL.md'));
    expect(names(discover())).toEqual(['deploy', 'wdroz']);
  });
});

/*
 * Plik specjalny pod stałą nazwą (FIFO jako `settings.local.json` albo `SKILL.md`) zamroziłby CAŁĄ pętlę
 * zdarzeń serwera, gdyby `head` otwierał go synchronicznie bez `O_NONBLOCK`, a woła go bramka wysyłki. Agent
 * w sandboksie zapisuje katalog projektu, więc podłożenie to jedno `mkfifo`. Odczyt synchroniczny reprodukuje się
 * tylko w procesie potomnym z limitem rodzica (`child-limit.ts`).
 */
describe('plik specjalny w katalogu projektu', () => {
  const discoverInChild = async (): Promise<{ notes: string[]; names: string[] }> => childJson(await runInChild(root, `
import { discoverCommands } from ${serverModule('herdr/commands/discover.ts')};
import { reservedNames } from ${serverModule('herdr/commands/catalog.ts')};
const result = discoverCommands({
  home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(repo)}, roots: [${JSON.stringify(projects)}], reserved: reservedNames(),
});
console.log(JSON.stringify({ notes: result.notes, names: result.commands.map((entry) => entry.name).sort() }));
`));

  it('FIFO jako `.claude/settings.local.json`: skan kończy się z notatką „nie czytam pliku”', async () => {
    await put(join(repo, '.claude/skills/zostaje/SKILL.md'), skillMd());
    await mkdir(join(repo, '.claude'), { recursive: true });
    execFileSync('mkfifo', [join(repo, '.claude/settings.local.json')]);
    const result = await discoverInChild();
    expect(result.names).toEqual(['zostaje']);
    expect(result.notes.some((note) => note.startsWith(`${COMMAND_CATALOG_SKIP_FILE_LOG} `)
      && note.includes('.claude/settings.local.json'))).toBe(true);
  }, CHILD_TEST_TIMEOUT_MS);

  it('FIFO jako `SKILL.md`: skill odpada z notatką, sąsiedni skill zostaje', async () => {
    await put(join(repo, '.claude/skills/zostaje/SKILL.md'), skillMd());
    await mkdir(join(repo, '.claude/skills/kolejka'), { recursive: true });
    execFileSync('mkfifo', [join(repo, '.claude/skills/kolejka/SKILL.md')]);
    const result = await discoverInChild();
    expect(result.names).toEqual(['zostaje']);
    expect(result.notes.some((note) => note.startsWith(`${COMMAND_CATALOG_SKIP_FILE_LOG} `)
      && note.includes('kolejka/SKILL.md'))).toBe(true);
  }, CHILD_TEST_TIMEOUT_MS);
});

describe('skille i komendy projektu', () => {
  it('`cwd` i rodzice do pierwszego `.git` włącznie; wyżej nie', async () => {
    const cwd = join(repo, 'apps', 'web');
    await put(join(cwd, '.claude/skills/wewnatrz/SKILL.md'), skillMd());
    await put(join(repo, 'apps/.claude/commands/srodek.md'), skillMd());
    await put(join(repo, '.claude/skills/korzen/SKILL.md'), skillMd());
    await put(join(projects, '.claude/skills/nad-repo/SKILL.md'), skillMd());
    expect(names(discover(cwd))).toEqual(['korzen', 'srodek', 'wewnatrz']);
  });

  it('bez `.git` szukanie kończy się na korzeniu z `RAROG_HERDR_ROOTS`', async () => {
    const loose = join(projects, 'luzny', 'pod');
    await put(join(loose, '.claude/skills/tu/SKILL.md'), skillMd());
    await put(join(projects, '.claude/skills/korzen-rootow/SKILL.md'), skillMd());
    await put(join(root, '.claude/skills/nad-rootem/SKILL.md'), skillMd());
    expect(names(discover(loose))).toEqual(['korzen-rootow', 'tu']);
  });

  it('zagnieżdżone `<podkatalog>/.claude/` poniżej `cwd` i podkatalogi `commands/` są poza katalogiem', async () => {
    await put(join(repo, 'apps/web/.claude/skills/zagniezdzony/SKILL.md'), skillMd());
    await put(join(repo, '.claude/commands/front/komponent.md'), skillMd());
    expect(names(discover())).toEqual([]);
  });

  it('`skillOverrides` z `settings.local.json` projektu wygrywa z kontem', async () => {
    await put(join(repo, '.claude/skills/projektowy/SKILL.md'), skillMd());
    await put(join(home, '.claude/settings.json'), JSON.stringify({ skillOverrides: { projektowy: 'on' } }));
    await put(join(repo, '.claude/settings.local.json'), JSON.stringify({ skillOverrides: { projektowy: 'off' } }));
    expect(names(discover())).toEqual([]);
  });
});

describe('pluginy', () => {
  const files = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'narzedzia' }),
    'skills/review/SKILL.md': skillMd(),
    'skills/fancy-dir/SKILL.md': skillMd({ name: 'fancy' }),
    'skills/prefiks/SKILL.md': skillMd({ name: 'narzedzia:z-przedrostkiem' }),
    'skills/ukryty/SKILL.md': skillMd({ 'user-invocable': 'false' }),
    'commands/przekaz.md': skillMd({ name: 'inna' }),
    'commands/podkatalog/nie.md': skillMd(),
  };

  it('`scope: user`, włączony: `/<plugin>:<name|katalog>` i `/<plugin>:<plik>`, z domyślnych katalogów', async () => {
    const installed: Record<string, unknown[]> = {};
    await plugin('narzedzia@rynek', { scope: 'user' }, files, installed);
    await put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'narzedzia@rynek': true } }));
    const result = discover();
    expect(names(result)).toEqual([
      'narzedzia:fancy', 'narzedzia:przekaz', 'narzedzia:review', 'narzedzia:z-przedrostkiem',
    ]);
    expect(hidden(result)).toEqual(['narzedzia:ukryty:user-invocable']);
    expect(result.commands.every((entry) => entry.source === 'plugin')).toBe(true);
  });

  it('wyłączony w ustawieniach: poza; bez wpisu: `defaultEnabled` manifestu, domyślnie włączony', async () => {
    const installed: Record<string, unknown[]> = {};
    await plugin('wylaczony@r', { scope: 'user' }, { 'commands/a.md': skillMd() }, installed);
    await plugin('domyslny@r', { scope: 'user' }, { 'commands/b.md': skillMd() }, installed);
    await plugin('nie-domyslny@r', { scope: 'user' }, {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'nie-domyslny', defaultEnabled: false }),
      'commands/c.md': skillMd(),
    }, installed);
    await put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'wylaczony@r': false } }));
    const result = discover();
    expect(names(result)).toEqual(['domyslny:b']);
    expect(result.skippedPlugins).toEqual(expect.arrayContaining([
      { plugin: 'wylaczony@r', reason: 'disabled' }, { plugin: 'nie-domyslny@r', reason: 'disabled' },
    ]));
  });

  it('włączenie z `settings.local.json` projektu wygrywa z `settings.json` projektu i z kontem', async () => {
    const installed: Record<string, unknown[]> = {};
    await plugin('p@r', { scope: 'user' }, { 'commands/a.md': skillMd() }, installed);
    await put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'p@r': false } }));
    await put(join(repo, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'p@r': false } }));
    await put(join(repo, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'p@r': true } }));
    expect(names(discover())).toEqual(['p:a']);
  });

  it('`scope: project` tylko przy `projectPath` równym korzeniowi repo `cwd`', async () => {
    const installed: Record<string, unknown[]> = {};
    await plugin('nasz@r', { scope: 'project', projectPath: repo }, { 'commands/a.md': skillMd() }, installed);
    await plugin('cudzy@r', { scope: 'project', projectPath: join(projects, 'birch') }, {
      'commands/b.md': skillMd(),
    }, installed);
    await plugin('lokalny@r', { scope: 'local' }, { 'commands/c.md': skillMd() }, installed);
    const result = discover(join(repo, 'apps'));
    expect(names(result)).toEqual(['nasz:a']);
    expect(result.skippedPlugins).toEqual(expect.arrayContaining([
      { plugin: 'cudzy@r', reason: 'project-path' }, { plugin: 'lokalny@r', reason: 'scope' },
    ]));
  });

  it('manifest z własnymi ścieżkami `commands`/`skills`: plugin pominięty z jedną notatką', async () => {
    const installed: Record<string, unknown[]> = {};
    await plugin('wlasny@r', { scope: 'user' }, {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'wlasny', commands: ['./inne'] }),
      'commands/a.md': skillMd(),
    }, installed);
    const result = discover();
    expect(names(result)).toEqual([]);
    expect(result.skippedPlugins).toEqual([{ plugin: 'wlasny@r', reason: 'manifest-paths' }]);
    expect(result.notes.filter((line) => line.includes('wlasny@r'))).toHaveLength(1);
  });

  it('ścieżka instalacji spoza `~/.claude/plugins/` jest pominięta (plik CLI nie wskazuje Rarogowi dysku)', async () => {
    await put(join(root, 'gdzie-indziej/commands/a.md'), skillMd());
    await put(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'obcy@r': [{ scope: 'user', installPath: join(root, 'gdzie-indziej') }] },
    }));
    const result = discover();
    expect(names(result)).toEqual([]);
    expect(result.skippedPlugins).toEqual([{ plugin: 'obcy@r', reason: 'install-path' }]);
  });

  it('nieznana wersja `installed_plugins.json` i nieczytelny JSON: pluginy puste + notatka, bez wyjątku', async () => {
    await put(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 3, plugins: {} }));
    expect(discover().notes.join('\n')).toMatch(/at version 3/);
    await put(join(home, '.claude/plugins/installed_plugins.json'), '{ nie json');
    expect(discover().notes.join('\n')).toMatch(/unreadable JSON/);
  });
});

describe('frontmatter', () => {
  it('czyta proste pola, zdejmuje cudzysłowy i komentarz; bez bloku — pusto', () => {
    const meta = frontmatterOf('---\nname: "deploy"\nuser-invocable: false # tylko model\n  zagniezdzone: x\n---\nTreść');
    expect(meta.get('name')).toBe('deploy');
    expect(frontmatterOf('---\nuser-invocable: "false" # tylko model\n---\n').get('user-invocable')).toBe('false');
    expect(meta.get('user-invocable')).toBe('false');
    expect(meta.has('zagniezdzone')).toBe(false);
    expect(frontmatterOf('# bez frontmattera\nname: x').size).toBe(0);
    expect(frontmatterOf('﻿---\r\nname: crlf\r\n---\r\n').get('name')).toBe('crlf');
  });
});

describe('opis i podpowiedź argumentu z frontmattera (lista apki)', () => {
  const front = (...lines: string[]): string => ['---', ...lines, '---', '', '# Treść', 'description: nie z nagłówka'].join('\n');

  it('jedna linia, cudzysłowy z ucieczkami, komentarz; brak pola, pusty blok i brak nagłówka = brak', () => {
    expect(frontmatterText(front('description: Zwykły opis # komentarz'), 'description')).toBe('Zwykły opis');
    expect(frontmatterText(front('argument-hint: "[review-aspects]"'), 'argument-hint')).toBe('[review-aspects]');
    expect(frontmatterText(front(String.raw`description: "Cytat \"w środku\" # nie komentarz"`), 'description'))
      .toBe('Cytat "w środku" # nie komentarz');
    expect(frontmatterText(front("description: 'To ''jest'' opis'"), 'description')).toBe("To 'jest' opis");
    expect(frontmatterText(front('name: x'), 'description')).toBeUndefined();
    expect(frontmatterText(front('description: ""'), 'description')).toBeUndefined();
    expect(frontmatterText(front('description: "bez domknięcia'), 'description')).toBeUndefined();
    expect(frontmatterText('# bez nagłówka\ndescription: x', 'description')).toBeUndefined();
    // Ostatnie wystąpienie klucza wygrywa (jak `frontmatterOf`).
    expect(frontmatterText(front('description: pierwszy', 'description: drugi'), 'description')).toBe('drugi');
  });

  it('wartość na wiele linii: blok `>` i `|`, ciąg dalszy wcięty; lista i mapa pod kluczem to nie tekst', () => {
    // Blok `description: >` z wciętymi liniami, pustą linią i listą pod następnym kluczem (dane zmyślone).
    expect(frontmatterText(front('name: dyskusja', 'description: >', '  Użyj, gdy ktoś pisze "/dyskusja",',
      '  albo chce debaty.', '', 'allowed-tools:', '  - Read'), 'description'))
      .toBe('Użyj, gdy ktoś pisze "/dyskusja", albo chce debaty.');
    expect(frontmatterText(front('description: |-', '  linia pierwsza', '  linia druga'), 'description'))
      .toBe('linia pierwsza linia druga');
    expect(frontmatterText(front('description: początek', '  i ciąg dalszy # uwaga', 'name: x'), 'description'))
      .toBe('początek i ciąg dalszy');
    expect(frontmatterText(front('description: "cytat', '  na dwie linie"'), 'description')).toBe('cytat na dwie linie');
    expect(frontmatterText(front('description:', '  - jeden', '  - dwa'), 'description')).toBeUndefined();
    expect(frontmatterText(front('description:', '  pl: opis'), 'description')).toBeUndefined();
    expect(frontmatterText(front('description:', '  pod kluczem'), 'description')).toBe('pod kluczem');
  });

  it('ucieczki YAML w podwójnym cudzysłowie: `\\u`, `\\x`, `\\U`; nieznana ucieczka = brak pola', () => {
    expect(frontmatterText(front(String.raw`description: "Za\u017c\u00f3\u0142\u0107 \x41 \U0001F600 a\/b \\ \_x"`),
      'description')).toBe('Zażółć A 😀 a/b \\ \u00a0x'.replace(/\s+/g, ' '));
    expect(frontmatterText(front(String.raw`argument-hint: "linia\tdruga\nkoniec"`), 'argument-hint'))
      .toBe('linia druga koniec');
    expect(frontmatterText(front(String.raw`description: "zła \q ucieczka"`), 'description')).toBeUndefined();
    expect(frontmatterText(front(String.raw`description: "ucięte \u01"`), 'description')).toBeUndefined();
    // W apostrofach backslash to zwykły znak.
    expect(frontmatterText(front(String.raw`description: 'C:\temp'`), 'description')).toBe(String.raw`C:\temp`);
  });

  it('komentarz przed listą albo mapą i komentarz po kluczu nie robią z nich tekstu', () => {
    expect(frontmatterText(front('description:', '  # komentarz', '  pl: Opis'), 'description')).toBeUndefined();
    expect(frontmatterText(front('description: # komentarz', '  - pierwszy', '  - drugi'), 'description'))
      .toBeUndefined();
    expect(frontmatterText(front('description: # komentarz', '  zwykły tekst'), 'description')).toBe('zwykły tekst');
    expect(frontmatterText(front('description: # sam komentarz'), 'description')).toBeUndefined();
    // W bloku `>` linia z `#` jest treścią, nie komentarzem.
    expect(frontmatterText(front('description: >', '  # nagłówek', '  treść'), 'description')).toBe('# nagłówek treść');
  });

  it('znaki sterujące wypadają, białe znaki się zwijają, sufit 200 z `…` bez rozcinania pary zastępczej', () => {
    expect(frontmatterText(front('description: a\u001b[31mb\u0007c\td'), 'description')).toBe('a [31mb c d');
    const long = `${'x'.repeat(198)}😀😀`;
    const clipped = frontmatterText(front(`description: ${long}`), 'description') ?? '';
    expect(clipped.length).toBeLessThanOrEqual(COMMAND_TEXT_MAX);
    expect(clipped).toBe(`${'x'.repeat(198)}…`);
    const exact = 'y'.repeat(COMMAND_TEXT_MAX);
    expect(frontmatterText(front(`description: ${exact}`), 'description')).toBe(exact);
  });

  it('skill, komenda i plugin niosą opis do wyniku, druga nazwa ten sam; zbiór nazw bez zmian', async () => {
    await put(join(home, '.claude/skills/przekaz-dir/SKILL.md'),
      front('name: przekaz', 'description: Przekazanie pracy', 'argument-hint: "Na co następna sesja?"'));
    await put(join(home, '.claude/commands/notatka.md'), '# bez frontmattera\n');
    const installed: Record<string, unknown[]> = {};
    await plugin('narzedzia@rynek', { scope: 'user' }, {
      'commands/review-pr.md': front('description: "Przegląd PR"', 'argument-hint: "[aspekty]"'),
      'skills/szkic/SKILL.md': front('description: >', '  Szkic na', '  dwie linie'),
    }, installed);
    const result = discover();
    expect(names(result)).toEqual(['narzedzia:review-pr', 'narzedzia:szkic', 'notatka', 'przekaz', 'przekaz-dir']);
    const by = new Map(result.commands.map((entry) => [entry.name, entry]));
    expect(by.get('przekaz-dir')).toMatchObject({ description: 'Przekazanie pracy', argumentHint: 'Na co następna sesja?' });
    expect(by.get('przekaz')).toMatchObject({ description: 'Przekazanie pracy', argumentHint: 'Na co następna sesja?' });
    expect(by.get('notatka')).toEqual({ name: 'notatka', source: 'skill', origin: 'user-command' });
    expect(by.get('narzedzia:review-pr')).toMatchObject({ description: 'Przegląd PR', argumentHint: '[aspekty]' });
    expect(by.get('narzedzia:szkic')).toMatchObject({ description: 'Szkic na dwie linie' });
    expect(by.get('narzedzia:szkic')).not.toHaveProperty('argumentHint');
  });

  it('migawka: opis w `CatalogCommand`, wbudowane bez opisu; zmiana samego opisu = nowa `revision`', async () => {
    const skill = join(home, '.claude/skills/opisany/SKILL.md');
    await put(skill, front('description: Wersja pierwsza'));
    const first = buildCatalog(repo, discover());
    expect(first.commands.get('opisany')).toMatchObject({ source: 'skill', description: 'Wersja pierwsza' });
    expect(first.commands.get('compact')).toEqual({ name: 'compact', kind: 'local', source: 'builtin' });
    await put(skill, front('description: Wersja druga'));
    const second = buildCatalog(repo, discover());
    expect(second.revision).not.toBe(first.revision);
    expect(buildCatalog(repo, discover()).revision).toBe(second.revision);
  });
});

describe('lista dla apki z migawki (`commandListOf`)', () => {
  it('ta sama `revision`, po nazwie małymi literami, bez aliasów, przekierowań i ścieżek', async () => {
    await put(join(home, '.claude/skills/Zeta/SKILL.md'), skillMd());
    await put(join(home, '.claude/skills/atlas-skill/SKILL.md'), skillMd());
    const catalog = buildCatalog(repo, discover());
    const list = commandListOf(catalog);
    expect(list.revision).toBe(catalog.revision);
    const listed = list.commands.map((entry) => entry.name);
    expect(listed).toEqual([...catalog.commands.keys()].sort().map((key) => catalog.commands.get(key)?.name));
    expect(listed).toContain('Zeta');
    expect(listed.indexOf('atlas-skill')).toBeLessThan(listed.indexOf('Zeta'));
    // Aliasy nie przechodzą przez strażnika, więc nie ma ich na liście.
    expect(listed).not.toContain('new');
    expect(listed).not.toContain('review');
    for (const entry of list.commands) {
      expect(Object.keys(entry).every((key) => ['name', 'kind', 'source', 'description', 'argumentHint'].includes(key)))
        .toBe(true);
      // Każda pozycja listy przechodzi tę samą regułę z tej samej migawki.
      expect(classifySlashText(`/${entry.name}`, catalog), entry.name).toMatchObject({ type: 'command' });
    }
    expect(commandListSchema.parse(list)).toEqual(list);
    expect(JSON.stringify(list)).not.toContain(home);
  });
});

describe('migawka katalogu: `revision`, sygnatura, sprawdzanie co 5 s i pełny skan co 60 s', () => {
  function counted(): { calls: () => number; discover: typeof discoverCommands } {
    let calls = 0;
    return {
      calls: () => calls,
      discover: (opts) => { calls += 1; return discoverCommands(opts); },
    };
  }

  it('ta sama treść = ten sam obiekt i ten sam `revision`; zmiana treści = nowy', async () => {
    let clock = 0;
    const scan = counted();
    const catalogs = createCommandCatalogs({ home, roots: [projects], now: () => clock, discover: scan.discover });
    await put(join(home, '.claude/skills/a/SKILL.md'), skillMd());
    const first = catalogs.get(repo, '2.1.302');
    expect(first.commands.has('a')).toBe(true);
    clock += 1_000;
    expect(catalogs.get(repo, '2.1.302')).toBe(first);
    expect(scan.calls()).toBe(1);
    clock += 60_000;
    expect(catalogs.get(repo, '2.1.302')).toBe(first);
    expect(scan.calls()).toBe(2);
    await put(join(home, '.claude/skills/b/SKILL.md'), skillMd());
    clock += 6_000;
    const second = catalogs.get(repo, '2.1.302');
    expect(second).not.toBe(first);
    expect(second.revision).not.toBe(first.revision);
    expect(second.commands.has('b')).toBe(true);
  });

  it('edycja `SKILL.md` bez zmiany mtime katalogu daje nową migawkę po sprawdzeniu sygnatury', async () => {
    let clock = 0;
    const catalogs = createCommandCatalogs({ home, roots: [projects], now: () => clock });
    const dir = join(home, '.claude/skills/edytowany');
    await put(join(dir, 'SKILL.md'), skillMd());
    const before = catalogs.get(repo, '2.1.302');
    expect(before.commands.has('edytowany')).toBe(true);
    const past = new Date(Date.now() - 3_600_000);
    await utimes(dir, past, past);
    await writeFile(join(dir, 'SKILL.md'), skillMd({ 'user-invocable': 'false' }));
    await utimes(dir, past, past);
    clock += 1_000;
    expect(catalogs.get(repo, '2.1.302')).toBe(before);
    clock += 5_000;
    const after = catalogs.get(repo, '2.1.302');
    expect(after.commands.has('edytowany')).toBe(false);
    expect(after.names.get('edytowany')?.origin).toBe('hidden');
  });

  it('nowy katalog `.claude/skills` w projekcie (ścieżka dotąd nieistniejąca) też zmienia sygnaturę', async () => {
    let clock = 0;
    const catalogs = createCommandCatalogs({ home, roots: [projects], now: () => clock });
    const before = catalogs.get(repo, '2.1.302');
    await put(join(repo, '.claude/skills/nowy/SKILL.md'), skillMd());
    clock += 5_000;
    expect(catalogs.get(repo, '2.1.302')).not.toBe(before);
  });

  it('wersja CLI inna niż zmierzona: zestaw 2.1.302 i jedna linia logu na wersję', () => {
    const log: string[] = [];
    const catalogs = createCommandCatalogs({ home, roots: [projects], log: (line) => log.push(line) });
    const next = catalogs.get(repo, '2.1.400');
    catalogs.get(repo, '2.1.400');
    catalogs.get(repo, null);
    expect(next.cli).toBe('2.1.302');
    expect(next.commands.has('compact')).toBe(true);
    expect(log.filter((line) => line.includes('2.1.400'))).toHaveLength(1);
    expect(log.filter((line) => line.includes('of unknown version'))).toHaveLength(1);
  });

  it('skan, który rzuci, daje migawkę z samego rejestru (fail-closed), a nie wyjątek w bramce wysyłki', () => {
    const log: string[] = [];
    const catalogs = createCommandCatalogs({
      home, roots: [projects], log: (line) => log.push(line),
      discover: () => { throw new TypeError('zepsuty plik'); },
    });
    const catalog = catalogs.get(repo, '2.1.302');
    expect(catalog.cwd).toBeNull();
    expect(catalog.commands.has('compact')).toBe(true);
    expect(log.join('\n')).toMatch(/disk scan .* failed \(TypeError\)/);
  });

  it('notatka skanu idzie do logu raz na proces, nie co pełny skan', async () => {
    let clock = 0;
    const log: string[] = [];
    await put(join(home, '.claude/skills/hooks/SKILL.md'), skillMd());
    const catalogs = createCommandCatalogs({ home, roots: [projects], now: () => clock, log: (line) => log.push(line) });
    catalogs.get(repo, '2.1.302');
    clock += 61_000;
    catalogs.get(repo, '2.1.302');
    expect(log.filter((line) => line.includes('hooks'))).toHaveLength(1);
  });
});
