#if os(iOS)
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Źródła załączników: wybór zdjęć (`PHPickerViewController`, bez zgody na bibliotekę), Pliki
/// (`UIDocumentPickerViewController`, kopie) i przeciąganie (`UIDropInteraction` z Plików
/// i Zdjęć). Wklejenie obsługuje pole (`ComposerTextView.paste`). Właściciel: wysyłka.
///
/// Każde źródło oddaje paczkę ``AttachmentCandidate`` — limity, przygotowanie i zdania robi
/// wspólna droga (`ComposerView.ingest`). Po spinaczu i przeciągnięciu nikt nie wciąga kursora
/// do pola: na dotyku wysunęłaby się klawiatura, o którą nikt nie prosił.
@MainActor
final class AttachmentSources: NSObject {
  /// Kontroler, który pokazuje okna wyboru (ekran sesji).
  weak var presenter: UIViewController?
  /// Paczka gotowa do przyjęcia.
  var deliver: (([AttachmentCandidate]) -> Void)?
  /// Czy pole przyjmuje teraz załączniki (wygaszone pole — spinacz i upuszczanie nie).
  var accepting: () -> Bool = { true }

  func presentPhotos(limit: Int) {
    var config = PHPickerConfiguration()
    config.filter = .images
    config.selectionLimit = max(1, limit)
    // Bez transkodowania przez system: i tak zmniejszamy i kodujemy JPEG sami.
    config.preferredAssetRepresentationMode = .current
    let picker = PHPickerViewController(configuration: config)
    picker.delegate = self
    presenter?.present(picker, animated: true)
  }

  func presentFiles() {
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
    picker.allowsMultipleSelection = true
    picker.delegate = self
    presenter?.present(picker, animated: true)
  }

  /// Interakcja upuszczania dla widoku ekranu sesji (cały ekran jest celem, jak `root` w PWA).
  func makeDropInteraction() -> UIDropInteraction {
    UIDropInteraction(delegate: self)
  }

  /// Elementy schowka albo przeciągania, które są załącznikami (tekst i adresy spoza pliku nie są).
  static func candidates(_ providers: [NSItemProvider]) -> [AttachmentCandidate] {
    providers.compactMap(AttachmentCandidate.from)
  }
}

extension AttachmentSources: PHPickerViewControllerDelegate {
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    let candidates = Self.candidates(results.map(\.itemProvider))
    if !candidates.isEmpty { deliver?(candidates) }
  }
}

extension AttachmentSources: UIDocumentPickerDelegate {
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    let candidates = urls.map(AttachmentCandidate.file(at:))
    if !candidates.isEmpty { deliver?(candidates) }
  }
}

extension AttachmentSources: UIDropInteractionDelegate {
  func dropInteraction(_ interaction: UIDropInteraction, canHandle session: any UIDropSession) -> Bool {
    session.items.contains { AttachmentCandidate.classify($0.itemProvider) != nil }
  }

  func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: any UIDropSession) -> UIDropProposal {
    UIDropProposal(operation: accepting() ? .copy : .forbidden)
  }

  func dropInteraction(_ interaction: UIDropInteraction, performDrop session: any UIDropSession) {
    let candidates = Self.candidates(session.items.map(\.itemProvider))
    if !candidates.isEmpty { deliver?(candidates) }
  }
}
#endif
