import Foundation
import RarogTransport

// Przestrzenie danych per serwer w magazynie. Układ katalogów i kosz:
// `ServerSpaces`. Właściciel: parowanie.
//
// - Wskaźnik bieżącej przestrzeni (plik `servers/.current.json`, zapis atomowy) to JEDYNE źródło prawdy, czyje dane
//   apka czyta i pisze. Dysk czyta się RAZ, przy wpięciu; potem decyduje kopia w pamięci (`ServerRuntime.pointer`),
//   a każda zmiana idzie najpierw na dysk. Pliki poprzedniej przestrzeni idą do kosza dopiero PO zapisie wskaźnika,
//   więc proces zabity w dowolnej chwili, nieudany `rename` albo kasowanie nie zmieniają tego, co apka przeczyta.
// - Klucz innego serwera niż wskaźnik (inna `ServerIdentity`; dla klucza z adresem: inny `ServerOrigin`) =
//   NOWA przestrzeń; wskaźnik, którego dysk nie przyjął = żadna (dane tej sesji w pamięci, nic poprzedniego serwera
//   na ekranie). Bez klucza = przestrzeń ze wskaźnika (dane czekają na parowanie z tym serwerem, np. po odpięciu
//   z Maca) albo żadna. Wyjątek: ponowne parowanie serwera tylko przez iroh, które połączeniem iroh dowiodło
//   tego samego klucza serwera przy tym samym `serverId`, zostaje w przestrzeni wskaźnika pod nową tożsamością.
// - "Replace" (one server per app: a link to another server key, or another origin for a link without `k`): the new key
//   never opens the replaced pairing's space, also under the same origin. A fresh space goes on the pointer BEFORE the
//   key goes to the Keychain, and a Keychain refusal restores the previous pointer with its space.
// - Przejście z dowodem klucza przeżywa śmierć procesu i odmowę dysku: wskaźnik `{identity: stara, successor: nowa}`
//   PRZED zapisem klucza w Keychainie, potem wskaźnik `{identity: nowa}`. Klucz z tożsamością `identity` albo
//   `successor` otwiera tę samą przestrzeń; trafienie w `successor` kończy przejście, trafienie w `identity` je cofa
//   (klucz nie przeszedł). To samo uzgodnienie z bieżącym kluczem idzie przed każdym parowaniem. Dysk, który nie
//   przyjął zapowiedzi, daje parowanie bez przejścia (nowa przestrzeń); dysk, który nie przyjął końca, zostawia sesję w
//   tej samej przestrzeni, a koniec zapisze następny wybór. Odmowa Keychaina po zapowiedzi przywraca wskaźnik DOKŁADNIE
//   sprzed niej, także z poprzednim następcą, którego klucz Keychain dalej trzyma. Następca, którego dysk nie dał
//   skreślić ani zamienić, zostaje we wskaźniku, dopóki Keychain może trzymać jego klucz: parowanie przechodzi wtedy
//   tylko z dowodem z parowania i z nowym kluczem o tożsamości `identity` albo `successor`, każde inne kończy się
//   odmową, zanim cokolwiek trafi na dysk i do Keychaina. Zapowiedź nigdy nie zamienia jednego następcy na innego. W
//   sesji bez klucza parowanie najpierw skreśla następcę, gdy Keychain na pewno nie ma żadnego klucza (nie:
//   zablokowany, nieczytelny).
// - Parowanie zaczyna się dopiero po odczycie wskaźnika: start, który go nie dostał, daje jedną próbę przed żądaniem
//   do serwera, a dysk, który dalej nie oddaje pliku, kończy parowanie odmową bez żądania (uzgodnienie nie miałoby
//   czego uzgodnić, a wybór przestrzeni po parowaniu przeczytałby wskaźnik bez sprawdzenia dowodu).
// - Wejście w inną przestrzeń czyści stan w pamięci (`.dataWiped`, półka załączników), a preferencje zależne od serwera
//   (`NavigationPreferences.serverScoped`) zeruje znacznik ich przestrzeni (`preferencesSpaceKey`), sprawdzany przy
//   każdym wyborze — także po zabiciu procesu, zanim `UserDefaults` utrwaliło zerowanie. Interfejs buduje się od nowa
//   i czyta szkice z nowej przestrzeni. A space entered after the start also gets its queue back
//   (`restoreEnteredSpace`), because the start reads it once per store; a pairing logs in only after that read, with
//   the space's list cache (`switchEndpoint`).

extension RarogStore {
  /// Nazwa przestrzeni, do której należą preferencje `NavigationPreferences.serverScoped` (UTF-8; pusta = żadna; brak
  /// wpisu = właściciel nieznany, więc pierwszy wybór przestrzeni je zeruje).
  public nonisolated static let preferencesSpaceKey = "rarog.server.preferences-space"

  /// Katalog bieżącej przestrzeni: szkice pól (`ServerSpaces.drafts`) i notatek (`ServerSpaces.noteDrafts`) czyta
  /// z niego RarogUI. `nil` = bez przestrzeni (apka bez serwera albo magazyn bez `ServerSpaces`) — szkice w pamięci.
  public var dataSpaceDirectory: URL? {
    guard let spaces = serverRuntime.spaces, let space = serverRuntime.space else { return nil }
    return spaces.directory(space)
  }

  /// Pierwszy wybór przestrzeni (wpięcie albo pierwsze odblokowanie telefonu): katalogi przestrzeni i wskaźnik
  /// z dysku — przed pierwszą klatką interfejsu. Wskaźnik, którego dysk nie oddał, nie ustawia `spacesReady`:
  /// następny wybór czyta znowu.
  private func prepareSpaces(_ spaces: ServerSpaces) {
    if let problem = spaces.prepare() { reportUnhandled(problem) }
    do {
      serverRuntime.pointer = try spaces.readPointer()
    } catch {
      let error = error as NSError
      reportUnhandled("przestrzenie danych: wskaźnik nieczytelny (\(error.domain) \(error.code)) — sesja bez danych na dysku")
      return
    }
    serverRuntime.spacesReady = true
  }

  /// Przestrzeń dla punktu końcowego (wpięcie, parowanie, odpięcie, „Zapomnij serwer”, Keychain po odblokowaniu).
  /// Zwraca, czy przestrzeń się zmieniła (także z „żadnej” albo na „żadną”) — interfejs czytał szkice z poprzedniej
  /// i ma się zbudować od nowa.
  @discardableResult
  func selectSpace(for endpoint: ServerEndpoint) -> Bool {
    guard let spaces = serverRuntime.spaces else { return false }
    if !serverRuntime.spacesReady { prepareSpaces(spaces) }
    guard serverRuntime.spacesReady else { return enter(nil, endpoint, spaces) }
    var target = serverRuntime.pointer
    if let identity = endpoint.credential.flatMap({ ServerIdentity($0) }) {
      if let kept = settlePointer(with: identity, spaces) {
        target = kept
      } else {
        // Klucz innego serwera: nowa przestrzeń, zanim cokolwiek z dysku trafi na ekran.
        let fresh = spaces.newSpace(for: identity)
        if spaces.writePointer(fresh) {
          serverRuntime.pointer = fresh
          target = fresh
        } else {
          // Dysk dalej wskazuje poprzedni serwer: ta sesja bez danych na dysku, następny wybór spróbuje znowu.
          reportUnhandled("przestrzenie danych: wskaźnik nowego serwera nie zapisany — sesja bez danych na dysku")
          target = nil
        }
      }
    }
    alignPreferences(with: target)
    let changed = enter(target, endpoint, spaces)
    // Do kosza tylko to, czego nie wskazuje dysk: przestrzeń ze wskaźnika, którego dysk nie dał zastąpić, zostaje do
    // zapisu nowego wskaźnika.
    spaces.collectGarbage(keeping: target ?? serverRuntime.pointer)
    return changed
  }

  /// Przed żądaniem parowania: wskaźnik z dysku, gdy start go nie dostał (jedna próba odczytu). Bez wskaźnika
  /// uzgodnienie przed parowaniem nic nie widzi, a wybór przestrzeni po nim przeczytałby wskaźnik, który mógłby dać
  /// przestrzeń następcy kluczowi bez dowodu. `false` = dysk dalej nie oddaje pliku: parowanie się nie zaczyna.
  func readPointerBeforePairing() -> Bool {
    guard let spaces = serverRuntime.spaces else { return true }
    if !serverRuntime.spacesReady { prepareSpaces(spaces) }
    return serverRuntime.spacesReady
  }

  /// PIERWSZY krok przejścia z dowodem klucza, czyli ponownego parowania, które zostaje w przestrzeni wskaźnika pod
  /// nową tożsamością `successor`: wskaźnik `{identity: stara, successor: nowa}` na dysku, ZANIM Keychain dostanie nowy
  /// klucz. Proces zabity po zapisie klucza zostawia wskaźnik, który nowy klucz dalej otwiera (``selectSpace(for:)``).
  /// `false` = dysk nie przyjął zapowiedzi (albo nie ma wskaźnika): parowanie bez przejścia, czyli nowa przestrzeń jak
  /// przy linku z samym `u`. Przy wskaźniku z innym następcą parowanie tu nie dochodzi (odmowa przy wiszącym następcy w
  /// `confirmPairing`).
  func announceSuccessor(_ successor: ServerIdentity) -> Bool {
    guard let spaces = serverRuntime.spaces, serverRuntime.spacesReady, let pointer = serverRuntime.pointer else {
      return false
    }
    // Ten sam następca już stoi we wskaźniku (dysk nie dał skończyć poprzedniego przejścia): zapowiedź jest na dysku.
    if pointer.successor == successor { return true }
    let announced = ServerSpace(identity: pointer.identity, name: pointer.name, successor: successor)
    guard spaces.writePointer(announced) else {
      reportUnhandled("data spaces: pointer with the successor identity not saved — pairing continues in a new space")
      return false
    }
    serverRuntime.pointer = announced
    return true
  }

  /// Początek parowania, zanim parowanie zapowie następcę albo zapisze klucz: wskaźnik uzgodniony z bieżącym kluczem
  /// tak jak przy wyborze przestrzeni (``selectSpace(for:)``), a w sesji bez klucza z Keychainem
  /// (``withdrawSuccessorWithoutKey()``). Zwraca następcę, który po tej próbie dalej stoi we wskaźniku (dysk odmówił
  /// zapisu, bieżący klucz nie należy do przejścia albo Keychain może trzymać klucz następcy): parowanie nie może go
  /// zastąpić, więc przechodzi tylko z dowodem z parowania i z nowym kluczem, który ten wskaźnik już dopuszcza.
  func settlePointer(for endpoint: ServerEndpoint) -> ServerIdentity? {
    if let spaces = serverRuntime.spaces, serverRuntime.spacesReady {
      if let credential = endpoint.credential {
        if let identity = ServerIdentity(credential) { _ = settlePointer(with: identity, spaces) }
      } else if serverRuntime.pointer?.successor != nil {
        withdrawSuccessorWithoutKey()
      }
    }
    return serverRuntime.pointer?.successor
  }

  /// Wiszący następca w sesji bez klucza (np. odpięcie z Maca po przejściu z dowodem klucza, którego koniec dysk
  /// odrzucił): bez skreślenia każde parowanie kończyłoby się odmową, bo dowodu klucza serwera nie ma czym porównać.
  /// Skreśla go tylko Keychain, który na pewno nie ma klucza (`.none`): wtedy żaden klucz nie otworzy przestrzeni
  /// następcy. Keychain zablokowany, nieczytelny albo z kluczem, którego sesja nie używa, może trzymać klucz następcy,
  /// więc wskaźnik zostaje (kolejka i szkice nie idą do kosza), a parowanie kończy się odmową. Start bez klucza
  /// następcy nie skreśla: dane czekają na parowanie z tym serwerem, a start nie wie, czy użytkownik w ogóle się
  /// sparuje.
  private func withdrawSuccessorWithoutKey() {
    guard let keychain = serverRuntime.connector?.keychain else { return }
    let reason: String
    switch keychain.load() {
    case .none:
      _ = withdrawSuccessor()
      return
    case .locked: reason = "the Keychain is locked"
    case let .failed(status): reason = "the Keychain read failed (OSStatus \(status))"
    case .found: reason = "the Keychain holds a device key the session does not use"
    }
    reportUnhandled("data spaces: successor kept without a device key in the session — \(reason)")
  }

  /// What ``emptySpaceForReplacement(_:)`` did with the pointer.
  enum ReplacementSpace {
    /// The new key opens another space anyway (another identity), or there is no pointer: nothing to empty.
    case untouched
    /// The pointer names a fresh space for the new key; a Keychain refusal restores the previous pointer.
    case emptied
    /// The disk refused the fresh pointer: pairing stops before the Keychain.
    case refused
  }

  /// One server per app: after "Replace" and BEFORE the new key goes to the Keychain: when the new key would open the
  /// pointer's space (the same origin, or the same iroh key reported by the reply), the pointer gets a fresh space for
  /// it, the way another server gets one. So neither this session nor a process killed right after the Keychain
  /// write gives the new server the queue and drafts of the replaced pairing. The replaced space goes to the trash at
  /// the next choice of space, as any space no pointer names. A disk that refuses the fresh pointer stops the pairing
  /// (the new key would open the replaced space).
  func emptySpaceForReplacement(_ credential: DeviceCredential) -> ReplacementSpace {
    guard let spaces = serverRuntime.spaces, serverRuntime.spacesReady, let pointer = serverRuntime.pointer,
      let identity = ServerIdentity(credential), identity == pointer.identity || identity == pointer.successor
    else { return .untouched }
    let fresh = spaces.newSpace(for: identity)
    guard spaces.writePointer(fresh) else {
      reportUnhandled("data spaces: pointer of a fresh space for the replacing server not saved — pairing refused")
      return .refused
    }
    serverRuntime.pointer = fresh
    return .emptied
  }

  /// Odmowa Keychaina po zapowiedzi następcy: wskaźnik DOKŁADNIE sprzed zapowiedzi. Wskaźnik bez następcy byłby błędem,
  /// gdy poprzedni następca został (dysk nie dał skończyć przejścia), bo jego klucz Keychain dalej trzyma: następny
  /// start dałby nową przestrzeń, a kolejkę i szkice do kosza. Dysk, który odmówi, zostawia zapowiedź na dysku
  /// i w pamięci.
  func restorePointer(_ previous: ServerSpace) {
    guard let spaces = serverRuntime.spaces, serverRuntime.pointer != previous else { return }
    guard spaces.writePointer(previous) else {
      reportUnhandled("data spaces: pointer from before the successor announcement not restored after the Keychain refusal")
      return
    }
    serverRuntime.pointer = previous
  }

  /// Wskaźnik uzgodniony z kluczem o tożsamości `identity`: klucz z tożsamością wskaźnika cofa zapowiedź następcy,
  /// klucz następcy kończy przejście. Zwraca przestrzeń wskaźnika, którą ten klucz otwiera (wskaźnik w pamięci po
  /// próbie zapisu), albo `nil` dla klucza innego serwera (wskaźnik bez zmian).
  private func settlePointer(with identity: ServerIdentity, _ spaces: ServerSpaces) -> ServerSpace? {
    guard let pointer = serverRuntime.pointer else { return nil }
    if pointer.identity == identity {
      // Zapowiedź następcy bez jego klucza w Keychainie (zapis klucza odrzucony albo proces zabity przed nim)
      // przepada: następca dostanie przestrzeń tylko nowym dowodem z parowania.
      return pointer.successor == nil ? pointer : withdrawSuccessor()
    }
    guard pointer.successor == identity else { return nil }
    // Ten sam serwer pod nową tożsamością: ta sama nazwa katalogu, kolejka i szkice na miejscu.
    let moved = ServerSpace(identity: identity, name: pointer.name)
    guard spaces.writePointer(moved) else {
      // Dysk dalej wskazuje starą tożsamość z następcą: ta sesja zostaje w tej przestrzeni, następny wybór zapisze
      // koniec przejścia.
      reportUnhandled("data spaces: pointer with the new server identity not saved — session stays in the same space")
      return pointer
    }
    serverRuntime.pointer = moved
    return moved
  }

  /// Cofnięcie zapowiedzi następcy przy kluczu z tożsamością wskaźnika (klucz następcy nie przeszedł) albo w sesji bez
  /// klucza przy pustym Keychainie: wskaźnik bez `successor`, ta sama przestrzeń. Dysk, który odmówi, zostawia
  /// zapowiedź do następnego uzgodnienia. Zwraca wskaźnik w pamięci po próbie.
  private func withdrawSuccessor() -> ServerSpace? {
    guard let spaces = serverRuntime.spaces, let pointer = serverRuntime.pointer, pointer.successor != nil else {
      return serverRuntime.pointer
    }
    if spaces.writePointer(pointer.settled) {
      serverRuntime.pointer = pointer.settled
    } else {
      reportUnhandled("data spaces: pointer without the successor identity not saved — the successor stays in the pointer")
    }
    return serverRuntime.pointer
  }

  /// Stan w pamięci, kolejka i pamięć podręczna listy na przestrzeń `target` (`nil` = żadna: kolejka w koszu, bez
  /// pamięci podręcznej). Zwraca, czy zmienił się właściciel danych w pamięci (interfejs od nowa).
  private func enter(_ target: ServerSpace?, _ endpoint: ServerEndpoint, _ spaces: ServerSpaces) -> Bool {
    // Czyje dane trzyma pamięć: przestrzeni, a w sesji bez przestrzeni z kluczem — serwera z klucza. Inny właściciel
    // = stan w pamięci poprzedniego do kosza, także gdy poprzedni nie miał przestrzeni na dysku.
    let holder = target?.name ?? endpoint.credential.flatMap { ServerIdentity($0) }.map { "bez przestrzeni: \($0)" }
    // Ten sam właściciel (np. ponowne parowanie z tym samym serwerem): ta sama kolejka — także w sesji bez
    // przestrzeni, gdzie nowy katalog roboczy odciąłby wpisy kolejki od plików ich załączników.
    guard holder != serverRuntime.holder else { return false }
    // Z „niczyich” danych (start, apka bez serwera) nie ma czego zapominać: cel z pusha sprzed parowania zostaje.
    if serverRuntime.holder != nil {
      // Stan w pamięci należał do poprzedniego właściciela; jego pliki zostają w jego przestrzeni (nikt ich nie czyta).
      serverRuntime.spaceChanges += 1
      dispatch(.pairing(.dataWiped))
      serverRuntime.connector?.wipeAppData()
    }
    serverRuntime.holder = holder
    serverRuntime.space = target
    let directory = target.map(spaces.directory)
    persistence = OutboxPersistence(directory: directory?.appending(path: ServerSpaces.outbox) ?? spaces.scratch())
    listCacheDisk.cache = directory.map { SnapshotCache(directory: $0.appending(path: ServerSpaces.list)) }
    if target != nil { restoreEnteredSpace() }
    return true
  }

  /// A space entered after the start (pairing, unpairing): its queue comes back the way the start reads it, because
  /// the start takes effect once per store and the memory holds another owner's data (or none). Before the start
  /// (attaching, the Keychain after the first unlock) the start reads it itself. The read belongs to the space entered
  /// here: a later entry swaps `persistence`, and the result goes to the bin. A login waits for this read
  /// (`serverRuntime.spaceRestore`) and reads the list cache after it (`switchEndpoint`).
  private func restoreEnteredSpace() {
    guard started else { return }
    let persistence = persistence
    serverRuntime.spaceRestore = Task { [weak self] in
      guard let self, self.persistence === persistence else { return }
      await self.restoreOutbox()
    }
  }

  /// „Zapomnij serwer”, PIERWSZY krok: dane tego serwera unieważnione na dysku, zanim cokolwiek (także własne
  /// `device-revoked`) skasuje klucz — proces zabity w dowolnej chwili nie zostawi ich do odczytu, a ponowne parowanie
  /// z nim dostaje nową, pustą przestrzeń. Stan w pamięci i katalogi sprząta `selectSpace` przy `install(.none)`.
  /// `false` = dysk nie dał ich unieważnić: „Zapomnij” nie idzie dalej, klucz i dane zostają.
  func dropSpace() -> Bool {
    guard let spaces = serverRuntime.spaces else { return true }
    if !spaces.writePointer(nil) {
      // Plik wskaźnika został: przestrzenie do kosza od razu, żeby po restarcie nie było czego czytać.
      guard spaces.discardAll() else {
        reportUnhandled("przestrzenie danych: ani wskaźnik, ani przestrzeń nie do skasowania — „Zapomnij” przerwane")
        return false
      }
      reportUnhandled("przestrzenie danych: wskaźnik nie skasowany — przestrzenie w koszu")
    }
    serverRuntime.pointer = nil
    alignPreferences(with: nil)
    return true
  }

  /// Preferencje zależne od serwera należą do jednej przestrzeni (znacznik `preferencesSpaceKey`). Inna przestrzeń =
  /// zerowanie, potem znacznik.
  private func alignPreferences(with space: ServerSpace?) {
    guard let preferences = serverPreferences else { return }
    let owner = preferences.data(forKey: Self.preferencesSpaceKey).map { String(decoding: $0, as: UTF8.self) }
    let name = space?.name ?? ""
    guard owner != name else { return }
    for key in NavigationPreferences.serverScoped { preferences.set(nil, forKey: key) }
    preferences.set(Data(name.utf8), forKey: Self.preferencesSpaceKey)
  }
}
