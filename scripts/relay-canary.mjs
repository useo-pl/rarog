#!/usr/bin/env node
// The iroh relay canary from outside (from CI on a schedule, or by hand on any machine after `pnpm install`).
// It checks the relay the way a client sees it: admission, denial, the `rx` limit and the burst.
//
//   node scripts/relay-canary.mjs [--relay-only]
//
// `--relay-only`: the caller guarantees a network without UDP other than DNS (CI blocks it before the canary).
// Only then does the `rate` step measure the relay: sender and receiver run on one machine, and with UDP they would
// connect directly, bypassing the relay (the library has no relay-only mode). Without the flag `rate` is skipped.
//
// Variables:
//   RELAY_CANARY_URL       the relay (default https://relay.rarog.ai/)
//   RELAY_CANARY_REGISTRY  the relay's registry Worker (default https://relay-auth.rarog.ai/)
//   RELAY_CANARY_MODE      shadow (default: the hook admits everyone) or enforce (the Worker denies keys without an
//                          entry)
//   RELAY_CANARY_KEYS      two secret keys (64 hex characters each, comma-separated) with registry entries; without
//                          them the steps that need them say "skipped" with a reason
//
// Key roles: key 0 has an app entry in the registry and sponsors key 1, which has a server entry. Both entries live
// 90 days from the last renewal, and the `renew` step renews both on every run.
//
// Steps (threshold in parentheses):
//   unknown     a fresh random key: shadow = home relay (≤ 10 s); enforce = relay denial within 10 s
//   renew       key 0 signs the registry's `renew` listing key 1 (200 with nothing unsponsored); a 404 means key 0
//               lost its app entry, a server in `unsponsored` means key 1 lost its sponsorship
//   registered  the first key from RELAY_CANARY_KEYS: home relay (≤ 10 s)
//   rate        60 MB over one connection through the relay alone, 14–18 s. The `rx` limit of 3 MB/s with a 16 MB
//               burst gives about (60 − 16) MB / 3 MB/s ≈ 14.7 s whatever the client's speed (as long as it is
//               above 3 MB/s); without the burst 60 MB / 3 MB/s = 20 s. Faster than 14 s = the `rx` limit does not
//               work; slower than 18 s = no burst or a tighter limit; a direct path next to the relay = failure.
//               The first 16 MB slower than 4.5 MB/s = invalid measurement: a client with a steady pace up to
//               60 MB / 14 s ≈ 4.29 MB/s would fit the 14–18 s window even without any limit, so only a faster
//               client tells the relay's limit from its own network
// Exit code 0: every step passed or was skipped; 1: a failure; 2: a bad argument or no iroh module.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';

const RELAY = process.env.RELAY_CANARY_URL || 'https://relay.rarog.ai/';
const REGISTRY = process.env.RELAY_CANARY_REGISTRY || 'https://relay-auth.rarog.ai/';
const MODE = process.env.RELAY_CANARY_MODE || 'shadow';
const ONLINE_MS = 10_000;
const BYTES = 60_000_000;
const BURST = 16_000_000;
/** The slowest first 16 MB (MB/s) at which the client measures the relay, not itself: above 60 MB / 14 s. */
const CLIENT_MIN_MBS = 4.5;
const TOTAL_MIN_MS = 14_000;
const TOTAL_MAX_MS = 18_000;
const XFER_DEADLINE_MS = 60_000;
const CHUNK = 64 * 1024;
const ALPN = Array.from(Buffer.from('rarog-canary/1'));
const DENIED = 'relay denied our authentication';
/** Deadline of the registry call in the `renew` step. */
const REGISTRY_DEADLINE_MS = 10_000;
/**
 * The registry contract for `renew` (`shared/src/relay-auth.ts`), kept here so the canary runs under plain `node`;
 * `relay-vps/test/canary.test.ts` holds the signing text equal to the contract's.
 */
const SIGNING_DOMAIN = 'rarog-relay-auth/v1';
const RENEW_PATH = '/v1/app/renew';
const CLIENT_HEADER = 'x-rarog-relay-client';
const CLIENT = 'rarog-canary/1';
/**
 * PKCS#8 prefix of a raw 32-byte Ed25519 secret: an iroh secret key is an Ed25519 seed whose public key is the
 * EndpointId.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Keys from RELAY_CANARY_KEYS: an empty list, two keys, or an error description (never with key values). */
export function parseKeys(raw) {
  const text = (raw ?? '').trim();
  if (text === '') return { keys: [] };
  const keys = text.split(',').map((one) => one.trim().toLowerCase());
  if (keys.length !== 2 || !keys.every((one) => /^[0-9a-f]{64}$/.test(one))) {
    return { error: 'RELAY_CANARY_KEYS: expected two keys of 64 hex characters each, comma-separated' };
  }
  return { keys: keys.map((one) => Array.from(Buffer.from(one, 'hex'))) };
}

/** Verdict of the `rate` step from the receiver's times (ms from the first byte): `null` = passed, else the reason. */
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

/** Transfer description for the canary log: times and pace of both parts. */
export function describeTransfer({ burstMs, totalMs }) {
  const mbs = (bytes, ms) => (bytes / ms / 1000).toFixed(2);
  return `60 MB in ${String(totalMs)} ms; first 16 MB in ${String(burstMs)} ms (${mbs(BURST, burstMs)} MB/s), `
    + `rest ${mbs(BYTES - BURST, totalMs - burstMs)} MB/s`;
}

const privateKeyOf = (secret) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(secret)]), format: 'der', type: 'pkcs8' });

/** EndpointId (64 hex characters) of an iroh secret key given as 32 bytes. */
export function endpointIdOf(secret) {
  const { x } = createPublicKey(privateKeyOf(secret)).export({ format: 'jwk' });
  return Buffer.from(x, 'base64url').toString('hex');
}

/** Text that key 0 signs for `renew`: lines joined by `\n`, the servers comma-separated on the last one. */
export function renewSigningText({ endpointId, issuedAt, servers }) {
  return [SIGNING_DOMAIN, RENEW_PATH, endpointId, String(issuedAt), servers.join(',')].join('\n');
}

/**
 * The `renew` step: key 0 renews its app entry and its sponsorship of key 1 in the registry, which recreates key 1's
 * server entry when it is gone. Both terms run 90 days from this call, so a canary every 6 h keeps both keys
 * registered. `fetch` and `nowSec` stand in for the network and the clock in tests.
 */
export async function renewEntries(keys, {
  registry = REGISTRY, fetch = globalThis.fetch, nowSec = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (keys.length === 0) return { skip: 'no RELAY_CANARY_KEYS (keys with registry entries)' };
  const [app, server] = keys;
  const unsigned = { v: 1, endpointId: endpointIdOf(app), issuedAt: nowSec(), servers: [endpointIdOf(server)] };
  const sig = sign(null, Buffer.from(renewSigningText(unsigned)), privateKeyOf(app)).toString('hex');
  let response;
  let body;
  try {
    response = await fetch(new URL(RENEW_PATH.slice(1), registry), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: CLIENT },
      body: JSON.stringify({ ...unsigned, sig }),
      signal: AbortSignal.timeout(REGISTRY_DEADLINE_MS),
    });
    body = await response.json().catch(() => null);
  } catch (err) {
    return { ok: false, text: `registry unreachable: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  const error = typeof body?.error === 'string' ? body.error : '';
  if (response.status === 404 && error === 'not-registered') {
    return { ok: false, text: 'key 0 has no app entry in the registry: set up both keys again' };
  }
  if (response.status !== 200) {
    return { ok: false, text: `registry answered ${String(response.status)}${error === '' ? '' : ` ${error}`}` };
  }
  if (!Array.isArray(body?.unsponsored) || !Number.isSafeInteger(body?.expiresAt)) {
    return { ok: false, text: 'unexpected response from the registry (no expiresAt or unsponsored)' };
  }
  if (body.unsponsored.length > 0) {
    return { ok: false, text: 'key 1 is not sponsored by key 0 (renew lists it as unsponsored): sponsor it again' };
  }
  const until = new Date(body.expiresAt * 1000).toISOString().slice(0, 10);
  return { ok: true, text: `both registry entries renewed until ${until}` };
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

/** A child process with the library log at Debug: only there does the relay's denial show. */
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
 * 60 MB from sender to receiver through the relay alone (a network without UDP, `--relay-only`). The receiver
 * counts the times from the first byte.
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
  const steps = [
    ['unknown', stepObcy], ['renew', (_iroh, keys) => renewEntries(keys)], ['registered', stepWpis],
    ['rate', stepTempo],
  ];
  for (const [name, step] of steps) {
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
