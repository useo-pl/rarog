/**
 * Lista plików repo — JEDNA reguła dla strażników (`server/test/source-scan.ts`, `repoFiles`), skanera prywatnych
 * literałów (`scripts/lib/private-scan.mjs`) i bramki publikacji (`docs/publishing.md`).
 *
 * Z gitem (`.git` w korzeniu jako katalog ALBO plik, jak w worktree): `git ls-files -z --cached --others
 * --exclude-standard`, czyli pliki śledzone i nowe nieignorowane. Bez `.git` (eksport `git archive`, kopia bez
 * historii): spacer po drzewie z wzorcami `.gitignore` korzenia i podkatalogów, tymi samymi regułami, które czyta
 * git. Spacer NIE wyklucza katalogów po nazwie: `node_modules` znika, bo stoi w `.gitignore`, a nie dlatego, że tak
 * się nazywa. Nie zna `.git/info/exclude` ani globalnego `core.excludesFile`: eksport ich nie ma. Pomija tylko wpis
 * `.git`, którego git też nigdy nie wypisuje.
 *
 * Dowiązanie to plik (jak w gicie): spacer nie wchodzi za nie. Nieczytelny katalog albo `.gitignore` to wyjątek,
 * nie cisza: strażnik, który po cichu widzi mniej plików, przepuszcza to, czego miał pilnować. Z tego samego powodu
 * nazwa spoza UTF-8 (z gita albo ze spaceru) to wyjątek: dekodowanie podmieniłoby bajty na U+FFFD, a filtr obecności
 * na dysku po cichu wyrzuciłby taki plik z listy.
 *
 * Czysty ESM, wyłącznie `node:*`: działa przed `pnpm install` (bramka uruchamia skaner na czystym eksporcie).
 * Typy: `repo-files.d.mts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Nazwa z bajtów; bajty spoza UTF-8 to wyjątek (`where` mówi, skąd nazwa), nie cicha podmiana na U+FFFD. */
function utf8Name(bytes, where) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${where}: name is not UTF-8 (bytes ${bytes.toString('hex')}): the file list cannot describe it`);
  }
  return text;
}

/** Tryb listy: `git` — z indeksu i drzewa przez git; `walk` — spacer z regułami `.gitignore`. */
export function repoFilesMode(root) {
  return existsSync(path.join(root, '.git')) ? 'git' : 'walk';
}

/** Znak wzorca gitignore → fragment wyrażenia regularnego (bez `**`, które obsługuje `globToRegex`). */
function globChars(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length) {
      i += 1;
      out += escapeRegex(glob[i]);
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = glob.indexOf(']', glob[i + 1] === '!' || glob[i + 1] === '^' ? i + 3 : i + 2);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      // Jak w gicie (fnmatch z FNM_PATHNAME): klasa, także zanegowana albo z zakresem, nie dopasowuje `/`.
      out += `(?!/)[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

function escapeRegex(ch) {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/** Wzorzec bez wiodącego `/` → wyrażenie na ścieżce względem katalogu `.gitignore` (`**` według gitignore(5)). */
function globToRegex(glob) {
  const parts = glob.split('/');
  let out = '';
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**') {
      // `**/` na początku i `/**/` w środku: zero albo więcej katalogów; `/**` na końcu: wszystko w środku.
      out += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    out += globChars(part) + (last ? '' : '/');
  });
  return new RegExp(`^${out}$`, 'u');
}

/**
 * Reguły jednego pliku `.gitignore` (`base` — jego katalog względem korzenia, `''` dla korzenia), według
 * gitignore(5): `#` komentarz, `!` negacja, `/` na końcu = tylko katalog, `/` na początku albo w środku = wzorzec
 * zakotwiczony w katalogu pliku, bez `/` = nazwa na dowolnej głębokości.
 */
export function parseGitignore(text, base = '') {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/u, '');
    if (line === '' || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === '') continue;
    const anchored = line.includes('/');
    const glob = anchored ? line.replace(/^\//, '') : `**/${line}`;
    rules.push({ base, negate, dirOnly, regex: globToRegex(glob) });
  }
  return rules;
}

/**
 * Czy ścieżka (względem korzenia, `/`) jest ignorowana przez reguły `stack` (od korzenia w głąb). Głębszy plik
 * wygrywa z płytszym, w pliku wygrywa ostatnia pasująca reguła — jak w gicie.
 */
export function isIgnored(relPath, isDir, stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const rule = stack[i];
    if (rule.dirOnly && !isDir) continue;
    const local = rule.base === '' ? relPath : relPath.startsWith(`${rule.base}/`) ? relPath.slice(rule.base.length + 1) : null;
    if (local === null) continue;
    if (rule.regex.test(local)) return !rule.negate;
  }
  return false;
}

/** Spacer po drzewie z regułami `.gitignore` (tryb `walk`): ścieżki plików i dowiązań względem `root`. */
export function walkRepoFiles(root) {
  const out = [];
  const visit = (rel, stack) => {
    const dir = rel === '' ? root : path.join(root, rel);
    // Nazwy jako bajty: napis z `readdirSync` ma już podmienione bajty spoza UTF-8.
    const entries = readdirSync(dir, { withFileTypes: true, encoding: 'buffer' })
      .map((entry) => ({ entry, name: utf8Name(entry.name, rel === '' ? '.' : rel) }));
    const own = entries.find(({ entry, name }) => name === '.gitignore' && entry.isFile());
    const here = own === undefined ? stack : [...stack, ...parseGitignore(readFileSync(path.join(dir, '.gitignore'), 'utf8'), rel)];
    for (const { entry, name } of entries) {
      if (name === '.git') continue;
      const child = rel === '' ? name : `${rel}/${name}`;
      const isDir = entry.isDirectory();
      if (isIgnored(child, isDir, here)) continue;
      if (isDir) visit(child, here);
      else out.push(child);
    }
  };
  visit('', []);
  return out;
}

/** Pliki z gita (tryb `git`): śledzone i nowe nieignorowane, opcjonalnie pod `sub`. */
function gitRepoFiles(root, sub) {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  if (sub !== undefined) args.push('--', sub);
  const raw = execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  const out = [];
  for (let start = 0; start < raw.length;) {
    let end = raw.indexOf(0, start);
    if (end === -1) end = raw.length;
    if (end > start) out.push(utf8Name(raw.subarray(start, end), 'git ls-files'));
    start = end + 1;
  }
  return out;
}

/**
 * Pliki repo pod `root` (opcjonalnie tylko pod podkatalogiem `sub`) jako ścieżki względem `root` z `/`,
 * posortowane, bez powtórzeń i bez wpisów, których nie ma na dysku (plik w indeksie, skasowany z drzewa roboczego).
 * Pliki binarne zostają: o treści decyduje wołający.
 */
export function repoFiles(root, sub) {
  const prefix = sub === undefined ? undefined : sub.replace(/\/+$/, '');
  const listed = repoFilesMode(root) === 'git'
    ? gitRepoFiles(root, prefix)
    : walkRepoFiles(root).filter((file) => prefix === undefined || file === prefix || file.startsWith(`${prefix}/`));
  const present = [...new Set(listed)].filter((file) => {
    try {
      lstatSync(path.join(root, file));
      return true;
    } catch (err) {
      if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return false;
      throw err;
    }
  });
  return present.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
