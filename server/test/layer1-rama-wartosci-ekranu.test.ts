/**
 * Guard: the screen values of `PermissionRequest.unavailable` (`SCREEN_UNAVAILABLE_REASONS`) never leave the
 * consent channel frames (`layer1/frames.ts`: the channel card and `permission-settled`). An older app reads an
 * unknown reason on a CHANNEL card as "no buttons at all", so such a value there would take the deny button away
 * from it; on a card without `channel` an older app ignores the field.
 *
 * Sentences this file guards: the channel list and the screen list are disjoint; the layer 1 list equals the channel
 * list and holds no screen value; every layer 1 reason goes out of both frames unchanged and outside the screen list;
 * no layer 1 source file names a screen value or imports the screen list.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSENT_UNAVAILABLE_REASONS, SCREEN_UNAVAILABLE_REASONS } from '@rarog/shared';
import { CONSENT_UNAVAILABLE_REASONS as LAYER1_REASONS } from '../src/herdr/dialogs/layer1/contract.ts';
import { consentPermissionRequest, consentSettledEvent } from '../src/herdr/dialogs/layer1/frames.ts';
import { consentBash, consentView } from './sse-fixtures-producenci-zgody.ts';

const SCREEN: readonly string[] = SCREEN_UNAVAILABLE_REASONS;
const LAYER1_DIR = join(import.meta.dirname, '..', 'src', 'herdr', 'dialogs', 'layer1');

describe('screen values stay off the consent channel frames', () => {
  it('the channel list and the screen list are disjoint', () => {
    expect(CONSENT_UNAVAILABLE_REASONS.filter((reason) => SCREEN.includes(reason))).toEqual([]);
  });

  it('the layer 1 list is the channel list, without a screen value', () => {
    expect([...LAYER1_REASONS].sort()).toEqual([...CONSENT_UNAVAILABLE_REASONS].sort());
    expect(LAYER1_REASONS.filter((reason) => SCREEN.includes(reason))).toEqual([]);
  });

  for (const reason of LAYER1_REASONS) {
    it(`\`${reason}\` goes out of the channel card and \`permission-settled\` as a channel value`, () => {
      const view = consentView('rarog-k-guard', 'Bash', consentBash(false), { canAllow: false, unavailable: reason });
      const card = consentPermissionRequest(view, { cwd: '/Users/demo/Projects/birch', risk: 'normal' });
      const settled = consentSettledEvent(view, Date.parse('2026-11-14T00:00:00.000Z'), true);
      for (const sent of [card.unavailable, settled.unavailable]) {
        expect(sent).toBe(reason);
        expect(SCREEN).not.toContain(sent);
        expect(CONSENT_UNAVAILABLE_REASONS as readonly unknown[]).toContain(sent);
      }
    });
  }

  it('no layer 1 source file names a screen value or imports the screen list', () => {
    const named: string[] = [];
    for (const file of readdirSync(LAYER1_DIR).filter((name) => name.endsWith('.ts'))) {
      const text = readFileSync(join(LAYER1_DIR, file), 'utf8');
      for (const value of SCREEN) {
        if (text.includes(`'${value}'`) || text.includes(`"${value}"`)) named.push(`${file}: ${value}`);
      }
      if (/SCREEN_UNAVAILABLE_REASONS|ScreenUnavailableReason/u.test(text)) named.push(`${file}: screen list`);
    }
    expect(named).toEqual([]);
  });
});
