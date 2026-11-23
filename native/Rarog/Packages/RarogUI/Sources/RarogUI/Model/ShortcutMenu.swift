import Foundation
import RarogContract
import RarogCore

// Keyboard shortcuts as data: what the command menu (the iPadOS menu bar) shows and
// what a press does. The menu view (`RarogCommands`) only draws it; the shortcut sheet under a held Cmd lists
// its rows from `ShortcutSheetContent`. Owner: shortcuts.

public enum RarogShortcut: Sendable, Equatable {
  /// Cmd+1…8 (pozycja w pasku) i Cmd+9 (ostatnia zakładka): zakładka (sesja albo terminal), którą cyfra
  /// wskazywała w chwili rysowania menu — nie numer liczony od nowa przy naciśnięciu.
  case tab(ProjectTabRef)
  case previousProject
  case newSession
  /// Cmd+Shift+N: kolejny terminal projektu.
  case newTerminal
  /// Cmd+F (`popup`, goła powłoka) i Cmd+G (`lazygit`): okno nad ekranem.
  case popup(TerminalRole)
  case toggleList
  /// Cmd+I: prawy panel sesji na iPadzie.
  case toggleInspector
  /// Cmd+J: notatka projektu — otwiera formularz, nad formularzem notatki zamyka go z zapisem.
  case note
  /// Shift+Cmd+U: przeczytane ↔ nieprzeczytane wyniku sesji zaznaczonej na liście, jak w Mailu.
  case toggleRead
}

/// Cmd+X na ekranie sesji. Zaznaczenie w polu wiadomości z fokusem zostaje
/// systemowym „Wytnij" i niczego nie uzbraja; bez niego skrót zamyka zakładkę dwoma
/// naciśnięciami, o ile sesja ma „×". Wykonuje `SessionViewController+KeysTabs`.
public enum CloseTabKey: Sendable, Equatable {
  case cut
  case close
  /// Ani zaznaczenia, ani „×" (Codex, nieznany silnik, nieobsługiwana): skrót wyłączony.
  case unavailable

  public init(composerFocused: Bool, selectionLength: Int, canClose: Bool) {
    if composerFocused, selectionLength > 0 {
      self = .cut
    } else {
      self = canClose ? .close : .unavailable
    }
  }
}

/// Stan menu poleceń z chwili rysowania: numer wskazuje to, co widać na pasku, a polecenie niesie
/// identyfikator tej zakładki.
public struct ShortcutMenu: Sendable, Equatable {
  public struct Tab: Sendable, Equatable {
    public let number: Int
    public let label: String
    public let target: ProjectTabRef
  }

  /// Zakładki 1…8: najpierw sesje, potem terminale (bez paska albo przy otwartym arkuszu — pusto,
  /// a skrót milczy).
  public var tabs: [Tab] = []
  /// Cmd+9 — ostatnia zakładka; `nil`, gdy paska nie ma.
  public var lastTab: ProjectTabRef?
  /// Nazwa projektu celu Cmd+L; `nil` = skrót milczy.
  public var previousProject: String?
  /// Cmd+N: bieżący projekt jest znany (blokadę zakładania ogłasza samo naciśnięcie).
  public var canNewSession = false
  /// Cmd+Shift+N: projekt jest znany, a serwer zna terminal (odmowę mówi naciśnięcie).
  public var canTerminal = false
  /// Cmd+F, Cmd+G: jak ``canTerminal``, ale działają też nad innym oknem (zamykają swoje, zastępują cudze);
  /// milczą tylko przy otwartym formularzu.
  public var canPopup = false
  public var canToggleList = false
  public var listHidden = false
  /// Cmd+I: iPad w zwykłej szerokości i sesja Claude na ekranie (za wąska kolumna mówi zdaniem przy naciśnięciu).
  public var canToggleInspector = false
  public var inspectorVisible = false
  /// Cmd+J: serwer ma notatki, a na ekranie stoi projekt albo otwarty formularz notatki; nad innym formularzem milczy.
  public var canNote = false

  public init() {}

  /// Cyfry klawiszy rysowanych na zakładkach paska: pozycja 1…8, a 9 na ostatniej zakładce, gdy stoi
  /// dalej niż ósma — ta sama numeracja co `tabs` i `lastTab`. Bez klawiatury sprzętowej pusto: cyfra
  /// bez klawisza Cmd niczego nie mówi. Otwarte okno terminala cyfr NIE zdejmuje, choć skrót wtedy milczy:
  /// znikające klawisze przesuwałyby zakładki pod oknem przy każdym jego otwarciu i zamknięciu.
  public static func tabDigits(_ strip: [ProjectTabRef], hardwareKeyboard: Bool) -> [ProjectTabRef: Int] {
    guard hardwareKeyboard else { return [:] }
    var digits: [ProjectTabRef: Int] = [:]
    for (index, tab) in strip.prefix(8).enumerated() { digits[tab] = index + 1 }
    if let last = strip.last, digits[last] == nil { digits[last] = 9 }
    return digits
  }
}

extension RarogNavigation {
  /// The tab digits in the agent rows of the active project in the tree: the strip's own digits
  /// (`ShortcutMenu.tabDigits`), keyed by session id, so a row shows the key that opens its tab. Empty without a
  /// hardware keyboard, like the strip; an agent running in a terminal has no session tab and no digit.
  public func treeTabDigits(_ state: AppState, hardwareKeyboard: Bool) -> [String: Int] {
    var digits: [String: Int] = [:]
    for (tab, digit) in ShortcutMenu.tabDigits(tabRefs(state), hardwareKeyboard: hardwareKeyboard) {
      if case let .session(id) = tab { digits[id] = digit }
    }
    return digits
  }
}

extension RarogNavigation {
  public func shortcutMenu(_ state: AppState) -> ShortcutMenu {
    var menu = ShortcutMenu()
    // Pod arkuszem (oknem albo formularzem) milczą wszystkie skróty, które zmieniają ekran pod nim:
    // przeskok pod oknem zostawiłby je nad innym ekranem, a pod formularzem zmieniał to, czego nie
    // widać. Działa tylko skrót okna — i tylko nad innym oknem, nie nad formularzem.
    let free = sheet == nil
    if currentProjectCwd(state) != nil {
      // Ta sama lista co pasek (`stripTabs`): numer wskazuje to, co widać, także świeży terminal sprzed listy.
      let tabs = stripTabs(state).compactMap { tab in tab.target.map { (tab.label, $0) } }
      if free {
        menu.tabs = tabs.prefix(8).enumerated().map { index, tab in
          ShortcutMenu.Tab(number: index + 1, label: tab.0, target: tab.1)
        }
        menu.lastTab = tabs.last?.1
      }
      menu.canNewSession = free
      menu.canTerminal = free && canTogglePopup(state)
    }
    // Also with no project on screen: a window opened from the tree's terminal glyph closes and switches by key.
    menu.canPopup = sheet?.isForm != true && canTogglePopup(state)
    // Nazwa projektu to basename katalogu (tak samo nazywa go wiersz sekcji PROJEKTY); bez
    // przeliczania całej sekcji przy każdej ramce stanu.
    menu.previousProject = free ? previousProjectCwd(state).map(ProjectPath.name) : nil
    menu.canToggleList = free && canToggleList
    menu.listHidden = listHidden
    menu.canToggleInspector = free && inspector.eligible && inspectorSession(state) != nil
    menu.inspectorVisible = inspectorVisible(state)
    menu.canNote = state.notesAvailable
      && (noteSheet != nil || (sheet?.isForm != true && (noteBubble ?? currentProjectCwd(state)) != nil))
    return menu
  }

  /// Okno, w którym drugie wywołanie Cmd+L uznajemy za to samo wciśnięcie. Ślad z iPada:
  /// jedno wciśnięcie dochodzi dwa razy w tej samej milisekundzie — skok do poprzedniego projektu i od razu
  /// powrót, bo tytuł polecenia (z nazwą celu) zmienia się po skoku i menu odpala je ponownie z nowym celem.
  /// Osobne wciśnięcia człowieka dzieli ≥ 1 s.
  static let previousProjectRepeatWindow: TimeInterval = 0.3

  /// Czy Cmd+L o tej chwili to nowe wciśnięcie (a nie drugie wywołanie tego samego); `true` zapamiętuje chwilę.
  func acceptsPreviousProject(at now: Date) -> Bool {
    if let last = previousProjectJumpAt, now >= last, now.timeIntervalSince(last) < Self.previousProjectRepeatWindow {
      return false
    }
    previousProjectJumpAt = now
    return true
  }

  /// Czy skrót wolno wykonać przy bieżącym arkuszu: pod arkuszem działa tylko skrót okna, a o tym, czy
  /// zamknie, zastąpi albo zamilknie (formularz), rozstrzyga ``togglePopup(_:state:)``. Reszta milczy jak
  /// wygaszona pozycja menu — menu rysuje się rzadziej, niż zmienia się stan.
  func accepts(_ shortcut: RarogShortcut) -> Bool {
    guard sheet != nil else { return true }
    switch shortcut {
    // Notatka: nad formularzem notatki zamyka TĘ prezentację, nad oknem staje zamiast niego (`perform`).
    case .popup, .note: return true
    // Przeczytane ↔ nieprzeczytane zmieniałoby wiersz listy, którego pod arkuszem nie widać.
    case .tab, .previousProject, .newSession, .newTerminal, .toggleList, .toggleInspector, .toggleRead: return false
    }
  }

  /// Naciśnięty skrót. Nowa sesja jedzie w tle (wynik mówi zdanie pod paskiem).
  public func perform(_ shortcut: RarogShortcut, store: RarogStore, now: Date = Date()) {
    guard accepts(shortcut) else { return }
    let state = store.state
    switch shortcut {
    case let .tab(tab):
      openTab(tab, state: state)
    case .previousProject:
      guard acceptsPreviousProject(at: now) else {
        store.trace(DiagnosticsTrace.previousProjectRepeat)
        return
      }
      store.trace(DiagnosticsTrace.previousProject(target: previousProjectCwd(state)))
      openPreviousProject(state)
    case .newSession:
      guard let cwd = currentProjectCwd(state) else { return }
      Task { await createSession(in: cwd, store: store) }
    case .newTerminal:
      guard let cwd = currentProjectCwd(state) else { return }
      openTerminal(.next, in: cwd, state: state)
    case let .popup(role):
      togglePopup(role, state: state)
    case .toggleList:
      toggleList()
    case .toggleInspector:
      // Za wąska kolumna: dymek mówi, jak zrobić miejsce, a preferencja stoi.
      if toggleInspector(state) == .noRoom {
        NotificationCenter.default.post(name: .rarogAppNotice, object: UICopy.inspectorNoRoom)
      }
    case .note:
      toggleNote(state)
    case .toggleRead:
      // Kierunek z wyniku w chwili naciśnięcia; bez stojącego wyniku skrót milczy. Drugie wywołanie tego samego
      // naciśnięcia (jak przy Cmd+L) czyta to samo `seen`, bo ramka serwera jeszcze nie doszła — żądanie się powtórzy,
      // a serwer jest idempotentny.
      guard let sessionId = listSelection(state), let toggle = state.readToggle(sessionId) else { return }
      store.setResultRead(sessionId, read: toggle == .markRead)
    }
  }

  /// Cmd+J: formularz notatki stoi → zamknięcie TEJ prezentacji (zapis robi jej zakończenie, także gdy pod spodem
  /// stoi inny projekt); inny formularz → nic (Cmd+J nie ma prawa skasować wpisanej „Nowej sesji"); dymek notatki →
  /// formularz TEJ notatki (dymek z drzewa bywa o innym projekcie niż ekran); okno albo nic → formularz notatki
  /// projektu z ekranu. Kursor na końcu.
  func toggleNote(_ state: AppState) {
    guard state.notesAvailable else { return }
    if let open = noteSheet {
      closeSheet(id: open.id)
      return
    }
    guard sheet?.isForm != true, let cwd = noteBubble ?? currentProjectCwd(state) else { return }
    noteBubble = nil
    openNote(cwd: cwd, start: .edit)
  }
}
