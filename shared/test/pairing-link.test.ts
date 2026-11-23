/**
 * Link parowania: przypadki `shared/fixtures/pairing-links/manifest.json` → `parsePairingLink`
 * i `buildPairingLink`. Te same przypadki czyta `PairingLinkWireTests` w `RarogContract` (lustro Swift), więc
 * manifest jest kontraktem obu stron: tekst → pola albo kod błędu, a pola → link w postaci kanonicznej.
 *
 * Oczekiwane wartości manifestu są pisane ręcznie (generator przypadków poza repo nie woła parsera). Postać `k=`
 * i `r=` ze źródła iroh opisuje `sources` w manifeście.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  IROH_ENDPOINT_ID_RE, PAIRING_LINK_ERRORS, PAIRING_LINK_HOST, PAIRING_LINK_SCHEME, buildPairingLink, irohRelayUrl,
  pairingServerUrl, parsePairingLink,
} from '../src/pairing-link.ts';
import { serverIrohSchema } from '../src/rest.ts';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/pairing-links/manifest.json');

const fieldsSchema = z.strictObject({
  server: z.string().nullable(),
  iroh: z.strictObject({ endpointId: z.string(), relay: z.string() }).nullable(),
  code: z.string(),
});
const caseSchema = z.union([
  z.strictObject({ text: z.string(), ok: fieldsSchema, link: z.string() }),
  z.strictObject({ text: z.string(), error: z.enum(PAIRING_LINK_ERRORS) }),
]);
const manifest = z.strictObject({
  sources: z.strictObject({ endpointId: z.string().min(1), relay: z.string().min(1) }),
  cases: z.record(z.string(), caseSchema),
}).parse(JSON.parse(readFileSync(FILE, 'utf8')));

const cases = Object.entries(manifest.cases).sort(([a], [b]) => a.localeCompare(b));
const okCases = cases.flatMap(([name, entry]) => ('ok' in entry ? [[name, entry] as const] : []));
/** The app's former custom scheme: a link under it is rejected like any other foreign scheme. */
const LEGACY_SCHEME = 'pilot'; // stara-nazwa

describe('link parowania: manifest → parser i składanie', () => {
  it.each(cases)('%s', (name, entry) => {
    const result = parsePairingLink(entry.text);
    if ('ok' in entry) {
      expect(result, name).toEqual({ ok: true, fields: entry.ok });
    } else {
      expect(result, name).toEqual({ ok: false, error: entry.error });
    }
  });

  it.each(okCases)('%s: złożenie daje link z manifestu, a jego parsowanie te same pola (round-trip)', (name, entry) => {
    const link = buildPairingLink(entry.ok);
    expect(link, name).toBe(entry.link);
    expect(parsePairingLink(link), name).toEqual({ ok: true, fields: entry.ok });
  });

  it('coverage: every error code, three transport combinations under both prefixes, `t=`, whitespace, `v=2`', () => {
    const errors = new Set(cases.flatMap(([, entry]) => ('error' in entry ? [entry.error] : [])));
    expect([...errors].sort()).toEqual([...PAIRING_LINK_ERRORS].sort());
    // Both accepted prefixes: the custom scheme and the universal link on the site domain.
    for (const prefix of [`${PAIRING_LINK_SCHEME}://pair#`, `https://${PAIRING_LINK_HOST}/pair#`]) {
      const fields = okCases.flatMap(([, entry]) => (entry.text.startsWith(prefix) ? [entry.ok] : []));
      expect(fields.some((f) => f.server !== null && f.iroh === null), `${prefix} u only`).toBe(true);
      expect(fields.some((f) => f.server !== null && f.iroh !== null), `${prefix} u+k+r`).toBe(true);
      expect(fields.some((f) => f.server === null && f.iroh !== null), `${prefix} k+r without u`).toBe(true);
      expect(cases.some(([, entry]) => entry.text.startsWith(`${prefix}v=2&`)), `${prefix} v=2`).toBe(true);
    }
    const texts = okCases.map(([, entry]) => entry.text);
    expect(texts.some((text) => text.includes('&t=')), 'field t= skipped').toBe(true);
    expect(texts.some((text) => /\s/.test(text)), 'whitespace').toBe(true);
  });

  it('the legacy scheme yields no fields: every valid custom-scheme link under it is not-a-link', () => {
    expect(LEGACY_SCHEME).not.toBe(PAIRING_LINK_SCHEME);
    const prefix = `${PAIRING_LINK_SCHEME}://`;
    const valid = okCases.flatMap(([, entry]) => (entry.text.startsWith(prefix) ? [entry.text] : []));
    expect(valid.length).toBeGreaterThan(0);
    const legacy = valid.map((text) => `${LEGACY_SCHEME}${text.slice(PAIRING_LINK_SCHEME.length)}`);
    for (const text of [...legacy, `${LEGACY_SCHEME}://session/x`]) {
      expect(parsePairingLink(text), text).toEqual({ ok: false, error: 'not-a-link' });
    }
  });

  it('postać kanoniczna jest punktem stałym: wartości z manifestu przechodzą reguły bez zmian', () => {
    for (const [name, { ok }] of okCases) {
      if (ok.server !== null) expect(pairingServerUrl(ok.server), name).toBe(ok.server);
      if (ok.iroh !== null) {
        expect(ok.iroh.endpointId, name).toMatch(IROH_ENDPOINT_ID_RE);
        expect(irohRelayUrl(ok.iroh.relay), name).toBe(ok.iroh.relay);
        // Ten sam kształt co `iroh` w odpowiedziach REST (`PairResponse.server`, `/api/version`).
        expect(serverIrohSchema.parse(ok.iroh), name).toEqual(ok.iroh);
      }
    }
  });

  it('relaye n0 z iroh v1.4.1 (`iroh/src/defaults.rs`): host z kropką na końcu, ukośnik dokłada postać kanoniczna', () => {
    for (const host of ['use1-1.relay.n0.iroh.link.', 'usw1-1.relay.n0.iroh.link.', 'euc1-1.relay.n0.iroh.link.',
      'aps1-1.relay.n0.iroh.link.']) {
      expect(irohRelayUrl(`https://${host}`)).toBe(`https://${host}/`);
      expect(irohRelayUrl(`https://${host}/`)).toBe(`https://${host}/`);
    }
  });

  it('without `iroh` the fragment is byte for byte the one before the `k=`/`r=` fields (also for an address outside the rules)', () => {
    const before = (url: string, code: string): string =>
      `https://${PAIRING_LINK_HOST}/pair#v=1&u=${encodeURIComponent(url)}&c=${code}`;
    for (const [url, code] of [
      ['https://rarog.example.ts.net', 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'],
      ['http://127.0.0.1:18930', 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'],
      ['https://a.example', 'k'],
      ['https://Rarog.example:443/x?y#z', 'kod'],
    ] as const) {
      expect(buildPairingLink({ server: url, iroh: null, code })).toBe(before(url, code));
    }
  });

  it('link złożony z adresu `RAROG_ORIGINS` albo `--url` wraca z tym samym adresem (wielkie litery, IPv6, loopback)', () => {
    // Apka liczy z tego adresu `Origin`, a bramka serwera porównuje go dosłownie z `RAROG_ORIGINS`.
    for (const server of ['https://rarog.example.ts.net', 'https://Rarog.Example.ts.net', 'https://[2001:db8::1]:8930',
      'https://[fd7a:115c:a1e0::1]', 'http://127.0.0.1:18930', 'https://rarog.example.ts.net.']) {
      const code = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
      const link = buildPairingLink({ server, iroh: null, code });
      expect(parsePairingLink(link), server).toEqual({ ok: true, fields: { server, iroh: null, code } });
    }
  });

  it('`iroh` w odpowiedziach REST: kanoniczny relay i EndpointId; inna postać odpada', () => {
    const iroh = { endpointId: 'a'.repeat(64), relay: 'https://relay.example.com/' };
    expect(serverIrohSchema.parse(iroh)).toEqual(iroh);
    for (const bad of [
      { ...iroh, endpointId: 'A'.repeat(64) },
      { ...iroh, endpointId: 'a'.repeat(63) },
      { ...iroh, relay: 'https://relay.example.com' },
      { ...iroh, relay: 'https://relay.example.com:443/' },
      { ...iroh, relay: 'http://relay.example.com/' },
      { endpointId: iroh.endpointId },
    ]) {
      expect(serverIrohSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
