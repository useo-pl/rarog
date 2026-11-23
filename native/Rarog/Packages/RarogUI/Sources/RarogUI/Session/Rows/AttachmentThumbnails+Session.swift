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
      self.present(ImagePreviewNavigation(preview: preview), animated: true)
    }
  }
}

/// Rama podglądu: QuickLook w nawigacji apki. Pasek z „Zamknij" i skrót Esc żyją w procesie apki —
/// QuickLook prezentowany sam (iPadOS 26) nie wystawia przycisku zamknięcia czytnikowi ani
/// testom, a klawisze trafiają do jego procesu (zmierzone XCUITestem).
final class ImagePreviewNavigation: UINavigationController {
  init(preview: ImagePreviewController) {
    super.init(rootViewController: preview)
    modalPresentationStyle = .fullScreen
    preview.navigationItem.leftBarButtonItem = closeItem()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override var canBecomeFirstResponder: Bool { true }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    becomeFirstResponder()
    // QuickLook ustawia własne przyciski przy pojawieniu się — „Zamknij" wraca, gdyby zniknął.
    if let root = viewControllers.first, root.navigationItem.leftBarButtonItem == nil {
      root.navigationItem.leftBarButtonItem = closeItem()
    }
  }

  /// Esc z klawiatury sprzętowej zamyka podgląd jak „Zamknij" — o ile klawisz trafi do apki, a nie do
  /// procesu QuickLook (XCUITest go tu nie dowozi; sprawdza się ręcznie na iPadzie).
  override var keyCommands: [UIKeyCommand]? {
    [UIKeyCommand(title: UICopy.previewClose, action: #selector(closePreview), input: UIKeyCommand.inputEscape)]
  }

  @objc private func closePreview() {
    dismiss(animated: true)
  }

  private func closeItem() -> UIBarButtonItem {
    let item = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.closePreview() })
    item.accessibilityLabel = UICopy.previewClose
    item.accessibilityIdentifier = "preview.close"
    return item
  }
}

/// QuickLook z jednym obrazkiem. QuickLook czyta wyłącznie pliki, więc bajty idą do pliku
/// tymczasowego (ochrona danych pełna), który znika razem z kontrolerem. Źródło danych trzyma
/// sam kontroler — `dataSource` jest słabą referencją.
final class ImagePreviewController: QLPreviewController, QLPreviewControllerDataSource {
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
