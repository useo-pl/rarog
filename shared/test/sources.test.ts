/**
 * Higiena źródeł: żaden plik tekstowy repo nie może zawierać surowych bajtów sterujących
 * ani separatorów U+2028/U+2029.
 *
 * Ten test istnieje przez konkretną awarię, nie z zamiłowania do porządku. W `manager.ts`
 * wylądował surowy bajt U+0000 (separator klucza mapy zapisany dosłownie zamiast escapem).
 * Kod działał, TypeScript kompilował, testy przechodziły — ale plik stał się dla narzędzi
 * **binarny**: `grep -n "label" manager.ts` nie zwracało NIC, `git diff` pokazałby
 * „Binary files differ", a review szło na ślepo. Najgorsza klasa defektu: nie psuje programu,
 * tylko oślepia wszystkich, którzy go szukają.
 *
 * Escape w źródle daje identyczny ciąg w pamięci i zostawia plik tekstem, więc reguła nic
 * nie kosztuje: bajty sterujące zapisujemy jako `\\uXXXX`, nigdy dosłownie.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Katalogi pisane ręcznie (albo agentami) — bez `node_modules`, `dist` i artefaktów builda.
 *
 * `docs` jest tu nie dla ozdoby: spec implementacji jest kontraktem, który czyta się grepem,
 * a „binarny" plik ze specem oznacza cichą utratę całych sekcji przy wyszukiwaniu.
 * `shared/fixtures` (złote ramki SSE) to też kontrakt: plik czyta klient w innym języku.
 */
const ROOTS = [
  'shared/src', 'shared/test', 'shared/fixtures', 'server/src', 'server/test', 'docs',
];

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html', '.json', '.md']);

/**
 * Dozwolone bajty sterujące: tabulator (U+0009), LF (U+000A), CR (U+000D). Reszta zakresu C0
 * plus DEL (U+007F) nie ma prawa wystąpić dosłownie — każdy z nich albo psuje narzędzia, albo
 * jest niewidoczny w edytorze, albo jedno i drugie.
 *
 * Świadomie pętla po kodach, a nie klasa znaków w regexie: literał regexa musiałby zawierać
 * escape'y, a te bywają rozwijane w SUROWE bajty przez narzędzia, które ten plik zapisują —
 * czyli test wnosiłby dokładnie tę usterkę, której pilnuje. Kody szesnastkowe są odporne.
 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

/**
 * Separatory U+2028 (linii) i U+2029 (akapitu): niewidoczne w edytorze, a JavaScript liczy je
 * jako koniec linii (`.` i `$` w regexie, komentarze `//`). W złotej ramce SSE (`message.unicode`)
 * separator ma stać jako escape — surowy znak w pliku to dokładnie ta pułapka dla parsera
 * klienta, którą ramka ma pokazywać, a nie przemycać.
 */
const FORBIDDEN_SEPARATORS = new Set([0x2028, 0x2029]);

/** Indeks pierwszego zakazanego znaku albo −1. */
function forbiddenAt(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (ALLOWED_CONTROL.has(code)) continue;
    if (code < 0x20 || code === 0x7f || FORBIDDEN_SEPARATORS.has(code)) return i;
  }
  return -1;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

describe('higiena źródeł', () => {
  const files = ROOTS.flatMap((root) => collectFiles(path.join(REPO_ROOT, root)));

  it('zbiera pliki do sprawdzenia (inaczej test przechodziłby za darmo)', () => {
    // Bez tej asercji literówka w ROOTS zamieniłaby test poniżej w pustą pętlę.
    expect(files.length).toBeGreaterThan(30);
  });

  it('żaden plik nie zawiera surowego bajtu sterującego', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const at = forbiddenAt(text);
      if (at < 0) continue;
      const line = text.slice(0, at).split('\n').length;
      const hex = text.charCodeAt(at).toString(16).padStart(4, '0').toUpperCase();
      offenders.push(`${path.relative(REPO_ROOT, file)}:${String(line)} — U+${hex}`);
    }
    expect(offenders).toEqual([]);
  });
});
