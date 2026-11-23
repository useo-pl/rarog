/**
 * Golden SSE frames, producers of consent card frames: `sse-fixtures-producenci.test.ts` runs them next to
 * its other producers and checks each frame against `shared/fixtures/sse/` (the manifest must name every frame it
 * produces). Frames are built by server code and go through `formatSseEvent`, as in the test file.
 */
import type { ServerEvent } from '@rarog/shared';
import { formatSseEvent } from '../src/sse.ts';
import { clipForDisplay } from '../src/drivers/tool-text.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { consentOnlyEvent } from '../src/herdr/dialogs/consent-gate.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { consentHookWhyOf } from '../src/herdr/dialogs/layer1/desk-reason.ts';
import type { ConsentDeskRelease } from '../src/herdr/dialogs/layer1/desk-reason.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { presentConsentInput } from '../src/herdr/dialogs/layer1/card.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import {
  consentPermissionRequest, consentResolvedEvent, consentSettledEvent,
} from '../src/herdr/dialogs/layer1/frames.ts';

/** Produced frames: file name in `shared/fixtures/sse/` → frame as the client gets it. */
type Produced = Map<string, unknown>;

/** Ramka tak, jak dostaje ją klient: przez `formatSseEvent` i `JSON.parse` pola `data:`. */
export function overWire(event: ServerEvent): Record<string, unknown> {
  const data = formatSseEvent(event, null).split('\n').find((line) => line.startsWith('data: '))?.slice(6);
  if (data === undefined) throw new Error('ramka bez pola data:');
  return JSON.parse(data) as Record<string, unknown>;
}

/** Widok karty kanału z pełną prezentacją wejścia (`card.ts`), jak go trzyma magazyn kart (`cards.ts`). */
export function consentView(
  permId: string, toolName: string, toolInput: unknown, patch: Partial<ConsentCardView> = {},
): ConsentCardView {
  return {
    permId, sessionId: 'herdr-w1-p2', promptId: 'prompt-hook-1', toolName, agentId: null,
    presentation: presentConsentInput(toolName, toolInput),
    state: 'pending', canAllow: true, canDeny: true, canRelease: true, unavailable: null, cause: null, late: false,
    createdAt: Date.parse('2026-10-03T08:02:00.000Z'),
    ...patch,
  };
}

/** Wejście `Bash` karty kanału; `sandbox` dokłada `dangerouslyDisableSandbox: true`. */
export const consentBash = (sandbox: boolean): Record<string, unknown> => ({
  command: 'pnpm test server/test/layer1-cycle.test.ts',
  description: 'Run the consent cycle tests',
  timeout: 120000,
  ...(sandbox ? { dangerouslyDisableSandbox: true } : {}),
});

/**
 * Kanał zgód (warstwa 1): ramki karty kanału z `layer1/frames.ts` nad widokiem z `card.ts`. Manager jeszcze
 * tych kart nie wystawia, więc migawka transkryptu z kartami kanału powstaje tu z tych samych funkcji ramek.
 */
export function produceConsent(out: Produced): void {
  const context = { cwd: '/Users/demo/Projects/birch', risk: 'normal', dialogVisible: true } as const;
  const pending = consentView('rarog-k-7f3a91', 'Bash', consentBash(false));
  out.set('permission-pending.hook.json', overWire({
    type: 'permission-pending', request: consentPermissionRequest(pending, context),
  }));
  const running = consentView('rarog-k-7f3a91', 'Bash', consentBash(false), {
    state: 'running', canAllow: false, canDeny: false, canRelease: false,
  });
  out.set('permission-pending.hook-running.json', overWire({
    type: 'permission-pending', request: consentPermissionRequest(running, context),
  }));
  // „Zawsze”: dosłowna reguła z propozycji hooka i cel zapisu, obok przycisku zgody.
  const always = consentView('rarog-k-4d2a17', 'Bash', consentBash(false), {
    always: [{ kind: 'rule', value: 'Bash(pnpm test:*)', destination: 'localSettings' }],
  });
  out.set('permission-pending.hook-always.json', overWire({
    type: 'permission-pending', request: consentPermissionRequest(always, context),
  }));
  // Ta sama komenda bez sandboksa: osobna karta z uwagą `sandbox-disabled`.
  const sandbox = consentView('rarog-k-2c8e04', 'Bash', consentBash(true));
  out.set('permission-pending.hook-sandbox.json', overWire({
    type: 'permission-pending', request: consentPermissionRequest(sandbox, context),
  }));
  const sibling = consentView('rarog-k-91d0b6', 'Write', {
    file_path: '/Users/demo/Projects/birch/notes.md', content: '# Notes\n',
  }, { canAllow: false, unavailable: 'terminal-only', agentId: 'agent-a1' });
  out.set('permission-pending.hook-siblings.json', overWire({
    type: 'permission-pending',
    request: consentPermissionRequest(sibling, { ...context, dialogVisible: false, siblingsDenied: 2 }),
  }));
  const truncated = consentView('rarog-k-5b7d22', 'Write', null, { canAllow: false, unavailable: 'truncated' });
  out.set('permission-pending.hook-truncated.json', overWire({
    type: 'permission-pending', request: consentPermissionRequest(truncated, context),
  }));
  // Komenda ze znakiem kierunku pisma U+202E: treść na karcie, bez przycisku zgody (`hidden-chars`).
  const hidden = consentView('rarog-k-3e61f0', 'Bash', {
    command: `echo ${String.fromCodePoint(0x202e)}gnp.exe`, description: 'Print a file name',
  }, { canAllow: false, unavailable: 'hidden-chars' });
  out.set('permission-pending.hook-hidden.json', overWire({
    type: 'permission-pending', request: consentPermissionRequest(hidden, context),
  }));
  const proofless = consentView('rarog-k-7f3a91', 'Bash', consentBash(false), {
    canAllow: false, unavailable: 'no-proof',
  });
  out.set('permission-settled.max.json', overWire(
    consentSettledEvent(proofless, Date.parse('2026-10-03T08:02:05.000Z'), true),
  ));
  const released = consentView('rarog-k-7f3a91', 'Bash', consentBash(false), {
    state: 'released', canAllow: false, canDeny: false, canRelease: false,
  });
  const resolved = consentResolvedEvent(released, 'release', 'iPad');
  if (resolved === null) throw new Error('`released` to stan końcowy, a ramki nie ma');
  out.set('permission-resolved.release.json', overWire(resolved));
  out.set('transcript-snapshot.hook.json', overWire({
    type: 'transcript-snapshot', sessionId: 'herdr-w1-p2', messages: [],
    pendingPermissions: [
      consentPermissionRequest(sandbox, context),
      consentPermissionRequest(sibling, { ...context, dialogVisible: false, siblingsDenied: 2 }),
      consentPermissionRequest(always, context),
    ],
    pendingQuestions: [],
  }));
}

/**
 * Consent cards WITHOUT `channel` (from the screen or jsonl) as the herdr driver hands them to the manager: each event
 * goes through the consent gate (`consent-gate.ts`), which takes the approve button away in channel mode and adds
 * the reason (`screen-unavailable.ts`). The manager under test turns them into frames (`reqId` → event):
 * `settings-changed` (a subagent request the hook list sent back to the desk, `all`), `no-channel` (a main-thread
 * card from jsonl in `main`), `truncated` (a cut text with the channel off).
 */
export function screenConsentEvents(cwd: string): ReadonlyMap<string, DriverEvent> {
  const out = new Map<string, DriverEvent>();
  const command = 'pnpm test shared/test/decode.test.ts';
  const card = (
    reqId: string, mode: ConsentEffectiveMode, origin: ActiveReq['origin'], release: ConsentDeskRelease | null,
    text = command,
  ): void => {
    const clipped = clipForDisplay(text, 80);
    const event: DriverEvent = {
      type: 'permission-request', reqId, toolName: 'Bash', input: { command: text }, displayText: clipped.text,
      ...(clipped.truncation === undefined ? {} : { truncation: clipped.truncation }),
    };
    const active: ActiveReq = { reqId, toolName: 'Bash', options: [], ...(origin === undefined ? {} : { origin }) };
    out.set(reqId, consentOnlyEvent(event, active, {
      consentMode: () => mode, consentDeskRelease: () => release,
    }, 'permission', { engineSessionId: '7f9c2ba4-e88f-4d2a-9b1c-3a5e6f7d8c90', cwd }));
  };
  card('hook:1763080020000', 'all', {
    source: 'hook', promptId: 'prompt-hook-2', agentId: 'agent-a1',
    callKey: `7f9c2ba4-e88f-4d2a-9b1c-3a5e6f7d8c91-${'5d'.repeat(16)}`,
  }, { reason: 'other-hooks', hooks: consentHookWhyOf('changed:/Users/demo/.claude/settings.json'), cwd });
  card('toolu_65', 'main', { source: 'jsonl', toolUseId: 'toolu_65' }, null);
  const long = `${command} ${'--reporter=verbose '.repeat(6)}`;
  card('toolu_66', 'off', { source: 'jsonl', toolUseId: 'toolu_66' }, null, long);
  return out;
}
