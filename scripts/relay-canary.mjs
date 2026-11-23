#!/usr/bin/env node
// Kanarek relaya iroh z zewnątrz (z CI według harmonogramu albo ręcznie z dowolnej maszyny po `pnpm install`).
// Sprawdza relay tak, jak widzi go klient: przyjęcie, odmowę, limit `rx` i burst.
//
//   node scripts/relay-canary.mjs [--relay-only]
//
// `--relay-only`: wołający gwarantuje sieć bez UDP poza DNS (CI blokuje go przed kanarkiem). Tylko wtedy krok
// `rate` mierzy relay: nadawca i odbiorca biegną na jednej maszynie, a z UDP połączyłyby się wprost, z pominięciem
// relaya (biblioteka nie ma trybu „tylko relay”). Bez flagi krok `rate` jest pominięty.
//
// Zmienne:
//   RELAY_CANARY_URL   relay (domyślnie https://relay.rarog.ai/)
//   RELAY_CANARY_MODE  shadow (domyślnie: hak wpuszcza każdego) albo enforce (Worker odmawia kluczom bez wpisu)
//   RELAY_CANARY_KEYS  dwa klucze tajne (64 znaki hex, po przecinku) z wpisem w rejestrze; bez nich kroki, które ich
//                      wymagają, mówią „skipped” z powodem
//
// Kroki (próg w nawiasie):
//   unknown     świeży losowy klucz: shadow = relay domowy (≤ 10 s); enforce = odmowa relaya w 10 s
//   registered  pierwszy klucz z RELAY_CANARY_KEYS: relay domowy (≤ 10 s)
//   rate        60 MB jednym połączeniem przez sam relay, 14–18 s. Limit `rx` 3 MB/s z burstem 16 MB
//               daje ok. (60 − 16) MB / 3 MB/s ≈ 14,7 s niezależnie od szybkości klienta (byle ponad
//               3 MB/s); bez burstu 60 MB / 3 MB/s = 20 s. Szybciej niż 14 s = limit `rx` nie działa;
//               wolniej niż 18 s = brak burstu albo ciaśniejszy limit; ścieżka bezpośrednia obok relaya =
//               porażka. Pierwsze 16 MB wolniej niż 4,5 MB/s = pomiar nieważny: klient ze stałym tempem do
//               60 MB / 14 s ≈ 4,29 MB/s zmieściłby się w oknie 14–18 s także bez żadnego limitu, więc tylko
//               szybszy klient odróżnia limit relaya od własnej sieci
// Kod 0: każdy krok zaliczony albo pominięty; 1: porażka; 2: zły argument albo brak modułu iroh.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';

const RELAY = process.env.RELAY_CANARY_URL || 'https://relay.rarog.ai/';
const MODE = process.env.RELAY_CANARY_MODE || 'shadow';
const ONLINE_MS = 10_000;
const BYTES = 60_000_000;
const BURST = 16_000_000;
/** Najwolniejsze pierwsze 16 MB (MB/s), przy którym klient mierzy relay, a nie siebie: powyżej 60 MB / 14 s. */
const CLIENT_MIN_MBS = 4.5;
const TOTAL_MIN_MS = 14_000;
const TOTAL_MAX_MS = 18_000;
const XFER_DEADLINE_MS = 60_000;
const CHUNK = 64 * 1024;
const ALPN = Array.from(Buffer.from('rarog-canary/1'));
const DENIED = 'relay denied our authentication';

/** Klucze z RELAY_CANARY_KEYS: pusta lista, dwa klucze albo błąd z opisem (wartości nigdy w komunikacie). */
export function parseKeys(raw) {
  const text = (raw ?? '').trim();
  if (text === '') return { keys: [] };
  const keys = text.split(',').map((one) => one.trim().toLowerCase());
  if (keys.length !== 2 || !keys.every((one) => /^[0-9a-f]{64}$/.test(one))) {
    return { error: 'RELAY_CANARY_KEYS: expected two keys of 64 hex characters each, comma-separated' };
  }
  return { keys: keys.map((one) => Array.from(Buffer.from(one, 'hex'))) };
}

/** Werdykt kroku `rate` z czasów odbiorcy (ms od pierwszego bajtu): `null` = zaliczony, inaczej powód. */
export function judgeTransfer({ burstMs, totalMs, bytes }) {
  if (bytes !== BYTES) return `received ${String(bytes)} of ${String(BYTES)} B`;
  if (totalMs < TOTAL_MIN_MS) return `faster than ${String(TOTAL_MIN_MS)} ms: the rx limit does not work`;
  const clientMbs = BURST / burstMs / 1000;
  if (clientMbs < CLIENT_MIN_MBS) {
    return `first 16 MB slower than ${String(CLIENT_MIN_MBS)} MB/s: client or network too slow, measurement invalid`;
  }
  if (totalMs > TOTAL_MAX_MS) return `slower than ${String(TOTAL_MAX_MS)} ms: no 16 MB burst or an rx limit tighter than 3 MB/s`;
  return null;
}

/** Opis transferu do logu kanarka: czasy i tempo obu części. */
export function describeTransfer({ burstMs, totalMs }) {
  const mbs = (bytes, ms) => (bytes / ms / 1000).toFixed(2);
  return `60 MB in ${String(totalMs)} ms; first 16 MB in ${String(burstMs)} ms (${mbs(BURST, burstMs)} MB/s), `
    + `rest ${mbs(BYTES - BURST, totalMs - burstMs)} MB/s`;
}

function loadIroh() {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  try {
    return require('@number0/iroh');
  } catch (err) {
    console.error(`relay-canary: no @number0/iroh module (pnpm install): ${String(err?.message ?? err)}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint(iroh, key, bind) {
  const builder = iroh.Endpoint.builder();
  iroh.presetMinimal(builder);
  builder.secretKey(key);
  builder.alpns([ALPN]);
  builder.relayMode(iroh.RelayMode.customFromUrls([RELAY]));
  if (bind) builder.bindAddr(bind);
  return builder.bind();
}

async function onlineWithin(ep, ms) {
  const t0 = performance.now();
  const res = await Promise.race([ep.online().then(() => 'ok'), sleep(ms).then(() => 'timeout')]);
  return res === 'ok' ? Math.round(performance.now() - t0) : null;
}

/** Proces potomny z logiem biblioteki na Debug: tylko tam widać odmowę relaya. */
function probeChild(keyHex) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--probe'], {
      env: { ...process.env, RELAY_CANARY_PROBE_KEY: keyHex }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), ONLINE_MS + 15_000);
    child.on('close', () => {
      clearTimeout(kill);
      const online = /^probe online=(\d+|null)$/m.exec(out)?.[1];
      resolve({ denied: out.toLowerCase().includes(DENIED), online: online && online !== 'null' ? Number(online) : null });
    });
  });
}

async function probeMain(iroh) {
  iroh.setLogLevel('Debug');
  const ep = await endpoint(iroh, Array.from(Buffer.from(process.env.RELAY_CANARY_PROBE_KEY ?? '', 'hex')));
  const ms = await onlineWithin(ep, ONLINE_MS);
  console.log(`probe online=${ms === null ? 'null' : String(ms)}`);
  process.exit(0);
}

async function stepObcy(iroh) {
  const key = randomBytes(32);
  if (MODE === 'enforce') {
    const res = await probeChild(key.toString('hex'));
    if (res.denied && res.online === null) return { ok: true, text: 'unknown key denied by the relay' };
    if (res.online !== null) return { ok: false, text: `unknown key accepted in ${String(res.online)} ms (expected a denial)` };
    return { ok: false, text: 'no home relay in 10 s and no relay denial (network or relay unreachable)' };
  }
  const ep = await endpoint(iroh, Array.from(key));
  const ms = await onlineWithin(ep, ONLINE_MS);
  await ep.close();
  return ms === null
    ? { ok: false, text: 'unknown key without a home relay in 10 s (shadow mode: expected acceptance)' }
    : { ok: true, text: `unknown key accepted in ${String(ms)} ms (shadow mode)` };
}

async function stepWpis(iroh, keys) {
  if (keys.length === 0) return { skip: 'no RELAY_CANARY_KEYS (a key with a registry entry)' };
  const ep = await endpoint(iroh, keys[0]);
  const ms = await onlineWithin(ep, ONLINE_MS);
  await ep.close();
  return ms === null
    ? { ok: false, text: 'registered key without a home relay in 10 s' }
    : { ok: true, text: `registered key accepted in ${String(ms)} ms` };
}

/**
 * 60 MB od nadawcy do odbiorcy przez sam relay (sieć bez UDP, `--relay-only`). Czasy liczy odbiorca od pierwszego
 * bajtu.
 */
async function stepTempo(iroh, keys, relayOnly) {
  if (!relayOnly) return { skip: 'no --relay-only (needs a network without UDP except DNS)' };
  let pair;
  if (keys.length === 2) pair = keys;
  else if (MODE === 'enforce') return { skip: 'enforce mode without RELAY_CANARY_KEYS (two registered keys)' };
  else pair = [Array.from(randomBytes(32)), Array.from(randomBytes(32))];
  const [sender, receiver] = await Promise.all([endpoint(iroh, pair[0]), endpoint(iroh, pair[1])]);
  try {
    const online = await Promise.all([onlineWithin(sender, ONLINE_MS), onlineWithin(receiver, ONLINE_MS)]);
    if (online.includes(null)) return { ok: false, text: 'sender or receiver without a home relay in 10 s' };
    const received = (async () => {
      const inc = await receiver.acceptNext();
      const conn = await (await inc.accept()).connect();
      const bi = await conn.acceptBi();
      let total = 0;
      let first = 0;
      let burstAt = 0;
      for (;;) {
        const chunk = await bi.recv.read(256 * 1024);
        if (chunk.length === 0) break;
        if (total === 0) first = performance.now();
        total += chunk.length;
        if (burstAt === 0 && total >= BURST) burstAt = performance.now();
      }
      await bi.send.writeAll(Array.from(Buffer.from('ok')));
      await bi.send.finish();
      return { bytes: total, burstMs: Math.round(burstAt - first), totalMs: Math.round(performance.now() - first) };
    })();
    const conn = await sender.connect(new iroh.EndpointAddr(receiver.id(), RELAY, []), ALPN);
    const bi = await conn.openBi();
    const buf = Array.from(Buffer.alloc(CHUNK, 0x61));
    const sent = (async () => {
      for (let done = 0; done < BYTES; done += CHUNK) {
        const n = Math.min(CHUNK, BYTES - done);
        await bi.send.writeAll(n === CHUNK ? buf : buf.slice(0, n));
      }
      await bi.send.finish();
      await bi.recv.readToEnd(16);
    })();
    const res = await Promise.race([
      Promise.all([received, sent]).then(([r]) => r),
      sleep(XFER_DEADLINE_MS).then(() => null),
    ]);
    if (res === null) return { ok: false, text: `transfer did not finish in ${String(XFER_DEADLINE_MS / 1000)} s` };
    const direct = conn.paths().filter((p) => !p.isRelay);
    if (direct.length > 0) return { ok: false, text: 'direct path next to the relay: measurement invalid' };
    const fail = judgeTransfer(res);
    const text = describeTransfer(res);
    return fail === null ? { ok: true, text } : { ok: false, text: `${fail} (${text})` };
  } finally {
    await Promise.allSettled([sender.close(), receiver.close()]);
  }
}

async function main(args) {
  const unknown = args.filter((one) => one !== '--relay-only');
  if (unknown.length > 0) {
    console.error(`relay-canary: unknown argument ${unknown[0]} (usage: relay-canary.mjs [--relay-only])`);
    process.exit(2);
  }
  const relayOnly = args.includes('--relay-only');
  if (MODE !== 'shadow' && MODE !== 'enforce') {
    console.error(`relay-canary: RELAY_CANARY_MODE must be shadow or enforce (found: ${MODE})`);
    process.exit(2);
  }
  const parsed = parseKeys(process.env.RELAY_CANARY_KEYS);
  if (parsed.error) {
    console.error(`relay-canary: ${parsed.error}`);
    process.exit(2);
  }
  const iroh = loadIroh();
  console.log(`relay-canary: ${RELAY} (mode ${MODE})`);
  let failed = 0;
  for (const [name, step] of [['unknown', stepObcy], ['registered', stepWpis], ['rate', stepTempo]]) {
    let res;
    try {
      res = await step(iroh, parsed.keys, relayOnly);
    } catch (err) {
      res = { ok: false, text: `exception: ${String(err?.message ?? err).slice(0, 200)}` };
    }
    if (res.skip) console.log(`skipped ${name}: ${res.skip}`);
    else console.log(`${res.ok ? 'ok' : 'FAIL'} ${name}: ${res.text}`);
    if (res.ok === false) failed += 1;
  }
  console.log(failed === 0 ? 'relay-canary: green' : `relay-canary: failures ${String(failed)}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--probe') await probeMain(loadIroh());
  else await main(process.argv.slice(2));
}
