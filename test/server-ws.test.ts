import { describe, expect, it } from 'vitest';
import { acceptKey, decodeFrame, encodeTextFrame } from '../src/server/ws';

/** Masks a payload the way a browser client must (RFC6455 §5.3) so decodeFrame can be exercised. */
function maskedClientFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  return Buffer.concat([header, mask, masked]);
}

describe('WebSocket framing', () => {
  it('computes the RFC6455 accept key from the spec example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('decodes a masked client text frame back to its payload', () => {
    const frame = decodeFrame(maskedClientFrame('hello'));
    expect(frame).not.toBeNull();
    expect(frame!.opcode).toBe(0x1);
    expect(frame!.payload.toString('utf8')).toBe('hello');
    expect(frame!.size).toBe(frame!.payload.length + 6); // 2 header + 4 mask
  });

  it('recognises a close frame (opcode 0x8)', () => {
    const frame = decodeFrame(maskedClientFrame('', 0x8));
    expect(frame!.opcode).toBe(0x8);
  });

  it('returns null until a whole frame has arrived', () => {
    const full = maskedClientFrame('partial-payload');
    expect(decodeFrame(full.subarray(0, 4))).toBeNull();
    expect(decodeFrame(full)).not.toBeNull();
  });

  it('encodes a server frame with the 126 extended-length path for >125 bytes', () => {
    const text = 'x'.repeat(200);
    const encoded = encodeTextFrame(text);
    expect(encoded[0]).toBe(0x81);
    expect(encoded[1]).toBe(126);
    expect(encoded.readUInt16BE(2)).toBe(200);
    expect(encoded.subarray(4).toString('utf8')).toBe(text);
  });
});
