/**
 * Kontrakt przekaźnika push `/v1/*` po stronie serwera: każde ciało z `shared/fixtures/relay/` przechodzi
 * schemat z `shared/src/relay.ts` (albo odpada, gdy fixture opisuje ciało złe z założenia).
 *
 * Fixture'y pisze strona przekaźnika (`relay/test/fixtures.test.ts` porównuje z nimi kod co do bajtu); ten plik
 * mówi, że schematy serwera czytają te same ciała. Żądania produkowane przez nadajnik serwera porównuje
 * `server/test/relay-fixtures-producenci.test.ts`. Tekst zastępczy serwera (`RELAY_ALERT_PLACEHOLDER`) równa się
 * literałowi polityki przekaźnika (`alert.placeholder` w `alert-policy.json`) — strażnik 13a planu dystrybucji.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RELAY_ALERT_PLACEHOLDER, RELAY_PASS_ERRORS, RELAY_PUSH_ERRORS, relayErrorSchema, relayHealthResponseSchema, relayPassRequestSchema,
  relayPassResponseSchema, relayPushRequestSchema, relayPushResponseSchema,
} from '../src/relay.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/relay');

interface Case {
  readonly route: 'pass' | 'push' | 'health' | 'unknown';
  readonly status: number;
  readonly error?: string;
  /** Wymagany nagłówek POST zły z założenia: ciało jest poprawne, odrzuca je nagłówek. */
  readonly header?: string;
}

interface Fixture {
  readonly request: { readonly method: string; readonly path: string; readonly body?: unknown };
  readonly response: { readonly status: number; readonly body: unknown };
}

const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as {
  readonly cases: Readonly<Record<string, Case>>;
};
const cases = Object.entries(manifest.cases).sort(([a], [b]) => a.localeCompare(b));
const read = (name: string): Fixture => JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as Fixture;

describe('kontrakt przekaźnika: pliki przypadków ↔ schematy serwera', () => {
  it('manifest ↔ katalog: każdy plik przypadku jest w manifeście', () => {
    const files = readdirSync(DIR).filter((name) => name !== 'manifest.json' && name !== 'alert-policy.json').sort();
    expect(files).toEqual(cases.map(([name]) => name));
  });

  it.each(cases)('%s: żądanie przechodzi schemat (bad-request z założenia odpada)', (name, entry) => {
    const { request } = read(name);
    if (entry.route !== 'pass' && entry.route !== 'push') return;
    if (request.method !== 'POST') return;
    const schema = entry.route === 'pass' ? relayPassRequestSchema : relayPushRequestSchema;
    const parsed = schema.safeParse(request.body);
    // `bad-request` ze złym nagłówkiem (`header` w manifeście) ma ciało poprawne: odpada na nagłówku, nie na ciele.
    const valid = entry.error !== 'bad-request' || entry.header !== undefined;
    expect(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`).toBe(valid);
  });

  it.each(cases)('%s: odpowiedź przechodzi schemat odpowiedzi albo błędu', (name, entry) => {
    const { response } = read(name);
    expect(response.status).toBe(entry.status);
    if (entry.status === 200) {
      const schema = entry.route === 'pass' ? relayPassResponseSchema
        : entry.route === 'push' ? relayPushResponseSchema : relayHealthResponseSchema;
      const parsed = schema.safeParse(response.body);
      expect(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      return;
    }
    const error = relayErrorSchema.parse(response.body);
    expect(error.error).toBe(entry.error);
    if (entry.route === 'pass') expect(RELAY_PASS_ERRORS).toContain(error.error);
    if (entry.route === 'push' && entry.status !== 405) expect(RELAY_PUSH_ERRORS).toContain(error.error);
  });

  it('każdy kod błędu tras ma fixture', () => {
    const seen = (route: Case['route']): Set<string> => new Set(cases
      .filter(([, entry]) => entry.route === route && entry.error !== undefined && entry.status !== 405)
      .map(([, entry]) => entry.error ?? ''));
    expect([...seen('pass')].sort()).toEqual([...RELAY_PASS_ERRORS].sort());
    expect([...seen('push')].sort()).toEqual([...RELAY_PUSH_ERRORS].sort());
  });

  it('`devicePass` wyłącznie przy `liveactivity`', () => {
    const body = { v: 1, token: 'ab'.repeat(32), environment: 'development', type: 'alert', topic: 'ai.rarog.app' };
    expect(relayPassRequestSchema.safeParse(body).success).toBe(true);
    expect(relayPassRequestSchema.safeParse({ ...body, devicePass: 'v1.x' }).success).toBe(false);
    expect(relayPassRequestSchema.safeParse({ ...body, type: 'liveactivity' }).success).toBe(false);
    expect(relayPassRequestSchema.safeParse({ ...body, type: 'liveactivity', devicePass: 'v1.x' }).success).toBe(true);
  });

  it('tekst zastępczy serwera = `alert.placeholder` polityki przekaźnika', () => {
    const policy = JSON.parse(readFileSync(path.join(DIR, 'alert-policy.json'), 'utf8')) as {
      alert: { placeholder: unknown };
    };
    expect(RELAY_ALERT_PLACEHOLDER).toEqual(policy.alert.placeholder);
  });
});
