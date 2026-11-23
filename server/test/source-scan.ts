/**
 * Skaner źródła TypeScript dla strażników granic (`herdr-background-boundary.test.ts`,
 * `herdr-commands-boundary.test.ts`): kod bez komentarzy, szkielet nawiasów i lista plików; treść napisów
 * z miejscem czyta strażnik tożsamości (`product-identity-guard.test.ts`, teksty pushy i zdania serwera dla apki).
 *
 * Wyniesiony z `herdr-background-boundary.test.ts`, gdy drugi strażnik zaczął pytać
 * o literały w KODZIE tak samo. Testy samego skanera zostały tam, gdzie powstały.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoFiles } from '../../scripts/lib/repo-files.mjs';

/**
 * Pliki repo pod `root` (opcjonalnie pod `sub`) względem `root`: z gitem `git ls-files --cached --others
 * --exclude-standard`, bez `.git` (eksport) spacer z regułami `.gitignore`. Reguła i jej opis:
 * `scripts/lib/repo-files.mjs` (ta sama lista dla skanera prywatnych literałów i bramki publikacji).
 */
export { repoFiles };

/**
 * Pliki tekstowe repo pod `root` (opcjonalnie pod `sub`) jako mapa ścieżka → treść; pliki binarne (bajt zerowy
 * w pierwszych 8000 bajtach) i nie-pliki (dowiązania) pominięte. `skip` wyklucza ścieżki (np. sam strażnik).
 */
export function repoTextFiles(root: string, sub?: string, skip: (file: string) => boolean = () => false): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of repoFiles(root, sub)) {
    if (skip(file)) continue;
    const full = join(root, file);
    // Dowiązanie nie jest treścią pliku (cel czyta skaner prywatnych literałów); nieczytelny plik to wyjątek.
    if (!lstatSync(full).isFile()) continue;
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 8000).includes(0)) continue;
    files.set(file, bytes.toString('utf8'));
  }
  return files;
}

/** Pliki `.ts` pod `dir`, rekurencyjnie, jako ścieżki bezwzględne. */
export function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) out.push(...tsFiles(path));
    else if (item.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

/**
 * Ścieżki względne, które plik importuje, w trzech kształtach: `from '…'` (także `import type` i reeksporty),
 * import dla efektu (`import '…'`) i dynamiczny (`import('…')`, także w grawisach bez `${…}`). Na tej liście stoją
 * zakazy strażników granic, więc kształt, którego wzorzec nie widzi, jest cichą dziurą w zakazie.
 */
export function relativeImports(source: string): string[] {
  return [
    ...[...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((hit) => hit[1]),
    ...[...source.matchAll(/\bimport\s+['"](\.[^'"]+)['"]/g)].map((hit) => hit[1]),
    ...[...source.matchAll(/\bimport\s*\(\s*(['"`])(\.[^'"`$]+)\1\s*\)/g)].map((hit) => hit[2]),
  ].map((spec) => spec ?? '');
}

/**
 * The scanner itself lives in `scripts/lib/source-scan.mjs` (pure ESM, so it also runs before `pnpm install`);
 * the tests import it from here.
 */
export { scan } from '../../scripts/lib/source-scan.mjs';
export type { Scanned } from '../../scripts/lib/source-scan.mjs';

/** Pierwszy niedomknięty albo nadmiarowy nawias szkieletu; `null` = nawiasy się domykają. */
export function unbalanced(skeleton: string): string | null {
  const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of skeleton) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in OPEN && stack.pop() !== OPEN[ch]) return `nadmiarowe „${ch}"`;
  }
  return stack.length === 0 ? null : `niedomknięte „${stack.join('')}"`;
}

/** Liczba wywołań `import(…)` z argumentem innym niż literał napisu w kodzie bez komentarzy (strażniki iroh). */
export function nonLiteralImports(code: string): number {
  let count = 0;
  for (const hit of code.matchAll(/\bimport\s*\(\s*/g)) {
    const rest = code.slice((hit.index ?? 0) + hit[0].length);
    const literal = /^(['"])[^'"\n]*\1\s*\)/.test(rest) || /^`[^`$]*`\s*\)/.test(rest);
    if (!literal) count += 1;
  }
  return count;
}
