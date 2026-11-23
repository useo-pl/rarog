/**
 * Strażnik kluczy limitów: w `src/` każde wywołanie licznika (`limits.pass(`, `limits.push(`,
 * `limits.pushAddr(`) bierze klucz z funkcji `client-key.ts` (`clientBucket`, `pushKey`, `parentKey`), nigdy
 * z surowego nagłówka, adresu ani `tokenHash`; bindingi Workera (`.limit({`) woła tylko adapter, a adres klienta
 * (`cf-connecting-ip…`) czyta tylko adapter. Inaczej jedna zmiana w rdzeniu wróciłaby do klucza per pełny adres IPv6
 * albo per token kafla, które obchodzą limit.
 */
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('../src/*.ts', { eager: true, query: '?raw', import: 'default' });
const byName = Object.entries(sources).map(([file, text]) => [file.split('/').pop() ?? file, text] as const);

/** Funkcje, które jako jedyne składają klucz licznika. */
const KEY_FUNCTIONS = ['clientBucket', 'pushKey', 'parentKey'] as const;
const LIMIT_CALL_RE = /limits\.(pass|push|pushAddr)\s*\(/g;

/** Kod bez komentarzy (`//` do końca linii i bloki), żeby opis w komentarzu nie udawał wywołania. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Naruszenia w jednym pliku: wywołanie licznika z kluczem spoza funkcji `client-key.ts`. */
export function limitKeyViolations(name: string, text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  for (const match of code.matchAll(LIMIT_CALL_RE)) {
    const argument = code.slice((match.index ?? 0) + match[0].length).trimStart();
    if (!KEY_FUNCTIONS.some((fn) => argument.startsWith(`${fn}(`))) {
      out.push(`${name}: limits.${match[1] ?? '?'}(${argument.slice(0, 40)}`);
    }
  }
  if (name !== 'worker.ts' && /\.limit\s*\(\s*\{/.test(code)) out.push(`${name}: binding .limit({ poza worker.ts`);
  if (name !== 'worker.ts' && /cf-connecting-ip/i.test(code)) out.push(`${name}: nagłówek adresu poza worker.ts`);
  return out;
}

describe('strażnik kluczy limitów', () => {
  it('src/: każdy licznik dostaje klucz z client-key.ts; bindingi i nagłówek adresu tylko w worker.ts', () => {
    expect(byName.length).toBeGreaterThan(5);
    expect(byName.flatMap(([name, text]) => limitKeyViolations(name, text))).toEqual([]);
  });

  it('rdzeń woła wszystkie trzy liczniki (strażnik nie przechodzi pustym zbiorem)', () => {
    const core = stripComments(byName.find(([name]) => name === 'core.ts')?.[1] ?? '');
    expect([...core.matchAll(LIMIT_CALL_RE)].map((match) => match[1]).sort()).toEqual(['pass', 'pass', 'push', 'pushAddr']);
  });

  it.each([
    ['surowy adres', 'await context.limits.pass(context.clientAddress ?? "unknown")'],
    ['skrót tokenu', 'await context.limits.push(tokenHash)'],
    ['skrót kafla', 'await context.limits.push(claims.tokenHash)'],
    ['nagłówek', 'context.limits.pushAddr(request.headers.get("cf-connecting-ip"))'],
    ['binding w rdzeniu', 'await env.RL_PASS.limit({ key })'],
  ])('naruszenie (%s) → strażnik je widzi', (_what, line) => {
    expect(limitKeyViolations('core.ts', `const x = 1;\n${line};\n`)).not.toEqual([]);
  });

  it('wywołanie w komentarzu nie jest naruszeniem; klucz z funkcji przechodzi', () => {
    const text = '// limits.push(tokenHash)\n/* limits.pass(raw) */\nawait limits.push(pushKey(claims));\n';
    expect(limitKeyViolations('core.ts', text)).toEqual([]);
  });
});
