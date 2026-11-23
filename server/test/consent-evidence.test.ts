/**
 * Korelacja klucza hooka `PermissionRequest` z `tool_use.id` i dowód skutku w transkrypcie: fakty, na których stoi
 * reguła wiązania warstwy 1 (sekcja 5.3), z pomiaru na żywym CLI 2.1.314.
 *
 * Fixture'y w `fixtures/consent-dowod/` to wycinki jednego przebiegu, zanonimizowane: `<przypadek>.hook.json` to
 * wejście hooka `PermissionRequest` (stdin), `<tura>.jsonl` to linie tury pliku wywołania (wątek główny albo plik
 * subagenta, tylko wpisy `user`, `assistant` i `system`, pola korelacji), `<tura>.glowny.jsonl` to tura wątku
 * głównego przy subagencie, a `przypadki.json` to fakty przebiegu per klucz. Prawdę o kluczu (`toolUseId`) przebieg
 * ustalił z wywołania jedynego kandydata albo z wyniku zapisanego pierwszego po decyzji hooka; zgadza się z nią
 * `tool_use_id` hooka `PostToolUse` (`zgodnyPost`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { openToolUses } from '../src/herdr/jsonl-pending.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'consent-dowod');

interface Przypadek {
  readonly nazwa: string;
  readonly tura: string;
  readonly narzedzie: string;
  readonly agent: boolean;
  readonly toolUseId: string | null;
  readonly zapis: string | null;
  readonly zgodnyPost: string;
  readonly postToolUseId: string | null;
  readonly hook: string;
  readonly transkrypt?: string;
  readonly transkryptGlowny?: string;
  readonly czasy: { readonly pending: number; readonly toolUse: number; readonly decyzja: number; readonly timestampToolUse: number };
}

interface Blok {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: string;
}

interface Wpis {
  readonly type: string;
  readonly subtype?: string;
  readonly timestamp?: string;
  readonly promptId?: string;
  readonly agentId?: string;
  readonly isSidechain?: boolean;
  readonly origin?: { readonly kind: string };
  readonly permissionDecision?: { readonly source: string; readonly decision: string } | null;
  readonly wireToolInputs?: Record<string, unknown>;
  readonly message?: { readonly content?: string | readonly Blok[] };
}

interface WejscieHooka {
  readonly session_id: string;
  readonly prompt_id: string;
  readonly agent_id?: string;
  readonly tool_name: string;
  readonly tool_input: unknown;
}

const czytaj = (plik: string): string => readFileSync(join(DIR, plik), 'utf8');
const PRZYPADKI = JSON.parse(czytaj('przypadki.json')) as Przypadek[];
const przypadek = (nazwa: string): Przypadek => {
  const p = PRZYPADKI.find((x) => x.nazwa === nazwa);
  if (p === undefined) throw new Error(`brak przypadku ${nazwa}`);
  return p;
};
const linie = (plik: string): string[] => czytaj(plik).split('\n').filter((l) => l !== '');
const wpisy = (plik: string): Wpis[] => linie(plik).map((l) => JSON.parse(l) as Wpis);
const hookOf = (p: Przypadek): WejscieHooka => JSON.parse(czytaj(p.hook)) as WejscieHooka;
const bloki = (w: Wpis): readonly Blok[] => (Array.isArray(w.message?.content) ? w.message.content : []);

/** Wpis i indeks wywołania `tool_use` przypadku oraz jego wyniku w pliku tury. */
function para(p: Przypadek): {
  lista: Wpis[]; uzycie: number; uzycieWpis: Wpis; blok: Blok; wynik: number; wynikWpis: Wpis; wynikBlok: Blok;
} {
  if (p.transkrypt === undefined || p.toolUseId === null) throw new Error(`${p.nazwa}: bez transkryptu`);
  const lista = wpisy(p.transkrypt);
  const uzycie = lista.findIndex((w) => w.type === 'assistant' && bloki(w).some((b) => b.type === 'tool_use' && b.id === p.toolUseId));
  const wynik = lista.findIndex((w) => w.type === 'user' && bloki(w).some((b) => b.type === 'tool_result' && b.tool_use_id === p.toolUseId));
  expect(uzycie, `${p.nazwa}: tool_use`).toBeGreaterThanOrEqual(0);
  expect(wynik, `${p.nazwa}: wynik`).toBeGreaterThan(uzycie);
  const uzycieWpis = lista[uzycie];
  const wynikWpis = lista[wynik];
  if (uzycieWpis === undefined || wynikWpis === undefined) throw new Error(`${p.nazwa}: bez pary`);
  const blok = bloki(uzycieWpis).find((b) => b.id === p.toolUseId) as Blok;
  const wynikBlok = bloki(wynikWpis).find((b) => b.tool_use_id === p.toolUseId) as Blok;
  return { lista, uzycie, uzycieWpis, blok, wynik, wynikWpis, wynikBlok };
}

const Z_TRANSKRYPTEM = PRZYPADKI.filter((p) => p.transkrypt !== undefined && p.toolUseId !== null);

/** Narzędzia, których wejście hooka równa się zapisanemu `input` wpisu (lista do `layer1/contract.ts`). */
const POROWNYWALNE = ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'mcp__pomiar__echo', 'mcp__pomiar__echo_osobiscie'];

describe('klucz hooka → `tool_use.id` (CLI 2.1.314)', () => {
  it('przebieg ma każdy przypadek planu i prawdę o kluczu potwierdzoną przez `PostToolUse`', () => {
    expect(PRZYPADKI.map((p) => p.nazwa).sort()).toEqual([
      'bash-cd', 'bash-dlugi', 'bash-kolejno-1', 'bash-kolejno-2', 'bash-krotki', 'bash-odrzuc', 'bash-rownolegle-1',
      'bash-rownolegle-2', 'edit', 'exitplanmode', 'mcp', 'mcp-osobiscie', 'read', 'read-rownolegle-1',
      'read-rownolegle-2', 'sigkill-biurko', 'sigkill-esc', 'subagent-fg', 'subagent-tlo', 'webfetch', 'write',
    ]);
    expect(Z_TRANSKRYPTEM).toHaveLength(PRZYPADKI.length);
    // Bez wykonania narzędzia `PostToolUse` nie ma: odmowa, Esc i MCP z interakcją. Przy wykonanym `tool_use_id`
    // z `PostToolUse` to ten sam identyfikator co prawda o kluczu.
    const bezPost = ['bash-odrzuc', 'mcp-osobiscie', 'sigkill-esc'];
    for (const p of PRZYPADKI) {
      expect(p.postToolUseId, p.nazwa).toBe(bezPost.includes(p.nazwa) ? null : p.toolUseId);
    }
    expect(new Set(PRZYPADKI.map((p) => p.toolUseId)).size).toBe(PRZYPADKI.length);
  });

  it('wpis `tool_use` nie niesie `promptId`; turę daje wpis `user` przed nim i wpis wyniku', () => {
    for (const p of Z_TRANSKRYPTEM) {
      const { lista, uzycie, uzycieWpis, wynikWpis } = para(p);
      const hook = hookOf(p);
      expect(uzycieWpis.promptId, `${p.nazwa}: promptId na tool_use`).toBeUndefined();
      const przed = lista.slice(0, uzycie).filter((w) => w.type === 'user' && typeof w.promptId === 'string').pop();
      expect(przed?.promptId, `${p.nazwa}: user przed`).toBe(hook.prompt_id);
      expect(wynikWpis.promptId, `${p.nazwa}: wynik`).toBe(hook.prompt_id);
    }
  });

  it('wejście hooka = `tool_use.input` wpisu (nie `wireToolInputs`) dla narzędzi porównywalnych', () => {
    for (const p of Z_TRANSKRYPTEM.filter((x) => POROWNYWALNE.includes(x.narzedzie))) {
      const { blok } = para(p);
      expect(canonicalSha256(hookOf(p).tool_input), p.nazwa).toBe(canonicalSha256(blok.input));
    }
    // `wireToolInputs` (wejście z modelu) różni się od zapisanego: CLI zdejmuje `cd <katalog sesji> && ` z komendy
    // i dopisuje `replace_all: false` do `Edit`. Hook dostaje postać zapisaną.
    const cd = para(przypadek('bash-cd'));
    const wireCd = cd.uzycieWpis.wireToolInputs?.[przypadek('bash-cd').toolUseId as string] as { command: string };
    expect(wireCd.command).toMatch(/^cd \S+ && echo m5-cd > m5-cd\.txt$/);
    expect((cd.blok.input as { command: string }).command).toBe('echo m5-cd > m5-cd.txt');
    expect(hookOf(przypadek('bash-cd')).tool_input).toEqual(cd.blok.input);
    const ed = para(przypadek('edit'));
    const wireEd = ed.uzycieWpis.wireToolInputs?.[przypadek('edit').toolUseId as string] as Record<string, unknown>;
    expect('replace_all' in wireEd).toBe(false);
    expect(ed.blok.input).toMatchObject({ replace_all: false });
    expect(hookOf(przypadek('edit')).tool_input).toMatchObject({ replace_all: false });
  });

  it('`ExitPlanMode` nieporównywalny: hook `{}`, wpis z planem modelu — wiązanie tylko po nazwie', () => {
    const p = przypadek('exitplanmode');
    expect(hookOf(p).tool_input).toEqual({});
    expect(para(p).blok.input).toMatchObject({ plan: expect.stringContaining('m5-plan') as unknown });
  });

  it('rozstrzygnięcie w transkrypcie: `permissionDecision` wyniku i przerwanie', () => {
    const oczekiwane: Record<string, string> = {
      'bash-odrzuc': 'hook/reject', 'sigkill-biurko': 'user_temporary/accept', 'sigkill-esc': 'null+przerwane',
      'mcp-osobiscie': 'null+przerwane',
    };
    for (const p of Z_TRANSKRYPTEM) {
      const { wynikWpis, wynikBlok } = para(p);
      const pd = wynikWpis.permissionDecision;
      const tekst = pd === null || pd === undefined ? 'null' : `${pd.source}/${pd.decision}`;
      const przerwane = /interrupted by user|doesn't want to proceed/.test(wynikBlok.content ?? '');
      expect(`${tekst}${przerwane ? '+przerwane' : ''}`, p.nazwa).toBe(oczekiwane[p.nazwa] ?? 'hook/accept');
    }
  });

  it('odbiór bez skutku: hook przejął plik i zginął przed stdout, skutek dał dopiero klawisz przy biurku', () => {
    for (const nazwa of ['sigkill-biurko', 'sigkill-esc']) expect(przypadek(nazwa).zapis).toBe('sigkill-przed-stdout');
    // Odpowiedź przejęta (`.claimed`) to nie skutek: wynik ma źródło klawisza, nie hooka.
    expect(para(przypadek('sigkill-biurko')).lista.some((w) => w.permissionDecision?.source === 'hook')).toBe(false);
  });

  it('dwa identyczne z jednej wiadomości nakładają się (oba otwarte przed pierwszym wynikiem), kolejne nie', () => {
    for (const tura of ['bash-rownolegle', 'read-rownolegle']) {
      const [a, b] = [przypadek(`${tura}-1`), przypadek(`${tura}-2`)];
      const pa = para(a);
      const pb = para(b);
      const pierwszy = Math.min(pa.wynik, pb.wynik);
      const otwarte = openToolUses(linie(`${tura}.jsonl`).slice(0, pierwszy));
      expect(otwarte.map((t) => t.id).sort(), tura).toEqual([a.toolUseId, b.toolUseId].sort());
      expect(new Set(otwarte.map((t) => canonicalSha256(t.input))).size, tura).toBe(1);
      expect(canonicalSha256(hookOf(a).tool_input)).toBe(canonicalSha256(hookOf(b).tool_input));
    }
    const [a, b] = [przypadek('bash-kolejno-1'), przypadek('bash-kolejno-2')];
    const pb = para(b);
    expect(para(a).wynik).toBeLessThan(pb.uzycie);
    expect(openToolUses(linie('bash-kolejno.jsonl').slice(0, pb.uzycie + 1)).map((t) => t.id)).toEqual([b.toolUseId]);
    expect(canonicalSha256(hookOf(a).tool_input)).toBe(canonicalSha256(hookOf(b).tool_input));
  });

  it('koniec tury: `stop_hook_summary` i `turn_duration` bez `promptId`; po przerwaniu Esc sam `turn_duration`', () => {
    for (const p of Z_TRANSKRYPTEM.filter((x) => !x.agent)) {
      const { lista, wynik } = para(p);
      const koniec = lista.slice(wynik + 1).filter((w) => w.type === 'system');
      const podtypy = koniec.map((w) => w.subtype);
      expect(podtypy, p.nazwa).toContain('turn_duration');
      expect(koniec.every((w) => w.promptId === undefined), p.nazwa).toBe(true);
      const przerwane = p.nazwa === 'sigkill-esc' || p.nazwa === 'mcp-osobiscie';
      expect(podtypy.includes('stop_hook_summary'), p.nazwa).toBe(!przerwane);
      if (przerwane) {
        // Znacznik przerwania to wpis `user` tej samej tury (z jej `promptId`), przed `turn_duration`.
        const znacznik = lista.slice(wynik + 1).find((w) => w.type === 'user');
        expect(bloki(znacznik as Wpis).map((b) => (b as { text?: string }).text)).toEqual([
          '[Request interrupted by user for tool use]',
        ]);
        expect(znacznik?.promptId, p.nazwa).toBe(hookOf(p).prompt_id);
        expect(lista.indexOf(znacznik as Wpis)).toBeLessThan(lista.findIndex((w) => w.subtype === 'turn_duration'));
      }
    }
  });

  it('subagent: wywołanie w pliku subagenta z `agentId` hooka; tracker wątku głównego pliku subagenta nie czyta', () => {
    for (const nazwa of ['subagent-fg', 'subagent-tlo', 'webfetch']) {
      const p = przypadek(nazwa);
      const hook = hookOf(p);
      const { lista, uzycie, uzycieWpis } = para(p);
      expect(p.agent, nazwa).toBe(true);
      expect(uzycieWpis).toMatchObject({ isSidechain: true, agentId: hook.agent_id });
      // `openToolUses` pomija wpisy `isSidechain`: wiązanie subagenta potrzebuje czytnika pliku subagenta.
      expect(openToolUses(linie(p.transkrypt as string).slice(0, uzycie + 1)), nazwa).toEqual([]);
      // Plik subagenta nie ma wpisu końca tury; ma go wątek główny.
      expect(lista.some((w) => w.type === 'system'), nazwa).toBe(false);
      expect(wpisy(p.transkryptGlowny as string).some((w) => w.subtype === 'turn_duration'), nazwa).toBe(true);
    }
    // Subagent na pierwszym planie: jego koniec to wynik `Agent` w wątku głównym, zapisany po wyniku subagenta.
    for (const nazwa of ['subagent-fg', 'webfetch']) {
      const p = przypadek(nazwa);
      const glowny = wpisy(p.transkryptGlowny as string);
      const agent = glowny.flatMap((w) => bloki(w)).find((b) => b.type === 'tool_use' && b.name === 'Agent');
      const wynikAgenta = glowny.find((w) => bloki(w).some((b) => b.type === 'tool_result' && b.tool_use_id === agent?.id));
      expect(agent, nazwa).toBeDefined();
      expect(Date.parse(wynikAgenta?.timestamp as string), nazwa)
        .toBeGreaterThan(Date.parse(para(p).wynikWpis.timestamp as string));
    }
    // Subagent w tle: wątek główny kończy turę przed wynikiem subagenta, a powiadomienie o końcu zadania przychodzi
    // jako wpis `user` z `origin.kind` `task-notification` i NOWYM `promptId`.
    const tlo = przypadek('subagent-tlo');
    const glowny = wpisy(tlo.transkryptGlowny as string);
    const wynikT = Date.parse(para(tlo).wynikWpis.timestamp as string);
    const pierwszyKoniec = glowny.find((w) => w.subtype === 'turn_duration');
    expect(Date.parse(pierwszyKoniec?.timestamp as string)).toBeLessThan(wynikT);
    const powiadomienie = glowny.find((w) => w.origin?.kind === 'task-notification');
    expect(powiadomienie?.promptId).toEqual(expect.any(String));
    expect(powiadomienie?.promptId).not.toBe(hookOf(tlo).prompt_id);
    // Powiadomienie wskazuje subagenta prośby (`<task-id>` = `agent_id` hooka) i przychodzi po jego wyniku.
    const tresc = powiadomienie?.message?.content;
    expect(tresc).toContain(`<task-id>${hookOf(tlo).agent_id}</task-id>`);
    expect(tresc).toContain('<status>completed</status>');
    expect(Date.parse(powiadomienie?.timestamp as string)).toBeGreaterThan(wynikT);
  });

  it('czasy: wpis `tool_use` w pliku dopiero po starcie hooka; dwa `Bash` z jednej wiadomości — po decyzji pierwszego', () => {
    for (const p of Z_TRANSKRYPTEM) {
      // Chwila zapisu wpisu (`timestamp`) poprzedza start hooka, a linia pojawia się w pliku po nim.
      expect(p.czasy.timestampToolUse, p.nazwa).toBeLessThan(0);
      expect(p.czasy.toolUse, p.nazwa).toBeGreaterThan(p.czasy.pending);
    }
    const a = przypadek('bash-rownolegle-1');
    expect(a.czasy.toolUse).toBeGreaterThan(a.czasy.decyzja);
  });
});
