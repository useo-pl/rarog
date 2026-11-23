#!/usr/bin/env node
/**
 * Claude Code `statusLine` script for Rarog: dumps the status bar payload to `~/.claude/statusline/<session_id>.json`,
 * from which the server reads the session's window size and plan limits (`server/src/herdr/statusline.ts`), and prints
 * a short bar line: model and window percentage.
 *
 * It runs from the COPY in `~/.claude/hooks/rarog/`, like the permission hook: Claude Code runs the `statusLine`
 * command outside the sandbox on every bar render, and an agent in the sandbox can change the repo checkout. The copy
 * is made by `rarog hooks install` (together with the hook, the same "state from a commit" gate) or by `rarog setup`
 * (only the copy of this script, when it is missing). Imports only `node:` (guard `hook-granica-guard.test.ts`).
 *
 * Rules:
 * - stdin at most 64 KiB (the dump reader's cap) within 1 s; more, or no EOF = no dump;
 * - `session_id` matches `^[A-Za-z0-9-]{1,128}$`, otherwise no dump: the file name is built from this string;
 * - `~/.claude/statusline` must be a real directory of the user (`lstat`: not a symlink, owner = this
 *   process); missing = we create it with permissions 0700. The directory is writable from the sandbox, so a symlink
 *   in its place would point a write by a process outside the sandbox anywhere;
 * - writing: a temporary file with a random suffix in the same directory (`wx`, 0600), then `rename`; failure =
 *   cleaning up the temporary file. A dot at the start of the temporary name: the dump reader skips such files;
 * - never throws and always exits with code 0: a script error means an empty bar in every session of the account.
 *
 * Chain: `RAROG_STATUSLINE_CHAIN='<command>' node '<copy>'`. After the dump the script runs `sh -c '<command>'` with
 * the same payload on stdin and prints its output; after 2 s it kills its process group and prints its own line. It
 * kills the group at EVERY end of the script: after the time limit, after a normal exit (a background child with
 * redirected streams) and after a signal: Claude Code interrupts the script on the next bar refresh. This way a user
 * with their own status bar script gets Rarog's dump without changing their script.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** stdin cap = the server's dump read cap (`STATUSLINE_MAX_BYTES`). */
const STDIN_MAX_BYTES = 64 * 1024;
/** Claude Code gives the payload at once; waiting longer means a frozen bar. */
const STDIN_TIMEOUT_MS = 1000;
/** Time cap of the chain command. */
const CHAIN_TIMEOUT_MS = 2000;
/** Output cap of the chain command (the bar has one, at most a few lines). */
const CHAIN_MAX_BYTES = 64 * 1024;
/** The string the dump file name is built from (Claude Code gives a UUID). */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
/** Variable with the chain command, set in the `statusLine` command itself. */
const CHAIN_ENV = 'RAROG_STATUSLINE_CHAIN';

/** Process group of the chain (leader pid) to kill at the end of the script; `null` = no live chain. */
let chainGroup = null;
/** Temporary dump file during the write: cleaned up also on exit after a signal. */
let pendingTmp = null;

/** Kills the chain group (idempotent). Called from the time limit and from every end of the process. */
function killChain() {
  if (chainGroup === null) return;
  const group = chainGroup;
  chainGroup = null;
  try {
    process.kill(-group, 'SIGKILL');
  } catch {
    // The group is already empty.
  }
}

/** Cleans up what the script may have left: the chain group and the temporary dump file. Synchronous (`exit`). */
function cleanup() {
  killChain();
  if (pendingTmp !== null) {
    try {
      unlinkSync(pendingTmp);
    } catch {
      // The file is already gone.
    }
    pendingTmp = null;
  }
}

/** All of stdin, or `null` (over the cap, no EOF within the time limit, read error). Never throws. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (value === null) process.stdin.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => { finish(null); }, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > STDIN_MAX_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => { finish(Buffer.concat(chunks)); });
    process.stdin.on('error', () => { finish(null); });
  });
}

/** A JSON object or `null`. */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parsePayload(bytes) {
  if (bytes === null || bytes.length === 0) return null;
  try {
    return asRecord(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * The dump directory as `Stats`, or `null` when it is not a real directory of this user. Missing = `mkdir`
 * 0700 (without `recursive`: a missing `~/.claude` is not our installation).
 */
function dumpDir(dir) {
  let info;
  try {
    info = lstatSync(dir);
  } catch (err) {
    if (err?.code !== 'ENOENT') return null;
    try {
      mkdirSync(dir, { mode: 0o700 });
      info = lstatSync(dir);
    } catch {
      return null;
    }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
  return info;
}

/** Dump of the payload (bytes unchanged) at `<dir>/<sessionId>.json`. `true` = written. Never throws. */
function dump(bytes, sessionId) {
  const dir = join(homedir(), '.claude', 'statusline');
  const before = dumpDir(dir);
  if (before === null) return false;
  const tmp = join(dir, `.${sessionId}.${randomBytes(8).toString('hex')}.tmp`);
  let fd = null;
  try {
    pendingTmp = tmp;
    fd = openSync(tmp, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    closeSync(fd);
    fd = null;
    // The directory was swapped between the check and the write (a symlink in its place) = no dump.
    const after = lstatSync(dir);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('dump directory swapped');
    }
    renameSync(tmp, join(dir, `${sessionId}.json`));
    pendingTmp = null;
    return true;
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The end of the process closes the descriptor anyway.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // No temporary file (an `open` failure) is an expected state.
    }
    pendingTmp = null;
    return false;
  }
}

/** Own bar line: model and window percentage; control characters cut out (this goes straight to the terminal). */
function ownLine(payload) {
  if (payload === null) return '';
  const model = asRecord(payload.model);
  const display = typeof model?.display_name === 'string' && model.display_name !== '' ? model.display_name
    : (typeof model?.id === 'string' ? model.id : '');
  const used = asRecord(payload.context_window)?.used_percentage;
  const percent = typeof used === 'number' && Number.isFinite(used) && used >= 0 ? `${String(Math.round(used))}%` : '';
  return [display.replace(/[\u0000-\u001f\u007f]/g, ''), percent].filter((part) => part !== '').join(' · ');
}

/** Output of the chain command, or `null` (did not start, exceeded the time limit). Never throws. */
function runChain(command, bytes) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    } catch {
      resolve(null);
      return;
    }
    // Process group (`detached`): killing it also covers children of `sh -c` that would hold the output pipe.
    chainGroup = child.pid ?? null;
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killChain();
      finish(null);
    }, CHAIN_TIMEOUT_MS);
    child.on('error', () => { finish(null); });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= CHAIN_MAX_BYTES) chunks.push(chunk);
    });
    child.on('close', () => { finish(Buffer.concat(chunks).toString('utf8')); });
    // A command that does not read stdin gives EPIPE: not a chain error.
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

async function main() {
  const bytes = await readStdin();
  const payload = parsePayload(bytes);
  const sessionId = payload?.session_id;
  if (payload !== null && typeof sessionId === 'string' && SESSION_ID.test(sessionId)) dump(bytes, sessionId);
  const line = `${ownLine(payload)}\n`;
  const chain = process.env[CHAIN_ENV];
  if (typeof chain !== 'string' || chain.trim() === '' || bytes === null) return line;
  const out = await runChain(chain, bytes);
  return out ?? line;
}

/** Prints the text and exits with code 0; writing to a pipe can be asynchronous, so exit after its callback. */
function exitWith(text) {
  killChain();
  const exit = () => { process.exit(0); };
  setTimeout(exit, 500).unref();
  try {
    process.stdout.write(text, exit);
  } catch {
    exit();
  }
}

// A closed bar pipe (Claude Code does not wait for the result) is no reason for a code ≠ 0.
process.stdout.on('error', () => { process.exit(0); });
// Every end of the process cleans up the chain and the temporary file; a signal exits with code 0 (an interrupted
// render is not an error).
process.on('exit', cleanup);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { process.exit(0); });
main().then(exitWith, () => { exitWith(''); });
