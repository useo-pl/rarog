/**
 * Konfiguracja `relay-vps/config.toml` dla iroh-relay 1.4.1. Parser relaya ignoruje nieznane klucze, a brak
 * `[access]` znaczy „wpuść każdego” (main.rs @v1.4.1, `Config` bez `deny_unknown_fields`, `AccessConfig::Everyone`
 * domyślnie), więc literówka otwiera relay albo zdejmuje limit po cichu. Test trzyma zamknięty zestaw kluczy
 * i wartości. TOML czyta `tomllib` Pythona 3.11+ (jak krok TOML bramki), bez zależności w repo.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG = path.resolve(import.meta.dirname, '..', 'config.toml');

/** Python z `tomllib` (3.11+): ścieżka interpretera albo `null`. */
const PYTHON = ((): string | null => {
  const res = spawnSync('python3', ['-I', '-c', 'import sys, tomllib; print(sys.executable)'], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() !== '' ? res.stdout.trim() : null;
})();

function load(): Record<string, unknown> {
  const res = spawnSync(PYTHON ?? 'python3', ['-I', '-c',
    'import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', CONFIG], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`config.toml nie parsuje się: ${res.stderr}`);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

/** Klucze struktur `Config`, `TlsConfig`, `Limits`, `AccessConfig` z iroh-relay 1.4.1 (main.rs). */
const KNOWN = {
  top: ['enable_relay', 'http_bind_addr', 'tls', 'enable_quic_addr_discovery', 'limits', 'enable_metrics',
    'metrics_bind_addr', 'key_cache_capacity', 'access'],
  tls: ['https_bind_addr', 'quic_bind_addr', 'hostname', 'cert_mode', 'cert_dir', 'manual_cert_path', 'manual_key_path',
    'prod_tls', 'contact', 'dangerous_http_only'],
  limits: ['accept_conn_limit', 'accept_conn_burst', 'client'],
};

describe.skipIf(PYTHON === null)('relay-vps/config.toml (requires python3 with tomllib)', () => {
  const cfg = PYTHON === null ? {} : load();
  const tls = (cfg.tls ?? {}) as Record<string, unknown>;
  const limits = (cfg.limits ?? {}) as Record<string, unknown>;

  it('tylko klucze znane iroh-relay 1.4.1, na każdym poziomie', () => {
    for (const key of Object.keys(cfg)) expect(KNOWN.top, `klucz ${key}`).toContain(key);
    for (const key of Object.keys(tls)) expect(KNOWN.tls, `tls.${key}`).toContain(key);
    for (const key of Object.keys(limits)) expect(KNOWN.limits, `limits.${key}`).toContain(key);
    expect(Object.keys(limits.client as object)).toEqual(['rx']);
  });

  it('dostęp przez lokalny adapter haka; bearer nie w pliku', () => {
    expect(cfg.access).toEqual({ http: { url: 'http://127.0.0.1:8081/v1/access' } });
  });

  it('limit per połączenie 3 MB/s z burstem 16 MB; bez limitu przyjmowania połączeń (nie działa w 1.4.1)', () => {
    expect(limits).toEqual({ client: { rx: { bytes_per_second: 3_000_000, max_burst_bytes: 16_000_000 } } });
  });

  it('metryki tylko na pętli; relay, QAD i port 80 dla sondy klienta', () => {
    expect(cfg).toMatchObject({
      enable_relay: true, enable_metrics: true, metrics_bind_addr: '127.0.0.1:9090',
      enable_quic_addr_discovery: true, http_bind_addr: '[::]:80',
    });
  });

  it('TLS z Let\'s Encrypt (produkcja) pod relay.rarog.ai, cert_dir w katalogu stanu jednostki', () => {
    expect(tls).toEqual({
      https_bind_addr: '[::]:443', cert_mode: 'LetsEncrypt', hostname: 'relay.rarog.ai', contact: 'security@rarog.ai',
      cert_dir: '/var/lib/iroh-relay/certs', prod_tls: true,
    });
  });
});
