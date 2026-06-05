import type { Readable, Writable } from 'stream';

export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
type MessageHandler = (message: JsonRpcMessage) => void;

interface PendingRequest {
  resolve: (message: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal stdio JSON-RPC client for codex-app-server (codex-cli >= 0.98).
 *
 * codex 0.98.0 dropped the `--listen unix://` WebSocket-framed socket transport;
 * `codex app-server` now speaks newline-delimited JSON-RPC over its own
 * stdin/stdout. This client writes one `JSON.stringify(message)\n` per call to
 * the child's stdin and parses newline-delimited JSON from its stdout. The
 * JSON-RPC routing (pending-request map, notification fan-out, error frames) is
 * identical to the retired WsUnixJsonRpcClient — only the framing changed.
 *
 * Uses Node built-ins only so the adapter adds no runtime deps.
 */
export class StdioJsonRpcClient {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private handlers: MessageHandler[] = [];
  private lineBuffer = '';
  private connected = false;
  private onStdoutData = (chunk: Buffer | string): void => {
    this.lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let newlineIdx: number;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx);
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
      this.parseLine(line);
    }
  };

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
  ) {}

  // Symmetry with WsUnixJsonRpcClient.connect(): the child process and its pipes
  // are already live by the time this is called (the spawner created them), so
  // there is no handshake — just start consuming stdout. Returns a resolved
  // promise so call sites can `await` it uniformly.
  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.stdout.on('data', this.onStdoutData);
    this.stdout.on('close', () => this.rejectAll(new Error('codex app-server stdout closed')));
    this.stdout.on('error', (err) => this.rejectAll(err));
  }

  close(): void {
    if (!this.connected) {
      this.rejectAll(new Error('codex app-server stdio closed'));
      return;
    }
    this.connected = false;
    this.stdout.off('data', this.onStdoutData);
    this.rejectAll(new Error('codex app-server stdio closed'));
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<JsonRpcResponse<T>> {
    if (!this.connected) {
      return Promise.reject(new Error('codex app-server stdio is not connected'));
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, params };
    return new Promise<JsonRpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => resolve(response as JsonRpcResponse<T>),
        reject,
        timer,
      });
      this.send(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    this.send({ id, error: { code, message, data } });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.connected) {
      throw new Error('codex app-server stdio is not connected');
    }
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private parseLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (err) {
      for (const handler of this.handlers) {
        handler({
          method: '_parse_error',
          params: { line, error: (err as Error).message },
        } as unknown as JsonRpcMessage);
      }
      return;
    }

    if ('id' in message && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if ('error' in message && message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message as JsonRpcResponse);
      }
      return;
    }

    for (const handler of this.handlers) {
      handler(message);
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
