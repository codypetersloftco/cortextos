import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { StdioJsonRpcClient } from '../../../src/utils/stdio-json-rpc-client.js';

/**
 * The stdio transport for codex-app-server (codex >= 0.98): newline-delimited
 * JSON-RPC over a child process's stdin/stdout. These tests drive the client
 * against in-memory PassThrough streams standing in for the child's pipes.
 */
function makePair() {
  const toChild = new PassThrough(); // client writes here (child stdin)
  const fromChild = new PassThrough(); // client reads here (child stdout)
  const client = new StdioJsonRpcClient(toChild, fromChild);
  return { client, toChild, fromChild };
}

function written(stream: PassThrough): string {
  return stream.read()?.toString() ?? '';
}

describe('StdioJsonRpcClient', () => {
  it('writes a newline-delimited JSON-RPC request to stdin', async () => {
    const { client, toChild } = makePair();
    await client.connect();
    client.request('initialize', { a: 1 });
    const out = written(toChild);
    expect(out.endsWith('\n')).toBe(true);
    const msg = JSON.parse(out.trim());
    expect(msg).toMatchObject({ id: 1, method: 'initialize', params: { a: 1 } });
  });

  it('resolves a pending request when a matching id response arrives on stdout', async () => {
    const { client, fromChild } = makePair();
    await client.connect();
    const p = client.request('thread/start', {});
    fromChild.write(JSON.stringify({ id: 1, result: { thread: { id: 't1' } } }) + '\n');
    const res = await p;
    expect(res.result).toEqual({ thread: { id: 't1' } });
  });

  it('rejects a pending request on a JSON-RPC error response', async () => {
    const { client, fromChild } = makePair();
    await client.connect();
    const p = client.request('turn/start', {});
    fromChild.write(JSON.stringify({ id: 1, error: { code: -32000, message: 'boom' } }) + '\n');
    await expect(p).rejects.toThrow('boom');
  });

  it('routes server-initiated notifications to onMessage handlers', async () => {
    const { client, fromChild } = makePair();
    const handler = vi.fn();
    client.onMessage(handler);
    await client.connect();
    fromChild.write(JSON.stringify({ method: 'turn/completed', params: { ok: true } }) + '\n');
    // allow the stream 'data' event to flush
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ method: 'turn/completed' }));
  });

  it('reassembles a JSON message split across two stdout chunks', async () => {
    const { client, fromChild } = makePair();
    await client.connect();
    const p = client.request('m', {});
    const full = JSON.stringify({ id: 1, result: { v: 42 } }) + '\n';
    fromChild.write(full.slice(0, 10));
    fromChild.write(full.slice(10));
    const res = await p;
    expect(res.result).toEqual({ v: 42 });
  });

  it('rejects in-flight requests when the stream closes', async () => {
    const { client, fromChild } = makePair();
    await client.connect();
    const p = client.request('m', {});
    fromChild.emit('close');
    await expect(p).rejects.toThrow(/closed/);
  });

  it('refuses to send before connect()', () => {
    const { client } = makePair();
    expect(() => client.notify('x')).toThrow(/not connected/);
  });
});
