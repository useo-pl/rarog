#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Formularz notatki projektu: PISANIE. Formularz, nie okno: zmiana ekranu z zewnątrz (tap
// w powiadomienie w trakcie dyktowania) zamyka okno, a formularz zostaje. Każde zakończenie prezentacji zapisuje —
// przycisk, Esc, ⌘W, ⌘J, gest w dół, zastąpienie arkusza i wylogowanie idą do `NoteDocument.finish` (idempotentne
// po identyfikatorze prezentacji); dwie ostatnie drogi zna tylko `onDisappear`. Przed zapisem nagranie oddaje
// hipotezę jako tekst (`NoteDictation.handOff`). Pytania „Na pewno?" nie ma, bo nic nie ginie. Właściciel: notatki
// (apka natywna).

/// Arkusz notatki nad bieżącym ekranem. Prezentacja i nagranie żyją na CAŁYM arkuszu, nie na polu: strona
/// „Porównaj" na stosie formularza zasłania pole (`onDisappear` treści), a prezentacja trwa. Koniec nagrania wchodzi
/// do modelu PRZED zapisem.
struct NoteSheet: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let request: NoteRequest
  @Environment(ProjectNotes.self) private var notes
  @State private var dictation: NoteDictation?
  /// Na stosie stoi strona „Porównaj".
  @State private var comparing = false

  var body: some View {
    let doc = notes.document(request.cwd)
    FormSheet(
      title: UICopy.list([UICopy.noteTitle, ProjectPath.name(request.cwd)], .dot),
      // Skróty arkusza (Esc, Cmd+W) wiszą na jednym kontrolerze prezentacji, a pierwszy wygrywa: drugi skrót Esc na
      // stronie nigdy by nie zadziałał. Jedno zamknięcie — na stronie porównania albo „Dyktowanie” wraca do pola, na
      // polu zamyka.
      close: SheetClose(label: UICopy.noteClose, identifier: "note.close") {
        if comparing {
          comparing = false
        } else if let dictation, dictation.choosing {
          dictation.choosing = false
        } else {
          navigation.closeSheet(id: request.id)
        }
      }
    ) {
      NoteForm(doc: doc, request: request, store: store, dictation: dictation, comparing: $comparing) {
        navigation.closeSheet(id: request.id)
      }
    }
    .onAppear {
      doc.attach(request.id)
      if dictation == nil { dictation = NoteDictation(store: store) }
    }
    .onDisappear {
      dictation?.handOff()
      doc.finish(request.id)
    }
  }
}

/// Treść formularza: baner konfliktu albo zdanie trybu tylko do odczytu, pole i pasek stanu na dole (nad
/// klawiaturą); strona „Porównaj" wchodzi na stos.
struct NoteForm: View {
  let doc: NoteDocument
  let request: NoteRequest
  let store: RarogStore
  let dictation: NoteDictation?
  @Binding var comparing: Bool
  /// Zamknięcie formularza (Esc w polu).
  let close: () -> Void
  /// Wejście z mikrofonu w dymku: nagranie rusza raz, gdy pole przyjmie tekst.
  @State private var dictateOnOpen: Bool
  @State private var editing = false
  @State private var savingVisible = false
  /// Wklejka ponad sufit: zdanie w wierszu stanu do następnej zmiany pola.
  @State private var rejection: String?
  @State private var field: NoteTextView?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    doc: NoteDocument, request: NoteRequest, store: RarogStore, dictation: NoteDictation?, comparing: Binding<Bool>,
    close: @escaping () -> Void
  ) {
    self.doc = doc
    self.request = request
    self.store = store
    self.dictation = dictation
    _comparing = comparing
    self.close = close
    _dictateOnOpen = State(initialValue: request.start == .dictate)
  }

  var body: some View {
    VStack(spacing: 0) {
      if let readOnly = doc.readOnly {
        NoteReadOnlyBanner(readOnly: readOnly, text: doc.text)
      } else if let conflict = doc.conflict {
        NoteConflictBanner(doc: doc, conflict: conflict, settle: { dictation?.handOff() }) {
          // Pole schowane pod stroną nie może brać klawiszy (Return wpisałby niewidoczną linię).
          field?.resignFirstResponder()
          comparing = true
        }
        .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
      }
      if doc.ancestor == nil {
        unavailable
      } else {
        NoteEditor(
          doc: doc, focus: request.start == .edit, editing: $editing,
          rejected: { paste, left in rejection = UICopy.notePasteTooLong(paste: paste, left: left) },
          attach: { editor in
            field = editor
            dictation?.attach(editor: editor)
          },
          close: close, userEdit: { dictation?.noticeEdit() })
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Color(uiColor: Palette.background))
    // ⌥⌘M na arkuszu, nie na polu: działa też wtedy, gdy klawiaturę trzyma kotwica arkusza (formularz z mikrofonu
    // w dymku), jak skrót pola wiadomości, który wisi na kontrolerze sesji nad polem.
    .background(alignment: .topLeading) {
      if micAvailable {
        Button { toggleDictation() } label: { Color.clear.frame(width: 1, height: 1) }
          .keyboardShortcut(DictationShortcut.key, modifiers: DictationShortcut.eventModifiers)
          .buttonStyle(.plain)
          .opacity(0.011)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      NoteFormBar(
        doc: doc, dictation: dictation, savingVisible: savingVisible, rejection: rejection, keyboard: editing,
        machine: store.state.serverMachine, mic: micAvailable ? { toggleDictation() } : nil,
        done: {
          field?.resignFirstResponder()
          doc.flush()
        })
    }
    .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: doc.conflict == nil)
    .navigationDestination(isPresented: $comparing) {
      NoteComparePage(doc: doc, project: ProjectPath.name(request.cwd), settle: { dictation?.handOff() }) {
        comparing = false
      }
    }
    // Strona „Dyktowanie” w stosie formularza, jak „Porównaj”: stuknięcie mikrofonu przy trasie, która
    // pyta. Wybór wraca do pola i niczego nie nagrywa — nagrywa następne stuknięcie mikrofonu.
    .navigationDestination(isPresented: choosingDictation) {
      NoteDictationPage(store: store) { dictation?.choosing = false }
    }
    // Pole schowane pod stroną nie może brać klawiszy (Return wpisałby niewidoczną linię).
    .onChange(of: dictation?.choosing == true) { _, choosing in
      if choosing { field?.resignFirstResponder() }
    }
    .onAppear { startDictationOnOpen() }
    .onChange(of: doc.editable) { startDictationOnOpen() }
    .onChange(of: dictation == nil) { startDictationOnOpen() }
    .onChange(of: doc.conflict?.updatedAt) { _, version in
      if version != nil { Announcer.shared.say(UICopy.noteConflictSpoken) } else { comparing = false }
    }
    .task(id: doc.saving) {
      // „zapisuję…" dopiero po 400 ms: szybki zapis idzie od razu do „zapisano 14:07" bez mignięcia.
      guard doc.saving else {
        savingVisible = false
        return
      }
      try? await Task.sleep(for: .milliseconds(400))
      if !Task.isCancelled { savingVisible = true }
    }
    .onChange(of: doc.text) { rejection = nil }
  }

  /// Mikrofon w pasku i ⌥⌘M: pole przyjmuje tekst albo trwa nagranie, które trzeba móc skończyć. Trasę (ekran,
  /// systemowe, Soniox) bierze stuknięcie (`NoteDictation.toggle`).
  private var micAvailable: Bool {
    NoteDictation.offersMicrophone(editable: doc.editable, recording: dictation?.active == true)
  }

  /// Strona „Dyktowanie” na stosie: stan żyje w gospodarzu nagrania, więc stuknięcie mikrofonu ją stawia.
  private var choosingDictation: Binding<Bool> {
    Binding(get: { dictation?.choosing == true }, set: { dictation?.choosing = $0 })
  }

  /// Mikrofon w pasku i ⌥⌘M: dopisek po spacji, jak w polu wiadomości.
  private func toggleDictation() {
    dictation?.toggle(doc: doc, editor: field)
  }

  /// Mikrofon w dymku: nagranie od nowej linii na końcu, bez klawiatury — raz, gdy pole przyjmie tekst. Trasa, która
  /// pyta, stawia stronę „Dyktowanie” zamiast nagrania.
  private func startDictationOnOpen() {
    guard dictateOnOpen, doc.editable, let dictation else { return }
    dictateOnOpen = false
    dictation.toggle(doc: doc, editor: field, newLine: true)
  }

  /// Bez znanej wersji: wczytywanie (szkielet) albo zdanie o braku połączenia z „Spróbuj ponownie".
  @ViewBuilder private var unavailable: some View {
    VStack(alignment: .leading, spacing: 16) {
      if doc.loadFailure != nil, doc.readOnly == nil {
        Text(UICopy.noteLoadOffline)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.muted))
        Button(UICopy.noteRetry) { doc.refresh() }
          .buttonStyle(NeutralButtonStyle())
          .accessibilityIdentifier("note.retry")
      } else if doc.readOnly == nil {
        NoteSkeleton()
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Pasek na dole formularza: stan zapisu z jedną akcją (w nagraniu — stan nagrania), licznik od 90 % sufitu,
/// mikrofon, na telefonie „Gotowe" przy klawiaturze. Stoi nad klawiaturą (wstawka dolna podąża za nią) i przy dolnej
/// krawędzi bez niej — kciuk zastaje go w tym samym miejscu.
struct NoteFormBar: View {
  let doc: NoteDocument
  let dictation: NoteDictation?
  let savingVisible: Bool
  let rejection: String?
  let keyboard: Bool
  /// Słowo maszyny serwera w zdaniu braku kontaktu (``AppState/serverMachine``).
  let machine: ServerMachine
  /// Mikrofon; `nil` = pole tylko do odczytu (bez nagrania w toku).
  let mic: (() -> Void)?
  let done: () -> Void

  var body: some View {
    let status = rejection.map { NoteStatusLine($0, tone: .error) }
      ?? dictation?.statusLine
      ?? doc.statusLine(savingVisible: savingVisible, machine: machine)
    VStack(spacing: 0) {
      Rectangle()
        .fill(Color(uiColor: Palette.border))
        .frame(height: 1)
        .accessibilityHidden(true)
      HStack(spacing: 12) {
        if let status {
          Text(status.text)
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: status.tone == .error ? Palette.err : Palette.muted2))
            .lineLimit(2)
            .accessibilityIdentifier("note.status")
          if let action = status.action { actionButton(action) }
        }
        Spacer(minLength: 8)
        if let counter = doc.counter {
          Text(counter.text)
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: counter.full ? Palette.err : Palette.muted))
            .accessibilityIdentifier("note.counter")
        }
        if let mic {
          NoteMicButton(recording: dictation?.active == true, action: mic)
            .accessibilityIdentifier("note.mic")
        }
        if keyboard, PopoverLayout.sheetBar {
          Button(UICopy.noteDone, action: done)
            .appFont(.body.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.text))
            .frame(minHeight: 44)
            .accessibilityHint(UICopy.noteDoneHint)
            .accessibilityIdentifier("note.done")
        }
      }
      .padding(.horizontal, 16)
      .frame(minHeight: 48)
      if let counter = doc.counter, counter.full {
        Text(UICopy.noteFull)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
      }
    }
    .background(Color(uiColor: Palette.background))
  }

  private func actionButton(_ action: NoteStatusLine.Action) -> some View {
    let (title, identifier): (String, String) = switch action {
    case .retry: (UICopy.noteRetry, "note.retry")
    case .restore: (UICopy.noteRestore, "note.restore")
    case .undo: (UICopy.noteUndo, "note.undo")
    case .settings: (UICopy.voiceSettings, "note.voice.settings")
    }
    return Button(title) {
      if action == .settings {
        // Ustawienia apki w iOS: pola nie zmienia, nagrania w toku nie ma (odmowa je zakończyła).
        dictation?.openSettings()
        return
      }
      // Akcja zmienia pole z kodu: nagranie najpierw oddaje tekst, inaczej następny token nadpisałby wynik.
      dictation?.handOff()
      switch action {
      case .retry: doc.retry()
      case .restore: doc.restore()
      case .undo: doc.undoResolution()
      case .settings: break
      }
    }
    .accessibilityHint(action == .settings ? UICopy.voiceSettingsHint : "")
    .appFont(.footnote.weight(.semibold))
    .foregroundStyle(Color(uiColor: Palette.text))
    .frame(minHeight: 44)
    .accessibilityIdentifier(identifier)
  }
}

/// Strona „Dyktowanie” w notatce: ekran wyboru i zgody (`DictationChoiceView`) z modelem na czas tej strony.
struct NoteDictationPage: View {
  let chosen: () -> Void
  @State private var model: DictationChoiceModel

  init(store: RarogStore, chosen: @escaping () -> Void) {
    self.chosen = chosen
    _model = State(initialValue: DictationChoiceModel(store: store))
  }

  var body: some View {
    DictationChoiceView(model: model, presentation: .notePage) { _ in chosen() }
      .navigationTitle(UICopy.dictationTitle())
      .navigationBarTitleDisplayMode(.inline)
      // Strona bierze klawiaturę, jak strona porównania: pole notatki zeszło z okna, a bez kotwicy Return trafiłby do
      // pola wiadomości pod arkuszem. Esc i Cmd+W wracają do pola przez zamknięcie arkusza (`NoteSheet`).
      .background { SheetKeyboardAnchor() }
  }
}

/// Pole tylko do odczytu: zdanie dlaczego i „Kopiuj", żeby tekst nie utknął w apce.
struct NoteReadOnlyBanner: View {
  let readOnly: NoteDocument.ReadOnly
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(sentence)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      if !text.isEmpty {
        Button(UICopy.noteCopy) { UIPasteboard.general.string = text }
          .buttonStyle(NeutralButtonStyle())
          .accessibilityIdentifier("note.copy")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)))
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("note.readonly")
  }

  private var sentence: String {
    switch readOnly {
    case .disabled: UICopy.noteDisabled
    case let .directory(message): message ?? UICopy.noteDirectoryFallback
    }
  }
}
#endif
