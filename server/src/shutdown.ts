/**
 * Koniec procesu po SIGTERM i SIGINT (`docs/server-config.md`, „Refusals and failures”). Zamknięcia, na które warto poczekać (manager, nasłuch
 * iroh), biegną RAZEM (`Promise.allSettled`), a bezpiecznik `exit(0)` startuje dopiero po wszystkich. Nasłuch iroh
 * oddaje `close()` najpóźniej po swoim terminie (`IROH_LIMITS.endpointCloseMs`, 3 s), także gdy `Endpoint.close()`
 * wisi, więc proces kończy się w ≤ 5 s od sygnału.
 *
 * Bezpiecznik jest potrzebny nie tylko „na wszelki wypadek”: `Endpoint.online()` bez osiągalnego relaya nie kończy
 * się nigdy, także po `Endpoint.close()` (fakt 8 w `iroh/adapter.ts`), a wtedy pętla zdarzeń sama nie opustoszeje.
 */

/** Bezpiecznik po zamknięciach: tyle czeka proces, zanim wyjdzie mimo czegoś, co jeszcze trzyma pętlę zdarzeń. */
export const SHUTDOWN_FUSE_MS = 2_000;

/**
 * Czeka na wszystkie zamknięcia (porażka jednego nie wstrzymuje reszty) i nastawia bezpiecznik. Obietnica kończy się
 * w chwili nastawienia bezpiecznika; sam bezpiecznik nie trzyma pętli zdarzeń (`unref`).
 */
export function exitAfter(
  closing: readonly Promise<unknown>[],
  exit: (code: number) => void = (code) => { process.exit(code); },
  fuseMs: number = SHUTDOWN_FUSE_MS,
): Promise<void> {
  return Promise.allSettled(closing).then(() => {
    setTimeout(() => { exit(0); }, fuseMs).unref();
  });
}
