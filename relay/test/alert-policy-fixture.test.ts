/**
 * Literały polityki wkompilowane w przekaźnik = `shared/fixtures/relay/alert-policy.json` (kontrakt z serwerem).
 * Zmiana w jednym miejscu bez drugiego przewraca ten test.
 */
import { describe, expect, it } from 'vitest';
import policy from '../../shared/fixtures/relay/alert-policy.json';
import {
  ALERT_PLACEHOLDER, ALERT_PLACEHOLDER_KEYS, ALERT_POLICIES, APS_KEYS, LIVE_ACTIVITY_CHIME, LIVE_ACTIVITY_CHIME_KEYS,
  TOP_LEVEL_KEYS,
} from '../src/alert-policy.ts';
import { APNS_PAYLOAD_MAX_BYTES, POLICY_RULES } from '../src/policy.ts';

describe('alert-policy.json ↔ kod przekaźnika', () => {
  it('polityki', () => {
    expect(policy.policies).toEqual([...ALERT_POLICIES]);
  });

  it('baner: tekst zastępczy (literał i klucze), mutable-content', () => {
    expect(policy.alert).toEqual({
      placeholder: ALERT_PLACEHOLDER, placeholderKeys: ALERT_PLACEHOLDER_KEYS, mutableContent: 1,
    });
  });

  it('kafel: dzwonek (literał i klucze)', () => {
    expect(policy.liveactivity.chime).toEqual(LIVE_ACTIVITY_CHIME);
    expect(policy.liveactivity.chimeKeys).toEqual(LIVE_ACTIVITY_CHIME_KEYS);
  });

  it('zamknięte zestawy kluczy, sufit ładunku, nazwy reguł', () => {
    expect(policy.topLevelKeys).toEqual(TOP_LEVEL_KEYS);
    expect(policy.apsKeys).toEqual(APS_KEYS);
    expect(policy.payloadMaxBytes).toBe(APNS_PAYLOAD_MAX_BYTES);
    expect(policy.rules).toEqual([...POLICY_RULES]);
  });

  it('klucze lokalizacji z prefiksem push. (katalog pushy apki i NSE)', () => {
    for (const key of [...Object.values(ALERT_PLACEHOLDER_KEYS), ...Object.values(LIVE_ACTIVITY_CHIME_KEYS)]) {
      expect(key).toMatch(/^push\.[a-z]+\.[a-z]+$/);
    }
  });
});
