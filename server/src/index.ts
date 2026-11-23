/**
 * Entry serwera Rarog: config → nadzorca herdr → manager → SseHub → router → node:http.
 *
 * Uruchomienie: `pnpm run demo:server` (RAROG_DEMO=1 tsx server/src/index.ts).
 *
 * Bind TCP jest twardo na 127.0.0.1 — na świat wystawia go wyłącznie Caddy w tailnecie. Drugą drogą jest nasłuch
 * iroh za flagą `RAROG_IROH=1`: strumienie QUIC trafiają do tego samego `http.Server`.
 */
// Pierwszy import: czas na początku każdej linii stdout i stderr serwera (`log-timestamps.ts`).
import './log-timestamps-install.ts';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { FileAttachment } from '@rarog/shared';
import { createAdminHandler, publicUrlOf, redact, startAdminSocket } from './auth/index.ts';
import type { AdminSocket, ConsentSocket } from './auth/index.ts';
import { clearReviewClientLogs } from './client-log.ts';
import { assembleCompanion } from './companion/index.ts';
import { ConfigError, HERDR_HISTORY_BYTES, assertLoopbackHost, loadConfig } from './config.ts';
import type { RarogConfig } from './config.ts';
import { DIALOG_LAYER2_ENV } from './config-env.ts';
import { skippedOriginLine } from './config/listen.ts';
import { irohAdminStatus } from './iroh/listener.ts';
import { gitReadEnv, probeGitSandboxAtStart } from './git-status.ts';
import { exitAfter } from './shutdown.ts';
import { consoleLogger } from './router.ts';
import type { Logger } from './router.ts';
import { readHookHealth } from './health.ts';
import type { HealthProbes } from './health.ts';
import {
  consentAdminControl, consentCardAwaitedAt, consentCardLive, consentManagerPort, consentTranscriptOf,
  createConsentChannel, observeConsent, startConsentCycle, startConsentRegistration, watchConsentMode,
} from './bootstrap/consent.ts';
import { createAliveSessionsSignal } from './bootstrap/alive-sessions.ts';
import type { AliveSessionsSignal } from './bootstrap/alive-sessions.ts';
import type { ConsentLink } from './bootstrap/consent.ts';
import { createDeviceAuth, startDeviceSweep } from './bootstrap/devices.ts';
import { healthProbes } from './bootstrap/health.ts';
import { prepareHookFiles } from './bootstrap/hook-files.ts';
import type { HerdrRuntime } from './bootstrap/herdr.ts';
import { loadDemoHerdr } from './bootstrap/herdr.ts';
import { buildRouter, configureHttpServer } from './bootstrap/http.ts';
import { startInbox } from './bootstrap/inbox.ts';
import { startServerIroh } from './bootstrap/iroh.ts';
import { loadSdk, managerConfig } from './bootstrap/manager.ts';
import { createPush } from './bootstrap/push.ts';
import { createPrStatus } from './bootstrap/pr-status.ts';
import { createSseHub } from './bootstrap/sse.ts';
import { loadTerm } from './bootstrap/term.ts';
import { createVersionSignal } from './bootstrap/versions.ts';
import { consentSubagentsOpen } from './herdr/dialogs/hook/contract.ts';
import { CONSENT_EVIDENCE_SCAN_MAX_BYTES } from './herdr/dialogs/layer1/contract.ts';
import { nodeConsentEvidenceIo } from './herdr/consent-evidence.ts';
import { createSessionHookList } from './herdr/dialogs/layer1/hook-list/hook-list.ts';
import { consentStep } from './herdr/consent-step.ts';
import { createSubagentObservation } from './herdr/consent-subagent.ts';
import { hookCommand } from './herdr/hook-commands.ts';
import { createConsentMode } from './herdr/dialogs/layer1/mode.ts';
import type { ConsentModeSource } from './herdr/dialogs/layer1/mode.ts';
import { createConsentProofGate, createConsentTopLoss } from './herdr/dialogs/layer1/observe.ts';
import type { ConsentProofGate } from './herdr/dialogs/layer1/observe.ts';
import type { ConsentHiddenSources } from './herdr/dialogs/layer1/observe.ts';
import { createConsentCanaryFile } from './herdr/dialogs/layer1/version-gate.ts';
import { psLiveness } from './herdr/dialogs/shadow/liveness.ts';
import { createPromptQueueStore } from './drivers/herdr/prompt-queue-store.ts';
import { consentRegistrationWanted, registrationWithoutCard } from './herdr/dialogs/layer1/registry.ts';
import { createAliveWriter } from './herdr/dialogs/shadow/alive.ts';
import { createShadowChannel } from './herdr/dialogs/shadow/channel.ts';
import { sweepMarkerFiles, sweepShadowFiles } from './herdr/dialogs/shadow/sweep.ts';
import type { ShadowChannel } from './herdr/dialogs/shadow/channel.ts';
import { cliWaitingOf } from './cli-version.ts';
import type { CliVersionReader } from './cli-version.ts';
import type { VersionWatch } from './version-watch.ts';
// Router i SseHub kodują przeciw `ManagerApi`; tutaj
// dodatkowo korzystamy z `ready` (start integracji) i `dispose()` (graceful drain).
import { BadRequestError, RESUME_UNREADABLE_MESSAGE, createManager } from './sessions/manager.ts';
import type { ManagerApi } from './sessions/manager-api.ts';
import { createMacStats } from './mac-stats.ts';
import { serverSystem } from './version.ts';
import type { HerdrLauncherSeam } from './herdr/supervisor.ts';
import type { DemoContent } from './demo/content/types.ts';

/**
 * Fabryka launchera z `herdr/launcher.ts`. Typ idzie z modułu (`typeof import`, bez ładowania),
 * więc zmiana pola w `HerdrLauncherDeps` przewraca `tsc` w miejscu wywołania niżej.
 */
type LauncherFactory = typeof import('./herdr/launcher.ts').createHerdrLauncher;

/**
 * Ładuje moduł launchera — leniwie (`import()` z literałem) i tylko przy `RAROG_HERDR_LAUNCH=1`.
 *
 * Ładowanie idzie PRZED złożeniem nadzorcy, żeby `canLaunch` mówiło prawdę od pierwszej
 * sekundy: przycisk „Nowa sesja", który jest aktywny i rzuca błędem, jest gorszy niż przycisk
 * wygaszony z wyjaśnieniem. Dlatego błąd ładowania nie przewraca startu, tylko wygasza kanał.
 */
async function loadLauncherFactory(log: Logger): Promise<LauncherFactory | null> {
  try {
    const { createHerdrLauncher } = await import('./herdr/launcher.ts');
    return createHerdrLauncher;
  } catch (err: unknown) {
    log.info(
      `herdr: launch channel unavailable (${redact(err)}); "New session" stays disabled.`,
    );
    return null;
  }
}

/**
 * Ogon pliku transkryptu w liniach — wejście dla `cwdFrom`.
 *
 * Czytamy OGON, a nie całość: pliki jsonl dochodzą do dziesiątek megabajtów, a `cwd` niesie
 * każdy wpis, więc ostatnie 256 kB odpowiada na to pytanie tak samo dobrze. Pierwsza linia
 * odczytu bywa ucięta w połowie i dlatego wypada — parser i tak odrzuciłby ją jako śmieć,
 * ale jawne odrzucenie mówi, że to skutek cięcia, a nie uszkodzonego pliku.
 */
async function readTranscriptTail(file: string): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const from = Math.max(0, size - HERDR_HISTORY_BYTES);
    const length = size - from;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from);
    const lines = buffer.toString('utf8').split('\n');
    return from > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

/**
 * Składa integrację herdr — albo mówi wprost, że jej nie ma.
 *
 * Po wycięciu SDK to jest JEDYNE źródło sesji, więc import nie jest opcjonalny. Fail-closed zostaje w każdym możliwym miejscu (`docs/security-model.md`, „Fail closed at start”): brak
 * modułu, wyjątek przy budowie nadzorcy, nieosiągalne gniazdo — wszystko kończy się tak samo,
 * czyli logiem, pustą listą i BANEREM w kliencie. Nigdy 500 i nigdy nieudany start.
 */
async function loadHerdr(
  config: RarogConfig, log: Logger, shadow: ShadowChannel | null, demoContent: DemoContent | null,
  consentMode: ConsentModeSource, consentLink: ConsentLink, cliVersionReader: CliVersionReader | null,
  versionWatch: VersionWatch | null, consentProofGate: ConsentProofGate, aliveSessions: AliveSessionsSignal,
): Promise<HerdrRuntime | null> {
  // `main()` ładuje zestaw treści tylko w demo, więc to jest gałąź demo.
  if (demoContent !== null) return loadDemoHerdr(log, demoContent);
  try {
    const [herdr, uploadsModule, uploadsRegistry, driverModule, pendingHook, refusalDump, answersModule] =
      await Promise.all([
        import('./herdr/index.ts'),
        import('./herdr/uploads.ts'),
        import('./herdr/uploads-registry.ts'),
        import('./drivers/herdr-driver.ts'),
        import('./herdr/dialogs/hook/dump.ts'),
        import('./herdr/dialogs/refusals.ts'),
        import('./herdr/dialogs/hook/answers.ts'),
      ]);
    // The start sweep cleans only the directories this registry lists (the uploads item in `docs/security-model.md`,
    // "herdr sessions: Rarog writes to a terminal it does not own").
    const uploads = uploadsModule.createUploads({
      registry: uploadsRegistry.createUploadsRegistry({ dataDir: config.dataDir }),
    });
    /*
     * Kanał odpowiedzi jest JEDEN na proces i ma WŁASNĄ bramkę killswitcha:
     * pisze plik, a nie klawisz, więc `RAROG_HERDR_SEND=0` nie wyciąłby go po drodze przez
     * klienta herdr. Zamknięta bramka = zapis oddaje `null`, czyli driver wraca na tor cyfry,
     * a odmowę „widzę, nie ruszam" wypowiada klient — jednym, znanym komunikatem (`docs/security-model.md`, „There are FIVE killswitches…”).
     */
    const hookAnswers = answersModule.createHookAnswerChannel(
      config.dataDir, () => config.herdrSend,
    );
    /*
     * Katalog komend sesji — JEDNA fabryka migawek na proces: ta sama migawka idzie do strażnika
     * managera i (w `SendOptions`) do drugiego strażnika w driverze. Czyta wyłącznie dysk konta i projektu
     * w opisanym podzbiorze (`herdr/commands/discover.ts`); notatki skanu idą do logu raz na proces.
     */
    const commandCatalogs = herdr.createCommandCatalogs({
      home: homedir(),
      roots: config.herdrRoots,
      log: (line: string) => { log.info(line); },
    });
    // Jeden zapisywacz na wszystkie drivery — wyłącznik i wersja Raroga rozstrzygają się RAZ.
    const dumpRefusal = refusalDump.createRefusalDumper({
      dataDir: config.dataDir,
      version: config.version,
      enabled: config.refusalDumps,
    });
    // One paste queue file for every driver: messages waiting for a paste survive a restart.
    const promptStore = createPromptQueueStore({
      dataDir: config.dataDir, logger: (line: string) => { log.info(line); },
      // The message route's gate for a voice agent body: the voice agent exists in this process exactly when
      // `companionEnabled` (`assembleCompanion`), so these two flags are the whole condition.
      voiceAgentSends: config.companionEnabled && config.companionSessionsEnabled,
    });
    const [trust, transcriptPath, jsonlPending] = await Promise.all([
      import('./herdr/trust.ts'),
      import('./herdr/transcript-path.ts'),
      import('./herdr/jsonl-pending.ts'),
    ]);
    const createLauncher = config.herdrLaunch ? await loadLauncherFactory(log) : null;
    // Jedno `ps` na proces dla obserwacji kanału zgód (te same zasady co kanał cienia).
    const consentLiveness = psLiveness();
    // Fakty plików subagentów dla obserwacji przy trybie `all`; `RAROG_AGENT_FILES=0` = prośba subagenta bez
    // dowodu.
    const consentSubagents = createSubagentObservation({
      io: nodeConsentEvidenceIo, locate: consentTranscriptOf, agentFiles: config.agentFiles,
      maxBytes: CONSENT_EVIDENCE_SCAN_MAX_BYTES,
    });
    // Hidden evidence under `all`: the memory of a lost consent top (`topLoss`) and the session's `PermissionRequest`
    // hook list (a read of Claude Code settings, no write). Without the CLI registry reader (demo) the list does not
    // know the session process, so there is no hidden evidence at all.
    const consentHidden: ConsentHiddenSources | null = cliVersionReader === null ? null : {
      topLoss: createConsentTopLoss(),
      sessionHooks: createSessionHookList({
        home: homedir(), accepted: [hookCommand(homedir())],
        entry: async (engineSessionId) => {
          const read = await cliVersionReader({ registryOnly: true });
          if (read.registry === null || (read.unreadablePids ?? 0) > 0) return null;
          if (read.unlistedSessions?.has(engineSessionId) === true) return null;
          const entries = read.registry.get(engineSessionId);
          const entry = entries?.length === 1 ? entries[0] : undefined;
          return entry === undefined ? null
            : { pid: entry.pid, ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }) };
        },
        onVerdict: (engineSessionId, verdict) => {
          log.info(`consent: session hooks ${engineSessionId} ${verdict.ok ? 'ok' : `no (${verdict.why})`}`);
        },
      }),
    };
    const supervisor = herdr.createHerdrSupervisor({
      socketPath: config.herdrSocket,
      roots: config.herdrRoots,
      yoloRoots: config.yoloRoots,
      sendEnabled: config.herdrSend,
      launchEnabled: config.herdrLaunch,
      // Bez tej flagi filtr wejściowy odrzuca panele Codexa.
      codexStatusEnabled: config.codexStatusEnabled,
      // `0` = etykiety tabów zostają z zakładania, bez synchronizacji z kartą i bez migracji.
      tabLabels: config.herdrTabLabels,
      maxPanes: config.maxPanes,
      dataDir: config.dataDir,
      logger: (message: string) => { log.info(message); },
    }, {
      // Ten sam zapisywacz co w driverach: odmowa „nie znam trybu" zostawia ekran w `refusals/`.
      dumpRefusal,
      // Sygnał nowej wersji: walidowany `ping` na ticku resyncu niesie wersję programu herdr (`version-watch.ts`).
      ...(versionWatch === null ? {} : {
        onVersion: (version: string) => { versionWatch.observe('herdr', version); },
      }),
      // The first sessions after the start go to `alive.json` at once (`bootstrap/alive-sessions.ts`).
      onAgentsChanged: aliveSessions.onAgentsChanged,
      /*
       * Fabryka dostaje `HerdrLaunchClient` zbudowany na TYM SAMYM gnieździe co reszta
       * integracji — dzięki temu nie powstaje drugie połączenie z własną bramką protokołu
       * (a przy dwóch bramkach `readOnly` mogłoby znaczyć co innego po każdej ze stron).
       */
      ...(createLauncher !== null ? {
        createLauncher: (seam: HerdrLauncherSeam) => createLauncher({
          // Rezerwacja, stempel własności, ekran i log przychodzą OD nadzorcy: to on jest
          // właścicielem tożsamości agentów i on nadaje `key`. Launcher tylko tworzy.
          ...seam,
          trust: trust.createTrustCheck({ logger: (message) => { log.info(message); } }),
          // Bez wyzerowania tych zmiennych panel wstaje z wyłączonym zapisem transkryptu
          // i cała warstwa treści Raroga znika PO CICHU.
          envClear: config.claudeEnvClear,
        }),
      } : {}),
      createDriver: (ctx) => driverModule.createHerdrDriver(ctx.handle, {
        client: ctx.client,
        // Limit okna kontekstu TYLKO wtedy, gdy Rarog sam podał `--model`. Brak pola
        // = stan `unknown`: liczba tokenów bez paska i bez procentu, zamiast procentu
        // policzonego z domysłu o wariancie modelu.
        ...(ctx.knownContextLimit === undefined
          ? {}
          : { knownContextLimit: ctx.knownContextLimit }),
        // Identyfikator sesji Raroga jest DETERMINISTYCZNY z klucza agenta, więc driver zna
        // go bez pytania managera — dziennik wysyłek ma się dać zestawić z listą sesji.
        sessionId: herdr.sessionIdFor(ctx.handle.agent.key),
        /*
         * Adapter dziennika: driver opisuje wpis polem opcjonalnym (`sessionId?`), a dziennik
         * wymaga go zawsze. Tłumaczenie stoi TUTAJ, w miejscu zszycia dwóch modułów, zamiast
         * rozluźniać kontrakt po którejkolwiek stronie — pusty `sessionId` w pliku audytu
         * byłby wpisem, którego nie da się z niczym powiązać.
         */
        audit: {
          log: (entry) => {
            ctx.audit.log({
              ...entry,
              sessionId: entry.sessionId ?? herdr.sessionIdFor(ctx.handle.agent.key),
            });
          },
        },
        // Uploadów driver NIE dostaje świadomie: zdjęcia zapisuje manager PRZED przejściem
        // stanu (6.7), a drugi zapis tych samych plików byłby cichym duplikatem na dysku.
        // Guard zostaje jako druga linia obrony — sanityzacja jest idempotentna. Katalog komend dostaje
        // tylko na wysyłkę bez klasyfikacji managera; zwykle migawka przychodzi w `SendOptions`.
        guard: herdr.assertSendable,
        commandCatalog: (cwd: string) => commandCatalogs.get(cwd, null),
        snippet: herdr.snippet,
        yoloRoots: ctx.yoloRoots,
        now: () => Date.now(),
        // Wysyłka w trakcie tury: linia przy wiadomości, która czeka, i przy Enterze po progu.
        logger: (message: string) => { log.info(message); },
        promptStore,
        markSent: () => { ctx.markSent(); },
        // Pętla zmiany trybu czyta stopkę PRZEZ nadzorcę — bez tego jego wpis stoi 15 s.
        refreshMode: () => ctx.refreshMode(),
        // Dialog zaufania katalogu re-eksekuuje `claude`, a nadzorca musi wiedzieć, że
        // zniknięcie agenta w tym oknie znaczy „wstaje", a nie „zniknął".
        markTrustDialog: () => { ctx.markTrustDialog(); },
        // Zrzuty hooka `PreToolUse` (warstwa 1 uniwersalnej karty): hook pisze, driver czyta
        // — oba przez ten sam `dataDir`. Bez zainstalowanego hooka plików po prostu nie ma
        // i karta powstaje z ekranu (warstwa 2).
        readPendingHook: (engineSessionId) => pendingHook
          .readPendingHook(config.dataDir, engineSessionId, () => Date.now()),
        clearPendingHook: (engineSessionId, answerKey) => {
          pendingHook.clearPendingHook(config.dataDir, engineSessionId, answerKey);
        },
        // Kanał ODPOWIEDZI na pytania: plik zamiast cyfry, gdy hook czeka.
        hookAnswers,
        // Kanał cienia idzie za trybem EFEKTYWNYM (`consentMode`): plik cienia przed klawiszem wyłącznie przy `shadow`,
        // także przy konfiguracji `main` albo `all` zdegradowanej do `shadow`; przy `off`, `main` i `all` driver go
        // nie używa.
        ...(shadow === null ? {} : { shadow }),
        // Tryb efektywny przy każdym kroku: przy `main` i `all` zgoda na narzędzie nie idzie cyfrą
        // (`consentDigitBlocked`).
        consentMode: () => consentMode.current().effective,
        // Kanał zgód przy `main` i `all`: karty kanału ze zrzutów per wywołanie i „jedna karta na dialog”.
        // Przy `all` obserwacja dostaje też fakty plików subagentów (dowód z wierzchu prośby subagenta).
        consentObserve: (request) => {
          const all = consentSubagentsOpen(consentMode.current().effective);
          return observeConsent(
            consentLink, config.dataDir, consentLiveness, request, all ? consentSubagents : null,
            all ? consentHidden : null, consentProofGate, (line) => { log.error(line); },
          );
        },
        // Status rejestru bez `waiting: permission` przyjęty przez driver zdejmuje od razu dowód z kanału z odczytów
        // nie późniejszych, także gdy obserwacja z takim odczytem jeszcze trwa.
        consentRegistryNotWaiting: (engineSessionId, at) => {
          const cycle = consentLink.cycle;
          if (cycle === null) return;
          void consentStep('registry not waiting', (line) => { log.error(line); }, () => (
            cycle.noteRegistryNotWaiting(engineSessionId, at)));
        },
        // Przy `all` i czekającej prośbie subagenta obserwacja co najwyżej co sekundę, każda z własnym odczytem
        // rejestru tym samym czytnikiem co szybki tik managera (5.6); bez szybkiego tiku
        // (`RAROG_CLI_WAITING=0`) rejestru nie czyta też obserwacja.
        consentSubagentPending: (engineSessionId) => consentLink.cycle?.subagentPending(engineSessionId) === true,
        ...(cliVersionReader === null || !config.cliWaiting ? {} : {
          consentRegistryRead: async (engineSessionId: string) =>
            cliWaitingOf((await cliVersionReader({ registryOnly: true })).registry, engineSessionId),
        }),
        consentCardLive: (engineSessionId) => consentCardLive(consentLink, engineSessionId),
        // The reason of a consent card without the approve button: what the desk release of its call key kept.
        consentDeskRelease: (engineSessionId, key) => consentLink.cycle?.deskRelease(engineSessionId, key) ?? null,
        // Karta zgody z ekranu albo jsonl czeka na kartę kanału, póki rejestracja hooka sesji nie ma karty (z sufitem).
        consentCardAwaited: (engineSessionId) => consentCardAwaitedAt(consentLink, engineSessionId),
        // The measured "Yes" digit waits for no registration without a card, a subagent's too, of any age.
        consentRegistrationWaits: (engineSessionId) => registrationWithoutCard(consentLink, engineSessionId),
        // Zrzut diagnostyczny odmowy (`docs/dialogs.md`, „Refusal diagnostics”): wyłącznik siedzi w fabryce, więc driver ma
        // JEDNĄ ścieżkę odmowy i nie musi wiedzieć, czy diagnostyka jest włączona.
        dumpRefusal,
        // `RAROG_AGENT_FILES=0` = driver nie zakłada czytnika plików subagentów.
        readAgentFiles: config.agentFiles,
        // `RAROG_PROMPT_BLOCK=0` = follower pomija wpis promptu zablokowanego przez hook (`docs/dialogs.md`).
        promptBlock: config.promptBlock,
        // `RAROG_DIALOG_LAYER2`: flaga czytana raz przy starcie, do decyzji dociera tym polem (`docs/dialogs.md`).
        dialogLayer2: config.dialogLayer2,
      }),
    });
    // Restored messages of a pane that does not attach after the first resync (and a grace) are not sent.
    promptStore.expireUnclaimedAfter(supervisor.ready);
    return {
      supervisor,
      probe: () => supervisor.ping(),
      // Miniatury zdjęć z `.rarog-uploads/`: jedyna droga odczytu tego katalogu.
      readUpload: uploadsModule.readUploadWithinRoots(uploads, config.herdrRoots),
      deps: {
        sessionIdFor: herdr.sessionIdFor,
        /*
         * Znacznik „widziane z telefonu" mieszka w `herdr-hidden.json` — jeden atomowy
         * pisarz na cały trwały stan integracji. Nazwa pliku i magazynu
         * (`supervisor.hidden`) nie mówi o treści: plik niesie aliasy i `seen`.
         */
        seen: {
          seq: (key, agentSessionId) => supervisor.hidden.seenSeq(key, agentSessionId),
          mark: (key, agentSessionId, stateChangeSeq, by) => {
            void supervisor.hidden.markSeen(key, agentSessionId, stateChangeSeq, by);
          },
          seenBy: (key, agentSessionId) => supervisor.hidden.seenBy(key, agentSessionId),
          unseenSeq: (key, agentSessionId) => supervisor.hidden.unseenSeq(key, agentSessionId),
          markUnseen: (key, agentSessionId, stateChangeSeq) => {
            void supervisor.hidden.markUnseen(key, agentSessionId, stateChangeSeq);
          },
        },
        aliasFor: (engineSessionId) => supervisor.hidden.aliasFor(engineSessionId),
        rememberAlias: (engineSessionId, sessionId) => {
          void supervisor.hidden.rememberAlias(engineSessionId, sessionId);
        },
        assertSendable: herdr.assertSendable,
        commandCatalog: (cwd, cliVersion) => commandCatalogs.get(cwd, cliVersion),
        /*
         * Walidacja `resumeFrom` po TREŚCI transkryptu (`docs/security-model.md`, „`resumeFrom` is validated…”), nie po samym regeksie uuida.
         *
         * `--resume <uuid z innego katalogu>` DZIAŁA, a jsonl dopisuje się do oryginalnego
         * sluga — bez tego jedno pole w POST ładowałoby na telefon całą historię sesji spoza
         * korzeni i dopisywało do niej dalej. Brak tej zależności jest fail-closed: manager
         * odmawia wznowienia (400), zamiast wznawiać w ciemno.
         */
        resumeSource: {
          locate: (root, cwd, engineSessionId) => (
            transcriptPath.locateTranscript(root, cwd, engineSessionId)
          ),
          /*
           * Odczyt pliku w try/catch: transkrypt mógł zniknąć MIĘDZY `locate` a `cwdOf`
           * (posprzątany katalog, cofnięte uprawnienia). Bez tego `ENOENT`/`EACCES` szedł
           * przez managera i router jako 500 „błąd serwera" — mylnie, bo to nie awaria
           * Raroga, tylko nieistniejące wejście; 400 mówi to samo, ale prawdę.
           */
          cwdOf: async (file) => {
            let lines: string[];
            try {
              lines = await readTranscriptTail(file);
            } catch {
              throw new BadRequestError(RESUME_UNREADABLE_MESSAGE);
            }
            return jsonlPending.cwdFrom(lines);
          },
          // Effort i tryb wznowienia. Manager woła to dopiero po bramkach katalogu; błąd
          // odczytu to 400 jak przy `cwdOf` — bez odczytu nie wiadomo, czy potrzebna flaga trybu.
          settingsOf: async (file) => {
            let lines: string[];
            try {
              lines = await readTranscriptTail(file);
            } catch {
              throw new BadRequestError(RESUME_UNREADABLE_MESSAGE);
            }
            return jsonlPending.resumeSettingsFrom(lines);
          },
        },
        takeSendSlot: (key, opts) => supervisor.takeSendSlot(key, opts),
        writeUploads: (cwd: string, images: readonly string[]) => uploads.write(cwd, images),
        writeUploadFiles: (cwd: string, files: readonly FileAttachment[]) => (
          uploads.writeFiles(cwd, files)
        ),
        sweepUploads: (roots: readonly string[]) => uploads.sweepAll(roots),
      },
      // The paste queue file stays as it is for the next start: the store closes before the drivers go.
      dispose: () => { promptStore.close(); supervisor.dispose(); },
    };
  } catch (err: unknown) {
    log.error(
      `herdr integration unavailable (${redact(err)}); Rarog shows no sessions.`,
    );
    return null;
  }
}

async function main(): Promise<void> {
  const log = consoleLogger;
  const config = loadConfig();
  assertLoopbackHost(config.host);
  for (const entry of config.originsSkipped ?? []) log.info(skippedOriginLine(entry));

  /*
   * Tryb recenzji demo: diagnostyka z telefonów recenzentów z poprzedniego startu (`client.log`
   * i `client.log.1`) znika, zanim serwer przyjmie pierwsze żądanie. Błąd inny niż brak pliku kończy start kodem 1:
   * w katalogu, w którym serwer nie skasuje własnego pliku, nie zapisze też parowania. Zwykłe demo i serwer: no-op.
   */
  try {
    const cleared = await clearReviewClientLogs(config);
    if (cleared.length > 0) log.info(`review demo: deleted ${cleared.join(', ')} at start`);
  } catch (err: unknown) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  /*
   * Nasłuch iroh PRZED wszystkim innym i przed `listen`: EndpointId zna router od pierwszego
   * żądania (bez okna z `iroh: null`), a porażka (brak klucza, brak modułu natywnego albo paczki platformy, zajęty
   * port UDP) kończy start kodem 1, zanim serwer zacznie udawać zdrowego. Pętla przyjmowania rusza w `listening`
   * (`iroh/listener.ts`), więc żaden strumień nie trafi do serwera bez handlera. Bez flagi moduł natywny się nie ładuje.
   */
  const server = http.createServer();
  const iroh = await startServerIroh(config, server, log);

  // Hook files in the data directory, before anything reads them: roots, start cleanup, log rotation.
  prepareHookFiles(config, log);

  // Git under `sandbox-exec` on macOS (layer 2): one probe before the first read, one log line without it.
  if (!config.demo) await probeGitSandboxAtStart(gitReadEnv(config.gitEnvBase), (line) => { log.info(line); });

  const serverStartId = randomUUID();
  const startedAtMs = Date.now();

  // Klucze urządzeń, parowanie i dławik porażek: przed terminalem i routerem (`bootstrap/devices.ts`).
  const { loginLimiter, devices, pairing } = createDeviceAuth(config, log);

  /*
   * Kanał cienia (`docs/dialogs.md`, „Server in shadow mode”). Domknięcie rekordów `decisions/` po poprzednim
   * procesie i sprzątanie plików trybu cienia (`shadow/sweep.ts`) biegną w KAŻDYM trybie: plik cienia, którego
   * nikt już nie obserwuje, dostaje `.revoked`, resztki i sieroty po martwych hookach znikają. Driver używa kanału
   * wyłącznie przy efektywnym `shadow`; przy `off` i `main` nie czyta zrzutów per wywołanie i nie pisze plików
   * cienia. Demo nie ma hooka.
   */
  const shadowChannel = config.demo ? null : createShadowChannel({
    dataDir: config.dataDir, bootId: serverStartId, log: (line) => { log.info(line); },
  });
  if (shadowChannel !== null) {
    void (async () => {
      const closed = await shadowChannel.recover();
      if (closed > 0) log.info(`shadow: closed ${String(closed)} decisions/ records left by the previous start`);
      // Sprzątanie PO domknięciu: rekord `sent` sprzed restartu ma najpierw zobaczyć swój plik cienia.
      const swept = await sweepShadowFiles(config.dataDir);
      const total = swept.shadowFiles + swept.callDumps + swept.decisions;
      if (total > 0) {
        log.info(`shadow: start cleanup — shadow/ ${String(swept.shadowFiles)}, pending/<session>/`
          + ` ${String(swept.callDumps)}, decisions/ ${String(swept.decisions)}`);
      }
      // Znaczniki prośby kanału zgód: retencja 7 dni, w każdym trybie (serwer bez kanału ich nie kasuje).
      const markers = sweepMarkerFiles(config.dataDir);
      if (markers > 0) log.info(`consent: start cleanup — markers/ ${String(markers)}`);
    })();
  }
  /*
   * Zestaw treści demo w języku `RAROG_DEMO_LANG`: wybrany RAZ i podany atrapie nadzorcy, managerowi
   * i notatkom. Import dynamiczny tylko w demo: proces produkcyjny treści demo nie wczytuje.
   *
   * Tryb recenzji (`RAROG_DEMO_REVIEW_CODE`) bierze z zestawu stałe zamiast odczytów hosta: nazwę serwera
   * w odpowiedzi parowania zamiast `hostname()`, model i effort nowej sesji zamiast `~/.claude/settings.json`. Nie
   * składa też sondy hooka, czytnika tailnetu (`tailscale status`), atrapy dyktowania ani sterowania testów UI (niżej).
   * The plain demo reads no host data either: the tailnet comes from the content set and the server name from
   * `demo/mac.ts` (`demoHost`, `bootstrap/http.ts`).
   * `RAROG_DEMO_CONTENT` picks a named set instead of the language set (plain English demo only), loaded from the set
   * directory of the install (`demo/content/named-set.ts`).
   */
  const demoContent = config.demo
    ? await (await import('./demo/content/index.ts')).demoContent(config.demoLang, config.demoSet) : null;
  const reviewConstants = config.demoReview === null ? null : demoContent?.review ?? null;
  const demoHost = demoContent === null ? null
    : { tailnet: demoContent.tailnet, serverName: (await import('./demo/mac.ts')).DEMO_SERVER_NAME };
  /*
   * Tryb efektywny kanału zgód (`layer1/mode.ts`): przy konfiguracji `off` i `shadow` równy skonfigurowanemu od razu,
   * przy `main` i `all` — `off` (`starting`) do rozstrzygnięcia po starcie obu gniazd (niżej, po `listen`). Za nim idą
   * `alive.json`, zakres rejestru sekretów, `/health`, wyłącznik z gniazda administracyjnego i driver: kanał cienia
   * działa wyłącznie przy efektywnym `shadow`, a przy `main` i `all` zgoda na narzędzie nie idzie cyfrą. Dlatego
   * powstaje przed `loadHerdr`, a driver dostaje kanał cienia w każdym trybie i sam pyta o tryb przy każdym kroku.
   */
  const consentMode = createConsentMode({ configured: config.consentChannel, log: (line) => { log.info(line); } });
  const consentLink: ConsentLink = { cycle: null, registry: null };
  // Sygnał nowej wersji i jeden czytnik rejestru procesów CLI przed nadzorcą herdr (`bootstrap/versions.ts`).
  const { versionWatch, cliVersionReader, setVersionSink } = createVersionSignal(config, log);
  // Bramka wersji reguły dowodu zgody (`RAROG_CONSENT_PROOF`): wersja CLI sesji z odczytu rejestru, który niesie
  // obserwacja (ten sam odczyt co stan `waiting`). Rejestr nieznany (demo, błąd odczytu, kilka procesów) = `screen`.
  // The canary file in the data dir adds releases the canary passed (`layer1/version-gate.ts`).
  const consentProofGate = createConsentProofGate({
    configured: config.consentProof, log: (line) => { log.info(line); },
    canary: createConsentCanaryFile(config.dataDir),
  });
  // The supervisor's agent set signal for `alive.json`; the writer joins it below (`bootstrap/alive-sessions.ts`).
  const aliveSessions = createAliveSessionsSignal();
  const herdr = await loadHerdr(
    config, log, shadowChannel, demoContent, consentMode, consentLink, cliVersionReader, versionWatch,
    consentProofGate, aliveSessions,
  );
  if (config.demo) {
    log.info('herdr: demo mode, a supervisor mock instead of the socket (zero panes, zero processes)');
  } else {
    log.info(herdr === null
      ? `herdr: integration INACTIVE (socket ${config.herdrSocket}); Rarog shows a banner`
      : `herdr: listening on ${config.herdrSocket}, send=${String(config.herdrSend)},`
        + ` launch=${String(config.herdrLaunch)}`);
  }

  /*
   * `alive.json` trybu cienia (`docs/dialogs.md`, „Server in shadow mode”): co 10 s w KAŻDYM trybie
   * kanału, także `off` — hook czeka wyłącznie przy `mode: "shadow"`, więc przy `off` plik mówi mu „nie czekaj”.
   * Tryb w pliku to tryb EFEKTYWNY; jego zmiana zapisuje plik od razu (słuchacz niżej).
   * `bootId` to identyfikator tego startu procesu. Demo nie pisze: jego `dataDir` nie czyta żaden hook.
   */
  const aliveWriter = config.demo ? null : createAliveWriter({
    dataDir: config.dataDir,
    mode: () => consentMode.current().effective,
    send: () => config.herdrSend,
    bootId: serverStartId,
    sessions: () => herdr?.supervisor.observedEngineSessions?.() ?? [],
    // Serwer z kanałem zgód czyta znaczniki prośby: `markers: true` przy efektywnym `main` i `all`.
    markers: consentRegistrationWanted(config.consentChannel),
    // Restart grace (`RAROG_CONSENT_RESTART_GRACE`): `stop` and `phase` only for a server with the channel.
    graceMs: consentRegistrationWanted(config.consentChannel) ? config.consentRestartGraceMs : 0,
    killswitch: () => consentMode.current().reason === 'killswitch',
    channelStarting: () => consentMode.current().reason === 'starting',
    log: (line) => { log.info(line); },
  });
  aliveWriter?.start();
  aliveSessions.connect(aliveWriter);
  if (!config.demo) log.info(`shadow: hook consent channel ${config.consentChannel}`);
  if (!config.demo) log.info(`dialogs: layer 2 ${DIALOG_LAYER2_ENV}=${config.dialogLayer2 ? '1' : '0'}`);

  /*
   * Manager powstaje niżej, a cykl woła go od pierwszej karty (`onCard`), także w `recover` przed managerem: wtedy
   * referencja jest pusta i karta trafia do urządzeń przez snapshot sesji. Rejestracja przed managerem nie szturcha
   * nikogo (gniazdo rejestracji startuje i tak po managerze). Opis kolejności przy harmonogramie niżej.
   */
  let managerRef: ManagerApi | null = null;
  // Consent channel: the hook's secret registry and the cycle, only with configured `main` or `all`.
  const { consentRegistry, consentCycle } = createConsentChannel(config, {
    serverStartId, herdr, consentMode, consentLink, managerRef: () => managerRef, consentProofGate, log,
  });
  // Record recovery before the first tick, then the answer file tick and the registry sweep (`bootstrap/consent.ts`).
  const consentTimers = consentCycle !== null && consentRegistry !== null
    ? await startConsentCycle(config, { consentCycle, consentRegistry, consentLink, log })
    : null;
  // Effective mode change: the registry scope first, then `alive.json`.
  watchConsentMode(consentMode, { consentRegistry, consentCycle, aliveWriter, log });
  // Channel control from the admin socket (`rarog dialogs`); none in the demo.
  const consentAdmin = consentAdminControl(config, consentCycle, consentMode);

  /*
   * Obciążenie Maca — JEDEN próbnik na proces dla dwóch odbiorców: `GET /api/mac` (stopka listy
   * apki) i Live Activity. Stoi poza kanałem APNs, więc działa też przy `RAROG_PUSH=0`; zamyka go
   * `shutdown`. Demo nie próbkuje maszyny, na której akurat biegną testy — stała fikcja jak limity.
   */
  const macStats = config.demo ? (await import('./demo/mac.ts')).demoMacStats() : createMacStats();
  // Powiadomienia: obecność, kanał APNs i harmonogram banerów (`bootstrap/push.ts`). Manager powstaje niżej,
  // więc push czyta go przez `managerRef`; sygnał nowej wersji dostaje sink kanału APNs.
  const { presence, apns, notifier } = createPush(config, { managerRef: () => managerRef, devices, macStats, log });
  setVersionSink(apns?.sink);

  // SDK Claude listy „Ostatnie sesje” raz, przed `listen()`; demo go nie dotyka (`bootstrap/manager.ts`).
  const sdk = await loadSdk(config, log);
  // System maszyny w `/api/version` i w zdaniach managera z parą Mac/VPS (`.mac`/`.vps`): z `process.platform`;
  // demo to fikcyjny Mac na każdej maszynie (`demo/mac.ts`).
  const system = config.demo ? (await import('./demo/mac.ts')).DEMO_SERVER_SYSTEM : serverSystem();

  // PR status (`bootstrap/pr-status.ts`): `gh` in real mode, a fixed map in the demo, nothing at `RAROG_PR_STATUS=0`.
  const prStatus = await createPrStatus(config, log, demoContent);

  const manager = await createManager({
    // Wszystko poza portami kanału zgód (`bootstrap/manager.ts`).
    ...managerConfig({
      config, demoContent, system, sdk, log, notifier, reviewConstants, cliVersionReader, herdr,
    }),
    // Karty kanału zgód: decyzje i zwolnienie tylko przy otwartym kanale (`main`, `all`), inaczej 410.
    ...(consentCycle === null ? {} : { consent: consentManagerPort(consentCycle, consentMode, log) }),
    ...(prStatus === null ? {} : { prStatus: prStatus.port }),
  });
  managerRef = manager;
  /*
   * Live Activity słucha strumienia GLOBALNEGO — tego samego, z którego lista klienta zna stan
   * każdej sesji. Każdy event to tylko „przelicz" (składane w 250 ms); czy coś wyjdzie do APNs,
   * rozstrzyga diff treści w sterowniku. Pierwsze przeliczenie po `ready` odświeża aktywności
   * zarejestrowane przed restartem serwera.
   */
  if (apns !== undefined) {
    manager.onEvent((scope) => { if (scope === 'global') apns.liveActivity.poke(); });
  }
  // Inbox cards from the manager's events and their removals in `inbox.json` (`bootstrap/inbox.ts`); none in the demo.
  const inbox = config.demo ? null : startInbox({
    manager, ready: manager.ready, dataDir: config.dataDir, promptBlock: config.promptBlock,
    log: (line) => { log.info(line); },
  });
  // Nadzorca podpięty, seedy demo założone — dopiero wtedy wpuszczamy ruch HTTP.
  await manager.ready;
  apns?.liveActivity.poke();

  // Notatki demo żyją w pamięci procesu (`demo/notes.ts`): ten sam magazyn liczy `notesCwds` i obsługuje trasę.
  const demoNotes = demoContent !== null && config.notesEnabled
    ? (await import('./demo/notes.ts')).createDemoNotes(demoContent)
    : undefined;
  const hub = createSseHub({
    config, manager, serverStartId, log, demoNotes,
    // The PR status reads GitHub only while a client is connected.
    ...(prStatus === null
      ? {}
      : { onClientCount: (count: number) => { prStatus.tracker.setClientConnected(count > 0); } }),
  });
  hub.start();

  /*
   * Terminal PTY — składany PRZED routerem, bo router musi znać jego obecność
   * (`termEnabled` w `/api/version`, 404 na `/api/term` bez ficzeru). `null` znaczy
   * „ficzeru nie ma" i jest jedynym stanem wyłączenia: killswitch `RAROG_TERM` albo awaria
   * złożenia modułu. Terminal NIE stoi poza herdr: powłoka mieszka w panelu, `loadTerm`
   * (`bootstrap/term.ts`) sam stawia gniazdo herdr, a `RAROG_HERDR_LAUNCH`/`RAROG_HERDR_SEND` odmawiają
   * otwarcia terminala.
   */
  const term = await loadTerm(config, log, { devices, limiter: loginLimiter });

  const companion = assembleCompanion({ config, manager, log: (line) => { log.info(line); } }); // off in demo

  // Skutki odpięcia urządzenia, pierwszy przebieg wygasania i przebieg co minutę (`bootstrap/devices.ts`).
  const deviceSweep = startDeviceSweep(devices, {
    pairing, hub, term: term ?? undefined, companion, apns, log: (line) => { log.info(line); },
  });

  // Sondy `/health` z `bootstrap/health.ts`; pole kanału zgód dokłada `main()`.
  const health: HealthProbes = {
    ...healthProbes({ config, herdr, term, reviewConstants, devices, sdk, home: homedir() }),
    // Tryb kanału zgód (`layer1/mode.ts`); demo kanału nie ma, więc pola nie niesie.
    ...(config.demo ? {} : { consent: () => consentMode.current() }),
  };

  // Serwer iroh w odpowiedziach (`/api/version`, `PairResponse.server`, kod z gniazda administracyjnego).
  const irohPair = iroh === null || config.iroh === null
    ? null
    : { endpointId: iroh.endpointId, relay: config.iroh.relay };
  // Demo nie czyta zrzutów paska statusu ani `~/.claude.json`: limity planu są stałą fikcją.
  const demoUsage = config.demo ? (await import('./demo/usage.ts')).demoUsageProvider() : undefined;
  // Ani klucza Soniox: dyktowanie demo wydaje klucz-atrapę, mikrofon i strumień gra apka. Tryb recenzji
  // atrapy nie dostaje: router składa prawdziwy minter, który bez klucza odpowiada 503 (`voiceEnabled: false`).
  const demoVoice = reviewConstants !== null ? undefined
    : config.demo ? (await import('./demo/voice.ts')).demoVoiceMinter() : undefined;

  // Router z czytnikiem tailnetu i tożsamością urządzeń (`bootstrap/http.ts`).
  const router = buildRouter({
    config, manager, hub, serverStartId, startedAtMs, log, health, system, macStats, demoUsage, demoVoice, demoNotes,
    readUpload: herdr?.readUpload, term, companion, notifier, presence, apns, loginLimiter, irohPair, devices, pairing,
    reviewConstants, demoHost,
  });
  // Sterowanie testów UI tylko w zwykłym demo: w trybie recenzji słuchacz `request` to sam router.
  const demoControl = config.demo && config.demoReview === null && herdr?.scenarioPanels !== undefined
    ? (await import('./demo/control.ts')).createDemoControl(router, config, manager, herdr.scenarioPanels, demoNotes && {
      store: demoNotes,
      // Zapis „z innego urządzenia" rozsyła ten sam event co trasa `PUT /api/notes`.
      announce: (cwd, empty) => { hub.broadcast('global', null, { type: 'notes', cwd, empty }); },
    })
    : null;
  server.on('request', demoControl?.handler ?? router);

  /*
   * Upgrade WS obsługujemy sami: router HTTP zostaje nietknięty, a autoryzacja (klucz
   * urządzenia + Origin) dzieje się PRZED `handleUpgrade`. Bez ficzeru każdy upgrade jest zrywany —
   * `server.on('upgrade')` bez listenera odpowiadałby domyślnie, a tu ma być cisza.
   */
  server.on('upgrade', (req, socket, head) => {
    if (term === null) {
      socket.destroy();
      return;
    }
    term.handleUpgrade(req, socket, head);
  });

  // Timeouty dla strumieni SSE i obsługa błędu `listen` (EADDRINUSE = kod 1), `bootstrap/http.ts`.
  configureHttpServer(server, config, log);

  /*
   * Gniazdo administracyjne i gniazdo rejestracji kanału zgód — PO udanym `listen` portu: przy EADDRINUSE
   * proces kończy się wyżej, zanim dotknie gniazd żywego poprzednika. Brak gniazda administracyjnego (za długa
   * ścieżka, cudze żywe gniazdo) nie jest błędem startu: serwer działa, tylko `rarog pair` i `rarog devices` nie mają
   * z kim rozmawiać. Brak gniazda rejestracji też nie: hook nie czeka.
   */
  let adminSocket: AdminSocket | null = null;
  let consentSocket: ConsentSocket | null = null;
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    log.info(
      `rarog ${config.version} listening on http://${config.host}:${port}`
      + ` (demo=${String(config.demo)}, protocol v${String(PROTOCOL_VERSION)},`
      + ` data in ${config.dataDir})`,
    );
    const adminStarted = startAdminSocket(config.dataDir, createAdminHandler({
      store: devices, pairing, publicUrl: publicUrlOf(config.originAllowList), log: (line) => { log.info(line); },
      iroh: irohPair,
      irohStatus: () => irohAdminStatus(iroh, config.iroh?.port ?? null),
      ...(consentAdmin === undefined ? {} : { consent: consentAdmin }),
    }), (line) => { log.info(line); }).then((socket) => {
      if (shuttingDown) void socket?.close();
      else adminSocket = socket;
      return shuttingDown ? null : socket;
    });
    const consentStarted = consentRegistry === null ? Promise.resolve(null)
      : startConsentRegistration(config, consentRegistry, consentCycle, log).then((socket) => {
        if (shuttingDown) void socket?.close();
        else consentSocket = socket;
        return shuttingDown ? null : socket;
      });
    /*
     * Rozstrzygnięcie trybu efektywnego RAZ, po starcie obu gniazd (oba starty nigdy nie rzucają): brak gniazda,
     * status hooka inny niż `ok` albo brak progu buildu apki = `shadow` z powodem, nigdy `main`.
     */
    void Promise.all([adminStarted, consentStarted]).then(([admin, consent]) => {
      if (shuttingDown) return;
      consentMode.resolve({
        hook: () => readHookHealth(health).status,
        consentSocket: consent !== null,
        adminSocket: admin !== null,
        minClientBuild: config.minClientBuild,
      });
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal}: closing the server`);
    // Najpierw przestajemy przyjmować nowe połączenia, potem zrywamy strumienie SSE
    // (bez tego `server.close()` czeka na nie w nieskończoność). Nasłuch iroh zamyka połączenia kodem 0
    // i `Endpoint.close()` z terminem 3 s; na niego czeka bezpiecznik niżej.
    server.close(() => { log.info('server closed'); });
    const irohClosed = iroh?.close() ?? Promise.resolve();
    demoControl?.dispose();
    hub.closeAll();
    prStatus?.tracker.close();
    // `server.close()` NIE dotyka gniazd po upgrade — bez tego proces wisiałby na żywym
    // WebSockecie terminala. Powłoki w panelach herdr zostają: giną wyłącznie kontrolery.
    term?.dispose();
    // Timery Live Activity i połączenia HTTP/2 do APNs — bez nich proces i tak wyjdzie (`unref`),
    // ale grzecznie. The channel closes in its own order (poller, the weekly-limit send in flight, passes, sender).
    const apnsClosed = apns?.close() ?? Promise.resolve();
    versionWatch?.dispose();
    macStats.close();
    clearInterval(deviceSweep);
    if (consentTimers !== null) {
      clearInterval(consentTimers.consentTick);
      clearInterval(consentTimers.consentSweep);
    }
    void adminSocket?.close();
    void consentSocket?.close();
    // Nadzorca należy do entry, nie do managera — i jego `dispose()` zamyka WYŁĄCZNIE
    // gniazdo Raroga. Do paneli nie idzie ani jeden bajt (żadnego `ctrl+c` przy SIGTERM).
    // `mode: "off"` before the supervisor closes: waiting hooks exit at their next poll (250 ms), or with G (`stop` in
    // the file) pause until the next server's channel (`docs/dialogs.md`, "Restart break").
    aliveWriter?.stop();
    inbox?.dispose();
    herdr?.dispose();
    // `dispose()` domyka drivery (bez dotykania cudzych procesów).
    const managerClosed = manager.dispose()
      .catch((err: unknown) => { log.error(`manager dispose: ${redact(err)}`); })
      .finally(() => { log.info('manager closed'); });
    // Bezpiecznik 2 s startuje dopiero po managerze, nasłuchu iroh, pytaniach agenta głosowego i kanale APNs razem
    // (`shutdown.ts`; `claude -p` zabity, jego katalog usunięty; kanał najwyżej 3 s): proces kończy się ≤ 5 s.
    void exitAfter([
      managerClosed, irohClosed, companion?.closeAll() ?? Promise.resolve(), apnsClosed, inbox?.flush() ?? Promise.resolve(),
    ]);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
  } else {
    console.error(`Could not start: ${redact(err)}`);
  }
  process.exit(1);
});
