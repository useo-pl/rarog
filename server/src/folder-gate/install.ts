/**
 * The one folder gate of the process. Until bootstrap installs a gate, `folderGate()` gives the disabled one: no
 * client, no timers, no folder has a state, so every disk call goes straight to the disk as before the gate. The
 * module reads no environment and no platform; whether to install a gate is bootstrap's choice.
 */
import type { FolderGate } from './types.ts';

/** The gate of Linux, the demo, the kill switch and tests: it judges nothing and never waits. */
export const DISABLED_FOLDER_GATE: FolderGate = Object.freeze({
  enabled: false,
  stateOf: () => null,
  report: () => undefined,
  check: () => Promise.resolve('unknown' as const),
  blocked: () => [],
  onChange: () => () => undefined,
  dispose: () => undefined,
});

let installed: FolderGate | undefined;

export function folderGate(): FolderGate {
  return installed ?? DISABLED_FOLDER_GATE;
}

/**
 * Makes `gate` the gate of the process and returns its removal, which gives the disabled gate back; removing does not
 * dispose the gate. A second install while one stands is a programming error and throws.
 */
export function installFolderGate(gate: FolderGate): () => void {
  if (installed !== undefined) throw new Error('a folder gate is already installed in this process');
  installed = gate;
  return () => {
    if (installed === gate) installed = undefined;
  };
}
