/**
 * Decodes the `attributedBody` blob Messages.app writes instead of `text` on
 * modern macOS. The blob is an `streamtyped`-encoded NSAttributedString:
 *
 *   04 0B "streamtyped" … "NSString" … 0x2B <length> <utf8>
 *
 * The length is a typedstream-encoded integer: one byte when < 0x80, otherwise
 * 0x81 + uint16-LE or 0x82 + uint32-LE. A printable-run scan returns junk on real
 * blobs (it picks up class names), so the length-prefixed read is the correct one.
 */

const MARKER = 0x2b;

function readTypedstreamLength(buf: Uint8Array, offset: number): { length: number; next: number } | null {
  const first = buf[offset];
  if (first === undefined) return null;
  if (first < 0x80) return { length: first, next: offset + 1 };
  if (first === 0x81) {
    if (offset + 3 > buf.length) return null;
    return { length: (buf[offset + 1] ?? 0) | ((buf[offset + 2] ?? 0) << 8), next: offset + 3 };
  }
  if (first === 0x82) {
    if (offset + 5 > buf.length) return null;
    const length =
      ((buf[offset + 1] ?? 0) | ((buf[offset + 2] ?? 0) << 8) | ((buf[offset + 3] ?? 0) << 16) | ((buf[offset + 4] ?? 0) << 24)) >>> 0;
    return { length, next: offset + 5 };
  }
  return null;
}

export function decodeAttributedBody(input: Uint8Array | ArrayBuffer | Buffer | null | undefined): string | null {
  if (!input) return null;
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
  if (buf.length < 8) return null;

  const needle = new TextEncoder().encode('NSString');
  let classAt = -1;
  outer: for (let i = 0; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    classAt = i;
    break;
  }
  if (classAt < 0) return printableFallback(buf);

  for (let i = classAt + needle.length; i < buf.length; i++) {
    if (buf[i] !== MARKER) continue;
    const len = readTypedstreamLength(buf, i + 1);
    if (!len || len.length === 0) continue;
    const end = len.next + len.length;
    if (end > buf.length) continue;
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(len.next, end));
      if (text.length > 0 && isPlausible(text)) return text;
    } catch {
      /* try the next marker */
    }
  }
  return printableFallback(buf);
}

function isPlausible(text: string): boolean {
  // Reject binary noise: allow everything except control characters other than tab/newline.
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

function printableFallback(buf: Uint8Array): string | null {
  let best = '';
  let current = '';
  for (const byte of buf) {
    if (byte >= 0x20 && byte < 0x7f) current += String.fromCharCode(byte);
    else {
      if (current.length > best.length) best = current;
      current = '';
    }
  }
  if (current.length > best.length) best = current;
  // A plausible message is at least 2 chars and contains no streamtyped keywords.
  if (best.length < 2) return null;
  if (/streamtyped|NSString|NSAttributedString|NSObject/.test(best)) return null;
  return best;
}
