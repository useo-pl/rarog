#!/usr/bin/env node
// Strażnik relaya z crona co 5 min (iroh-relay.cron). Node bez zależności. Alert = linia w syslogu (tag
// relay-alert, daemon.crit) i w /var/log/relay-alert.log; kanał na telefon czyta jedno z dwóch.
//   - ruch wychodzący (tx_bytes interfejsu): średnio ≥ 80 % sufitu `tc` (100 Mbit/s) przez godzinę,
//     albo ≥ 15 TB w miesiącu kalendarzowym (UTC; po reboocie licznik jądra rośnie od zera, strażnik to dolicza);
//   - established TCP connections on 80 and 443 > 6000 (nftables budget: 8000 at once over both ports);
//   - linie `why=status:401` w dzienniku relay-access od poprzedniego przebiegu: Worker odrzucił bearer relaya,
//     a adapter przy fail-open wpuszcza wtedy każdego. Dziennik czyta strumieniowo (przy zalewie bywa większy niż
//     bufor spawnSync), a porażka odczytu daje własny alert i nie wstrzymuje pomiaru ruchu i połączeń.
// Ten sam alert powtarza się najwyżej raz na godzinę (miesięczny raz na miesiąc). Stan: /var/lib/relay-watch.
// The state also keeps the daily peak of connections (UTC day, today and yesterday) that relay-stats.mjs prints.
//
// Logika decyzji to czysta funkcja `evaluate` (testy: relay-vps/test/relay-watch.test.ts); `main` tylko zbiera
// odczyty i wysyła alerty.

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Sufit `tc` w bajtach na sekundę (100 Mbit/s). */
export const LINK_BYTES_PER_S = 12_500_000;
export const RATE_ALERT_FRACTION = 0.8;
export const MONTH_ALERT_BYTES = 15e12;
export const CONN_ALERT = 6000;
/**
 * `ss` arguments listing established TCP connections on 80 and 443, one per line: both ports share the nftables
 * connection budget. relay-stats counts the same list.
 */
export const SS_ARGS = ['-Htn', 'state', 'established', '( sport = :80 or sport = :443 )'];
const HOUR_MS = 3_600_000;
const UNAUTHORIZED = /\bwhy=status:401\b/;
/** Okno średniej: najstarsza próbka nie młodsza niż 55 min (cron co 5 min, z zapasem na spóźnienie). */
const WINDOW_MIN_MS = 55 * 60_000;
const KEEP_MS = 70 * 60_000;

/** Pusty stan pierwszego przebiegu. */
export function emptyState() {
  return {
    samples: [], month: '', monthBytes: 0, lastTx: null, monthAlerted: '', lastRunMs: null, alertedAt: {},
    connPeaks: {},
  };
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
/** UTC day `YYYY-MM-DD` of a timestamp. */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Daily connection peaks with `conns` counted in: only today and yesterday (UTC) are kept. */
function nextPeaks(prev, conns, nowMs) {
  const today = dayOf(nowMs);
  const yesterday = dayOf(nowMs - 86_400_000);
  const peaks = {};
  for (const day of [yesterday, today]) {
    const value = prev?.[day];
    if (typeof value === 'number' && Number.isFinite(value)) peaks[day] = value;
  }
  peaks[today] = Math.max(peaks[today] ?? 0, conns);
  return peaks;
}

/**
 * Decyzja jednego przebiegu. `input`: {txBytes, conns, unauthorized, journalError?} (unauthorized = liczba linii 401
 * od poprzedniego przebiegu; journalError = powód porażki odczytu dziennika). Zwraca nowy stan i listę alertów.
 */
export function evaluate(prev, input, nowMs) {
  const state = { ...emptyState(), ...prev, alertedAt: { ...(prev?.alertedAt ?? {}) } };
  const alerts = [];
  const raise = (key, message, everyMs = HOUR_MS) => {
    const last = state.alertedAt[key];
    if (last !== undefined && nowMs - last < everyMs) return;
    state.alertedAt[key] = nowMs;
    alerts.push(message);
  };

  // Licznik jądra maleje tylko po reboocie (albo nowym interfejsie): wtedy próbki sprzed niego nic nie znaczą,
  // a do miesiąca dochodzi cały bieżący stan licznika.
  const reset = state.lastTx !== null && input.txBytes < state.lastTx;
  const delta = state.lastTx === null || reset ? input.txBytes : input.txBytes - state.lastTx;
  const month = monthOf(nowMs);
  if (state.month !== month) {
    state.month = month;
    state.monthBytes = 0;
  }
  state.monthBytes += delta;
  state.lastTx = input.txBytes;

  const samples = (reset ? [] : state.samples).filter(([t]) => nowMs - t <= KEEP_MS);
  samples.push([nowMs, input.txBytes]);
  state.samples = samples;
  const [t0, b0] = samples[0];
  if (nowMs - t0 >= WINDOW_MIN_MS) {
    const rate = (input.txBytes - b0) / ((nowMs - t0) / 1000);
    if (rate >= RATE_ALERT_FRACTION * LINK_BYTES_PER_S) {
      raise('rate', `ALERT relay-watch: outbound traffic ${(rate / 1e6).toFixed(1)} MB/s on average over `
        + `${Math.round((nowMs - t0) / 60_000)} min (threshold 80 % of 12.5 MB/s)`);
    }
  }
  if (state.monthBytes >= MONTH_ALERT_BYTES && state.monthAlerted !== month) {
    state.monthAlerted = month;
    alerts.push(`ALERT relay-watch: outbound traffic in ${month}: ${(state.monthBytes / 1e12).toFixed(2)} TB `
      + '(threshold 15 TB)');
  }
  if (input.conns > CONN_ALERT) {
    raise('conns', `ALERT relay-watch: ${String(input.conns)} TCP connections on 80 and 443 `
      + `(threshold ${String(CONN_ALERT)})`);
  }
  if (input.journalError) {
    raise('journal', `ALERT relay-watch: reading the relay-access journal failed, Worker 401s of this window unknown: `
      + input.journalError);
  }
  if (input.unauthorized > 0) {
    raise('401', `ALERT relay-watch: the Worker rejected the relay bearer (${String(input.unauthorized)}× 401 in the `
      + 'relay-access journal); the adapter lets everyone in on fail-open: '
      + 'check the hook secret in the Worker and in relay.env');
  }
  state.connPeaks = nextPeaks(prev?.connPeaks, input.conns, nowMs);
  state.lastRunMs = nowMs;
  return { state, alerts };
}

/** Liczba linii decyzji adaptera z 401 w tekście dziennika. */
export function countUnauthorized(journal) {
  return journal.split('\n').filter((line) => UNAUTHORIZED.test(line)).length;
}

/**
 * Calls `onLine` for every output line of a command, read as a stream without holding the whole output (relay-stats
 * reads the adapter log the same way). A non-zero exit or a missing program throws.
 */
export async function forEachLine(cmd, args, onLine) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 300) stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', onLine);
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? signal));
  });
  const [code] = await Promise.all([exited, once(lines, 'close')]);
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')}: exit ${String(code)} ${stderr}`.trim());
}

/** Number of output lines of a command that match `re`, read as a stream (`forEachLine`). */
export async function countMatching(cmd, args, re) {
  let count = 0;
  await forEachLine(cmd, args, (line) => {
    if (re.test(line)) count += 1;
  });
  return count;
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return emptyState();
  }
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: exit ${String(res.status)} ${res.stderr ?? ''}`.trim());
  return res.stdout;
}

function alert(message, alertLog) {
  spawnSync('logger', ['-t', 'relay-alert', '-p', 'daemon.crit', message]);
  try {
    appendFileSync(alertLog, `${message} (${new Date().toISOString()})\n`);
  } catch { /* syslog wystarczy */ }
}

async function main() {
  const iface = process.env.RELAY_TC_IF || readIface('/etc/iroh-relay/tc.conf') || 'eth0';
  const stateDir = process.env.RELAY_WATCH_STATE_DIR || '/var/lib/relay-watch';
  const alertLog = process.env.RELAY_ALERT_LOG || '/var/log/relay-alert.log';
  const stateFile = path.join(stateDir, 'state.json');
  const now = Date.now();
  try {
    const prev = readState(stateFile);
    const txBytes = Number(readFileSync(`/sys/class/net/${iface}/statistics/tx_bytes`, 'utf8').trim());
    const conns = run('ss', SS_ARGS).split('\n')
      .filter((line) => line.trim() !== '').length;
    const since = prev.lastRunMs ?? now - 5 * 60_000;
    let unauthorized = 0;
    let journalError;
    try {
      unauthorized = await countMatching('journalctl', ['-u', 'relay-access.service',
        '--since', `@${String(Math.floor(since / 1000))}`, '-o', 'cat', '--no-pager'], UNAUTHORIZED);
    } catch (err) {
      journalError = String(err?.message ?? err).slice(0, 200);
    }
    const { state, alerts } = evaluate(prev, { txBytes, conns, unauthorized, journalError }, now);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
    for (const message of alerts) alert(message, alertLog);
  } catch (err) {
    alert(`ALERT relay-watch: przebieg nieudany: ${String(err?.message ?? err).slice(0, 300)}`, alertLog);
    process.exitCode = 1;
  }
}

/** RELAY_TC_IF z pliku `tc.conf` (ten sam, który czyta relay-tc.sh), bez wykonywania go. */
function readIface(file) {
  try {
    return /^RELAY_TC_IF=([A-Za-z0-9_.-]+)$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  } catch {
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
