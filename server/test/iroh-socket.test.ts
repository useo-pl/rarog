/**
 * Znacznik gniazda iroh (`server/src/iroh/socket.ts`): uwierzytelnienie należy do połączenia QUIC jako zbiór
 * urządzeń, odpięcie zdejmuje urządzenie ze wszystkich połączeń, gniazdo TCP nie ma wpisu.
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  irohPeerLabel, irohPeerOf, isIrohSocket, markAuthenticated, registerIrohPeer, revokeDevice,
} from '../src/iroh/socket.ts';

const ID_A = `abcdef012345${'0'.repeat(52)}`;
const ID_B = `fedcba987654${'1'.repeat(52)}`;

function peer(id: string): { changes: boolean[]; handle: ReturnType<typeof registerIrohPeer> } {
  const changes: boolean[] = [];
  return { changes, handle: registerIrohPeer(id, (authenticated) => { changes.push(authenticated); }) };
}

describe('socket.ts: znacznik i etykieta', () => {
  it('gniazdo nasłuchu ma wpis i etykietę `iroh:<12 znaków>`; gniazdo TCP i nie-obiekt nie mają', () => {
    const { handle } = peer(ID_A);
    const socket = {};
    handle.attach(socket);
    expect(isIrohSocket(socket)).toBe(true);
    expect(irohPeerLabel(socket)).toBe('iroh:abcdef012345');
    expect(irohPeerOf(socket)?.endpointId).toBe(ID_A);

    const tcp = new net.Socket();
    expect(isIrohSocket(tcp)).toBe(false);
    expect(irohPeerLabel(tcp)).toBeNull();
    expect(irohPeerOf(tcp)).toBeNull();
    expect(isIrohSocket(null)).toBe(false);
    expect(isIrohSocket('gniazdo')).toBe(false);
    markAuthenticated(tcp, 'urz-tcp'); // nic nie robi i nie rzuca
    tcp.destroy();
    handle.dispose();
  });
});

describe('socket.ts: uwierzytelnienie połączenia', () => {
  it('pierwsze urządzenie zmienia stan raz; dwa gniazda jednego połączenia dzielą stan', () => {
    const { changes, handle } = peer(ID_A);
    const first = {};
    const second = {};
    handle.attach(first);
    handle.attach(second);
    markAuthenticated(first, 'urz-1');
    markAuthenticated(second, 'urz-1');
    markAuthenticated(second, 'urz-2');
    expect(changes).toEqual([true]);
    expect(handle.peer.authenticated).toBe(true);
    expect([...handle.peer.devices]).toEqual(['urz-1', 'urz-2']);
    expect(irohPeerOf(first)?.authenticated).toBe(true);
    handle.dispose();
  });

  it('odpięcie zdejmuje urządzenie ze wszystkich połączeń; stan spada przy ostatnim urządzeniu', () => {
    const a = peer(ID_A);
    const b = peer(ID_B);
    const sa = {};
    const sb = {};
    a.handle.attach(sa);
    b.handle.attach(sb);
    markAuthenticated(sa, 'urz-x');
    markAuthenticated(sa, 'urz-y');
    markAuthenticated(sb, 'urz-x');
    revokeDevice('urz-x');
    expect(a.changes).toEqual([true]);
    expect(b.changes).toEqual([true, false]);
    expect(a.handle.peer.authenticated).toBe(true);
    expect(b.handle.peer.authenticated).toBe(false);
    revokeDevice('urz-y');
    expect(a.changes).toEqual([true, false]);
    revokeDevice('urz-nieznane');
    expect(a.changes).toEqual([true, false]);
    a.handle.dispose();
    b.handle.dispose();
  });

  it('po `dispose` połączenie nie zmienia stanu i nie dostaje odpięć', () => {
    const { changes, handle } = peer(ID_A);
    const socket = {};
    handle.attach(socket);
    markAuthenticated(socket, 'urz-1');
    handle.dispose();
    expect(handle.peer.authenticated).toBe(false);
    markAuthenticated(socket, 'urz-2');
    revokeDevice('urz-1');
    expect(changes).toEqual([true]);
  });
});
