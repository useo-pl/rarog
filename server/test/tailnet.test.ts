/**
 * Nazwa tailnetu dla nagłówka AGENCI.
 *
 * Testy trzymają trzy rzeczy, z których ten ficzer się składa i które łatwo cicho zepsuć:
 * co uznajemy za „jesteś połączony", że NIC nie rzuca, i że jeden odczyt starcza na minutę
 * (inaczej `/api/version` spawnowałby proces per request).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TAILNET_NAME_MAX, TAILSCALE_BINARIES, TAILSCALE_TERM, parseTailnetName, spawnTailscaleStatus, tailnetEnv,
  tailnetReader,
} from '../src/tailnet.ts';
import { TAILNET_ENV_PASSTHROUGH } from '../src/config-env.ts';

const RUNNING = {
  BackendState: 'Running',
  MagicDNSSuffix: 'example.ts.net',
  CurrentTailnet: { Name: 'example.com', MagicDNSSuffix: 'example.ts.net' },
};

describe('parseTailnetName', () => {
  it('bierze nazwę z konsoli Tailscale, nie sufiks MagicDNS', () => {
    // To jest ta nazwa, którą człowiek widzi w panelu Tailscale — sufiks jest tylko zapasem.
    expect(parseTailnetName(JSON.stringify(RUNNING))).toBe('example.com');
  });

  it('starsze CLI bez `CurrentTailnet` spada na `MagicDNSSuffix`', () => {
    const legacy = { BackendState: 'Running', MagicDNSSuffix: 'example.ts.net' };
    expect(parseTailnetName(JSON.stringify(legacy))).toBe('example.ts.net');
  });

  it('stan inny niż Running to `null`, a nie ostatnia znana nazwa', () => {
    // Nagłówek ma mówić „jesteś w tailnecie". Wyłączony Tailscale musi z niego ZNIKNĄĆ.
    for (const state of ['Stopped', 'NeedsLogin', 'NoState', 'Starting']) {
      expect(parseTailnetName(JSON.stringify({ ...RUNNING, BackendState: state }))).toBeNull();
    }
  });

  it('śmieci na wejściu nie wywracają odczytu', () => {
    for (const raw of ['', 'nie-json', 'null', '[]', '{}', '{"BackendState":"Running"}']) {
      expect(parseTailnetName(raw)).toBeNull();
    }
  });

  it('czyści znaki sterujące i tnie długość — to wejście z obcego procesu', () => {
    const dirty = { ...RUNNING, CurrentTailnet: { Name: '  example.com\n' } };
    expect(parseTailnetName(JSON.stringify(dirty))).toBe('example.com');
    const long = { ...RUNNING, CurrentTailnet: { Name: 'a'.repeat(200) } };
    expect(parseTailnetName(JSON.stringify(long))).toHaveLength(TAILNET_NAME_MAX);
  });

  it('pusta nazwa przechodzi do zapasu, zamiast oddać pustą etykietę', () => {
    const empty = { ...RUNNING, CurrentTailnet: { Name: '   ' } };
    expect(parseTailnetName(JSON.stringify(empty))).toBe('example.ts.net');
  });
});

describe('tailnetReader', () => {
  it('trzyma odczyt przez TTL — jedno wywołanie CLI, nie jedno na żądanie', async () => {
    let runs = 0;
    let clock = 0;
    const read = tailnetReader(
      () => { runs += 1; return Promise.resolve(JSON.stringify(RUNNING)); },
      { ttlMs: 60_000, now: () => clock },
    );

    expect(await read()).toBe('example.com');
    expect(await read()).toBe('example.com');
    expect(runs).toBe(1);

    clock = 60_001;
    expect(await read()).toBe('example.com');
    expect(runs).toBe(2);
  });

  it('sto równoległych odczytów daje JEDEN spawn (pojedynczy lot)', async () => {
    let runs = 0;
    let release: ((value: string) => void) | null = null;
    const read = tailnetReader(() => {
      runs += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    }, { ttlMs: 60_000, now: () => 0 });

    const all = Promise.all(Array.from({ length: 100 }, () => read()));
    await Promise.resolve();
    expect(runs).toBe(1);
    (release as unknown as (value: string) => void)(JSON.stringify(RUNNING));
    expect(await all).toEqual(Array.from({ length: 100 }, () => 'example.com'));
    expect(runs).toBe(1);
  });

  it('brak CLI i rzucający runner to `null`, nie wyjątek w `/api/version`', async () => {
    expect(await tailnetReader(() => Promise.resolve(null))()).toBeNull();
    expect(await tailnetReader(() => Promise.reject(new Error('ENOENT')))()).toBeNull();
  });

  it('powrót Tailscale do sieci wraca do nagłówka po wygaśnięciu TTL', async () => {
    let clock = 0;
    let state = 'Stopped';
    const read = tailnetReader(
      () => Promise.resolve(JSON.stringify({ ...RUNNING, BackendState: state })),
      { ttlMs: 1_000, now: () => clock },
    );
    expect(await read()).toBeNull();
    state = 'Running';
    clock = 1_001;
    expect(await read()).toBe('example.com');
  });
});

/**
 * Runner na PRAWDZIWYM procesie — atrapą jest skrypt, nie funkcja. Dwie rzeczy, których nie da
 * się sprawdzić inaczej niż uruchamiając coś: że binarka dostaje NIEPUSTY `TERM` (bez niego
 * wydanie z App Store wypisuje „The Tailscale GUI failed to start" i kończy się kodem 0, czyli
 * wygląda jak sukces) i że odpowiedź niebędąca JSON-em jest odrzucana zamiast przejść dalej.
 */
describe('spawnTailscaleStatus', () => {
  const scripts: string[] = [];

  const script = async (body: string): Promise<string> => {
    const path = join(await mkdtemp(join(tmpdir(), 'rarog-tailnet-')), 'tailscale');
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    scripts.push(path);
    return path;
  };

  afterEach(async () => {
    for (const path of scripts.splice(0)) await rm(dirname(path), { recursive: true, force: true });
  });

  it('podaje binarce niepusty TERM — inaczej CLI z App Store odpala GUI zamiast odpowiedzieć', async () => {
    // Skrypt oddaje własny $TERM jako nazwę tailnetu, więc wynik JEST dowodem na to, co dostał.
    const bin = await script(
      'printf \'{"BackendState":"Running","CurrentTailnet":{"Name":"%s"}}\' "$TERM"',
    );
    const raw = await spawnTailscaleStatus([bin])();
    expect(raw).not.toBeNull();
    expect(parseTailnetName(raw ?? '')).not.toBeNull();
  });

  it('odpowiedź spoza JSON-a (kod 0 + komunikat o GUI) leci do kosza, nie do nagłówka', async () => {
    const bin = await script('echo "The Tailscale GUI failed to start"');
    expect(await spawnTailscaleStatus([bin])()).toBeNull();
  });

  it('nieistniejąca ścieżka przechodzi do następnej z listy', async () => {
    const bin = await script('printf \'{"BackendState":"Running","CurrentTailnet":{"Name":"example.com"}}\'');
    const raw = await spawnTailscaleStatus(['/nie/ma/takiej/binarki', bin])();
    expect(parseTailnetName(raw ?? '')).toBe('example.com');
  });
});

describe('środowisko procesu CLI', () => {
  it('nie przepuszcza sekretów Raroga — lista jest ZAMKNIĘTA, nie `...process.env`', () => {
    const env = tailnetEnv({
      HOME: '/Users/u', PATH: '/usr/bin', TMPDIR: '/tmp/x', TERM: 'xterm',
      SONIOX_API_KEY: 'sekret', RAROG_APNS_KEY_ID: 'sekret',
    });
    expect(Object.keys(env).sort()).toEqual([...TAILNET_ENV_PASSTHROUGH, 'TERM'].sort());
    expect(JSON.stringify(env)).not.toContain('sekret');
  });

  it('brak i PUSTY `TERM` dają tę samą wartość zastępczą', () => {
    expect(tailnetEnv({ PATH: '/usr/bin' })['TERM']).toBe(TAILSCALE_TERM);
    expect(tailnetEnv({ PATH: '/usr/bin', TERM: '' })['TERM']).toBe(TAILSCALE_TERM);
    expect(tailnetEnv({ PATH: '/usr/bin', TERM: 'xterm' })['TERM']).toBe('xterm');
  });
});

describe('gdzie szukamy CLI', () => {
  it('same ścieżki ABSOLUTNE — pod `env -i` PATH jest szczątkowy, a szukanie po nim to zgadywanie', () => {
    expect(TAILSCALE_BINARIES.length).toBeGreaterThan(0);
    for (const bin of TAILSCALE_BINARIES) expect(bin.startsWith('/')).toBe(true);
    // Mac z App Store trzyma binarkę w pakiecie aplikacji, nie w żadnym `bin`.
    expect(TAILSCALE_BINARIES).toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('ścieżki macOS najpierw i w tej samej kolejności co dotąd, ścieżki Linuksa na końcu', () => {
    expect(TAILSCALE_BINARIES).toEqual([
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/usr/bin/tailscale',
      '/usr/sbin/tailscale',
    ]);
  });
});
