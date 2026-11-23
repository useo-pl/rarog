import Foundation
import RarogCore

/// Szkice pól wiadomości per sesja: tekst i niewysłane załączniki przeżywają nawigację
/// i zabicie apki. Właściciel: sterowanie sesją.
///
/// Dwie drogi zapisu:
/// - żywe pole (ekran sesji, `SessionViewController+Drafts`) zapisuje swój stan po krótkiej
///   przerwie w pisaniu, przy wyjściu z ekranu i przy zejściu apki w tło — ``persist(text:attachments:for:)``;
/// - tekst nieudanej wysyłki, gdy ekranu tej sesji już nie ma (``SendRecovery/saveDraft``) —
///   ``save(_:note:for:)``: nieudany na górze, wcześniejszy szkic pod spodem, a załączniki z półki
///   sesji (``AttachmentShelf``) jadą razem z nim.
/// Nowy ekran sesji zabiera tekst (``take(for:)``) i — po zabiciu apki, gdy półka jest pusta —
/// załączniki (``restoreAttachments(for:)``), a od razu potem zapisuje stan swojego pola. Ekran tej
/// sesji otwarty w międzyczasie dostaje szkic nieudanej wysyłki od razu (``watch(_:_:)``). Paczka
/// załączników wczytywana na półkę trafia na dysk po wczytaniu także bez ekranu
/// (``persistAfterLoading(_:)``).
///
/// A screen alive out of the window (under a full-screen presentation) leaves a failed send's text waiting in memory;
/// its field takes the waiting texts (``takeWaiting(for:)``) before it writes the draft again, because that write
/// replaces the draft.
///
/// The queue take-back writes and waits for the disk's answer, because the outbox entries of the taken messages leave
/// only after their texts are on disk: the live field of the session screen that stands at answer time
/// (``persistConfirmed(text:attachments:for:)``; screens register with ``registerScreen(_:for:)``), and without one
/// the stored draft (``saveTaken(_:for:)``).
///
/// Na dysku: `<przestrzeń serwera>/drafts/` (ochrona do pierwszego odblokowania, poza kopią
/// zapasową — ta sama klasa danych co kolejka wysyłki); bez katalogu (testy) tylko pamięć procesu.
@MainActor
public final class ComposerDrafts {
  public struct Draft: Sendable, Equatable {
    public let text: String
    /// Zdanie pod polem: dlaczego tekst wrócił (tylko w pamięci procesu — po zabiciu apki nie wraca).
    public let note: String?
  }

  /// A draft that waits in process memory for a field (``take(for:)``, ``takeWaiting(for:)``).
  private struct Waiting: Equatable {
    /// What a screen that opens takes: the waiting texts on top of the stored draft.
    var draft: Draft
    /// The waiting texts alone, without the stored draft under them.
    var onTop: String
  }

  private var memory: [String: Waiting] = [:]
  private let disk: DraftDisk?
  private let shelf: AttachmentShelf
  /// Zapisy odroczone do końca bieżącej tury głównego aktora (nieudana wysyłka: tekst, potem półka).
  private var pending: Set<String> = []
  /// Ekran sesji, który chce szkicu od razu; ostatni zarejestrowany wygrywa.
  private var watchers: [String: @MainActor () -> Void] = [:]
  /// Sesje, których wczytywaną paczkę szkic już śledzi (``persistAfterLoading(_:)``).
  private var loading: Set<String> = []
  /// Live session screens per session, the latest registered last (``screens(for:)``).
  private var screens: [String: [WeakScreen]] = [:]

  private struct WeakScreen {
    weak var screen: AnyObject?
  }

  /// - Parameter directory: katalog na dysku; `nil` = tylko pamięć procesu.
  public init(directory: URL? = nil, shelf: AttachmentShelf = .shared) {
    disk = directory.map(DraftDisk.init(directory:))
    self.shelf = shelf
  }

  /// Szkice w przestrzeni bieżącego serwera (`RarogStore.dataSpaceDirectory`); bez przestrzeni — tylko pamięć.
  public static func inSpace(_ space: URL?) -> ComposerDrafts {
    ComposerDrafts(directory: space?.appending(path: ServerSpaces.drafts, directoryHint: .isDirectory))
  }

  /// Dokłada tekst nieudanej wysyłki do szkicu sesji; wcześniejszy szkic zostaje pod spodem
  /// (nieudany tekst na górze). Na dysk trafia razem z załącznikami z półki sesji. Zarejestrowany
  /// ekran dostaje znak po zapisie — zabiera szkic, gdy stoi w oknie, inaczej szkic czeka na
  /// następne otwarcie.
  public func save(_ text: String, note: String?, for sessionId: String) {
    memory[sessionId] = stacked(text, note: note, for: sessionId)
    if disk != nil, pending.insert(sessionId).inserted {
      // Półkę wołający uzupełnia zaraz po tekście — zapis po bieżącej turze widzi oba.
      Task { @MainActor [weak self] in self?.flushPending(sessionId) }
    }
    watchers[sessionId]?()
  }

  /// Ekran sesji słucha nowych szkiców (otwarty w trakcie wysyłki z poprzedniego ekranu).
  public func watch(_ sessionId: String, _ watcher: @escaping @MainActor () -> Void) {
    watchers[sessionId] = watcher
  }

  /// A session screen registers when it builds its field. A queue take-back answers to the screen of the session
  /// that stands at answer time, which may be a newer one than the screen of the gesture.
  func registerScreen(_ screen: AnyObject, for sessionId: String) {
    var list = screens[sessionId] ?? []
    list.removeAll { $0.screen == nil || $0.screen === screen }
    list.append(WeakScreen(screen: screen))
    screens[sessionId] = list
  }

  /// The session's screens still alive, the latest registered last; the caller picks the one in a window.
  func screens(for sessionId: String) -> [AnyObject] {
    screens[sessionId]?.compactMap(\.screen) ?? []
  }

  /// Zabiera szkic do pola: z pamięci procesu, a bez niej z dysku (po zabiciu apki). Dysku nie
  /// czyści — robi to pierwszy zapis żywego pola.
  public func take(for sessionId: String) -> Draft? {
    if let waiting = memory.removeValue(forKey: sessionId) { return waiting.draft }
    guard let stored = disk?.load(sessionId), !stored.text.isEmpty else { return nil }
    return Draft(text: stored.text, note: nil)
  }

  /// What a live screen takes into its field before the field writes the draft again: only the texts waiting in
  /// process memory, without the stored draft under them, which the field already holds (it took that draft when the
  /// screen opened, and its writes made it). The disk is not read: its draft is a copy of a field, not a text to add.
  /// `nil`: nothing waits. A screen that opens takes the whole draft (``take(for:)``).
  func takeWaiting(for sessionId: String) -> Draft? {
    memory.removeValue(forKey: sessionId).map { Draft(text: $0.onTop, note: $0.draft.note) }
  }

  /// Załączniki szkicu z dysku jako świeże kopie w katalogu roboczym paska (``AttachmentStaging``).
  /// Plik, którego już nie ma, przepada po cichu — reszta wraca.
  public func restoreAttachments(for sessionId: String) -> [ComposerAttachment] {
    disk?.restoreAttachments(sessionId) ?? []
  }

  /// Stan żywego pola. Pusty tekst bez załączników kasuje szkic. `failed` (na głównym aktorze) =
  /// dysk tego stanu nie przyjął (brak miejsca, uprawnienia); na dysku został poprzedni szkic, cały.
  /// The state replaces the draft and drops the texts waiting in memory: the field takes them first
  /// (``takeWaiting(for:)``).
  public func persist(
    text: String, attachments: [ComposerAttachment], for sessionId: String,
    failed: (@MainActor @Sendable () -> Void)? = nil
  ) {
    memory[sessionId] = nil
    disk?.write(sessionId, text: text, attachments: attachments, failed: failed)
  }

  /// ``persist(text:attachments:for:failed:)`` that waits for the disk: `true` once the state is on disk (always
  /// without a disk). The queue take-back removes its bubbles only then. It drops the waiting texts too.
  public func persistConfirmed(text: String, attachments: [ComposerAttachment], for sessionId: String) async -> Bool {
    memory[sessionId] = nil
    guard let disk else { return true }
    return await disk.writeConfirmed(sessionId, text: text, attachments: attachments)
  }

  /// The texts of a queue take-back when no screen of the session stands: on top of the stored draft, as
  /// ``save(_:note:for:)`` puts a failed send, with the attachments of the session's shelf, but written at once and
  /// confirmed. No watcher hears it: a screen that opens later takes the draft when it builds its field. `false`: the
  /// disk refused, and the draft stays as it was, so the replay of the same take-back does not add the texts twice.
  public func saveTaken(_ text: String, for sessionId: String) async -> Bool {
    let kept = memory[sessionId]
    let waiting = stacked(text, note: nil, for: sessionId)
    memory[sessionId] = waiting
    guard let disk else { return true }
    guard await disk.writeConfirmed(sessionId, text: waiting.draft.text, attachments: shelf.attachments(for: sessionId))
    else {
      // A screen that opened during the write took the draft into its field: that copy stays.
      if memory[sessionId] == waiting { memory[sessionId] = kept }
      return false
    }
    return true
  }

  /// `text` on top of the draft waiting in memory, or else of the stored one; the earlier note stays unless `note`
  /// replaces it.
  private func stacked(_ text: String, note: String?, for sessionId: String) -> Waiting {
    let kept = memory[sessionId]
    let previous = kept?.draft
      ?? disk?.load(sessionId).flatMap { $0.text.isEmpty ? nil : Draft(text: $0.text, note: nil) }
    return Waiting(
      draft: Draft(text: previous.map { "\(text)\n\($0.text)" } ?? text, note: note ?? previous?.note),
      onTop: kept.map { "\(text)\n\($0.onTop)" } ?? text)
  }

  /// Paczka załączników sesji wczytuje się na półkę: jej wynik trafia na dysk także wtedy, gdy
  /// ekranu sesji już nie ma, więc zabicie apki nie gubi wczytanego załącznika. Tekst zostaje ten,
  /// który szkic już ma (nieudana wysyłka w pamięci albo zapis z dysku); żywe pole i tak zapisze
  /// potem swój stan. Woła ekran sesji na początku wczytywania.
  public func persistAfterLoading(_ sessionId: String) {
    guard disk != nil, shelf.isLoading(sessionId), loading.insert(sessionId).inserted else { return }
    Task { @MainActor [weak self, shelf] in
      await shelf.loaded(sessionId)
      self?.persistShelf(sessionId)
    }
  }

  /// Czeka na zapisy w kolejce dysku (testy).
  public func flush() {
    disk?.flush()
  }

  private func flushPending(_ sessionId: String) {
    // Szkic zabrał w międzyczasie ekran tej sesji (``watch(_:_:)``): na dysk pisze teraz jego pole.
    guard pending.remove(sessionId) != nil, let text = memory[sessionId]?.draft.text else { return }
    disk?.write(sessionId, text: text, attachments: shelf.attachments(for: sessionId))
  }

  private func persistShelf(_ sessionId: String) {
    loading.remove(sessionId)
    guard let disk else { return }
    let text = memory[sessionId]?.draft.text ?? disk.load(sessionId)?.text ?? ""
    disk.write(sessionId, text: text, attachments: shelf.attachments(for: sessionId))
  }
}

/// Szkic na dysku: manifest `<klucz>.json` i pliki treści załączników w `<klucz>/`. Zapis: najpierw
/// treść, potem manifest, a pliki poprzedniego szkicu znikają dopiero po zapisanym manifeście;
/// kasowanie: najpierw manifest, potem treść — jak kolejka wysyłki. Zapisy idą po kolei w kolejce
/// katalogu (``DraftsDisk``), poza głównym aktorem; odczyty czekają na zapisy przed sobą. Katalog leży
/// w przestrzeni serwera, więc instancja poprzedniego serwera pisze do przestrzeni, której nikt już nie czyta.
final class DraftDisk: @unchecked Sendable {
  /// Najwyżej tyle szkiców; przy otwarciu wypadają najdawniej zapisane.
  static let capacity = 64

  struct Stored: Codable, Equatable {
    struct Attachment: Codable, Equatable {
      var id: UUID
      var kind: ComposerAttachment.Kind
      var name: String
      var mime: String
      var bytes: Int
      /// Nazwa pliku treści w katalogu szkicu.
      var file: String
    }

    var version = 1
    var sessionId: String
    var text: String
    var attachments: [Attachment]
    var savedAt: Date
  }

  let directory: URL
  private let ticket: DraftsDisk.Ticket

  init(directory: URL) {
    self.directory = directory
    ticket = DraftsDisk.shared.ticket(directory)
    DraftsDisk.shared.async(ticket) { Self.prepare(directory) }
  }

  func load(_ sessionId: String) -> Stored? {
    DraftsDisk.shared.sync(ticket) { read(sessionId) }
  }

  /// `failed` dostaje znak na głównym aktorze, gdy dysk stanu nie przyjął.
  func write(
    _ sessionId: String, text: String, attachments: [ComposerAttachment],
    failed: (@MainActor @Sendable () -> Void)? = nil
  ) {
    let sources = attachments
    DraftsDisk.shared.async(ticket) { [self] in
      if !apply(sessionId, text: text, attachments: sources), let failed { Task { @MainActor in failed() } }
    }
  }

  /// ``write(_:text:attachments:failed:)`` with the answer: `true` once the state is on disk.
  func writeConfirmed(_ sessionId: String, text: String, attachments: [ComposerAttachment]) async -> Bool {
    await withCheckedContinuation { continuation in
      DraftsDisk.shared.async(ticket) { [self] in
        continuation.resume(returning: apply(sessionId, text: text, attachments: attachments))
      }
    }
  }

  func restoreAttachments(_ sessionId: String) -> [ComposerAttachment] {
    DraftsDisk.shared.sync(ticket) { () -> [ComposerAttachment] in
      guard let stored = read(sessionId) else { return [] }
      let folder = folder(sessionId)
      return stored.attachments.compactMap { item in
        let source = folder.appending(path: item.file)
        let target = AttachmentStaging.newURL(ext: (item.file as NSString).pathExtension)
        guard (try? FileManager.default.copyItem(at: source, to: target)) != nil else { return nil }
        return ComposerAttachment(id: item.id, kind: item.kind, name: item.name, mime: item.mime, bytes: item.bytes, file: target)
      }
    }
  }

  func flush() {
    DraftsDisk.shared.flush(ticket)
  }

  // MARK: - Na kolejce

  /// An empty text without attachments deletes the draft; `false` = the disk did not take the state.
  private func apply(_ sessionId: String, text: String, attachments: [ComposerAttachment]) -> Bool {
    text.isEmpty && attachments.isEmpty ? remove(sessionId) : store(sessionId, text: text, attachments: attachments)
  }

  private func read(_ sessionId: String) -> Stored? {
    guard let data = try? Data(contentsOf: manifest(sessionId)),
      let stored = try? JSONDecoder().decode(Stored.self, from: data),
      stored.version == 1, stored.sessionId == sessionId
    else { return nil }
    return stored
  }

  /// `false` = stan nie trafił na dysk; poprzedni manifest i jego pliki zostają nietknięte.
  private func store(_ sessionId: String, text: String, attachments: [ComposerAttachment]) -> Bool {
    let manager = FileManager.default
    let folder = folder(sessionId)
    try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
    var kept: [Stored.Attachment] = []
    for attachment in attachments {
      let ext = attachment.file.pathExtension
      let name = ext.isEmpty ? attachment.id.uuidString : "\(attachment.id.uuidString).\(ext)"
      let target = folder.appending(path: name)
      if !manager.fileExists(atPath: target.path), (try? manager.copyItem(at: attachment.file, to: target)) == nil {
        // Plik roboczy mógł już zniknąć (wysłany, zdjęty z paska) albo zabrakło miejsca — wtedy tego
        // załącznika w szkicu nie ma, a tekst idzie dalej (następny zapis spróbuje znowu). Niedokończona
        // kopia nie zostaje: następny zapis wziąłby ją za gotową.
        try? manager.removeItem(at: target)
        continue
      }
      kept.append(Stored.Attachment(
        id: attachment.id, kind: attachment.kind, name: attachment.name, mime: attachment.mime,
        bytes: attachment.bytes, file: name))
    }
    let stored = Stored(sessionId: sessionId, text: text, attachments: kept, savedAt: Date())
    guard let data = try? JSONEncoder().encode(stored),
      (try? data.write(to: manifest(sessionId), options: .atomic)) != nil
    else { return false }
    // Dopiero manifest wskazujący nowy stan zwalnia pliki poprzedniego.
    let names = Set(kept.map(\.file))
    for leftover in (try? manager.contentsOfDirectory(atPath: folder.path)) ?? [] where !names.contains(leftover) {
      try? manager.removeItem(at: folder.appending(path: leftover))
    }
    return true
  }

  /// `false` = manifest został (szkic wróciłby po zabiciu apki).
  private func remove(_ sessionId: String) -> Bool {
    let manager = FileManager.default
    try? manager.removeItem(at: manifest(sessionId))
    guard !manager.fileExists(atPath: manifest(sessionId).path) else { return false }
    try? manager.removeItem(at: folder(sessionId))
    return true
  }

  private func manifest(_ sessionId: String) -> URL {
    directory.appending(path: "\(Self.key(sessionId)).json")
  }

  private func folder(_ sessionId: String) -> URL {
    directory.appending(path: Self.key(sessionId), directoryHint: .isDirectory)
  }

  /// Nazwa pliku z identyfikatora sesji: base64url (bez separatorów ścieżki), odwracalna.
  static func key(_ sessionId: String) -> String {
    Data(sessionId.utf8).base64EncodedString()
      .replacing("+", with: "-").replacing("/", with: "_").replacing("=", with: "")
  }

  /// Katalog z ochroną danych i poza kopią zapasową; nadmiar szkiców i sieroty po awarii znikają.
  private static func prepare(_ directory: URL) {
    let manager = FileManager.default
    var dir = directory
    #if os(iOS)
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try? manager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: protection)
    try? manager.setAttributes(protection, ofItemAtPath: dir.path)
    #else
    try? manager.createDirectory(at: dir, withIntermediateDirectories: true)
    #endif
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)

    let names = (try? manager.contentsOfDirectory(atPath: directory.path)) ?? []
    let manifests: [(key: String, savedAt: Date)] = names.filter { $0.hasSuffix(".json") }.compactMap { name in
      let url = directory.appending(path: name)
      guard let data = try? Data(contentsOf: url), let stored = try? JSONDecoder().decode(Stored.self, from: data) else {
        try? manager.removeItem(at: url)
        return nil
      }
      return (String(name.dropLast(5)), stored.savedAt)
    }
    let kept = Set(manifests.sorted { $0.savedAt > $1.savedAt }.prefix(capacity).map(\.key))
    for item in manifests where !kept.contains(item.key) {
      try? manager.removeItem(at: directory.appending(path: "\(item.key).json"))
    }
    // Katalog bez manifestu = sierota (awaria między treścią a manifestem albo szkic za sufitem).
    for name in names where !name.hasSuffix(".json") && !kept.contains(name) {
      try? manager.removeItem(at: directory.appending(path: name))
    }
  }
}
