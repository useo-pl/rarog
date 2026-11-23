#if os(iOS)
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit
import VisionKit

// Skaner kodu QR parowania (VisionKit `DataScannerViewController`, iOS 16+, w miejscu kontrolek) i kod QR do pokazania
// nowemu urządzeniu (CoreImage). Zgoda na aparat: `NSCameraUsageDescription` w Info.plist apki. Symulator i urządzenie bez aparatu
// skanera nie mają (`isAvailable == false`): zostaje „Mam link”. Zeskanowany tekst idzie tą samą drogą co
// wklejony (`RarogStore.offerPairing(text:)`), więc kończy się arkuszem potwierdzenia.

enum PairingScanner {
  /// Sprzęt umie skanować, a system nie zabronił aparatu (ograniczenia ekranowe).
  @MainActor static var isAvailable: Bool {
    DataScannerViewController.isSupported && DataScannerViewController.isAvailable
  }
}

/// Skaner w miejscu kontrolek, nie w arkuszu (jeden arkusz naraz, a parowanie stoi też w „Ustawieniach”):
/// obraz aparatu w ramce, podpowiedź i zamknięcie. Pierwszy kod QR kończy skan.
struct PairingScannerPanel: View {
  let found: (String) -> Void
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ScannerView(found: found)
        .frame(height: 280)
        .clipShape(.block)
        .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
        .accessibilityLabel(UICopy.scannerTitle)
        .accessibilityIdentifier("pair.scanner")
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(UICopy.scannerHint)
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Button(UICopy.scannerClose, action: close)
          .buttonStyle(NeutralButtonStyle())
          .accessibilityIdentifier("pair.scanner.close")
      }
    }
  }
}

/// `DataScannerViewController` w SwiftUI: tylko kody QR, bez podświetlenia tekstu, skan od razu po pokazaniu.
private struct ScannerView: UIViewControllerRepresentable {
  let found: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
      recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let found: (String) -> Void
    private var done = false

    init(found: @escaping (String) -> Void) {
      self.found = found
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      for item in addedItems {
        guard !done, case let .barcode(code) = item, let payload = code.payloadStringValue else { continue }
        done = true
        dataScanner.stopScanning()
        found(payload)
        return
      }
    }
  }
}

/// Kod QR z tekstu (link parowania dla nowego urządzenia). Ostre piksele: obraz skalowany bez wygładzania.
struct PairingQRCode: View {
  let text: String

  var body: some View {
    if let image = Self.image(text) {
      Image(uiImage: image)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .frame(maxWidth: 240, maxHeight: 240)
        .padding(12)
        // Biała ramka (strefa ciszy) także w ciemnym motywie: skaner czyta ciemne moduły na jasnym tle.
        .background(Color.white, in: .block)
        .accessibilityLabel(UICopy.pairCodeImage)
        .accessibilityIdentifier("pair.code.qr")
    }
  }

  static func image(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
      let cgImage = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return UIImage(cgImage: cgImage)
  }
}
#endif
