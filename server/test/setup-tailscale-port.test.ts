/**
 * The port `tailscale serve` would take for `rarog setup` (`setup-tailscale-port.ts`): what a failed TCP probe means
 * and which mapping of this server Tailscale Funnel publishes. The setup runs that pick the port and map it stand in
 * `setup-transport.test.ts` and `setup-tailscale-only.test.ts`.
 */
import { describe, expect, it } from 'vitest';

describe('port 443 probe: a failed connection', () => {
  it('refused or an address the machine lacks (IPv6 off, no route) = no listener; else unknown', async () => {
    const { tcpFailureOf } = await import('../src/cli/setup-tailscale-port.ts');
    for (const code of ['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT']) {
      expect(tcpFailureOf(code), code).toBe('refused');
    }
    for (const code of ['ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', undefined]) {
      expect(tcpFailureOf(code), String(code)).toBe('unknown');
    }
  });
});

describe('Tailscale Funnel on a mapping of this server', () => {
  const HOST = 'rarog-test.example.ts.net';
  /** A serve config with `[P, proxy target]` mappings of HOST and `AllowFunnel` on `funnel` (`<host>:<P>` keys). */
  const config = (
    mappings: readonly (readonly [number, number])[], funnel: readonly string[],
  ): Record<string, unknown> => ({
    TCP: Object.fromEntries(mappings.map(([https]) => [String(https), { HTTPS: true }])),
    Web: Object.fromEntries(mappings.map(([https, target]) =>
      [`${HOST}:${String(https)}`, { Handlers: { '/': { Proxy: `http://127.0.0.1:${String(target)}` } } }])),
    AllowFunnel: Object.fromEntries(funnel.map((key) => [key, true])),
  });

  it.each([
    ['443 mapped to this server with Funnel', config([[443, 8930]], [`${HOST}:443`]), [443]],
    ['443 mapped to this server without Funnel', config([[443, 8930]], []), []],
    ['Funnel on another site (443 to port 3000)', config([[443, 3000], [8945, 8930]], [`${HOST}:443`]), []],
    ['Funnel on 443 of another host', config([[443, 8930]], ['other.example.ts.net:443']), []],
  ] as const)('%s', async (_name, serve, ports) => {
    const { funnelPorts } = await import('../src/cli/setup-tailscale-port.ts');
    expect(funnelPorts(serve, HOST, 8930)).toEqual(ports);
  });
});
