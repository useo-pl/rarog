/**
 * Różnica linii dwóch tekstów w kształcie hunków `diff -u` (bez nagłówków plików): `@@ -a,b +c,d @@`, potem linie
 * z prefiksem ` ` (kontekst), `-` (tylko przed) i `+` (tylko po). Czyta ją człowiek przed zapisem kopii hooka
 * w trybie paczki npm, więc liczy się czytelność, nie najkrótszy wynik: wspólny początek i koniec odpadają,
 * środek idzie przez najdłuższy wspólny podciąg, a środek za duży na tablicę ({@link LCS_CELLS_MAX}) to jeden blok
 * „wszystko przed, wszystko po”. Moduł nie importuje niczego.
 */

/** Sufit komórek tablicy najdłuższego wspólnego podciągu (4 B każda): ok. 2000 × 2000 linii zmienionego środka. */
const LCS_CELLS_MAX = 4_000_000;

interface Op {
  readonly kind: ' ' | '-' | '+';
  readonly text: string;
  /** Linie tekstu „przed” i „po” przed tą operacją (pozycja w obu tekstach). */
  readonly before: number;
  readonly after: number;
}

/** Operacje środka: najdłuższy wspólny podciąg albo, przy za dużej tablicy, usunięcie całości i dodanie całości. */
function middleOps(a: readonly string[], b: readonly string[]): (' ' | '-' | '+')[] {
  if (a.length * b.length > LCS_CELLS_MAX) return [...a.map(() => '-' as const), ...b.map(() => '+' as const)];
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: (' ' | '-' | '+')[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(' ');
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))) {
      out.push('-');
      i += 1;
    } else {
      out.push('+');
      j += 1;
    }
  }
  return out;
}

/** Wszystkie operacje: wspólny początek, środek, wspólny koniec, z pozycją w obu tekstach. */
function allOps(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const kinds: (' ' | '-' | '+')[] = [
    ...a.slice(0, head).map(() => ' ' as const),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(() => ' ' as const),
  ];
  const ops: Op[] = [];
  let before = 0;
  let after = 0;
  for (const kind of kinds) {
    const text = kind === '+' ? b[after] ?? '' : a[before] ?? '';
    ops.push({ kind, text, before, after });
    if (kind !== '+') before += 1;
    if (kind !== '-') after += 1;
  }
  return ops;
}

/** Nagłówek hunka: początek liczony od 1, a przy zerze linii pozycja linii przed hunkiem (konwencja `diff -u`). */
function hunkHeader(ops: readonly Op[]): string {
  const first = ops[0];
  const beforeCount = ops.filter((op) => op.kind !== '+').length;
  const afterCount = ops.filter((op) => op.kind !== '-').length;
  const start = (at: number, count: number): number => (count === 0 ? at : at + 1);
  return `@@ -${String(start(first?.before ?? 0, beforeCount))},${String(beforeCount)}`
    + ` +${String(start(first?.after ?? 0, afterCount))},${String(afterCount)} @@`;
}

/**
 * Hunki różnicy `before` → `after` z `context` liniami kontekstu; teksty równe dają pustą listę. Linie to człony
 * po `\n`, więc różnica w samym końcowym `\n` to pusta linia `-` albo `+` na końcu.
 */
export function lineDiff(before: string, after: string, context = 3): string[] {
  if (before === after) return [];
  const ops = allOps(before.split('\n'), after.split('\n'));
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  const out: string[] = [];
  let at = 0;
  while (at < changed.length) {
    const from = Math.max(0, (changed[at] ?? 0) - context);
    let last = changed[at] ?? 0;
    while (at + 1 < changed.length && (changed[at + 1] ?? 0) - last <= 2 * context) {
      at += 1;
      last = changed[at] ?? last;
    }
    const hunk = ops.slice(from, Math.min(ops.length, last + context + 1));
    out.push(hunkHeader(hunk));
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
    at += 1;
  }
  return out;
}
