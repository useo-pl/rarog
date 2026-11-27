/**
 * Pochodzenie panelu: etykieta PANELU herdr nadana przez Raroga przy zakładaniu
 * i nazwa agenta `rarog-<6 hex>`.
 *
 * Etykieta jest jedyną rzeczą Raroga, która przeżywa restart serwera herdr (snapshot), więc
 * jej format jest kontraktem z danymi na dysku użytkownika — stąd wyrażenia ZAMKNIĘTE
 * i testy po stronie „czego NIE wolno uznać za etykietę Raroga".
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeHex } from '../src/herdr/label-code.ts';
import {
  HERDR_NAME_PREFIX, RAROG_AGENT_NAME_RE, claudeKeyMatches, claudePaneLabel, claudePaneLabelFrom,
  claudeTraceMatches, labelTrace, newClaudeProvenance, newRarogAgentName, paneLabelTermId, parsePaneLabel,
  projectKey, realProjectPath, sanitizeTabLabel, termPaneLabel, terminalTabLabel,
} from '../src/herdr/provenance.ts';
import type { ClaudeProvenance } from '../src/herdr/provenance.ts';
import { RAROG_TERM_PANE_TOKEN, termPaneTokenOf } from '../src/config.ts';
import { labelFromPrompt, normalizeSessionLabel } from '../src/session-label.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const KEY = 'cafebabecafebabe';
const TRACE = '89abcdef';

describe('projectKey i realProjectPath', () => {
  it('klucz = pierwsze 16 hex sha256 ścieżki — deterministyczny, różny dla różnych ścieżek', () => {
    expect(projectKey('/Users/u/Projects/atlas')).toBe(sha('/Users/u/Projects/atlas').slice(0, 16));
    expect(projectKey('/Users/u/Projects/atlas')).toMatch(/^[0-9a-f]{16}$/);
    expect(projectKey('/Users/u/Projects/birch')).not.toBe(projectKey('/Users/u/Projects/atlas'));
  });

  it('dowiązanie do katalogu daje TEN SAM klucz co katalog (realpath)', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-provenance-')));
    const target = join(root, 'projekt');
    const link = join(root, 'skrot');
    await mkdir(target);
    await symlink(target, link);

    expect(await realProjectPath(link)).toBe(target);
    expect(projectKey(await realProjectPath(link))).toBe(projectKey(await realProjectPath(target)));
  });

  it('ścieżka, której nie ma na dysku, NIE rzuca — wraca znormalizowana', async () => {
    // Launcher liczy klucz PO starcie agenta; brak katalogu nie ma prawa wywrócić startu.
    expect(await realProjectPath('/nie/ma/takiego/../katalogu')).toBe(resolve('/nie/ma/katalogu'));
  });
});

describe('labelTrace', () => {
  it('ślad = pierwsze 8 hex sha256 etykiety taba', () => {
    expect(labelTrace('atlas')).toBe(sha('atlas').slice(0, 8));
    expect(labelTrace('atlas')).toMatch(/^[0-9a-f]{8}$/);
    expect(labelTrace('Atlas')).not.toBe(labelTrace('atlas'));
  });
});

describe('pane label format: `rt:` and `rc:` in Crockford base32', () => {
  it('terminal: the full 64-bit id in 13 characters and back', () => {
    const label = termPaneLabel('d703c6f230f3e25e', 'rarog 1 · atlas');
    expect(label).toBe('rarog 1 · atlas · rt:tw1wdwhgyfh5w');
    expect(parsePaneLabel(label)).toEqual({ kind: 'term', id: 'd703c6f230f3e25e' });
    expect(paneLabelTermId(label)).toBe('d703c6f230f3e25e');
    expect(termPaneLabel(KEY)).toMatch(/^rt:[0-9a-hjkmnp-tv-z]{13}$/u);
  });

  it('Claude: 7 characters of the project key and the full 32-bit trace, the trace comes back', () => {
    const label = claudePaneLabel('5987c60c24159c09', '428a2dd7', 'fixes');
    expect(label).toBe('fixes · rc:b63wc318a52vnr');
    expect(parsePaneLabel(label)).toEqual({ kind: 'claude', keyCode: 'b63wc31', trace: '428a2dd7' });
    expect(encodeHex('5987c60c24159c09').slice(0, 7)).toBe('b63wc31');
    expect(claudePaneLabel(KEY, TRACE)).toMatch(/^rc:[0-9a-hjkmnp-tv-z]{14}$/u);
  });

  it('every value round-trips: one label per value', () => {
    fc.assert(fc.property(fc.stringMatching(/^[0-9a-f]{16}$/u), fc.stringMatching(/^[0-9a-f]{8}$/u),
      (id, trace) => {
        expect(paneLabelTermId(termPaneLabel(id, 'x'))).toBe(id);
        const claude = parsePaneLabel(claudePaneLabel(id, trace, 'x'));
        expect(claude).toEqual({ kind: 'claude', keyCode: encodeHex(id).slice(0, 7), trace });
      }));
  });

  it('the parser refuses a wrong length, `i l o u`, padding bits and a blank description', () => {
    const refused = [
      'rt:tw1wdwhgyfh5', 'rt:tw1wdwhgyfh5w0', 'rc:b63wc318a52vn', 'rc:b63wc318a52vnr0',
      'notatki · rt:abc',
      // `i`, `l`, `o`, `u` and uppercase are outside the alphabet.
      'rt:tw1wdwhgyfh5i', 'rt:tw1wdwhgyfhlw', 'rc:b63wc318a52vno', 'rc:b63uc318a52vnr', 'rt:TW1WDWHGYFH5W',
      // The last character carries zero padding bits: 1 bit for the id, 3 for the trace.
      'rt:tw1wdwhgyfh5x', 'rc:b63wc318a52vns', 'rc:b63wc318a52vnz',
      ' · rt:tw1wdwhgyfh5w', '   · rc:b63wc318a52vnr', 'a ·rt:tw1wdwhgyfh5w', 'a · rt:tw1wdwhgyfh5w ',
      'a\nb · rt:tw1wdwhgyfh5w', 'rt: tw1wdwhgyfh5w', 'rc:b63wc31 8a52vnr',
    ];
    for (const label of refused) expect(parsePaneLabel(label), JSON.stringify(label)).toBeNull();
  });

  it('budowanie etykiety ze złym kluczem, śladem albo id RZUCA', () => {
    // Etykieta spoza wzorca nie dałaby się potem odczytać — panel byłby „cudzy" od urodzenia.
    expect(() => claudePaneLabel('ABCDEF0123456789', TRACE)).toThrow();
    expect(() => claudePaneLabel(KEY, '1234567')).toThrow();
    expect(() => claudePaneLabel(`${KEY} x`, TRACE)).toThrow();
    expect(() => termPaneLabel('0123456789abcde')).toThrow();
    expect(() => termPaneLabel('../../etc/passwd')).toThrow();
  });

  it('etykieta spoza wzorca → null (panel jest cudzy)', () => {
    const obce: (string | null | undefined)[] = [
      null, undefined, '', 'atlas', '1',
      // Wielkie litery, brak/nadmiar znaków, sufiksy i prefiksy — wyrażenia są ZAMKNIĘTE.
      `rarog-term ${KEY.toUpperCase()}`,
      `rarog-term ${KEY}0`,
      `rarog-term ${KEY.slice(1)}`,
      `rarog-term ${KEY}\n`,
      `rarog-term  ${KEY}`,
      ` rarog-term ${KEY}`,
      `rarog-term ${KEY} ${TRACE}`,
      `rarog-claude ${KEY}`,
      `rarog-claude ${KEY} `,
      `rarog-claude ${KEY} ${TRACE} extra`,
      `rarog-claude ${KEY} ${TRACE}\u001b`,
      `rarog-claude ${TRACE} ${KEY}`,
    ];
    for (const label of obce) expect(parsePaneLabel(label), String(label)).toBeNull();
  });
});

describe('jeden przedrostek: wyrażenia etykiet i token terminala są zamknięte', () => {
  it('wielkość liter, sklejenia i obce przedrostki → panel cudzy', () => {
    const obce = [
      `Rarog-term ${KEY}`, `RAROG-term ${KEY}`, `rarogx-term ${KEY}`, `xrarog-term ${KEY}`,
      `rarog-rarog-term ${KEY}`, `rarog rarog-term ${KEY}`, `inny-term ${KEY}`, `inny-claude ${KEY} ${TRACE}`,
      `${HERDR_NAME_PREFIX}${HERDR_NAME_PREFIX}-term ${KEY}`, `(?:rarog-term ${KEY}`,
    ];
    for (const label of obce) expect(parsePaneLabel(label), label).toBeNull();
  });

  it('token terminala: wyłącznie klucz `rarog-term`, obcy nie liczy się wcale', () => {
    expect(termPaneTokenOf({ [RAROG_TERM_PANE_TOKEN]: KEY })).toBe(KEY);
    expect(termPaneTokenOf({ [RAROG_TERM_PANE_TOKEN]: KEY, 'inny-term': '0123456789abcdef' })).toBe(KEY);
    expect(termPaneTokenOf({ 'inny-term': KEY })).toBeUndefined();
    expect(termPaneTokenOf({})).toBeUndefined();
    expect(termPaneTokenOf(undefined)).toBeUndefined();
    expect(termPaneTokenOf(null)).toBeUndefined();
  });
});

describe('nazwa agenta Raroga', () => {
  it('generator i wzorzec mają JEDNO źródło — każda wylosowana nazwa pasuje', () => {
    for (let i = 0; i < 50; i += 1) expect(newRarogAgentName()).toMatch(RAROG_AGENT_NAME_RE);
    // …i mieści się we wzorcu nazw agentów herdr.
    expect(newRarogAgentName()).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it('wzorzec jest zamknięty: tylko `rarog-` i dokładnie 6 małych hex', () => {
    expect(RAROG_AGENT_NAME_RE.test('rarog-abc123')).toBe(true);
    for (const name of [
      'rarog-xyz', 'rarogx-abc123', 'rarog-abc1234', 'rarog-ABC123', 'xrarog-abc123',
      'rarog-abc12', 'rarog-abc123\n', 'rarog-m3', '',
    ]) {
      expect(RAROG_AGENT_NAME_RE.test(name), name).toBe(false);
    }
  });

});

/*
 * Etykieta TABA: tab z Claude = etykieta karty, tab terminala = slot/rola
 * i katalog. herdr etykiet nie normalizuje (ESC, `\n`, pusty napis przyjęte — zmierzone),
 * więc czyszczenie jest po stronie Raroga i ma dawać DOKŁADNIE to, co karta.
 */
describe('sanitizeTabLabel — etykieta taba = etykieta karty', () => {
  it('etykieta karty z `labelFromPrompt` przechodzi BEZ ZMIANY', () => {
    for (const prompt of [
      'napraw zapis notatek', 'Zrób refaktor modułu sesji i managera', 'x'.repeat(60), 's3-back',
    ]) {
      const card = labelFromPrompt(prompt) ?? '';
      expect(sanitizeTabLabel(card, 'atlas'), prompt).toBe(card);
    }
  });

  it('ESC, `\n`, pusty napis i same spacje → fallback (nazwa katalogu)', () => {
    expect(sanitizeTabLabel('\u001b', 'atlas')).toBe('atlas');
    expect(sanitizeTabLabel('\n', 'atlas')).toBe('atlas');
    expect(sanitizeTabLabel('', 'atlas')).toBe('atlas');
    expect(sanitizeTabLabel('   ', 'atlas')).toBe('atlas');
    // Znak sterujący W ŚRODKU etykiety: spacja w jego miejscu, jak w tytule panelu.
    expect(sanitizeTabLabel('zły\u001b[31m\ntytuł', 'atlas')).toBe('zły [31m tytuł');
  });

  it('bez osobnego limitu długości — tab dostaje DOKŁADNIE to, co karta', () => {
    // Limit 28 znaków ma już `labelFromPrompt` (etykiety z promptu i tytułu); fallback z nazwy
    // katalogu karta pokazuje cały, więc tab też. Osobne ucięcie rozjeżdżało kartę z tabem.
    expect(sanitizeTabLabel('y'.repeat(103), 'atlas')).toBe('y'.repeat(103));
    expect(sanitizeTabLabel('', 'fjord-dashboard-settings-panel')).toBe('fjord-dashboard-settings-panel');
    // Pusty i fallback — wciąż niepusty napis (fasada odrzuciłaby pustą etykietę).
    expect(sanitizeTabLabel('', '')).toBe('rarog');
  });

  it('czyści tą samą funkcją co karta (`normalizeSessionLabel`) — znaki sterujące, U+2028/2029, białe znaki', () => {
    for (const raw of ['a\u001bb', 'a\u2028b', 'a\u2029b', 'a\u0085b', '  a \t\n b  ', 'a\u00a0b']) {
      expect(sanitizeTabLabel(raw, 'atlas'), JSON.stringify(raw)).toBe(normalizeSessionLabel(raw));
      expect(normalizeSessionLabel(raw), JSON.stringify(raw)).toBe('a b');
    }
  });

  it('idempotentna — nadzorca czyści po managerze drugi raz bez rozjazdu', () => {
    for (const raw of ['y'.repeat(103), 'zły\u001b[31m\ntytuł', '  a   b  ', '', 'ąę ść']) {
      const once = sanitizeTabLabel(raw, 'atlas');
      expect(sanitizeTabLabel(once, 'atlas'), raw).toBe(once);
    }
  });
});

describe('terminalTabLabel — `rarog <slot|rola> · <katalog>`', () => {
  const CWD = '/Users/u/Projects/rarog';

  it('formaty: slot, lazygit, popup', () => {
    expect(terminalTabLabel('shell', 1, CWD)).toBe('rarog 1 · rarog');
    expect(terminalTabLabel('shell', 4, CWD)).toBe('rarog 4 · rarog');
    expect(terminalTabLabel('lazygit', 0, CWD)).toBe('rarog lazygit · rarog');
    expect(terminalTabLabel('popup', 0, CWD)).toBe('rarog popup · rarog');
  });

  it('slot nieznany → sam `rarog`, bez zmyślonego numeru; rola popupowa ignoruje slot', () => {
    expect(terminalTabLabel('shell', null, CWD)).toBe('rarog · rarog');
    expect(terminalTabLabel('lazygit', 3, CWD)).toBe('rarog lazygit · rarog');
  });

  it('długi katalog — cały, bez ucięcia (jak nazwa katalogu na karcie)', () => {
    expect(terminalTabLabel('lazygit', 0, '/Users/u/Projects/fjord-dashboard-settings-panel'))
      .toBe('rarog lazygit · fjord-dashboard-settings-panel');
  });

  it('katalog ze znakiem sterującym i katalog główny', () => {
    expect(terminalTabLabel('shell', 2, '/tmp/a\u001bb')).toBe('rarog 2 · a b');
    expect(terminalTabLabel('popup', 0, '/')).toBe('rarog popup');
  });
});

describe('Claude pane label rebuilt from a read provenance', () => {
  const read = (label: string): ClaudeProvenance => {
    const provenance = parsePaneLabel(label);
    if (provenance?.kind !== 'claude') throw new Error(`not a Claude label: ${label}`);
    return provenance;
  };

  it('keeps the key read from the label, never one hashed again from a path', () => {
    // KEY is the hash of no path, so a rebuild that hashes a directory cannot produce it.
    const owned = read(claudePaneLabel(KEY, TRACE, 'old'));
    expect(claudePaneLabelFrom(owned, 'by hand', 'keep')).toBe(claudePaneLabel(KEY, TRACE, 'by hand'));
    expect(claudePaneLabelFrom(owned, 'atlas', 'fresh')).toBe(claudePaneLabel(KEY, labelTrace('atlas'), 'atlas'));
    expect(claudePaneLabelFrom(owned, '', 'keep')).toBe(claudePaneLabel(KEY, TRACE));
  });

  it('compares the key with a directory and the trace with a tab label', () => {
    const dir = '/Users/u/Projects/atlas';
    const owned = read(claudePaneLabel(projectKey(dir), labelTrace('atlas'), 'atlas'));
    expect(claudeKeyMatches(owned, dir)).toBe(true);
    expect(claudeKeyMatches(owned, '/Users/u/Projects/birch')).toBe(false);
    expect(claudeTraceMatches(owned, 'atlas')).toBe(true);
    expect(claudeTraceMatches(owned, 'Atlas')).toBe(false);
    const term = parsePaneLabel(termPaneLabel(projectKey(dir)));
    expect(term === null ? null : claudeKeyMatches(term, dir)).toBe(false);
  });

  it('a new provenance carries the key of the directory and the trace of the tab label', () => {
    const dir = '/Users/u/Projects/atlas';
    const fresh = newClaudeProvenance(dir, 'atlas');
    expect(claudePaneLabelFrom(fresh, 'atlas', 'keep'))
      .toBe(claudePaneLabel(projectKey(dir), labelTrace('atlas'), 'atlas'));
    expect(claudeKeyMatches(fresh, dir)).toBe(true);
  });
});
