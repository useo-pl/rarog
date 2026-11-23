/**
 * Biała lista logu rejestru (`src/log.ts`, formatter wspólny z przekaźnikiem push): pole spoza listy albo wartość
 * o złym kształcie odpada; pełny EndpointId wyłącznie jako 64 znaki hex małymi literami. Na konsolę pisze wyłącznie
 * adapter `worker.ts`. Szpieg na wszystkich ścieżkach rdzenia: `core.test.ts`, „log: biała lista”.
 */
import { describe, expect, it } from 'vitest';
import { LOG_ROUTES, filterLogFields, formatLogLine } from '../src/log.ts';

const SOURCES = import.meta.glob<string>('../src/**/*.ts', { eager: true, query: '?raw', import: 'default' });

describe('biała lista pól', () => {
  it('pola rejestru o dobrym kształcie zostają', () => {
    const fields = {
      event: 'request', route: 'register', status: 200, code: 'bad-request', field: 'proof.token', ms: 3,
      client: 'rarog-app/0.1.0', gate: 'devicecheck', fresh: true, apple_status: 400, reason: 'BadDeviceToken',
      cause: 'timeout', problem: 'gate-key-missing', decision: 'deny', enforce: false, endpoint: 'ab'.repeat(32),
    };
    expect(filterLogFields(fields)).toEqual(fields);
    expect(JSON.parse(formatLogLine(fields))).toEqual(fields);
  });

  it('pola spoza listy i złe kształty odpadają', () => {
    expect(filterLogFields({
      token: 'QUJD', sig: 'ab'.repeat(64), authorization: 'Bearer x', ip: '198.51.100.7', servers: ['a1'.repeat(32)],
      message: 'Error: x', env: 'production',
      route: 'pass', field: 'label', decision: 'maybe', endpoint: 'AB'.repeat(32), gate: 'appattest',
      client: 'Bearer abc', status: '200', fresh: 'yes', reason: 'Bad Device Token', code: 'Bad',
    })).toEqual({});
    expect(filterLogFields({ endpoint: 'ab'.repeat(31) })).toEqual({});
  });

  it('trasy logu = trasy kontraktu + unknown', () => {
    expect([...LOG_ROUTES].sort()).toEqual(
      ['access', 'allow', 'deny', 'forget', 'health', 'register', 'renew', 'sponsor', 'unknown'],
    );
  });
});

describe('konsola tylko w adapterze', () => {
  it('`console.` występuje wyłącznie w src/worker.ts', () => {
    const writers = Object.entries(SOURCES).filter(([, text]) => /\bconsole\./.test(text)).map(([file]) => file);
    expect(writers).toEqual(['../src/worker.ts']);
    expect(Object.keys(SOURCES)).toContain('../src/core.ts');
  });
});
