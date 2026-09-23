import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Computes the RFC6455 `Sec-WebSocket-Accept` response value for a client key. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/** Encodes a server→client text frame (unmasked, single FIN frame). */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** A control/close frame with an optional 2-byte status code (server→client, unmasked). */
export function encodeCloseFrame(code = 1000): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  /** Total bytes consumed from the input buffer for this frame. */
  size: number;
}

/**
 * Decodes the first complete WebSocket frame from `buf`, or null when more
 * bytes are needed. Client frames are always masked (RFC6455 §5.1); we unmask
 * so control frames (close/ping) can be handled. Fragmentation is not
 * reassembled — the browser client only ever sends control frames here.
 */
export function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const raw = buf.subarray(offset, offset + len);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = mask ? raw[i] ^ mask[i & 3] : raw[i];
  return { opcode: buf[0] & 0x0f, payload, size: offset + len };
}

/** Clients only send control frames (close/ping), whose payload RFC6455 caps at 125 bytes. */
const MAX_CLIENT_PAYLOAD = 125;

/**
 * Whether a (possibly partial) client frame header already breaks the rules
 * clients must follow: unmasked (§5.1), or declaring more than a control frame
 * may carry. Checked before buffering, so a hostile header cannot make the
 * server hold an arbitrarily large partial frame.
 */
export function frameRejected(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  return (buf[1] & 0x80) === 0 || (buf[1] & 0x7f) > MAX_CLIENT_PAYLOAD;
}

/** One live browser connection; the hub broadcasts events to every open socket. */
class WsConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private open = true;

  constructor(
    readonly clientId: string,
    private readonly socket: Duplex,
    private readonly onGone: (conn: WsConnection) => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.destroy());
    socket.on('error', () => this.destroy());
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (frameRejected(this.buffer)) {
        this.socket.destroy();
        this.destroy();
        return;
      }
      const frame = decodeFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.size);
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) this.socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload])); // pong
    }
  }

  send(text: string): void {
    if (this.open) this.socket.write(encodeTextFrame(text));
  }

  close(): void {
    if (!this.open) return;
    try {
      this.socket.write(encodeCloseFrame());
    } catch {
      // socket may already be gone
    }
    this.socket.end();
    this.destroy();
  }

  private destroy(): void {
    if (!this.open) return;
    this.open = false;
    this.onGone(this);
  }
}

/** Tracks connected `/events` sockets and fans out event frames to all of them. */
export class WsHub {
  private readonly connections = new Set<WsConnection>();

  /** Completes the RFC6455 handshake on an upgraded socket, registers it under `clientId`, and calls `onClose` when it goes away. */
  accept(req: IncomingMessage, socket: Duplex, clientId: string, onClose: () => void): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '\r\n'].join('\r\n'));
    this.connections.add(
      new WsConnection(clientId, socket, (conn) => {
        this.connections.delete(conn);
        onClose();
      }),
    );
  }

  /** Whether a client (by the id its page connected with) has an open socket. */
  has(clientId: string): boolean {
    for (const conn of this.connections) if (conn.clientId === clientId) return true;
    return false;
  }

  broadcast(text: string): void {
    for (const conn of this.connections) conn.send(text);
  }

  closeAll(): void {
    for (const conn of this.connections) conn.close();
  }
}
