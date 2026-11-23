/**
 * Artefakty sesji (`herdr/background/artifacts.ts`): rozpoznanie publikacji i usunięcia w pliku
 * rozmowy oraz lista.
 *
 * Sedno to przypadki UJEMNE. Wiersza nie tworzy nic poza wynikiem publikacji (odczyt, lista, quickstart,
 * wgranie zasobu, błąd, adres w wyniku innego narzędzia, wpis subagenta). Wiersza nie wygasza nic poza notką
 * harnessu (tekst meldunku w wyniku narzędzia, w prompcie człowieka, w kolejce, w wiadomości od agenta).
 * Kształty pochodzą z pomiaru magazynu CLI (`artifacts/measured/`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACTS_MAX, ARTIFACT_TITLE_MAX, artifactFact, artifactsSignature, createArtifactsTracker, sessionArtifacts,
} from '../src/herdr/background/artifacts.ts';
import { noticeFromText } from '../src/herdr/background/notice.ts';
import { parseTaskNotification } from '../src/herdr/background/notification.ts';
import { createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';
import { parseImportLine } from '../src/transcript-import.ts';

const MEASURED = join(import.meta.dirname, 'fixtures/herdr/artifacts/measured');
const measuredLines = (name: string): string[] =>
  readFileSync(join(MEASURED, name), 'utf8').split('\n').filter((line) => line !== '');

const ID = 'ArtefaktTestowyH000001';
const URL = `https://claude.ai/artifact/${ID}`;
const URL_B = 'https://claude.ai/artifact/ArtefaktTestowyB000002';
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 16, 10, minute, 0)).toISOString();

/** Wynik narzędzia: blok `tool_result` i `toolUseResult` obok (kształt zmierzony). */
const result = (
  value: unknown, minute = 0, extra: Record<string, unknown> = {}, block: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'user', isSidechain: false, timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', ...block }] },
  toolUseResult: value, ...extra,
});

/** Wynik publikacji nowej strony albo ponownej (`updated`), z polami, których lista nie bierze. */
const published = (url: string, title: string, minute: number, updated = false): Record<string, unknown> => result({
  url, title, artifact_id: url.slice(url.lastIndexOf('/') + 1), version: 3, seq: 7, updated,
  path: '/private/tmp/claude-uid/scratchpad/raport.html', audience: 'private', capabilities: {}, own_files: [],
}, minute);

/** Meldunek o końcu obserwacji: tekst dokładnie w kształcie z CLI. */
const watchText = (title: string, url: string, variant = '(artifact not found)'): string => [
  '<task-notification>',
  '<task-type>artifact-watch-lifecycle</task-type>',
  `<summary>Stopped watching Artifact: "${title}" ${variant}</summary>`,
  `<event>Watch on ${url} ended — no such artifact for this account (it was deleted, or it has not been shared `
    + 'with the user). This session no longer keeps track of new versions of it.</event>',
  '</task-notification>',
].join('\n');

/** Notka harnessu we wpisie `user` (osobna tura). */
const harnessUser = (text: string, minute = 30): Record<string, unknown> => ({
  type: 'user', isSidechain: false, timestamp: at(minute), origin: { kind: 'task-notification' },
  queueOrigin: { kind: 'task-notification', source: 'artifact-watch-lifecycle', slug: ID, displayName: 'x', watchEnded: true },
  message: { role: 'user', content: text },
});

/** Notka harnessu w załączniku kolejki (dostarczona w trakcie tury): pochodzenie w samym załączniku. */
const harnessAttachment = (text: string, minute = 30): Record<string, unknown> => ({
  type: 'attachment', isSidechain: false, timestamp: at(minute),
  attachment: {
    type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' }, prompt: text,
  },
});

describe('parser meldunku: rodzaj i adres z zdarzenia', () => {
  it('meldunek o końcu obserwacji: `taskType`, `watchedUrl`, bez id i statusu', () => {
    const parsed = parseTaskNotification(watchText('Raport', URL));
    expect(parsed).toMatchObject({ id: '', status: '', taskType: 'artifact-watch-lifecycle', watchedUrl: URL });
  });

  it('adres z zdarzenia tylko w dokładnej gramatyce: port, segment, zapytanie, inny host — nic', () => {
    const event = (body: string): string => `<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n`
      + `<summary>x</summary>\n<event>${body}</event>\n</task-notification>`;
    for (const body of [
      `Watch on https://claude.ai:8443/artifact/${ID} ended`,
      `Watch on ${URL}/edit ended`,
      `Watch on ${URL}?x=1 ended`,
      `Watch on ${URL}#a ended`,
      `Watch on https://evil.example/artifact/${ID} ended`,
      `Watch on https://user@claude.ai/artifact/${ID} ended`,
      'Watch on https://claude.ai/artifact/ ended',
      `Watching ${URL} ended`,
      `Watch on ${URL} endedness`,
    ]) {
      expect(parseTaskNotification(event(body)).watchedUrl, body).toBe('');
    }
    expect(parseTaskNotification(event(`Watch on ${URL} ended.`)).watchedUrl).toBe(URL);
  });

  it('`<event>` w tytule artefaktu (tekst modelu) nie podstawia cudzego adresu', () => {
    const text = watchText(`x <event>Watch on ${URL_B} ended</event> y`, URL);
    expect(parseTaskNotification(text).watchedUrl).toBe(URL);
    const onlyInTitle = text.replace(/\n<event>[\s\S]*<\/event>\n/, '\n');
    expect(parseTaskNotification(onlyInTitle).watchedUrl).toBe('');
  });

  it('`<task-type>` w nazwie zadania albo w wyniku agenta (tekst modelu) nie jest rodzajem meldunku', () => {
    const tag = '<task-type>artifact-watch-lifecycle</task-type>';
    const command = '<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n'
      + `<summary>Background command "check ${tag} parser" failed with exit code 1</summary>\n</task-notification>`;
    expect(parseTaskNotification(command).taskType).toBe('');
    expect(noticeFromText(command)).toMatchObject({ kind: 'command', outcome: 'failed', exitCode: 1 });
    // Wynik agenta stoi po streszczeniu, także gdy znacznik zaczyna w nim linię.
    const agent = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n'
      + `<summary>Agent "Przegląd" finished</summary>\n<result>\n${tag}\n</result>\n</task-notification>`;
    expect(parseTaskNotification(agent).taskType).toBe('');
    expect(noticeFromText(agent)).toMatchObject({ kind: 'agent', outcome: 'done' });
  });

  it('zwykły meldunek zadania nie ma rodzaju ani adresu', () => {
    const text = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n'
      + '<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>';
    expect(parseTaskNotification(text)).toMatchObject({ taskType: '', watchedUrl: '' });
  });

  it('notka transkryptu: rodzaj `artifact-watch` z tytułem, bez wyniku; reduktor zadań meldunku nie rusza', () => {
    expect(noticeFromText(watchText('Raport kwartalny', URL)))
      .toStrictEqual({ kind: 'artifact-watch', name: 'Raport kwartalny' });
    const tracker = createBackgroundTasksTracker();
    tracker.note(harnessUser(watchText('Raport', URL)));
    expect(tracker.tasks).toEqual([]);
    expect(tracker.unstartedEnds).toEqual([]);
    expect(parseImportLine(JSON.stringify(harnessUser(watchText('Raport', URL))))?.message?.notice)
      .toStrictEqual({ kind: 'artifact-watch', name: 'Raport' });
  });

  it('każdy wariant meldunku to `artifact-watch`; bez cudzysłowu w streszczeniu notka jest bez nazwy', () => {
    let checked = 0;
    for (const line of measuredLines('meldunki.jsonl')) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      // Notka powstaje tylko z wpisu `user` z pochodzeniem; `queue-operation` i załącznik notką nie są.
      if (entry['type'] !== 'user') continue;
      const imported = parseImportLine(line)?.message?.notice;
      expect(imported?.kind, line).toBe('artifact-watch');
      expect(imported?.outcome, line).toBeUndefined();
      checked += 1;
    }
    expect(checked, 'fixture z pomiaru nie ma meldunku we wpisie `user`').toBeGreaterThan(0);
    const accountChanged = '<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n'
      + '<summary>Stopped watching 1 artifact watch (the signed-in account changed)</summary>\n</task-notification>';
    expect(noticeFromText(accountChanged)).toStrictEqual({ kind: 'artifact-watch' });
    // Status w meldunku (dziś go nie ma) nie daje wyniku: koniec obserwacji nie jest zadaniem.
    const withStatus = accountChanged.replace('</task-type>', '</task-type>\n<status>completed</status>');
    expect(noticeFromText(withStatus)).toStrictEqual({ kind: 'artifact-watch' });
  });
});

describe('rozpoznanie publikacji', () => {
  it('nowa strona, ponowna publikacja i utworzenie z typu', () => {
    expect(artifactFact(published(URL, 'Raport', 1))).toEqual({ kind: 'published', url: URL, title: 'Raport', at: at(1) });
    expect(artifactFact(published(URL, 'Raport', 2, true))?.kind).toBe('published');
    const fromType = result({
      url: URL, title: 'Deck', version: 1, created_from_type: true, type: 'Slides', instructions: 'tajne',
      type_files: [], own_files: [],
    }, 3);
    expect(artifactFact(fromType)).toEqual({ kind: 'published', url: URL, title: 'Deck', at: at(3) });
  });

  /** Kryterium sukcesu 3 planu: wiersza NIE tworzy nic poza wynikiem publikacji. */
  it('wiersza nie tworzą: read, list, quickstart, wgranie zasobu, błąd, URL w wyniku Bash/Read/WebFetch, subagent', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['read', result({ file_read: { url: URL, title: 'x' } })],
      ['read (drugi kształt)', result({ read: { url: URL } })],
      ['list', result({ artifacts: [{ url: URL, title: 'x', updated: true }], scope: 'mine', pins_enabled: true })],
      ['quickstart', result({ quickstart: { intent: 'other' } })],
      ['wgranie zasobu', result({ asset_uploads: [{ url: URL }], written: 1 })],
      ['błąd: wynik-napis', result(`Error: publish failed for ${URL}`, 0, {}, { is_error: true })],
      ['błąd: blok z `is_error` i obiekt wyniku', result({ url: URL, title: 'x', updated: false }, 0, {}, { is_error: true })],
      ['URL w wyniku Bash', result({ stdout: `{"url":"${URL}","updated":true}`, stderr: '', interrupted: false })],
      ['URL w wyniku Read', result({ type: 'text', file: { filePath: '/a.json', content: `"url": "${URL}"` } })],
      ['WebFetch adresu artefaktu', result({ url: URL, code: 200, codeText: 'OK', bytes: 10, result: 'x' })],
      ['wpis subagenta', { ...published(URL, 'x', 1), isSidechain: true }],
      ['wynik bez bloku `tool_result`', { ...published(URL, 'x', 1), message: { role: 'user', content: 'tekst' } }],
      ['wynik bez czasu', { ...published(URL, 'x', 1), timestamp: undefined }],
      ['`updated` nie boolean', result({ url: URL, title: 'x', updated: 'true' })],
      ['`created_from_type` nie true', result({ url: URL, title: 'x', created_from_type: 'yes' })],
      ['wynik jako tablica', result([{ url: URL, title: 'x', updated: true }])],
    ];
    for (const [what, entry] of cases) expect(artifactFact(entry), what).toBeNull();
  });

  it('adres spoza dokładnej formy nie przechodzi (port, segment, zapytanie, fragment, dane użytkownika, inny host)', () => {
    for (const url of [
      `https://claude.ai:443/artifact/${ID}`, `${URL}/edit`, `${URL}?a=1`, `${URL}#x`, `https://u:p@claude.ai/artifact/${ID}`,
      `http://claude.ai/artifact/${ID}`, `https://claude.ai/artifact/${ID}-x`, 'https://claude.ai/artifact/',
      `https://claude.ai.evil.example/artifact/${ID}`, ` ${URL}`,
    ]) {
      expect(artifactFact(result({ url, title: 'x', updated: false })), url).toBeNull();
    }
  });

  it('tytuł: znaki sterujące usunięte, brzegi obcięte, sufit bez połowy znaku; pusty → identyfikator z adresu', () => {
    const fact = (title: unknown): unknown => artifactFact(result({ url: URL, title, updated: false }));
    expect(fact('  Plan\nmigracji\u0007  ')).toMatchObject({ title: 'Planmigracji' });
    expect(fact(`${'x'.repeat(ARTIFACT_TITLE_MAX - 1)}🙂`)).toMatchObject({ title: `${'x'.repeat(ARTIFACT_TITLE_MAX - 1)}\ufffd` });
    expect(fact('\n\t')).toMatchObject({ title: ID });
    expect(fact(undefined)).toMatchObject({ title: ID });
  });
});

describe('rozpoznanie usunięcia: wyłącznie notka harnessu', () => {
  it('notka we wpisie `user` i w załączniku kolejki (meldunek w trakcie tury) wygasza', () => {
    expect(artifactFact(harnessUser(watchText('Raport', URL)))).toEqual({ kind: 'gone', url: URL });
    expect(artifactFact(harnessAttachment(watchText('Raport', URL)))).toEqual({ kind: 'gone', url: URL });
  });

  /** Kryterium sukcesu 3 planu: wiersza NIE wygasza tekst meldunku poza notką harnessu. */
  it('nie wygaszają: kolejka (prompt człowieka i raport agenta), prompt bez pochodzenia, wynik Read, wiadomość agenta', () => {
    const text = watchText('Raport', URL);
    const cases: [string, Record<string, unknown>][] = [
      ['meldunek w `queue-operation` (pierwsza kopia CLI)', { type: 'queue-operation', operation: 'enqueue', timestamp: at(30), content: text }],
      ['prompt człowieka w kolejce cytujący meldunek', {
        type: 'queue-operation', operation: 'enqueue', timestamp: at(30), content: `Co znaczy to?\n${text}`,
      }],
      ['raport agenta w kolejce z cytatem', {
        type: 'queue-operation', operation: 'enqueue', timestamp: at(30), content: `<agent-message from="a1">raport: ${text}</agent-message>`,
      }],
      ['prompt człowieka bez pochodzenia', { type: 'user', isSidechain: false, timestamp: at(30), message: { role: 'user', content: text } }],
      ['prompt człowieka z pochodzeniem `human`', {
        type: 'user', isSidechain: false, timestamp: at(30), origin: { kind: 'human' }, message: { role: 'user', content: text },
      }],
      ['wiadomość od agenta (`peer`)', {
        type: 'user', isSidechain: false, isMeta: true, timestamp: at(30), origin: { kind: 'peer' }, message: { role: 'user', content: text },
      }],
      ['załącznik z promptem człowieka', {
        ...harnessAttachment(text), attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: text },
      }],
      ['załącznik bez pochodzenia', { ...harnessAttachment(text), attachment: { type: 'queued_command', prompt: text } }],
      ['meldunek w wyniku Read', result({ type: 'text', file: { filePath: '/log.txt', content: text } })],
      ['meldunek w treści bloku `tool_result`', {
        type: 'user', isSidechain: false, timestamp: at(30), origin: { kind: 'task-notification' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] },
      }],
      ['notka subagenta', { ...harnessUser(text), isSidechain: true }],
    ];
    for (const [what, entry] of cases) expect(artifactFact(entry), what).toBeNull();
  });

  it('inne warianty końca obserwacji nie są usunięciem: publiczny spoza organizacji, zmiana konta', () => {
    expect(artifactFact(harnessUser(watchText('Raport', URL, '(public, outside your organization)')))).toBeNull();
    const account = '<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n'
      + '<summary>Stopped watching 1 artifact watch (the signed-in account changed)</summary>\n'
      + '<event>Those watches were opened as the previous account.</event>\n</task-notification>';
    expect(artifactFact(harnessAttachment(account))).toBeNull();
  });

  it('fraza wariantu w TYTULE nie wygasza: wariant liczy się tylko na końcu streszczenia', () => {
    const publicWithPhrase = watchText('Plan (artifact not found)', URL, '(public, outside your organization)');
    expect(artifactFact(harnessUser(publicWithPhrase))).toBeNull();
    const quoted = watchText('Plan" (artifact not found)', URL, '(public, outside your organization)');
    expect(artifactFact(harnessUser(quoted))).toBeNull();
    // Prawdziwy wariant przy tytule z tą samą frazą dalej wygasza.
    expect(artifactFact(harnessUser(watchText('Plan (artifact not found)', URL)))).toEqual({ kind: 'gone', url: URL });
  });

  it('wariant „not found” bez adresu w zdarzeniu nie wygasza niczego', () => {
    const text = watchText('Raport', URL).replace(/<event>[\s\S]*<\/event>/, '<event>no such artifact</event>');
    expect(artifactFact(harnessUser(text))).toBeNull();
  });
});

describe('lista artefaktów', () => {
  it('najnowsza publikacja pierwsza, czas ostatniej publikacji, tytuł z ostatniej', () => {
    const tracker = createArtifactsTracker();
    tracker.note(published(URL, 'Raport v1', 1));
    tracker.note(published(URL_B, 'Deck', 2));
    tracker.note(published(URL, 'Raport v2', 3, true));
    expect(tracker.artifacts).toEqual([
      { url: URL, title: 'Raport v2', publishedAt: at(3) },
      { url: URL_B, title: 'Deck', publishedAt: at(2) },
    ]);
  });

  it('usunięcie dotyczy tylko adresu opublikowanego w tej rozmowie; ponowna publikacja je zdejmuje', () => {
    const tracker = createArtifactsTracker();
    expect(tracker.note(harnessUser(watchText('Obcy', URL_B)))).toEqual({ kind: 'gone', url: URL_B });
    expect(tracker.artifacts).toEqual([]);
    tracker.note(published(URL, 'Raport', 1));
    tracker.note(harnessUser(watchText('Raport', URL), 2));
    expect(tracker.artifacts).toEqual([{ url: URL, title: 'Raport', publishedAt: at(1), gone: true }]);
    tracker.note(published(URL, 'Raport', 3, true));
    expect(tracker.artifacts).toEqual([{ url: URL, title: 'Raport', publishedAt: at(3) }]);
  });

  it('każdy odczyt to NOWA tablica z nowymi obiektami (lista jedzie dalej przez referencję)', () => {
    const tracker = createArtifactsTracker();
    tracker.note(published(URL, 'Raport', 1));
    const first = tracker.artifacts;
    const second = tracker.artifacts;
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  it('remis czasów: późniejsza publikacja w pliku pierwsza; czas nie cofa się przy wpisie ze starszym czasem', () => {
    const tracker = createArtifactsTracker();
    tracker.note(published(URL, 'A', 5));
    tracker.note(published(URL_B, 'B', 5));
    expect(tracker.artifacts.map((item) => item.url)).toEqual([URL_B, URL]);
    tracker.note(published(URL_B, 'B2', 1, true));
    expect(tracker.artifacts[0]).toEqual({ url: URL_B, title: 'B2', publishedAt: at(5) });
  });

  it(`sufit ${String(ARTIFACTS_MAX)}: wypadają najstarsze, wynik jak przy mapie bez sufitu`, () => {
    const tracker = createArtifactsTracker();
    const url = (n: number): string => `https://claude.ai/artifact/A${String(n).padStart(21, '0')}`;
    for (let n = 0; n < ARTIFACTS_MAX + 5; n += 1) tracker.note(published(url(n), `T${String(n)}`, n));
    expect(tracker.artifacts).toHaveLength(ARTIFACTS_MAX);
    expect(tracker.artifacts[0]?.url).toBe(url(ARTIFACTS_MAX + 4));
    expect(tracker.artifacts.at(-1)?.url).toBe(url(5));
    // Usunięcie adresu, który wypadł, nie zmienia niczego; ponowna publikacja wraca na górę.
    const before = artifactsSignature(tracker.artifacts);
    tracker.note(harnessUser(watchText('T0', url(0)), 59));
    expect(artifactsSignature(tracker.artifacts)).toBe(before);
    tracker.note(published(url(0), 'T0', 59, true));
    expect(tracker.artifacts[0]).toEqual({ url: url(0), title: 'T0', publishedAt: at(59) });
  });

  it('podpis zmienia się przy zmianie tytułu, czasu i usunięcia; pusta lista to `[]`', () => {
    expect(artifactsSignature([])).toBe('[]');
    const base = { url: URL, title: 'A', publishedAt: at(1) };
    const signatures = new Set([
      artifactsSignature([base]), artifactsSignature([{ ...base, title: 'B' }]),
      artifactsSignature([{ ...base, publishedAt: at(2) }]), artifactsSignature([{ ...base, gone: true }]),
    ]);
    expect(signatures.size).toBe(4);
  });
});

describe('fixture’y z pomiaru magazynu CLI', () => {
  const publications = measuredLines('publikacje.jsonl');
  const watches = measuredLines('meldunki.jsonl');

  it('rozpoznanie = publikacje z wejścia: akcja publish, bez `asset`, bez błędu', () => {
    const calls = new Map<string, Record<string, unknown>>();
    let expected = 0;
    let recognized = 0;
    for (const line of publications) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const block = ((entry['message'] as { content: Record<string, unknown>[] }).content)[0] ?? {};
      if (block['type'] === 'tool_use') calls.set(String(block['id']), block['input'] as Record<string, unknown>);
      if (block['type'] !== 'tool_result') continue;
      const input = calls.get(String(block['tool_use_id'])) ?? {};
      const publication = (input['action'] ?? 'publish') === 'publish' && input['asset'] !== true && block['is_error'] !== true;
      if (publication) expected += 1;
      const fact = artifactFact(entry);
      if (fact !== null) recognized += 1;
      expect(fact !== null, `${line.slice(0, 160)}`).toBe(publication);
    }
    expect(expected).toBeGreaterThan(5);
    expect(recognized).toBe(expected);
  });

  it('meldunki: wygasza tylko „not found” z notki harnessu, nie kopia z kolejki ani inne warianty', () => {
    const facts = watches.map((line) => artifactFact(JSON.parse(line)));
    expect(facts.filter((fact) => fact?.kind === 'gone')).toHaveLength(1);
    const lines = watches.filter((line) => line.includes('(artifact not found)'));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes('"queue-operation"'))).toBe(true);
  });

  it('meldunek „account changed” w trakcie tury to załącznik z pochodzeniem `task-notification`', () => {
    const attachment = watches.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['type'] === 'attachment');
    expect(attachment?.['attachment']).toMatchObject({
      type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' },
    });
  });

  it('publikacje i meldunki razem: jeden artefakt, wygaszony', () => {
    expect(sessionArtifacts([...publications, ...watches])).toEqual([{
      url: 'https://claude.ai/artifact/Artefakt00000000000001', title: 'Tytuł artefaktu',
      publishedAt: expect.any(String) as string, gone: true,
    }]);
  });
});
