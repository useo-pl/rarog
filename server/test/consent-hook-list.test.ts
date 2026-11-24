/**
 * Lista hooków `PermissionRequest` sesji: dowód listy hooków dla dowodu ukrytego
 * (`server/src/herdr/dialogs/layer1/hook-list/hook-list.ts`).
 *
 * Zdania, których pilnuje plik:
 *
 * - dowód listy hooków zachodzi, gdy jedynym hookiem `PermissionRequest` we wszystkich warstwach jest hook Raroga:
 *   `--settings` (plik i JSON w argumencie) z samym hookiem Raroga daje `ok`;
 * - brak dowodu listy hooków: plik `--settings` nieobecny, nieczytelny, nie-JSON albo z obcym hookiem; obcy hook
 *   w warstwie użytkownika, projektu, local (także katalog wyżej), managed (plik, dopisek, kopia z serwera),
 *   we włączonej wtyczce, w nagłówku agenta (użytkownika i projektu) albo w skillu; hook Raroga z inną komendą, z `args` albo
 *   innego typu; warstwa nieczytelna; plik albo katalog zmieniony po starcie procesu sesji; preferencje MDM; inny
 *   system; argument wnoszący wtyczki, agentów albo katalogi, w każdym słowie `ps`; proces inny niż w rejestrze;
 *   w nagłówku YAML pliku spoza `.json` każdy ukośnik, tag (linie po wszystkich końcach linii YAML) albo język inny
 *   niż YAML (`hook-escape`); `hooks.JSON` dekodowany jak `.json`;
 * - `--setting-sources` z `ps` (flaga albo tekst promptu, bo `ps` gubi granice argumentów) nie zawęża warstw i zabiera
 *   pewność `false` u użytkownika; wtyczka wyłączona w `enabledPlugins` warstwy ładowanej na pewno nie liczy się;
 *   zapis synchronizacji koszyka z claude.ai i znaczniki `.in_use` wtyczki zmieniają się bez utraty dowodu;
 * - werdykt sesji dotyczy próśb, których hook wystartował przed odczytem: prośba późniejsza liczy werdykt od nowa,
 *   prośba wątku głównego nie pyta listy;
 * - a negative verdict lasts by its kind (the hook list proof contract): a durable one (`changed:`, `foreign:`…)
 *   lives 30 s, a transient one (`io:`, `no-process`…) is read again after 2 s, and a code outside both lists
 *   lives 30 s;
 * - a verdict holds only for the session process it was read for (pid and registry start) and for the `cwd` of the
 *   requests it was read for: a session restarted under the same id and a call with another `cwd`, also one made
 *   while another read runs, get a read of their own.
 *
 * Dysk i `ps` to atrapa w pamięci (`HookListIo`); moduł niczego nie zapisuje, więc atrapa nie ma zapisu.
 * Odczyt prawdziwego dysku (`nodeHookListIo.readFile`) idzie przez `safe-read.ts`: FIFO pod nazwą pliku
 * ustawień to błąd `EFTYPE` od razu, plik ponad sufit `EFBIG`, brak pliku `null` (test na katalogu w `$TMPDIR`).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HOOK_LIST_MAX_FILE_BYTES, HOOK_LIST_RETRY_MS, HOOK_LIST_TRANSIENT_RETRY_MS, createSessionHookList,
  frontmatterEscapeLine, hookListVerdictKind, nodeHookListIo, parseClaudeArgs, sessionHookVerdict,
} from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import type {
  HookListInput, HookListIo, HookListProcess, HookListVerdict,
} from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CLAUDE, CWD, HOME, MANAGED, NOW, OLD, PID, PROCESS_START, RAROG, REGISTRY_START, SESSION, UST, fake,
  foreignLayer, input, ioOf, put, rarogLayer, sessionIo,
} from './helpers/hook-list-io.ts';
import type { Fake, SessionProcess } from './helpers/hook-list-io.ts';

/** Scena z `--settings` z samym hookiem Raroga (jak sesje pomiarowe) i podanymi zmianami. */
async function verdict(setup: (f: Fake) => void = () => {}, over: Partial<HookListInput> = {}): Promise<HookListVerdict> {
  const f = fake();
  put(f, UST, rarogLayer());
  setup(f);
  return sessionHookVerdict(input(over), ioOf(f));
}

const no = (why: string | RegExp): unknown => ({ ok: false, why: typeof why === 'string' ? why : expect.stringMatching(why) });

describe('werdykt listy hooków jednej sesji', () => {
  it('`--settings` z samym hookiem Raroga, inne warstwy puste: dowód listy hooków zachodzi', async () => {
    expect(await verdict()).toEqual({ ok: true });
  });

  it('hook Raroga także w warstwie użytkownika i projektu: dowód listy hooków zachodzi', async () => {
    expect(await verdict((f) => {
      put(f, `${CLAUDE}/settings.json`, { ...rarogLayer(), permissions: { allow: ['Bash(ls:*)'] } });
      put(f, `${CWD}/.claude/settings.json`, rarogLayer());
    })).toEqual({ ok: true });
  });

  it('`--settings` jako JSON w argumencie (ze spacjami) z samym hookiem Raroga: dowód listy hooków zachodzi', async () => {
    const f = fake({ args: `claude --model sonnet --settings ${JSON.stringify(rarogLayer())} --verbose` });
    expect(f.proc?.args).toContain(' ');
    expect(await sessionHookVerdict(input(), ioOf(f))).toEqual({ ok: true });
  });

  it.each([
    ['plik nieobecny', (f: Fake): void => { f.files.delete(UST); }, 'settings-file'],
    ['plik nieczytelny', (f: Fake): void => { f.errors.set(UST, 'EACCES'); }, 'io:EACCES'],
    ['plik nie-JSON', (f: Fake): void => { put(f, UST, '{"hooks":'); }, /^unparseable:/],
    ['plik JSON, ale nie obiekt', (f: Fake): void => { put(f, UST, '[1]'); }, /^unparseable:/],
    ['obcy hook w pliku', (f: Fake): void => { put(f, UST, foreignLayer()); }, 'foreign:flag'],
    ['obcy hook obok hooka Raroga', (f: Fake): void => {
      put(f, UST, { hooks: { PermissionRequest: [
        { matcher: '*', hooks: [{ type: 'command', command: RAROG }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/echo allow' }] },
      ] } });
    }, 'foreign:flag'],
    ['hook Raroga z `args`', (f: Fake): void => { put(f, UST, rarogLayer(RAROG, { args: ['--x'] })); }, 'foreign:flag'],
    ['hook typu `http` z komendą Raroga', (f: Fake): void => {
      put(f, UST, rarogLayer(RAROG, { type: 'http' }));
    }, 'foreign:flag'],
    ['hook Raroga w starszej postaci komendy', (f: Fake): void => {
      put(f, UST, rarogLayer(RAROG.replace(/--answer-wait=\d+/, '--answer-wait=1')));
    }, 'foreign:flag'],
    ['`hooks` w złym kształcie', (f: Fake): void => { put(f, UST, { hooks: { PermissionRequest: {} } }); }, 'hooks-shape:flag'],
  ])('`--settings`: %s → brak dowodu listy hooków', async (_opis, setup, why) => {
    expect(await verdict(setup)).toEqual(no(why));
  });

  it.each([
    ['użytkownika', `${CLAUDE}/settings.json`, 'foreign:user'],
    ['użytkownika (local)', `${CLAUDE}/settings.local.json`, 'foreign:user'],
    ['projektu', `${CWD}/.claude/settings.json`, 'foreign:project'],
    ['local w `cwd`', `${CWD}/.claude/settings.local.json`, 'foreign:local'],
    ['local w katalogu wyżej (korzeń repozytorium)', '/w/repo/.claude/settings.local.json', 'foreign:local'],
    ['managed', `${MANAGED}/managed-settings.json`, 'foreign:managed'],
    ['managed, dopisek `managed-settings.d`', `${MANAGED}/managed-settings.d/10-firma.json`, 'foreign:managed'],
    ['managed, kopia ustawień z serwera', `${CLAUDE}/remote-settings.json`, 'foreign:managed'],
  ])('obcy hook w warstwie %s → brak dowodu listy hooków', async (_opis, file, why) => {
    expect(await verdict((f) => { put(f, file, foreignLayer()); })).toEqual(no(why));
  });

  it('obcy hook w `settings.json` katalogu wyżej niż `cwd` (projekt czyta tylko `cwd`): dowód listy hooków zachodzi', async () => {
    expect(await verdict((f) => { put(f, '/w/repo/.claude/settings.json', foreignLayer()); })).toEqual({ ok: true });
  });

  it('obcy hook w `cwd` prośby innym niż `cwd` sesji z rejestru → brak dowodu listy hooków', async () => {
    expect(await verdict((f) => { put(f, '/w/inny/.claude/settings.json', foreignLayer()); }, { cwds: [CWD, '/w/inny'] }))
      .toEqual(no('foreign:project'));
  });

  // `ps` skleja argumenty spacją, więc prompt podany jako jeden argument („… --setting-sources user …”) wygląda jak
  // flaga: odczytana z `ps` nie zawęża warstw, sprawdzane są wszystkie.
  it.each([
    ['prawdziwa flaga `--setting-sources project,local`, obcy hook użytkownika',
      `claude --setting-sources project,local --settings ${UST}`, `${CLAUDE}/settings.json`, 'foreign:user'],
    ['prompt jako jeden argument z tekstem `--setting-sources user`, obcy hook projektu',
      `claude czemu --setting-sources user pomija projekt? --settings ${UST}`, `${CWD}/.claude/settings.json`,
      'foreign:project'],
    ['tekst `--setting-sources=user` w prompcie, obcy hook local',
      `claude -p opisz --setting-sources=user --settings ${UST}`, `${CWD}/.claude/settings.local.json`, 'foreign:local'],
  ])('`--setting-sources` z `ps` nie zawęża warstw: %s → brak dowodu listy hooków', async (_opis, args, file, why) => {
    const f = fake({ args });
    put(f, UST, rarogLayer());
    put(f, file, foreignLayer());
    expect(await sessionHookVerdict(input(), ioOf(f))).toEqual(no(why));
  });

  it.each([
    ['warstwa nieczytelna (użytkownik)', (f: Fake): void => { f.errors.set(`${CLAUDE}/settings.json`, 'EACCES'); }, 'io:EACCES'],
    ['warstwa nie-JSON (projekt)', (f: Fake): void => { put(f, `${CWD}/.claude/settings.json`, 'hooks: {'); }, /^unparseable:/],
    ['katalog agentów nieczytelny', (f: Fake): void => {
      f.dirs.add(`${CLAUDE}/agents`);
      f.errors.set(`${CLAUDE}/agents`, 'EPERM');
    }, 'io:EPERM'],
  ])('%s → brak dowodu listy hooków', async (_opis, setup, why) => {
    expect(await verdict(setup)).toEqual(no(why));
  });

  describe('git worktree: warstwy i definicje głównego checkoutu', () => {
    const MAIN = '/w/glowny';
    const WT = '/w/drzewa/funkcja';
    const GITDIR = `${MAIN}/.git/worktrees/funkcja`;
    /** Worktree poza drzewem głównego checkoutu (`git worktree add ../drzewa/funkcja`). */
    const linked = (f: Fake): void => {
      put(f, `${MAIN}/.git/HEAD`, 'ref: refs/heads/main\n');
      put(f, `${GITDIR}/HEAD`, 'ref: refs/heads/funkcja\n');
      put(f, `${GITDIR}/commondir`, '../..\n');
      put(f, `${WT}/.git`, `gitdir: ${GITDIR}\n`);
    };
    const inWorktree = async (setup: (f: Fake) => void, cwds: readonly string[] = [WT]): Promise<HookListVerdict> => {
      const f = fake({ cwd: WT });
      put(f, UST, rarogLayer());
      linked(f);
      setup(f);
      return sessionHookVerdict(input({ cwds }), ioOf(f));
    };

    it('obcy hook w `settings.local.json` głównego checkoutu (worktree poza jego drzewem) → brak dowodu listy hooków', async () => {
      expect(await inWorktree((f) => { put(f, `${MAIN}/.claude/settings.local.json`, foreignLayer()); }))
        .toEqual(no('foreign:local'));
    });

    it('czysty główny checkout: dowód listy hooków zachodzi', async () => {
      expect(await inWorktree(() => {})).toEqual({ ok: true });
    });

    it.each([
      ['`gitdir` względny', (f: Fake): void => {
        put(f, `${WT}/.git`, 'gitdir: ../../glowny/.git/worktrees/funkcja\n');
      }, [WT]],
      ['prośba z podkatalogu worktree', (): void => {}, [`${WT}/server`]],
    ])('%s: obcy hook w local głównego checkoutu → brak dowodu listy hooków', async (_opis, setup, cwds) => {
      expect(await inWorktree((f) => {
        setup(f);
        put(f, `${MAIN}/.claude/settings.local.json`, foreignLayer());
      }, cwds)).toEqual(no('foreign:local'));
    });

    it.each([
      ['`settings.json` projektu', `${MAIN}/.claude/settings.json`, foreignLayer(), 'foreign:project'],
      ['skill', `${MAIN}/.claude/skills/zgody/SKILL.md`, '---\nhooks:\n  PermissionRequest: []\n---\n',
        `hook-in:${MAIN}/.claude/skills/zgody/SKILL.md`],
      ['agent', `${MAIN}/.claude/agents/a.md`, '---\nhooks:\n  PermissionRequest: []\n---\n',
        `hook-in:${MAIN}/.claude/agents/a.md`],
    ])('obcy hook w głównym checkoucie: %s → brak dowodu listy hooków', async (_opis, file, value, why) => {
      expect(await inWorktree((f) => { put(f, file, value); })).toEqual(no(why));
    });

    it.each([
      ['`.git` bez linii `gitdir:`', (f: Fake): void => { put(f, `${WT}/.git`, 'nic\n'); }, `worktree:${WT}/.git`],
      ['`.git` z dwiema liniami', (f: Fake): void => {
        put(f, `${WT}/.git`, `gitdir: ${GITDIR}\ngitdir: /w/inny/.git\n`);
      }, `worktree:${WT}/.git`],
      ['`gitdir` nie istnieje', (f: Fake): void => { put(f, `${WT}/.git`, 'gitdir: /w/brak/.git/worktrees/x\n'); },
        `worktree:${WT}/.git`],
      ['wspólny katalog repozytorium bez `.git` w nazwie (repozytorium bare)', (f: Fake): void => {
        put(f, '/w/goly.git/HEAD', 'ref: refs/heads/main\n');
        put(f, '/w/goly.git/worktrees/funkcja/commondir', '../..\n');
        put(f, `${WT}/.git`, 'gitdir: /w/goly.git/worktrees/funkcja\n');
      }, `worktree:${WT}/.git`],
      ['`.git` zmieniony po starcie sesji', (f: Fake): void => { f.changed.set(`${WT}/.git`, NOW - 1_000); },
        `changed:${WT}/.git`],
      ['`commondir` zmieniony po starcie sesji', (f: Fake): void => {
        f.changed.set(`${GITDIR}/commondir`, NOW - 1_000);
      }, `changed:${GITDIR}/commondir`],
    ])('%s → brak dowodu listy hooków', async (_opis, setup, why) => {
      expect(await inWorktree(setup)).toEqual(no(why));
    });

    it('`.git` jako plik bez `commondir` (submoduł): korzeń repozytorium to katalog z `.git`, dowód listy hooków zachodzi', async () => {
      expect(await inWorktree((f) => {
        put(f, `${MAIN}/.git/modules/funkcja/HEAD`, 'ref: refs/heads/main\n');
        put(f, `${WT}/.git`, `gitdir: ${MAIN}/.git/modules/funkcja\n`);
        put(f, `${MAIN}/.claude/settings.local.json`, foreignLayer());
      })).toEqual({ ok: true });
    });

    it('zwykły checkout (`.git` to katalog): bez głównego checkoutu, dowód listy hooków zachodzi', async () => {
      expect(await verdict((f) => {
        put(f, '/w/repo/.git/HEAD', 'ref: refs/heads/main\n');
        f.changed.set('/w/repo/.git', NOW - 1_000);
        put(f, `${MAIN}/.claude/settings.local.json`, foreignLayer());
      })).toEqual({ ok: true });
    });
  });

  describe('dowiązania na ścieżce', () => {
    it('katalog `--settings` jest dowiązaniem przełączonym po starcie sesji na starszy, czysty katalog → brak dowodu listy hooków',
      async () => {
        expect(await verdict((f) => {
          f.files.delete(UST);
          put(f, '/opt/rarog/v1/prod.json', foreignLayer());
          put(f, '/opt/rarog/v2/prod.json', rarogLayer());
          f.links.set('/etc/rarog-test', '/opt/rarog/v2');
          f.changed.set('/etc/rarog-test', NOW - 1_000);
        })).toEqual(no('changed:/etc/rarog-test'));
      });

    it('pośrednie dowiązanie w łańcuchu zmienione po starcie sesji → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        f.files.delete(UST);
        put(f, '/opt/rarog/v2.json', rarogLayer());
        f.links.set(UST, '/opt/rarog/current.json');
        f.links.set('/opt/rarog/current.json', 'v2.json');
        f.changed.set('/opt/rarog/current.json', NOW - 1_000);
      })).toEqual(no('changed:/opt/rarog/current.json'));
    });

    it('dowiązanie w drzewie agentów przełączone po starcie sesji → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        put(f, '/w/wspolni/a.md', '---\nname: a\n---\n');
        f.links.set(`${CLAUDE}/agents/wspolni`, '/w/wspolni');
        f.changed.set(`${CLAUDE}/agents/wspolni`, NOW - 1_000);
      })).toEqual(no(`changed:${CLAUDE}/agents/wspolni`));
    });

    it('dowiązania jak w dotfiles, niezmienione od startu (także względne): dowód listy hooków zachodzi, treść z celu', async () => {
      const dotfiles = (f: Fake): void => {
        put(f, `${HOME}/dotfiles/claude/settings.json`, { permissions: { allow: ['Bash(ls:*)'] } });
        put(f, `${HOME}/dotfiles/claude/skills/a/SKILL.md`, '---\nname: a\n---\n');
        f.links.set(`${CLAUDE}/settings.json`, '../dotfiles/claude/settings.json');
        f.links.set(`${CLAUDE}/skills`, `${HOME}/dotfiles/claude/skills`);
      };
      expect(await verdict(dotfiles)).toEqual({ ok: true });
      expect(await verdict((f) => {
        dotfiles(f);
        put(f, `${HOME}/dotfiles/claude/settings.json`, foreignLayer());
      })).toEqual(no('foreign:user'));
      expect(await verdict((f) => {
        dotfiles(f);
        put(f, `${HOME}/dotfiles/claude/skills/b/SKILL.md`, '---\nhooks:\n  PermissionRequest: []\n---\n');
      })).toEqual(no(`hook-in:${CLAUDE}/skills/b/SKILL.md`));
    });

    it.each([
      ['dowiązanie na siebie', (f: Fake): void => { f.links.set(UST, UST); }],
      ['katalog z dowiązaniem do przodka', (f: Fake): void => { f.links.set(`${CLAUDE}/agents/petla`, '..'); }],
    ])('%s → brak dowodu listy hooków', async (_opis, setup) => {
      expect(await verdict(setup)).toEqual(no(/^loop:/));
    });
  });

  describe('wtyczki', () => {
    const ID = 'straznik@rynek';
    const ROOT = `${CLAUDE}/plugins/cache/rynek/straznik/1.0.0`;
    const KNOWN = `${CLAUDE}/plugins/known_marketplaces.json`;
    const MARKET = `${CLAUDE}/plugins/marketplaces/rynek`;
    const CATALOG = `${MARKET}/.claude-plugin/marketplace.json`;
    const HOOKS = { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/echo allow' }] }] };
    /** Wpis rejestru marketplace'ów (`known_marketplaces.json`) dla kopii z GitHuba. */
    const market = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      source: { source: 'github', repo: 'firma/rynek' }, installLocation: MARKET,
      lastUpdated: new Date(OLD).toISOString(), ...over,
    });
    /** `marketplace.json` z wpisem wtyczki (pola wpisu z `entry`) i innymi wpisami. */
    const catalog = (entry: Record<string, unknown> = {}, more: readonly unknown[] = []): Record<string, unknown> => ({
      name: 'rynek', owner: { name: 'firma' },
      plugins: [{ name: 'straznik', source: './plugins/straznik', ...entry }, ...more],
    });
    const installed = (f: Fake): void => {
      put(f, `${CLAUDE}/plugins/installed_plugins.json`, { version: 2, plugins: { [ID]: [{ installPath: ROOT }] } });
      put(f, `${ROOT}/.claude-plugin/plugin.json`, { name: 'straznik' });
      put(f, KNOWN, { rynek: market() });
      put(f, CATALOG, catalog());
    };
    const withHook = (f: Fake): void => {
      installed(f);
      put(f, `${ROOT}/hooks/hooks.json`, { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    };

    it('czysty `plugin.json`, obcy `PermissionRequest` tylko we wpisie marketplace → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, CATALOG, catalog({ hooks: HOOKS }));
      })).toEqual(no(`hook-in:${CATALOG}`));
    });

    it('hook we wpisie innej, niezainstalowanej wtyczki tego marketplace: dowód listy hooków zachodzi', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, CATALOG, catalog({}, [{ name: 'inna', source: './plugins/inna', hooks: HOOKS }]));
      })).toEqual({ ok: true });
    });

    it.each([
      ['marketplace spoza `known_marketplaces.json`', (f: Fake): void => { put(f, KNOWN, {}); }, 'marketplace-unknown:rynek'],
      ['brak `known_marketplaces.json`', (f: Fake): void => { f.files.delete(KNOWN); }, 'marketplace-unknown:rynek'],
      ['źródło `url` (miejsce pobranego pliku poza dokumentacją)', (f: Fake): void => {
        put(f, KNOWN, { rynek: market({ source: { source: 'url', url: 'https://example.invalid/marketplace.json' } }) });
      }, 'marketplace-source:rynek'],
      ['kopia `github` poza `plugins/marketplaces/`', (f: Fake): void => {
        put(f, KNOWN, { rynek: market({ installLocation: '/opt/rynek' }) });
      }, 'marketplace-source:rynek'],
      ['brak pliku marketplace', (f: Fake): void => { f.files.delete(CATALOG); }, 'marketplace-missing:rynek'],
      ['brak wpisu wtyczki w pliku marketplace', (f: Fake): void => {
        put(f, CATALOG, { ...catalog(), plugins: [] });
      }, `marketplace-entry:${ID}`],
      ['dwa wpisy o nazwie wtyczki', (f: Fake): void => {
        put(f, CATALOG, catalog({}, [{ name: 'straznik', source: './plugins/drugi' }]));
      }, `marketplace-entry:${ID}`],
      ['plik marketplace zmieniony po starcie sesji', (f: Fake): void => {
        f.changed.set(CATALOG, NOW - 1_000);
      }, `changed:${CATALOG}`],
    ])('wpis marketplace: %s → brak dowodu listy hooków', async (_opis, setup, why) => {
      expect(await verdict((f) => {
        installed(f);
        setup(f);
      })).toEqual(no(why));
    });

    it('`known_marketplaces.json` przepisany po starcie sesji (odświeżenie `lastUpdated`): dowód listy hooków zachodzi', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, KNOWN, { rynek: market({ lastUpdated: new Date(NOW - 1_000).toISOString() }) });
        f.changed.set(KNOWN, NOW - 1_000);
      })).toEqual({ ok: true });
    });

    it('dowiązanie `known_marketplaces.json` przełączone po starcie sesji na starszy plik → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        installed(f);
        f.files.delete(KNOWN);
        put(f, '/opt/rynki/v1.json', { rynek: market() });
        f.links.set(KNOWN, '/opt/rynki/v1.json');
        f.changed.set(KNOWN, NOW - 1_000);
      })).toEqual(no(`changed:${KNOWN}`));
    });

    it('źródło `git` z plikiem pod `path` źródła: czysty wpis daje dowód, hook we wpisie → brak dowodu listy hooków', async () => {
      const ALT = `${MARKET}/meta/rynek.json`;
      const git = (f: Fake): void => {
        installed(f);
        f.files.delete(CATALOG);
        put(f, KNOWN, { rynek: market({ source: { source: 'git', url: 'https://example.invalid/rynek.git', path: 'meta/rynek.json' } }) });
        put(f, ALT, catalog());
      };
      expect(await verdict(git)).toEqual({ ok: true });
      expect(await verdict((f) => {
        git(f);
        put(f, ALT, catalog({ hooks: HOOKS }));
      })).toEqual(no(`hook-in:${ALT}`));
    });

    describe('marketplace z katalogu lokalnego (wtyczka ze ścieżką względną ładuje się w miejscu)', () => {
      const LOCAL = '/w/rynek-lokalny';
      const LOCAL_CATALOG = `${LOCAL}/.claude-plugin/marketplace.json`;
      const SOURCE = `${LOCAL}/plugins/straznik`;
      const local = (f: Fake, record: Record<string, unknown> = {}): void => {
        installed(f);
        put(f, KNOWN, { rynek: market({ source: { source: 'directory', path: LOCAL }, installLocation: LOCAL, ...record }) });
        put(f, LOCAL_CATALOG, catalog());
        put(f, `${SOURCE}/.claude-plugin/plugin.json`, { name: 'straznik' });
      };

      it('czysty katalog źródłowy: dowód listy hooków zachodzi', async () => {
        expect(await verdict((f) => { local(f); })).toEqual({ ok: true });
      });

      it('hook w katalogu źródłowym (kopia w cache czysta) → brak dowodu listy hooków', async () => {
        expect(await verdict((f) => {
          local(f);
          put(f, `${SOURCE}/hooks/hooks.json`, { hooks: HOOKS });
        })).toEqual(no(`hook-in:${SOURCE}/hooks/hooks.json`));
      });

      it('nazwa gołą pod `metadata.pluginRoot`: katalog źródłowy pod korzeniem wtyczek', async () => {
        expect(await verdict((f) => {
          local(f);
          put(f, LOCAL_CATALOG, { ...catalog({ source: 'straznik' }), metadata: { pluginRoot: './plugins' } });
          put(f, `${SOURCE}/hooks/hooks.json`, { hooks: HOOKS });
        })).toEqual(no(`hook-in:${SOURCE}/hooks/hooks.json`));
      });

      it.each([
        ['wpis odświeżony po starcie sesji (`lastUpdated`)', (f: Fake): void => {
          local(f, { lastUpdated: new Date(NOW - 1_000).toISOString() });
        }, 'marketplace-changed:rynek'],
        ['ścieżka wpisu wychodzi poza marketplace', (f: Fake): void => {
          local(f);
          put(f, LOCAL_CATALOG, catalog({ source: './../obok' }));
        }, `marketplace-entry:${ID}`],
        ['brak katalogu źródłowego', (f: Fake): void => {
          local(f);
          f.files.delete(`${SOURCE}/.claude-plugin/plugin.json`);
        }, `plugin-missing:${ID}`],
        ['`installLocation` inny niż ścieżka źródła', (f: Fake): void => {
          local(f, { installLocation: '/w/inny' });
        }, 'marketplace-source:rynek'],
      ])('%s → brak dowodu listy hooków', async (_opis, setup, why) => {
        expect(await verdict(setup)).toEqual(no(why));
      });
    });

    // Warstwa użytkownika mogła nie być ładowana, gdy `ps` gdziekolwiek ma `--setting-sources` (flaga albo tekst promptu).
    it.each([
      ['prawdziwa flaga `--setting-sources project,local`', `claude --setting-sources project,local --settings ${UST}`],
      ['tekst `--setting-sources user` w prompcie', `claude opisz --setting-sources user --settings ${UST}`],
    ])('%s: `false` u użytkownika nie wyłącza wtyczki → brak dowodu listy hooków', async (_opis, args) => {
      const f = fake({ args });
      put(f, UST, rarogLayer());
      withHook(f);
      put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { [ID]: false } });
      expect(await sessionHookVerdict(input(), ioOf(f))).toEqual(no(`hook-in:${ROOT}/hooks/hooks.json`));
    });

    it('`false` tylko w warstwie projektu (`cwd` prośby to nadzbiór warstw ładowanych) nie wyłącza wtyczki → brak dowodu listy hooków',
      async () => {
        expect(await verdict((f) => {
          withHook(f);
          put(f, `${CWD}/.claude/settings.json`, { enabledPlugins: { [ID]: false } });
        })).toEqual(no(`hook-in:${ROOT}/hooks/hooks.json`));
      });

    it('`false` w `--settings` (warstwa ładowana na pewno) wyłącza wtyczkę z hookiem: dowód listy hooków zachodzi', async () => {
      expect(await verdict((f) => {
        withHook(f);
        put(f, UST, { ...rarogLayer(), enabledPlugins: { [ID]: false } });
      })).toEqual({ ok: true });
    });

    it('`false` w `--settings` przy `--setting-sources project,local` (sesja pomiarowa) wyłącza wtyczkę: dowód listy hooków zachodzi',
      async () => {
        const f = fake({ args: `claude --setting-sources project,local --settings ${UST}` });
        put(f, UST, { ...rarogLayer(), enabledPlugins: { [ID]: false } });
        withHook(f);
        expect(await sessionHookVerdict(input(), ioOf(f))).toEqual({ ok: true });
      });

    it.each([
      // Managed: domyślnie działa tylko najwyższe źródło z kluczem polityki (`first-wins`), więc plik może nie działać.
      ['managed', `${MANAGED}/managed-settings.json`],
      ['użytkownika (`settings.local.json`)', `${CLAUDE}/settings.local.json`],
      ['local', `${CWD}/.claude/settings.local.json`],
    ])('`false` tylko w warstwie %s (nie na pewno ładowanej) nie wyłącza wtyczki → brak dowodu listy hooków', async (_opis, file) => {
      expect(await verdict((f) => {
        withHook(f);
        put(f, file, { enabledPlugins: { [ID]: false } });
      })).toEqual(no(`hook-in:${ROOT}/hooks/hooks.json`));
    });

    it('`false` u użytkownika, `true` w local: włączona → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        withHook(f);
        put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { [ID]: false } });
        put(f, `${CWD}/.claude/settings.local.json`, { enabledPlugins: { [ID]: true } });
      })).toEqual(no(`hook-in:${ROOT}/hooks/hooks.json`));
    });

    it('`true` u użytkownika przy `--setting-sources project` liczy się (źródła z `ps` nie zawężają) → brak dowodu listy hooków',
      async () => {
        const f = fake({ args: `claude --setting-sources project --settings ${UST}` });
        put(f, UST, rarogLayer());
        put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { 'inna@rynek': true } });
        expect(await sessionHookVerdict(input(), ioOf(f))).toEqual(no('plugin-unknown:inna@rynek'));
      });

    it('zainstalowana bez wzmianki w `enabledPlugins` (domyślnie włączona) z hookiem → brak dowodu listy hooków', async () => {
      expect(await verdict(withHook)).toEqual(no(`hook-in:${ROOT}/hooks/hooks.json`));
    });

    it('włączona w warstwie użytkownika z hookiem w `plugin.json` (słowo zakodowane w JSON) → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, `${ROOT}/.claude-plugin/plugin.json`, '{"hooks":{"Permission\\u0052equest":[]}}');
        put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { [ID]: true } });
      })).toEqual(no(`hook-in:${ROOT}/.claude-plugin/plugin.json`));
    });

    it('`hooks/hooks.JSON` (APFS nie rozróżnia wielkości liter) dekodowany jak `.json` → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, `${ROOT}/hooks/hooks.JSON`, '{"hooks":{"Permission\\u0052equest":[]}}');
      })).toEqual(no(`hook-in:${ROOT}/hooks/hooks.JSON`));
    });

    it('agent wtyczki z kluczem zdarzenia przez ucieczkę w nagłówku → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, `${ROOT}/agents/a.md`, '---\nname: a\nhooks:\n  "Permission\\u0052equest": []\n---\n');
      })).toEqual(no(`hook-escape:${ROOT}/agents/a.md`));
    });

    it('wyłączona we wszystkich warstwach (`false`) z hookiem: dowód listy hooków zachodzi', async () => {
      expect(await verdict((f) => {
        withHook(f);
        put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { [ID]: false } });
      })).toEqual({ ok: true });
    });

    it('`settings.json` użytkownika jako dowiązanie do `plik/` (ENOTDIR): jego `false` nie wyłącza wtyczki → brak dowodu listy hooków',
      async () => {
        const user = (target: string) => (f: Fake): void => {
          withHook(f);
          put(f, '/config/user.json', { enabledPlugins: { [ID]: false } });
          f.links.set(`${CLAUDE}/settings.json`, target);
        };
        expect(await verdict(user('/config/user.json'))).toEqual({ ok: true });
        expect(await verdict(user('/config/user.json/'))).toEqual(no(`hook-in:${ROOT}/hooks/hooks.json`));
      });

    it('włączona w `--settings` mimo `false` u użytkownika (zbiór wzmianek) → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => {
        withHook(f);
        put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { [ID]: false } });
        put(f, UST, { ...rarogLayer(), enabledPlugins: { [ID]: true } });
      })).toEqual(no(/^hook-in:/));
    });

    it('włączona bez wpisu instalacji → brak dowodu listy hooków', async () => {
      expect(await verdict((f) => { put(f, `${CLAUDE}/settings.json`, { enabledPlugins: { 'inna@rynek': true } }); }))
        .toEqual(no('plugin-unknown:inna@rynek'));
    });

    it('bez hooka, znacznik `.in_use` zmieniony po starcie sesji: dowód listy hooków zachodzi', async () => {
      expect(await verdict((f) => {
        installed(f);
        put(f, `${ROOT}/.in_use/${PID}`, '');
        f.changed.set(`${ROOT}/.in_use`, NOW - 1_000);
        f.changed.set(`${ROOT}/.in_use/${PID}`, NOW - 1_000);
      })).toEqual({ ok: true });
    });

    it('plik wtyczki zmieniony po starcie sesji → brak dowodu listy hooków do restartu', async () => {
      expect(await verdict((f) => {
        installed(f);
        f.changed.set(`${ROOT}/.claude-plugin/plugin.json`, NOW - 1_000);
      })).toEqual(no(`changed:${ROOT}/.claude-plugin/plugin.json`));
    });

    it('wtyczka z claude.ai (`plugins/synced`): hook → brak dowodu listy hooków; zapis koszyka zmieniony po starcie: dowód listy hooków zachodzi',
      async () => {
        const BUCKET = `${CLAUDE}/plugins/synced/koszyk`;
        const sync = (f: Fake): void => {
          put(f, `${BUCKET}/manifest.json`, { items: ['p'] });
          put(f, `${BUCKET}/.last-complete-round`, '7');
          put(f, `${BUCKET}/p/.claude-plugin/plugin.json`, { name: 'p' });
          for (const p of [`${CLAUDE}/plugins/synced`, BUCKET, `${BUCKET}/manifest.json`, `${BUCKET}/.last-complete-round`]) {
            f.changed.set(p, NOW - 1_000);
          }
        };
        expect(await verdict(sync)).toEqual({ ok: true });
        expect(await verdict((f) => {
          sync(f);
          put(f, `${BUCKET}/p/hooks/hooks.json`, { hooks: { PermissionRequest: [] } });
        })).toEqual(no(`hook-in:${BUCKET}/p/hooks/hooks.json`));
        expect(await verdict((f) => {
          sync(f);
          f.changed.set(`${BUCKET}/p/.claude-plugin/plugin.json`, NOW - 1_000);
        })).toEqual(no(/^changed:/));
        // Plik koszyka bez sprawdzenia startu, ale dowiązanie do niego przełączone po starcie: brak dowodu listy hooków.
        expect(await verdict((f) => {
          sync(f);
          f.files.delete(`${BUCKET}/manifest.json`);
          put(f, '/opt/koszyk/manifest.json', { items: ['p'] });
          f.links.set(`${BUCKET}/manifest.json`, '/opt/koszyk/manifest.json');
        })).toEqual(no(`changed:${BUCKET}/manifest.json`));
      });
  });

  it.each([
    ['nagłówek agenta użytkownika', `${CLAUDE}/agents/recenzent.md`],
    ['nagłówek agenta projektu', `${CWD}/.claude/agents/recenzent.md`],
    ['nagłówek agenta w katalogu wyżej', '/w/repo/.claude/agents/recenzent.md'],
    ['skill użytkownika', `${CLAUDE}/skills/zgody/SKILL.md`],
    ['skill z claude.ai (`skills/synced`)', `${CLAUDE}/skills/synced/koszyk/zgody/SKILL.md`],
    ['komenda projektu', `${CWD}/.claude/commands/zgoda.md`],
  ])('obcy hook: %s → brak dowodu listy hooków', async (_opis, file) => {
    const md = '---\nname: x\nhooks:\n  PermissionRequest:\n    - hooks:\n        - type: command\n          command: ./ok.sh\n---\n';
    expect(await verdict((f) => { put(f, file, md); })).toEqual(no(`hook-in:${file}`));
  });

  it('agent bez hooków: dowód listy hooków zachodzi', async () => {
    expect(await verdict((f) => { put(f, `${CLAUDE}/agents/recenzent.md`, '---\nname: recenzent\n---\nCzytaj kod.\n'); }))
      .toEqual({ ok: true });
  });

  describe('nagłówek YAML pliku spoza `.json`: słowo `PermissionRequest` bez dosłownego zapisu', () => {
    /** Nagłówek z obcym hookiem; klucz zdarzenia w zapisie `key` (YAML dekoduje go do `PermissionRequest`). */
    const md = (key: string, head = '---\n'): string => `${head}name: x\ndescription: Obcy hook\nhooks:\n  ${key}:\n`
      + '    - hooks:\n        - type: command\n          command: ./ok.sh\n---\nTreść.\n';
    /** To samo z kluczem jawnym (`? klucz`): klucz wieloliniowy albo z tagiem. */
    const explicit = (key: string): string => `---\nname: x\nhooks:\n  ? ${key}\n  : - hooks:\n`
      + '        - type: command\n          command: ./ok.sh\n---\n';
    const SKILL = `${CLAUDE}/skills/zgody/SKILL.md`;
    const AGENT = `${CWD}/.claude/agents/recenzent.md`;

    it.each([
      ['skill, klucz przez ucieczkę `\\u`', SKILL, md('"Permission\\u0052equest"')],
      ['definicja agenta, klucz przez ucieczkę `\\u`', AGENT, md('"Permission\\u0052equest"')],
      ['klucz przez `\\x50`', SKILL, md('"\\x50ermissionRequest"')],
      ['klucz przez `\\U`', AGENT, md('"Permission\\U00000052equest"')],
      ['klucz sklejony ukośnikiem przed końcem linii', SKILL, explicit('"Permission\\\n    Request"')],
      ['klucz `hooks` przez ucieczkę, zdarzenie przez ucieczkę', AGENT,
        '---\nname: x\n"\\x68ooks":\n  "\\u0050ermissionRequest": []\n---\n'],
      ['klucz z tagiem `!!binary` (base64 słowa)', SKILL, explicit('!!binary UGVybWlzc2lvblJlcXVlc3Q=')],
      ['nagłówek w innym języku niż YAML (`---js`)', SKILL,
        '---js\n{ hooks: { [\'Permission\' + \'Request\']: [{ hooks: [{ type: \'command\', command: \'./ok.sh\' }] }] } }\n---\n'],
      ['nagłówek bez zamknięcia: ucieczka daleko od `---`', AGENT,
        `---\nname: x\n${'description: długi opis\n'.repeat(40)}hooks:\n  "Permission\\u0052equest": []\n`],
      ['BOM i pusta linia przed `---`', SKILL, md('"Permission\\u0052equest"', '\uFEFF\n---\n')],
      ['końce linii CRLF', AGENT, md('"Permission\\u0052equest"').replaceAll('\n', '\r\n')],
      ['ukośnik przed samotnym CR w nagłówku z LF (klucz sklejony)', SKILL, explicit('"Permission\\\r    Request"')],
      ['ukośnik przed literą spoza `x`, `u`, `U` (`\\N`)', AGENT, md('"Permission\\NRequest"')],
      ['ukośnik przed U+2028 (koniec linii YAML 1.1)', SKILL, explicit('"Permission\\\u2028    Request"')],
      ['tag po NEL (U+0085, koniec linii YAML 1.1)', AGENT,
        '---\nname: x\nhooks: x\u0085!!binary UGVybWlzc2lvblJlcXVlc3Q=\n---\n'],
    ])('%s → brak dowodu listy hooków (`hook-escape`)', async (_opis, file, text) => {
      expect(text).not.toContain('PermissionRequest');
      expect(await verdict((f) => { put(f, file, text); })).toEqual(no(`hook-escape:${file}`));
    });

    it.each([
      ['nagłówek bez ucieczek (cudzysłowy, lista, komentarz, adres), ucieczki tylko w treści po nim', [
        '---', 'name: "recenzent"', 'description: \'Czyta kod: "src/" i testy\'  # komentarz',
        'tools: [Read, Grep]', 'model: sonnet', 'homepage: https://example.invalid/a?b=1', '---',
        'Przykład `"\\u0041"`, ścieżka `C:\\Users\\x`, wyjątek `"\\x41"` i linia z ukośnikiem na końcu \\', '',
      ].join('\n')],
      ['plik `.md` bez nagłówka z ucieczkami w treści', 'Przykład:\n\n    "\\u0041" i "\\x41" \\\n'],
      ['`---` dopiero w drugiej linii (treść, potem linia pozioma)', 'Tytuł\n---\nk: "\\u0041"\n---\n'],
      ['`\\"` w `description` w cudzysłowie (jak skille z claude.ai)',
        '---\nname: x\ndescription: "Użyj, gdy prośba mówi \\"przeglądarka\\"."\n---\nTreść.\n'],
      ['`\\n` w `description` w cudzysłowie', '---\nname: x\ndescription: "Pierwsza linia.\\nDruga linia."\n---\nTreść.\n'],
      ['`\\n` w `description` bez cudzysłowu (jak agent wtyczki)',
        '---\nname: x\ndescription: Użyj, gdy kod ma błąd.\\n\\nPrzykład w treści\n---\nTreść.\n'],
    ])('%s: dowód listy hooków zachodzi jak dotąd', async (_opis, text) => {
      expect(await verdict((f) => { put(f, `${CLAUDE}/agents/recenzent.md`, text); })).toEqual({ ok: true });
    });

    it('dosłowne słowo obok ucieczki: dalej `hook-in`, jak dotąd', async () => {
      const text = '---\nhooks:\n  PermissionRequest: []\n  "Pre\\u0054oolUse": []\n---\n';
      expect(await verdict((f) => { put(f, SKILL, text); })).toEqual(no(`hook-in:${SKILL}`));
    });
  });

  it.each([
    ['plik warstwy użytkownika', `${CLAUDE}/settings.json`],
    ['plik `--settings`', UST],
    ['katalog agentów', `${CLAUDE}/agents`],
  ])('%s zmieniony po starcie procesu sesji → brak dowodu listy hooków', async (_opis, file) => {
    expect(await verdict((f) => {
      if (!f.files.has(file)) f.dirs.add(file);
      if (file.endsWith('.json') && !f.files.has(file)) put(f, file, {});
      f.changed.set(file, PROCESS_START + 5_000);
    })).toEqual(no(`changed:${file}`));
  });

  it('preferencje MDM (`com.anthropic.claudecode.plist`) → brak dowodu listy hooków', async () => {
    expect(await verdict((f) => { put(f, '/Library/Managed Preferences/u/com.anthropic.claudecode.plist', '<plist/>'); }))
      .toEqual(no('managed-plist'));
  });

  it('inny plik w katalogu managed z hookiem → brak dowodu listy hooków', async () => {
    expect(await verdict((f) => { put(f, `${MANAGED}/mods/zgody.json`, { PermissionRequest: true }); }))
      .toEqual(no(`hook-in:${MANAGED}/mods/zgody.json`));
  });

  it.each([
    ['inny system', { platform: 'linux' as const }, 'platform'],
    ['brak wpisu rejestru', { entry: null }, 'no-registry-entry'],
    ['wpis rejestru bez `startedAt`', { entry: { pid: PID } }, 'no-registry-start'],
    ['proces nie żyje', { entry: { pid: PID + 1, startedAt: REGISTRY_START } }, 'no-process'],
    ['proces wystartował po wpisie rejestru (pid ponownie użyty)', {
      entry: { pid: PID, startedAt: PROCESS_START - 10_000 },
    }, 'process-start'],
    ['wpis rejestru dużo po starcie procesu', { entry: { pid: PID, startedAt: PROCESS_START + 15_000 } }, 'process-start'],
    ['inna sesja w pliku rejestru pidu', { sessionId: '00000000-0000-4000-9000-0000000000e2' }, 'registry-file'],
    ['`cwd` prośby względne', { cwds: ['repo'] }, 'cwd'],
  ])('%s → brak dowodu listy hooków', async (_opis, over, why) => {
    expect(await verdict(() => {}, over)).toEqual(no(why));
  });

  it.each([
    ['--plugin-dir /x/wtyczka', 'arg:--plugin-dir'],
    ['--plugin-url https://example.invalid/p.zip', 'arg:--plugin-url'],
    ['--agents {"a":{"description":"x","prompt":"y"}}', 'arg:--agents'],
    ['--add-dir /w/inne', 'arg:--add-dir'],
    ['--add-dir=/w/inne', 'arg:--add-dir'],
  ])('argument `%s` → brak dowodu listy hooków', async (arg, why) => {
    const f = fake({ args: `claude --settings ${UST} ${arg}` });
    put(f, UST, rarogLayer());
    expect(await sessionHookVerdict(input(), ioOf(f))).toEqual(no(why));
  });
});

describe('argumenty procesu sesji', () => {
  it.each([
    ['claude', { settings: [], settingSources: false }],
    [`claude --settings ${UST}`, { settings: [{ kind: 'file', path: UST }], settingSources: false }],
    [`claude --settings=${UST} -p`, { settings: [{ kind: 'file', path: UST }], settingSources: false }],
    ['claude --settings {"a": {"b": 1}} --verbose', {
      settings: [{ kind: 'inline', json: { a: { b: 1 } } }], settingSources: false,
    }],
    ['claude --settings={"a":1}', { settings: [{ kind: 'inline', json: { a: 1 } }], settingSources: false }],
    [`claude --settings ${UST} --settings /etc/b.json`, {
      settings: [{ kind: 'file', path: UST }, { kind: 'file', path: '/etc/b.json' }], settingSources: false,
    }],
    // `--setting-sources` (flaga albo tekst promptu) tylko odnotowane: wartość niczego nie zawęża.
    ['claude --setting-sources user,project', { settings: [], settingSources: true }],
    ['claude --setting-sources=local', { settings: [], settingSources: true }],
    [`claude czemu --setting-sources user pomija projekt? --settings ${UST}`, {
      settings: [{ kind: 'file', path: UST }], settingSources: true,
    }],
  ])('`%s`', (args, expected) => {
    expect(parseClaudeArgs(args)).toEqual(expected);
  });

  it.each([
    ['claude --settings', 'arg:--settings'],
    ['claude --settings ustawienia.json', 'arg:--settings'],
    ['claude --settings /Users/u/Moje Ustawienia/a.json', 'arg:--settings'],
    ['claude --settings {"a":', 'arg:--settings'],
    ['claude --setting-sources', 'arg:--setting-sources'],
    ['claude --setting-sources user,policy', 'arg:--setting-sources'],
    // Wartość `--setting-sources` spoza listy: następne słowo nie staje się warstwą `--settings` ładowaną na pewno.
    ['claude --setting-sources --settings /etc/b.json', 'arg:--setting-sources'],
    // Flaga blokująca w każdym słowie, także w wartości innej flagi i w prompcie (granice argumentów giną w `ps`).
    ['claude --settings {"a": " --plugin-dir /x "}', 'arg:--plugin-dir'],
    ['claude --setting-sources --add-dir /w', 'arg:--add-dir'],
    ['claude opisz --agents w prompcie', 'arg:--agents'],
  ])('`%s` → brak dowodu listy hooków', (args, why) => {
    expect(parseClaudeArgs(args)).toEqual({ why });
  });
});

describe('nagłówek YAML: linia zapisu, który bez parsera mógłby dać słowo', () => {
  it.each([
    ['nagłówek bez ucieczek', '---\nname: a\ndescription: "x: y" # z\n---\n', null],
    ['ucieczka `\\u` w drugiej linii', '---\na: "\\u0041"\n---\n', 2],
    ['BOM i puste linie przed `---`', '\uFEFF\n\n---\nx: 1\nk: "\\x41"\n---\n', 5],
    ['ucieczka tylko w treści po zamknięciu', '---\nname: a\n---\nk: "\\u0041" \\\n', null],
    ['bez zamknięcia: cały tekst', '---\nname: a\nk: "\\U00000041"\n', 3],
    ['ukośnik przed końcem linii', '---\nk: "a\\\n  b"\n---\n', 2],
    ['ukośnik przed CRLF; `---\\r` nie zamyka', '---\r\nname: a\r\n---\r\nk: "a\\\r\n  b"\r\n', 4],
    ['para `\\\\` zjada oba znaki: `n` po niej to zwykła litera', '---\nk: "a\\\\n"\n---\n', null],
    ['para `\\\\` przed LF: linia nie sklejona', '---\nk: "a\\\\\n  b"\n---\n', null],
    ['`\\\\\\` przed LF: para, potem ukośnik przed końcem linii', '---\nk: "a\\\\\\\n  b"\n---\n', 2],
    ['`\\"` przed samotnym CR', '---\nk: "a\\"\r  b"\n---\n', null],
    ['nieparzysta liczba ukośników przed `u`', '---\nk: "\\\\\\u0041"\n---\n', 2],
    ['parzysta liczba ukośników przed `u`: litery dosłowne', '---\nk: "\\\\u0041"\n---\n', null],
    ['`\\n` tuż przed końcem linii', '---\nk: "a\\n\n  b"\n---\n', null],
    ['`\\"` i `\\n` w `description`', '---\nname: a\ndescription: "Użyj \\"x\\".\\nDalej."\n---\n', null],
    ['`\\t` spoza listy par', '---\nk: "a\\tb"\n---\n', 2],
    ['`\\/` spoza listy par', '---\nk: "a\\/b"\n---\n', 2],
    ['ukośnik na końcu tekstu (nagłówek bez zamknięcia)', '---\nk: a\\', 2],
    ['ukośnik przed samotnym CR w nagłówku z LF',
      '---\nname: x\nhooks:\n  ? "Permission\\\r    Request"\n  : []\n---\n', 4],
    ['ukośnik przed literą spoza `x`, `u`, `U` (`\\N`)', '---\nk: "a\\Nb"\n---\n', 2],
    ['ukośnik przed U+2028', '---\nk: "Permission\\\u2028    Request"\n---\n', 2],
    ['tag po samotnym CR: linia liczona po końcach linii YAML', '---\nk: x\r!!binary QQ==\n---\n', 3],
    ['tag po NEL (U+0085)', '---\nk: x\u0085!!binary QQ==\n---\n', 3],
    ['samotny CR przed `---` liczy się jako linia', '\r---\nk: "\\u0041"\n---\n', 3],
    ['ścieżka Windows w nagłówku (`\\U`): bez parsera też liczona', '---\nk: C:\\Users\\x\n---\n', 2],
    ['tag `!!binary`', '---\nk: !!binary QQ==\n---\n', 2],
    ['tag po `[`', '---\nk: [!!str a]\n---\n', 2],
    ['wykrzyknik w słowie to nie tag', '---\ndescription: Uwaga! Działa\n---\n', null],
    ['linia otwarcia `---js`', '---js\n{}\n---\n', 1],
    ['linia otwarcia `---` ze spacją na końcu', '--- \nname: a\n---\n', null],
    ['`---` nie na początku pliku', 'Tytuł\n---\nk: "\\u0041"\n---\n', null],
    ['zamknięcie ze spacją nie zamyka (ucieczka dalej liczona)', '---\nname: a\n--- \nk: "\\u0041"\n---\n', 4],
  ])('%s', (_opis, text, line) => {
    expect(frontmatterEscapeLine(text)).toBe(line);
  });
});

describe('lista hooków sesji (pamięć werdyktu)', () => {
  const dump = (seed: string, startedAt: number, over: Partial<HookCallDump> = {}): HookCallDump => ({
    key: `p-${seed}`, sessionId: SESSION, promptId: 'p', agentId: 'a1', pid: 9, startedAt, toolName: 'Bash',
    toolInput: {}, cwd: CWD, at: startedAt, inputSha256: '0', ...over,
  });

  /** `reads` counts the list's reads (one `ps` each), not the registry entry asked on every call. */
  function list(f: Fake, clock: { now: number }, proc: SessionProcess = { pid: PID, start: PROCESS_START }): {
    readonly hooks: ReturnType<typeof createSessionHookList>; readonly reads: { count: number };
    readonly verdicts: HookListVerdict[];
  } {
    const verdicts: HookListVerdict[] = [];
    const { io, reads } = sessionIo(f, clock, proc);
    const hooks = createSessionHookList({
      home: HOME, accepted: [RAROG], io, now: () => clock.now, platform: 'darwin',
      entry: async () => ({ pid: proc.pid, startedAt: proc.start + 3_000 }),
      onVerdict: (_sid, one) => { verdicts.push(one); },
    });
    return { hooks, reads, verdicts };
  }

  it('prośba sprzed odczytu: z werdyktu; prośba po odczycie: odczyt od nowa', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    const clock = { now: NOW };
    const { hooks, reads, verdicts } = list(f, clock);
    const first = dump('a', NOW - 500);
    expect(await hooks(SESSION, [first])).toEqual(new Set([first.key]));
    expect(reads.count).toBe(1);
    clock.now += 1_000;
    expect(await hooks(SESSION, [first])).toEqual(new Set([first.key]));
    expect(reads.count).toBe(1);
    // Nowa prośba po odczycie: obcy hook dopisany w międzyczasie (zmiana po starcie) zabiera dowód obu.
    put(f, `${CLAUDE}/settings.json`, foreignLayer());
    f.changed.set(`${CLAUDE}/settings.json`, clock.now - 100);
    const second = dump('b', clock.now - 50);
    expect(await hooks(SESSION, [first, second])).toEqual(new Set());
    expect(reads.count).toBe(2);
    expect(verdicts).toEqual([{ ok: true }, no(`changed:${CLAUDE}/settings.json`)]);
  });

  it('`answer` gives the keys with the reason of the verdict they came from, `null` with `ok`', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    const clock = { now: NOW };
    const { hooks } = list(f, clock);
    const first = dump('a', NOW - 500);
    expect(await hooks.answer(SESSION, [first])).toEqual({ keys: new Set([first.key]), why: null });
    clock.now += 1_000;
    put(f, `${CLAUDE}/settings.json`, foreignLayer());
    f.changed.set(`${CLAUDE}/settings.json`, clock.now - 100);
    expect(await hooks.answer(SESSION, [first, dump('b', clock.now - 50)]))
      .toEqual({ keys: new Set(), why: `changed:${CLAUDE}/settings.json` });
  });

  it('a verdict holds only for its session process: a restart under the same id is read again', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    f.changed.set(UST, NOW - 60_000);
    const clock = { now: NOW };
    const proc: SessionProcess = { pid: PID, start: PROCESS_START };
    const { hooks, reads } = list(f, clock, proc);
    expect(await hooks(SESSION, [dump('a', NOW - 500)])).toEqual(new Set());
    // A new process of the same session, started after the change, within the 30 s of the old process's verdict.
    put(f, `${CLAUDE}/sessions/${String(PID + 1)}.json`, { pid: PID + 1, sessionId: SESSION, cwd: CWD });
    Object.assign(proc, { pid: PID + 1, start: NOW + 1_000 });
    clock.now += 5_000;
    const next = dump('b', clock.now - 500);
    expect(await hooks(SESSION, [next])).toEqual(new Set([next.key]));
    expect(reads.count).toBe(2);
  });

  it('a session restarted during the read: no keys and no reason, the next call reads the new process', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    f.changed.set(UST, NOW - 60_000);
    const clock = { now: NOW };
    put(f, `${CLAUDE}/sessions/${String(PID + 1)}.json`, { pid: PID + 1, sessionId: SESSION, cwd: CWD });
    // `ps` answers for the old process (its verdict is `changed:`), then the registry already names the new one.
    const proc: SessionProcess = {
      pid: PID, start: PROCESS_START, afterPs: () => { Object.assign(proc, { pid: PID + 1, start: NOW - 2_000 }); },
    };
    const { hooks, reads } = list(f, clock, proc);
    const one = dump('a', NOW - 500);
    expect(await hooks.answer(SESSION, [one])).toEqual({ keys: new Set(), why: null });
    clock.now += 1_000;
    expect(await hooks.answer(SESSION, [one])).toEqual({ keys: new Set([one.key]), why: null });
    expect(reads.count).toBe(2);
  });

  it('two calls at once with different `cwd`: each gets the verdict of its own scope', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    put(f, '/w/inny/.claude/settings.json', foreignLayer());
    const { hooks, reads } = list(f, { now: NOW });
    const here = dump('a', NOW - 500);
    const there = dump('b', NOW - 400, { cwd: '/w/inny' });
    const [bad, good] = await Promise.all([hooks(SESSION, [there]), hooks(SESSION, [here])]);
    expect(bad).toEqual(new Set());
    expect(good).toEqual(new Set([here.key]));
    expect(reads.count).toBe(2);
  });

  it('a negative verdict over two `cwd` does not answer a later call about one of them: read again', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    put(f, '/w/inny/.claude/settings.json', foreignLayer());
    const clock = { now: NOW };
    const { hooks, reads } = list(f, clock);
    const here = dump('a', NOW - 500);
    const there = dump('b', NOW - 400, { cwd: '/w/inny' });
    expect((await hooks.answer(SESSION, [here, there])).why).not.toBeNull();
    clock.now += 1_000;
    const next = dump('c', clock.now - 500);
    expect(await hooks.answer(SESSION, [next])).toEqual({ keys: new Set([next.key]), why: null });
    expect(reads.count).toBe(2);
  });

  it('werdykt negatywny żyje 30 s, potem odczyt od nowa', async () => {
    const f = fake();
    put(f, UST, foreignLayer());
    const clock = { now: NOW };
    const { hooks, reads } = list(f, clock);
    const one = dump('a', NOW - 500);
    expect(await hooks(SESSION, [one])).toEqual(new Set());
    clock.now += HOOK_LIST_RETRY_MS - 1;
    expect(await hooks(SESSION, [one])).toEqual(new Set());
    expect(reads.count).toBe(1);
    put(f, UST, rarogLayer());
    clock.now += 1;
    expect(await hooks(SESSION, [one])).toEqual(new Set([one.key]));
    expect(reads.count).toBe(2);
  });

  it.each([
    ['`io:EACCES`', (f: Fake): void => { f.errors.set(UST, 'EACCES'); }, (f: Fake): void => { f.errors.delete(UST); }],
    ['`no-process`', (f: Fake): void => { f.proc = null; }, (f: Fake): void => { f.proc = fake().proc; }],
  ])('a transient negative verdict (%s) is read again after 2 s', async (_code, fail, mend) => {
    const f = fake();
    put(f, UST, rarogLayer());
    fail(f);
    const clock = { now: NOW };
    const { hooks, reads } = list(f, clock);
    const one = dump('a', NOW - 500);
    expect(await hooks(SESSION, [one])).toEqual(new Set());
    mend(f);
    clock.now += HOOK_LIST_TRANSIENT_RETRY_MS - 1;
    expect(await hooks(SESSION, [one])).toEqual(new Set());
    expect(reads.count).toBe(1);
    clock.now += 1;
    expect(await hooks(SESSION, [one])).toEqual(new Set([one.key]));
    expect(reads.count).toBe(2);
  });

  it('a negative verdict outside both lists (`settings-file`) lives 30 s like a durable one', async () => {
    const f = fake();
    const clock = { now: NOW };
    const { hooks, reads } = list(f, clock);
    const one = dump('a', NOW - 500);
    expect(await hooks.answer(SESSION, [one])).toEqual({ keys: new Set(), why: 'settings-file' });
    put(f, UST, rarogLayer());
    clock.now += HOOK_LIST_RETRY_MS - 1;
    expect(await hooks(SESSION, [one])).toEqual(new Set());
    expect(reads.count).toBe(1);
  });

  it('nowy `cwd` prośby: odczyt od nowa; prośba wątku głównego listy nie pyta', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    put(f, '/w/inny/.claude/settings.json', foreignLayer());
    const clock = { now: NOW };
    const { hooks, reads } = list(f, clock);
    const here = dump('a', NOW - 500);
    expect(await hooks(SESSION, [here])).toEqual(new Set([here.key]));
    const there = dump('b', NOW - 400, { cwd: '/w/inny' });
    expect(await hooks(SESSION, [here, there])).toEqual(new Set());
    expect(reads.count).toBe(2);
    const main = dump('m', NOW - 300, { agentId: undefined });
    expect(await hooks(SESSION, [main])).toEqual(new Set());
    expect(reads.count).toBe(2);
  });

  it('dwa pytania naraz: jeden odczyt', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    const { hooks, reads } = list(f, { now: NOW });
    const one = dump('a', NOW - 500);
    const [a, b] = await Promise.all([hooks(SESSION, [one]), hooks(SESSION, [one])]);
    expect(a).toEqual(new Set([one.key]));
    expect(b).toEqual(new Set([one.key]));
    expect(reads.count).toBe(1);
  });
});

describe('kind of a negative verdict (the hook list proof contract)', () => {
  // The durable list decides that a subagent request goes back to the desk at once (`layer1/desk.ts`); a code moved
  // to the wrong list releases a request that could still get the approve button, or keeps one that cannot.
  it.each([
    ['changed:/Users/u/.claude/settings.json', 'durable'], ['foreign:user', 'durable'],
    ['hooks-shape:project', 'durable'], ['hook-in:/Users/u/.claude/agents/a.md', 'durable'],
    ['hook-escape:/Users/u/.claude/skills/s/SKILL.md', 'durable'], ['marketplace-changed:demo', 'durable'],
    ['arg:--plugin-dir', 'durable'], ['platform', 'durable'], ['managed-plist', 'durable'],
    ['io:EACCES', 'transient'], ['io:error', 'transient'], ['no-process', 'transient'], ['process-start', 'transient'],
    ['no-registry-entry', 'transient'], ['no-registry-start', 'transient'], ['registry-file', 'transient'],
    ['budget:/Users/u/.claude/plugins', 'transient'], ['unparseable:/Users/u/.claude/settings.json', 'transient'],
    ['settings-file', 'other'], ['plugin-missing:demo@market', 'other'], ['worktree:/w/.git', 'other'],
    ['cwd', 'other'], ['loop:/w/x', 'other'], ['changed', 'durable'], ['changedx:/w', 'other'],
  ])('%s → %s', (why, kind) => {
    expect(hookListVerdictKind(why)).toBe(kind);
  });
});

describe('ścieżki atrapy', () => {
  it('katalog z plików atrapy ma dzieci, plik nieobecny = `null`', async () => {
    const f = fake();
    put(f, path.join(CLAUDE, 'agents', 'a.md'), 'x');
    const io = ioOf(f);
    expect(await io.readdir(path.join(CLAUDE, 'agents'))).toEqual(['a.md']);
    expect(await io.lstat(path.join(CLAUDE, 'brak.json'))).toBeNull();
  });

  it('dowiązanie: `lstat` widzi dowiązanie, odczyt i lista katalogu idą do celu (także względnego)', async () => {
    const f = fake();
    put(f, '/opt/v2/a.json', '{}');
    f.links.set('/etc/conf', '../opt/v2');
    const io = ioOf(f);
    expect(await io.lstat('/etc/conf')).toMatchObject({ kind: 'link' });
    expect(await io.readlink('/etc/conf')).toBe('../opt/v2');
    expect(await io.readFile('/etc/conf/a.json')).toBe('{}');
    expect(await io.readdir('/etc/conf')).toEqual(['a.json']);
  });
});

describe('odczyt dysku przez `safe-read.ts`', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rarog-hook-list-'));
  });
  afterAll(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('plik zwykły daje treść, brak pliku `null`', async () => {
    const file = path.join(dir, 'settings.json');
    await writeFile(file, '{"hooks":{}}');
    expect(await nodeHookListIo.readFile(file)).toBe('{"hooks":{}}');
    expect(await nodeHookListIo.readFile(path.join(dir, 'brak.json'))).toBeNull();
    expect(await nodeHookListIo.readFile(path.join(dir, 'settings.json', 'pod'))).toBeNull();
  });

  it('FIFO pod nazwą pliku ustawień: błąd `EFTYPE` bez czekania na pisarza', async () => {
    const fifo = path.join(dir, 'fifo.json');
    execFileSync('mkfifo', [fifo]);
    await expect(nodeHookListIo.readFile(fifo)).rejects.toMatchObject({ code: 'EFTYPE' });
  });

  it('plik ponad sufit odczytu: błąd `EFBIG`, nie ucięta treść', async () => {
    const file = path.join(dir, 'duzy.json');
    await writeFile(file, '');
    await truncate(file, HOOK_LIST_MAX_FILE_BYTES + 1);
    await expect(nodeHookListIo.readFile(file)).rejects.toMatchObject({ code: 'EFBIG' });
  });
});

describe('dowiązanie przełączone po starcie sesji (prawdziwy dysk)', () => {
  let root = '';
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rarog-hook-link-')));
  });
  afterAll(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  /** `nodeHookListIo` zawężony do katalogu testu i jego przodków (reszta dysku = brak pliku); `ps` z atrapy. */
  function diskIo(args: string): HookListIo {
    const inside = (p: string): boolean => p === '/' || p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`);
    const io: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(nodeHookListIo as unknown as Record<string, (p: string) => Promise<unknown>>)) {
      io[name] = name === 'ps' ? async (): Promise<HookListProcess> => ({ elapsedS: 0, args }) : async (p: string) => {
        if (inside(p)) return fn(p);
        if (name === 'readlink') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return null;
      };
    }
    return io as unknown as HookListIo;
  }

  const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

  /**
   * `--settings <scena>/x/current/settings.json`, `current` → `a` (obcy hook) albo `b` (sam hook Raroga), oba
   * katalogi sprzed startu sesji. `switchTo` przełącza dowiązanie po starcie (atomowo, jak `ln -sfn` z `mv`).
   */
  async function scene(name: string, from: 'a' | 'b', switchTo?: 'b'): Promise<HookListVerdict> {
    const dir = path.join(root, name);
    const home = path.join(dir, 'home');
    await mkdir(path.join(dir, 'x', 'a'), { recursive: true });
    await mkdir(path.join(dir, 'x', 'b'), { recursive: true });
    await mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
    await writeFile(path.join(dir, 'x', 'a', 'settings.json'), JSON.stringify(foreignLayer()));
    await writeFile(path.join(dir, 'x', 'b', 'settings.json'), JSON.stringify(rarogLayer()));
    await symlink(from, path.join(dir, 'x', 'current'));
    await pause(30);
    const start = Date.now();
    await pause(30);
    if (switchTo !== undefined) {
      await symlink(switchTo, path.join(dir, 'x', 'current.new'));
      await rename(path.join(dir, 'x', 'current.new'), path.join(dir, 'x', 'current'));
    }
    const cwd = path.join(dir, 'projekt');
    await writeFile(path.join(home, '.claude', 'sessions', `${PID}.json`), JSON.stringify({
      pid: PID, sessionId: SESSION, cwd, startedAt: start + 1_000,
    }));
    // `etime` 0 s i chwila odczytu 2 s po `start`: dolna granica startu procesu to dokładnie `start`.
    return sessionHookVerdict({
      sessionId: SESSION, home, accepted: [RAROG], entry: { pid: PID, startedAt: start + 1_000 }, cwds: [cwd],
      platform: 'darwin', now: start + 2_000,
    }, diskIo(`claude --settings ${path.join(dir, 'x', 'current', 'settings.json')}`));
  }

  it('dowiązanie katalogu przełączone po starcie na starszy katalog z czystym plikiem → brak dowodu listy hooków', async () => {
    expect(await scene('przelaczone', 'a', 'b')).toEqual(no(`changed:${path.join(root, 'przelaczone', 'x', 'current')}`));
  });

  it('dowiązanie niezmienione od startu sesji: dowód listy hooków zachodzi', async () => {
    expect(await scene('stale', 'b')).toEqual({ ok: true });
  });
});
