#if os(iOS)
import RarogCore
import QuickLook
import SwiftUI
import UIKit

// Wiersz zdjęć wpięty w ekran sesji: fabryka komórek woła `mediaRowView`, stuknięcie w miniaturę
// otwiera systemowy podgląd QuickLook (szczypanie i przesuwanie; tap w obraz go nie zamyka, tylko
// chowa pasek). Właściciel: notki i miniatury.
extension SessionViewController {
  func mediaRowView(_ model: MediaRowModel) -> some View {
    MediaRowView(model: model, loader: ThumbnailLoader(store: store, sessionId: sessionId)) { [weak self] thumbnail in
      self?.openImagePreview(thumbnail)
    }
  }

  /// Podgląd zdjęcia. Bajty zwykle są już w pamięci (kafel je właśnie pokazał), ale odczyt bywa
  /// asynchroniczny: wynik trafia tylko do ekranu, który o niego prosił, gdy ten wciąż stoi
  /// w oknie i niczego nie pokazuje (drugi tap w trakcie i zamknięta sesja nie otwierają nic).
  func openImagePreview(_ thumbnail: MediaThumbnail) {
    let loader = ThumbnailLoader(store: store, sessionId: sessionId)
    Task { [weak self] in
      guard case let .bytes(data) = await loader.bytes(thumbnail),
        let self, self.viewIfLoaded?.window != nil, self.presentedViewController == nil,
        let preview = ImagePreviewController(data: data, title: thumbnail.label)
      else { return }
      self.present(PreviewPresentation.controller(for: preview), animated: true)
    }
  }
}

/// How a QuickLook preview stands. On an iPad and an iPhone it is QuickLook alone, full screen: its own close button
/// (exposed to VoiceOver and to UI tests) and its own Esc. On a Mac the iPad app gets the system Quick Look panel in a
/// window of its own, with its own close button and Esc, and the controller only stands behind it, so there it stands
/// in ``ImagePreviewNavigation``, which draws nothing.
enum PreviewPresentation {
  static func controller(for preview: RarogQuickLookController) -> UIViewController {
    if ProcessInfo.processInfo.isiOSAppOnMac { return ImagePreviewNavigation(preview: preview) }
    preview.modalPresentationStyle = .fullScreen
    return preview
  }
}

/// QuickLook of the app: the transcript photo and a file from the panel tree. QuickLook closes an image or a PDF on its
/// own Esc and keeps a text file open (iPadOS, as in the Files app); an Esc that comes back to the app (as a key
/// command or a bare press) closes the preview too.
class RarogQuickLookController: QLPreviewController {
  /// The preview itself is closing: its own dismissal, or the Mac frame's around it.
  var isClosing: Bool { isBeingDismissed || navigationController?.isBeingDismissed == true }

  override var keyCommands: [UIKeyCommand]? {
    [UIKeyCommand(title: UICopy.previewClose, action: #selector(escapeKey), input: UIKeyCommand.inputEscape)]
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if presses.contains(where: { $0.key?.keyCode == .keyboardEscape }), close() { return }
    super.pressesBegan(presses, with: event)
  }

  @objc private func escapeKey() {
    close()
  }

  /// Closes the preview, unless it is already closing or a sheet of QuickLook (share) stands over it.
  @discardableResult
  private func close() -> Bool {
    let shown = navigationController ?? self
    guard !isClosing, shown.presentingViewController != nil, shown.presentedViewController == nil,
      !shown.isBeingPresented
    else { return false }
    shown.dismiss(animated: true)
    return true
  }
}

/// The Mac frame of a preview (``PreviewPresentation``): a navigation controller that draws nothing, so the app stays
/// visible under the system Quick Look panel. Closing the panel dismisses it, and its dismissal discards the copy.
final class ImagePreviewNavigation: UINavigationController {
  init(preview: QLPreviewController) {
    super.init(rootViewController: preview)
    modalPresentationStyle = .overFullScreen
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.alpha = 0
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }
}

/// QuickLook z jednym obrazkiem. QuickLook czyta wyłącznie pliki, więc bajty idą do pliku
/// tymczasowego (ochrona danych pełna), który znika razem z kontrolerem. Źródło danych trzyma
/// sam kontroler — `dataSource` jest słabą referencją.
final class ImagePreviewController: RarogQuickLookController, QLPreviewControllerDataSource {
  private let item: ImagePreviewItem
  private let fileURL: URL

  init?(data: Data, title: String) {
    guard let ext = ThumbnailDecoder.fileExtension(of: data) else { return nil }
    let directory = FileManager.default.temporaryDirectory.appending(path: "rarog-preview", directoryHint: .isDirectory)
    let url = directory.appending(path: "\(UUID().uuidString).\(ext)")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: url, options: [.atomic, .completeFileProtection])
    } catch {
      return nil
    }
    fileURL = url
    item = ImagePreviewItem(url: url, title: title)
    super.init(nibName: nil, bundle: nil)
    dataSource = self
    accessibilityViewIsModal = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  deinit {
    try? FileManager.default.removeItem(at: fileURL)
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { item }
}

/// Element podglądu: plik i tytuł (nazwa dla czytnika — „Zdjęcie 2", opis obrazka z treści).
final class ImagePreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(url: URL, title: String) {
    previewItemURL = url
    previewItemTitle = title
  }
}
#endif
