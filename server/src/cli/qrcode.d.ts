/**
 * Typ jedynej funkcji `qrcode` (MIT, zależność korzenia repo), której używa `rarog pair` (`devices.ts`). Paczka nie
 * niesie własnych typów, a `@types/qrcode` byłoby nową zależnością dla jednej linii.
 */
declare module 'qrcode' {
  const QRCode: {
    toString(text: string, options: { readonly type: 'terminal'; readonly small?: boolean }): Promise<string>;
  };
  export default QRCode;
}
