/**
 * Consent dialogs measured for the "Yes" digit while the consent channel is on:
 * `server/src/herdr/dialogs/policy/measured-consent.ts`, the digit gate (`consentDigitBlocked`) and the driver path
 * (card with the approve button, fresh screen and send shield right before the key). Captures: the control set
 * (`kontrolny/zgoda-mcp-interakcja-2.1.322.txt`, `kontrolny/zgoda-siec-2.1.322.txt`, CLI 2.1.322).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { mcpFrameShows, measuredConsentHolds, measuredConsentOf } from '../src/herdr/dialogs/policy/measured-consent.ts';
import { consentDigitBlocked } from '../src/herdr/dialogs/router.ts';
import {
  FIXTURES, SESSION, makeDriver, quiet, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

const MCP = readFileSync(join(FIXTURES, 'kontrolny', 'zgoda-mcp-interakcja-2.1.322.txt'), 'utf8');
const NETWORK = readFileSync(join(FIXTURES, 'kontrolny', 'zgoda-siec-2.1.322.txt'), 'utf8');
const MCP_PLAIN = readFileSync(join(FIXTURES, 'measured', 'zgoda-mcp-argumenty-2.1.322.txt'), 'utf8');
const EDIT_YES_NO = readFileSync(join(FIXTURES, 'kontrolny', 'zgoda-edit-regula-2.1.321.txt'), 'utf8');

/** The 62-column network dialog from measurement 0c: the same lines, rules 62 wide (the report shortened them). */
const NETWORK_NARROW = NETWORK.split('\n')
  .map((line) => (/^[─╌]{8,}$/u.test(line) ? (line[0] ?? '').repeat(62) : line))
  .map((line) => line.replace(" -w '%{http_code}' http://example.com)", " -w '%{http_code}'\n      http://example.com)"))
  .join('\n');

const MCP_ARGS = 'text: "e0-rui"';
const withArgs = (screen: string, args: string): string => screen.replace(MCP_ARGS, args);

describe('measured shape on screen', () => {
  it('MCP with user interaction: header and argument frame are the identity, digit 1', () => {
    expect(measuredConsentOf(MCP)).toEqual({
      kind: 'mcp-interaction', cliDialog: 'permission', allow: '1', frame: [MCP_ARGS],
      identity: `pomiar — Echo Osobiscie Tool: (MCP)\n${MCP_ARGS}`,
    });
  });

  it('the argument frame shows exactly the call input: one string argument per line, anything else is not proof', () => {
    const mark = measuredConsentOf(MCP);
    expect(mark).not.toBeNull();
    if (mark === null) return;
    expect(mcpFrameShows(mark, { text: 'e0-rui' })).toBe(true);
    expect(mcpFrameShows(mark, { text: 'e0-inne' })).toBe(false);
    expect(mcpFrameShows(mark, { text: 'e0-rui', more: 'x' })).toBe(false);
    expect(mcpFrameShows(mark, { text: 7 })).toBe(false);
    expect(mcpFrameShows(mark, { text: 'a "quoted" one' })).toBe(false);
    expect(mcpFrameShows(mark, {})).toBe(false);
    expect(mcpFrameShows(mark, null)).toBe(false);
    const net = measuredConsentOf(NETWORK);
    if (net !== null) expect(mcpFrameShows(net, { text: 'e0-rui' })).toBe(false);
  });

  it('network: the host is the identity, digit 1, in the wide and the 62-column pane', () => {
    const mark = { kind: 'network', cliDialog: 'sandbox', allow: '1', identity: 'example.com', host: 'example.com' };
    expect(measuredConsentOf(NETWORK)).toEqual(mark);
    expect(measuredConsentOf(NETWORK_NARROW)).toEqual(mark);
  });

  it('queue counter, extra line, cut block and unmeasured dialogs give no mark', () => {
    expect(measuredConsentOf(MCP.replace(' Tool use', ' Tool use   1 of 2'))).toBeNull();
    expect(measuredConsentOf(NETWORK.replace('Network request outside of sandbox', 'Network request outside of sandbox  1 of 2')))
      .toBeNull();
    expect(measuredConsentOf(`${NETWORK}\n   4. Yes, always`)).toBeNull();
    expect(measuredConsentOf(MCP.replace('   2. No', '   2. No\n   3. Yes, and don\'t ask again'))).toBeNull();
    expect(measuredConsentOf(MCP.split('\n').slice(0, -2).join('\n'))).toBeNull();
    expect(measuredConsentOf(NETWORK.replace("don't ask again for example.com", "don't ask again for evil.example")))
      .toBeNull();
    // Regular MCP (three options) and a two-option `Edit` are not the measured shapes.
    expect(measuredConsentOf(MCP_PLAIN)).toBeNull();
    expect(measuredConsentOf(EDIT_YES_NO)).toBeNull();
    expect(measuredConsentOf(null)).toBeNull();
  });

  it('a second dialog under the measured one wins the bottom of the screen: no mark', () => {
    expect(measuredConsentOf(`${NETWORK}\n${EDIT_YES_NO}`)).toBeNull();
  });

  it('fresh read: same identity and digit 1 pass; other arguments, other host, other digit do not', () => {
    const mark = measuredConsentOf(MCP) ?? undefined;
    expect(measuredConsentHolds(mark, MCP, '1')).toBe(true);
    expect(measuredConsentHolds(mark, MCP, '2')).toBe(false);
    expect(measuredConsentHolds(mark, withArgs(MCP, 'text: "rm -rf"'), '1')).toBe(false);
    const net = measuredConsentOf(NETWORK) ?? undefined;
    expect(measuredConsentHolds(net, NETWORK.replaceAll('example.com', 'example.org'), '1')).toBe(false);
    expect(measuredConsentHolds(net, MCP, '1')).toBe(false);
    expect(measuredConsentHolds(undefined, null, '2')).toBe(true);
  });
});

describe('digit gate with a measured mark', () => {
  const mcp = measuredConsentOf(MCP) ?? undefined;
  const net = measuredConsentOf(NETWORK) ?? undefined;

  it.each(['main', 'all', null] as const)('mode %s: "Yes" of a measured dialog under its own class passes', (mode) => {
    expect(consentDigitBlocked({ mode, cliDialog: 'sandbox', toolName: 'SandboxNetwork', consent: true, measured: net }))
      .toBe(false);
    expect(consentDigitBlocked({
      mode, cliDialog: 'permission', toolName: 'mcp__pomiar__echo_osobiscie', consent: true, measured: mcp,
    })).toBe(false);
  });

  it('the mark under another class, an answer path or no mark: blocked as before', () => {
    expect(consentDigitBlocked({ mode: 'all', cliDialog: 'permission', toolName: 'SandboxNetwork', consent: true,
      measured: net })).toBe(true);
    expect(consentDigitBlocked({ mode: 'all', cliDialog: 'sandbox', toolName: 'x', consent: true, measured: mcp }))
      .toBe(true);
    expect(consentDigitBlocked({ mode: 'all', cliDialog: 'sandbox', toolName: 'SandboxNetwork', consent: false,
      measured: net })).toBe(true);
    expect(consentDigitBlocked({ mode: 'all', cliDialog: 'sandbox', toolName: 'SandboxNetwork', consent: true }))
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Driver: card, fresh screen and send shield before the digit
// ---------------------------------------------------------------------------

useDriverSandbox();

const WAITING_SANDBOX: CliWaitingSignal = { kind: 'waiting', dialog: 'sandbox' };
const WAITING_PERMISSION: CliWaitingSignal = { kind: 'waiting', dialog: 'permission' };

const toolUseLine = (id: string, name: string, input: unknown): string => `${JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: '2026-08-22T10:00:06.000Z', sessionId: SESSION,
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id, name, input }] },
})}\n`;

type Permission = Extract<DriverEvent, { type: 'permission-request' }>;
const permissions = (events: readonly DriverEvent[]): Permission[] =>
  events.filter((e): e is Permission => e.type === 'permission-request');
const digitsSent = (fx: Fixture): string[] => fx.client.calls
  .filter((call) => call.method === 'send_keys').flatMap((call) => call.keys ?? []).filter((key) => /^\d$/u.test(key));

interface Pane {
  readonly fx: Fixture;
  readonly reqId: string;
  readonly card: Permission | undefined;
  /** Registry signal a fresh read gives (the shield reads it right before the key). */
  registry: CliWaitingSignal;
}

async function measuredCard(
  screen: string, signal: CliWaitingSignal, deps: Partial<HerdrDriverDeps> = {}, transcript = '',
): Promise<Pane> {
  const pane: { registry: CliWaitingSignal } = { registry: signal };
  const fx = await makeDriver({
    transcript: userLine('zrob') + transcript, screen,
    deps: { consentMode: () => 'all', consentRegistryRead: () => Promise.resolve(pane.registry), ...deps },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  fx.driver.noteCliWaiting?.(signal);
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  await waitFor(() => permissions(fx.events).length > 0, 'card');
  const card = permissions(fx.events).at(-1);
  return Object.assign(pane, { fx, reqId: card?.reqId ?? '', card });
}

const MCP_CALL = toolUseLine('toolu_mcp', 'mcp__pomiar__echo_osobiscie', { text: 'e0-rui' });

describe('driver at `all`: measured dialogs get the digit of "Yes"', { timeout: 10_000 }, () => {
  it('MCP with user interaction alone on top: approve button, digit 1, `approve` in the audit log', async () => {
    const pane = await measuredCard(MCP, WAITING_PERMISSION, {}, MCP_CALL);
    expect(pane.card?.canAllow).not.toBe(false);
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(digitsSent(pane.fx)).toEqual(['1']);
    expect(pane.fx.audit.filter((entry) => entry.method === 'approve').map((entry) => entry.keys)).toEqual([['1']]);
  });

  it('network dialog alone on top: approve button without "always", digit 1; "always" refused', async () => {
    const pane = await measuredCard(NETWORK, WAITING_SANDBOX);
    expect(pane.card?.canAllow).not.toBe(false);
    expect(pane.card?.alwaysLabel).toBeUndefined();
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow-always')).resolves.toMatchObject({ kind: 'refused' });
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('network: "Yes" digit 1 under a fresh `sandbox request` registry', async () => {
    const pane = await measuredCard(NETWORK, WAITING_SANDBOX);
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(digitsSent(pane.fx)).toEqual(['1']);
  });

  it('a second dialog in the queue at card time: no approve button, no digit', async () => {
    const pane = await measuredCard(MCP.replace(' Tool use', ' Tool use   1 of 2'), WAITING_PERMISSION, {}, MCP_CALL);
    expect(pane.card?.canAllow).toBe(false);
    await pane.fx.driver.respondPermission(pane.reqId, 'allow');
    await quiet();
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('the call in the transcript has other arguments than the frame on screen: no approve button', async () => {
    const other = toolUseLine('toolu_mcp', 'mcp__pomiar__echo_osobiscie', { text: 'e0-inne' });
    const pane = await measuredCard(MCP, WAITING_PERMISSION, {}, other);
    expect(pane.card?.canAllow).toBe(false);
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('the queue counter appears before the key: no digit', async () => {
    const pane = await measuredCard(MCP, WAITING_PERMISSION, {}, MCP_CALL);
    pane.fx.client.screenText = MCP.replace(' Tool use', ' Tool use   1 of 2');
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('arguments on screen other than on the card: no digit', async () => {
    const pane = await measuredCard(MCP, WAITING_PERMISSION, {}, MCP_CALL);
    pane.fx.client.screenText = withArgs(MCP, 'text: "e0-inne"');
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('another dialog on top before the key (network replaced by a consent dialog): no digit', async () => {
    const pane = await measuredCard(NETWORK, WAITING_SANDBOX);
    pane.fx.client.screenText = EDIT_YES_NO;
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('send shield: a fresh registry without the class of the card, or a waiting hook request: no digit', async () => {
    const moved = await measuredCard(NETWORK, WAITING_SANDBOX);
    moved.registry = WAITING_PERMISSION;
    await expect(moved.fx.driver.respondPermission(moved.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    const gone = await measuredCard(NETWORK, WAITING_SANDBOX);
    gone.registry = { kind: 'active' };
    await expect(gone.fx.driver.respondPermission(gone.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    const hooked = await measuredCard(NETWORK, WAITING_SANDBOX, { consentRegistrationWaits: () => true });
    await expect(hooked.fx.driver.respondPermission(hooked.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect([...digitsSent(moved.fx), ...digitsSent(gone.fx), ...digitsSent(hooked.fx)]).toEqual([]);
  });

  it('a hook registration without a card accepted during the fresh screen read, after the shield: no digit', async () => {
    const hook: { acceptedAt: number | null; armed: boolean; shieldRead: boolean } = {
      acceptedAt: null, armed: false, shieldRead: false,
    };
    const pane = await measuredCard(NETWORK, WAITING_SANDBOX, {
      consentRegistrationWaits: () => hook.acceptedAt !== null,
      consentRegistryRead: () => {
        if (hook.armed) hook.shieldRead = true;
        return Promise.resolve(WAITING_SANDBOX);
      },
    });
    const read = pane.fx.client.readScreen.bind(pane.fx.client);
    pane.fx.client.readScreen = (paneId, source, format) => {
      if (hook.shieldRead) hook.acceptedAt = pane.fx.deps.now();
      return read(paneId, source, format);
    };
    hook.armed = true;
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect(hook.acceptedAt).not.toBeNull();
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('a hook registration without a card older than the card wait, or a port that throws: no digit', async () => {
    const old = await measuredCard(NETWORK, WAITING_SANDBOX, {
      consentCardAwaited: () => Date.UTC(2026, 7, 22, 11, 59, 0), consentRegistrationWaits: () => true,
    });
    expect(old.card?.canAllow).not.toBe(false);
    await expect(old.fx.driver.respondPermission(old.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    const broken = await measuredCard(NETWORK, WAITING_SANDBOX, {
      consentRegistrationWaits: () => { throw new Error('port'); },
    });
    await expect(broken.fx.driver.respondPermission(broken.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect([...digitsSent(old.fx), ...digitsSent(broken.fx)]).toEqual([]);
  });

  it('a subagent registration without a card (the card wait does not count it) at `all`: no digit', async () => {
    const pane = await measuredCard(NETWORK, WAITING_SANDBOX, {
      consentCardAwaited: () => null, consentRegistrationWaits: (engine) => engine === SESSION,
    });
    expect(pane.card?.canAllow).not.toBe(false);
    await expect(pane.fx.driver.respondPermission(pane.reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('MCP card from a hook dump alone (no `tool_use` entry): no approve button, no digit', async () => {
    const dump: PendingHookTool = {
      toolName: 'mcp__pomiar__echo_osobiscie', toolInput: { text: 'e0-rui' }, at: Date.UTC(2026, 7, 22, 11, 59, 58),
      hookEventName: 'PermissionRequest', promptId: 'p1',
    };
    const pane = await measuredCard(MCP, WAITING_PERMISSION, { readPendingHook: () => dump, clearPendingHook: () => {} });
    expect(pane.card?.canAllow).toBe(false);
    await pane.fx.driver.respondPermission(pane.reqId, 'allow');
    await quiet();
    expect(digitsSent(pane.fx)).toEqual([]);
  });

  it('guard: the same network card at `all` without a measured shape (cut option) stays without a digit', async () => {
    const pane = await measuredCard(NETWORK.replace('   3. No, and tell Claude what to do differently (esc)',
      '   3. No'), WAITING_SANDBOX);
    expect(pane.card?.canAllow).toBe(false);
    expect(digitsSent(pane.fx)).toEqual([]);
  });
});
