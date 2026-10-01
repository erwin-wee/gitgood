/** stdio transport: newline-delimited JSON-RPC messages in, one response line out per request (stdout carries nothing else). */
import { createInterface } from 'node:readline';
import { handleMessage } from './server';

const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = (msg as { id?: unknown } | null)?.id;
  handleMessage(msg).then(
    (res) => res && send(res),
    (err: unknown) => send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
  );
});
