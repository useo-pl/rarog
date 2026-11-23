/**
 * A test certificate authority shaped like Sigstore's Fulcio: it issues signing certificates of a GitHub Actions run
 * (an EC P-256 key, an empty subject and a critical subject alternative name with the given URIs; Fulcio writes the
 * workflow identity there, `https://github.com/<owner>/<repo>/<workflow path>@<ref>`) and hands out the signer of
 * each certificate's key. The code under test checks the issuer and the signature itself, so a test passes this
 * authority's certificate in place of the pinned one. Built here in DER, because Node can parse a certificate but
 * not create one.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** One DER element: tag, length (short or long form up to 64 KiB), contents. */
function der(tag: number, ...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? [body.length]
    : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: readonly Buffer[]): Buffer => der(0x30, ...parts);

function objectId(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const encoded = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) encoded.unshift((value & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const SUBJECT_ALT_NAME = '2.5.29.17';

interface CertificateParts {
  readonly issuer: Buffer;
  readonly subject: Buffer;
  readonly publicKey: KeyObject;
  /** The `[3]` extensions element; absent = none. */
  readonly extensions?: Buffer;
  /** The issuer's private key. */
  readonly signer: KeyObject;
}

/** The DER bytes of a version 3 certificate valid for ten minutes. */
function certificate(parts: CertificateParts): Buffer {
  const algorithm = sequence(objectId(ECDSA_SHA256));
  const validity = sequence(der(0x17, Buffer.from('261105064808Z')), der(0x17, Buffer.from('261105065808Z')));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, parts.issuer, validity,
    parts.subject, parts.publicKey.export({ type: 'spki', format: 'der' }),
    ...(parts.extensions === undefined ? [] : [parts.extensions]),
  );
  const signature = sign('sha256', tbs, parts.signer);
  return sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/** A signing certificate and the signer of its key. */
export interface IssuedCertificate {
  /** DER bytes. */
  readonly certificate: Buffer;
  /** The certificate key's ECDSA signature (DER) over the SHA-256 of `bytes`. */
  sign(bytes: Buffer): Buffer;
}

export interface TestAuthority {
  /** The authority's own certificate, DER. */
  readonly certificate: Buffer;
  /** A signing certificate whose subject alternative name holds `uris` (URI entries, in this order). */
  issue(uris: readonly string[]): IssuedCertificate;
}

/** A fresh authority; two of them have the same name and different keys. */
export function testAuthority(): TestAuthority {
  const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = sequence(der(0x31, sequence(objectId(COMMON_NAME), der(0x0c, Buffer.from('test intermediate')))));
  return {
    certificate: certificate({
      issuer: name, subject: name, publicKey: authority.publicKey, signer: authority.privateKey,
    }),
    issue(uris) {
      const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const names = sequence(...uris.map((uri) => der(0x86, Buffer.from(uri))));
      const altName = sequence(objectId(SUBJECT_ALT_NAME), der(0x01, Buffer.from([0xff])), der(0x04, names));
      return {
        certificate: certificate({
          issuer: name, subject: sequence(), publicKey: leaf.publicKey, extensions: der(0xa3, sequence(altName)),
          signer: authority.privateKey,
        }),
        sign: (bytes) => sign('sha256', bytes, leaf.privateKey),
      };
    },
  };
}
