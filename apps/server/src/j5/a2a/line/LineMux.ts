// @effect-diagnostics nodeBuiltinImport:off
import * as NodeStream from "node:stream";

/**
 * Many byte streams over one line. The storing server opens a stream for each HTTP connection it
 * makes to the poller; the poller answers each by connecting to its own server. The frames know
 * nothing about HTTP: Node writes and parses it at both ends.
 *
 * A frame is one binary WebSocket message: a type byte, a stream id (u32, big-endian), then data.
 */
export const FrameType = {
  open: 1,
  data: 2,
  /** No more data in this direction, sent after any data queued before it. */
  end: 3,
  /** The stream is gone in both directions; only that stream. */
  reset: 4,
  ping: 5,
  pong: 6,
} as const;
type FrameType = (typeof FrameType)[keyof typeof FrameType];

const HEADER_BYTES = 5;

export const encodeFrame = (type: FrameType, id: number, data?: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(HEADER_BYTES + (data?.byteLength ?? 0));
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, id);
  if (data !== undefined) frame.set(data, HEADER_BYTES);
  return frame;
};

export const decodeFrame = (
  frame: Uint8Array,
): { readonly type: number; readonly id: number; readonly data: Uint8Array } | null => {
  if (frame.byteLength < HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    type: view.getUint8(0),
    id: view.getUint32(1),
    data: frame.subarray(HEADER_BYTES),
  };
};

export interface LineMuxOptions {
  /**
   * Sends one frame. `sent` is called once the frame has left this process, or at once where the
   * transport cannot tell; a stream's next write waits for it.
   */
  readonly send: (frame: Uint8Array, sent: (error?: Error | null) => void) => void;
  /** A stream the other side opened. Only the poller's side accepts them. */
  readonly onOpen?: (stream: LineStream) => void;
  /** A stream holding more unread bytes than this is reset, so a stalled reader fails visibly. */
  readonly maxUnreadBytes: number;
}

// @effect-diagnostics-next-line extendsNativeError:off -- a Node stream's destroy error, handed to Node callbacks.
export class LineClosedError extends Error {
  override readonly name = "LineClosedError";
}

export class LineMux {
  readonly #streams = new Map<number, LineStream>();
  #nextId = 1;
  #closed: Error | null = null;

  readonly options: LineMuxOptions;

  constructor(options: LineMuxOptions) {
    this.options = options;
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** A new stream to the other side, usable at once; its open frame goes first. */
  open(): LineStream {
    if (this.#closed !== null) throw this.#closed;
    const id = this.#nextId++;
    const stream = new LineStream(this, id);
    this.#streams.set(id, stream);
    this.options.send(encodeFrame(FrameType.open, id), () => undefined);
    return stream;
  }

  receive(frame: Uint8Array): void {
    if (this.#closed !== null) return;
    const decoded = decodeFrame(frame);
    if (decoded === null) return;
    const { type, id, data } = decoded;
    switch (type) {
      case FrameType.ping:
        this.options.send(encodeFrame(FrameType.pong, 0), () => undefined);
        return;
      case FrameType.pong:
        return;
      case FrameType.open: {
        if (this.options.onOpen === undefined || this.#streams.has(id)) {
          this.options.send(encodeFrame(FrameType.reset, id), () => undefined);
          return;
        }
        const stream = new LineStream(this, id);
        this.#streams.set(id, stream);
        this.options.onOpen(stream);
        return;
      }
    }
    // Data for a stream already reset here is dropped; the reset already told the other side.
    const stream = this.#streams.get(id);
    if (stream === undefined) return;
    switch (type) {
      case FrameType.data:
        stream.push(Buffer.from(data));
        if (stream.readableLength > this.options.maxUnreadBytes) {
          stream.destroy(new Error("The line stream's reader fell too far behind."));
        }
        return;
      case FrameType.end:
        stream.push(null);
        return;
      case FrameType.reset:
        stream.resetByPeer();
        return;
    }
  }

  /** Ends the line: every stream is destroyed with `error`, and nothing opens on it again. */
  close(error: Error): void {
    if (this.#closed !== null) return;
    this.#closed = error;
    // Each stream leaves the map as it is destroyed, so iterate over a copy.
    for (const stream of Array.from(this.#streams.values())) stream.lineClosed(error);
    this.#streams.clear();
  }

  /** @internal */
  sendData(id: number, chunk: Uint8Array, sent: (error?: Error | null) => void): void {
    if (this.#closed !== null) {
      sent(this.#closed);
      return;
    }
    this.options.send(encodeFrame(FrameType.data, id, chunk), sent);
  }

  /** @internal */
  sendEnd(id: number): void {
    if (this.#closed === null) this.options.send(encodeFrame(FrameType.end, id), () => undefined);
  }

  /** @internal */
  forget(id: number, tellPeer: boolean): void {
    if (!this.#streams.delete(id)) return;
    if (tellPeer && this.#closed === null) {
      this.options.send(encodeFrame(FrameType.reset, id), () => undefined);
    }
  }
}

/**
 * One stream over a line. Node's HTTP client takes it as its socket, so it answers the socket
 * methods the client calls; none of them mean anything over a line.
 */
export class LineStream extends NodeStream.Duplex {
  #resetByPeer = false;
  #lineClosed = false;

  readonly mux: LineMux;
  readonly id: number;

  constructor(mux: LineMux, id: number) {
    super({ allowHalfOpen: true });
    this.mux = mux;
    this.id = id;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.mux.sendData(this.id, chunk, (error) => callback(error ?? null));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.mux.sendEnd(this.id);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // Both directions ended cleanly: the other side already has everything, so nothing to reset.
    const finished = error === null && this.writableFinished && this.readableEnded;
    this.mux.forget(this.id, !finished && !this.#resetByPeer && !this.#lineClosed);
    callback(error);
  }

  /** @internal */
  resetByPeer(): void {
    this.#resetByPeer = true;
    this.destroy(new Error("The other side reset the line stream."));
  }

  /** @internal */
  lineClosed(error: Error): void {
    this.#lineClosed = true;
    this.destroy(error);
  }

  setKeepAlive(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback !== undefined) this.once("timeout", callback);
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}
