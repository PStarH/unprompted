/** Local HTTP boundary helpers. These limits are transport safeguards only. */

export class HttpRequestError extends Error {
  constructor(message, { status = 400, closeConnection = false } = {}) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

/** Read one bounded JSON request body with both idle and total time limits. */
export async function readJsonBody(req, {
  maxBytes = 1024 * 1024,
  timeoutMs = 30_000,
  idleTimeoutMs = 10_000
} = {}) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpRequestError('Expected application/json', {
      closeConnection: req.complete !== true
    });
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpRequestError('Request too large', { status: 413, closeConnection: true });
  }

  return new Promise((resolve, reject) => {
    let complete = false;
    let bodyBytes = 0;
    const chunks = [];
    let totalTimer;
    let idleTimer;

    const cleanup = () => {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
    };
    const fail = error => {
      if (complete) return;
      complete = true;
      cleanup();
      reject(error);
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new HttpRequestError('Request body timed out while waiting for data.', {
        status: 408,
        closeConnection: true
      })), idleTimeoutMs);
    };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bodyBytes + buffer.length > maxBytes) {
        fail(new HttpRequestError('Request too large', { status: 413, closeConnection: true }));
        return;
      }
      bodyBytes += buffer.length;
      chunks.push(buffer);
      resetIdleTimer();
    };
    const onEnd = () => {
      if (complete) return;
      complete = true;
      cleanup();
      const raw = Buffer.concat(chunks, bodyBytes).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpRequestError('Request body is not valid JSON.')); }
    };
    const onAborted = () => fail(new HttpRequestError('Request body was interrupted.', {
      status: 400,
      closeConnection: true
    }));
    const onError = () => fail(new HttpRequestError('Could not read the request body.', {
      status: 400,
      closeConnection: true
    }));

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    totalTimer = setTimeout(() => fail(new HttpRequestError('Request body exceeded its time limit.', {
      status: 408,
      closeConnection: true
    })), timeoutMs);
    resetIdleTimer();
  });
}

const safePositiveInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? Math.round(number)
    : fallback;
};

/**
 * Bounded SSE fanout for full-state snapshots. A blocked client gets at most
 * one pending latest snapshot; older snapshots are redundant and are replaced.
 * A client which exceeds configured frame or memory limits is closed.
 */
export class SseHub {
  constructor({
    maxClients = 32,
    maxFrameBytes = 8 * 1024 * 1024,
    maxBufferedBytes = 10 * 1024 * 1024,
    maxTotalBufferedBytes = 64 * 1024 * 1024,
    heartbeatMs = 20_000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    onError = () => {}
  } = {}) {
    this.maxClients = safePositiveInt(maxClients, 32, 1, 4096);
    this.maxFrameBytes = safePositiveInt(maxFrameBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
    this.maxBufferedBytes = Math.max(this.maxFrameBytes, safePositiveInt(maxBufferedBytes, 10 * 1024 * 1024, 1024, 128 * 1024 * 1024));
    this.maxTotalBufferedBytes = safePositiveInt(maxTotalBufferedBytes, 64 * 1024 * 1024, 1024, 512 * 1024 * 1024);
    this.heartbeatMs = safePositiveInt(heartbeatMs, 20_000, 1000, 10 * 60_000);
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.onError = onError;
    this.clients = new Map();
    this.totalBufferedBytes = 0;
    this.closed = false;
    this.heartbeat = this.setIntervalFn(() => this.#heartbeat(), this.heartbeatMs);
    this.heartbeat?.unref?.();
  }

  #frame(state) {
    const json = JSON.stringify(state);
    if (typeof json !== 'string') return null;
    const payloadBytes = Buffer.byteLength(json);
    const frameBytes = payloadBytes + 8; // `data: ` plus the SSE record terminator.
    if (frameBytes > this.maxFrameBytes || frameBytes > this.maxBufferedBytes) return null;
    const frame = Buffer.allocUnsafe(frameBytes);
    frame.write('data: ', 0, 6, 'ascii');
    frame.write(json, 6, payloadBytes, 'utf8');
    frame.write('\n\n', 6 + payloadBytes, 2, 'ascii');
    return frame;
  }

  #reject(res, status, message) {
    try {
      res.once('error', () => {});
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '10',
        connection: 'close'
      });
      res.end(`${message}\n`);
    } catch {
      try { res.destroy(); } catch { /* already gone */ }
    }
  }

  add(req, res, initialState) {
    if (this.closed) {
      this.#reject(res, 503, 'The event stream is shutting down.');
      return false;
    }
    if (this.clients.size >= this.maxClients) {
      this.#reject(res, 503, 'The event stream reached its connection limit.');
      return false;
    }

    let initialFrame;
    try { initialFrame = this.#frame(initialState); }
    catch {
      this.#reject(res, 500, 'The current workspace snapshot could not be encoded.');
      this.#reportError();
      return false;
    }
    if (!initialFrame) {
      this.#reject(res, 503, 'The current workspace snapshot exceeds the event stream limit.');
      return false;
    }
    if (this.totalBufferedBytes + initialFrame.byteLength > this.maxTotalBufferedBytes) {
      this.#reject(res, 503, 'The event stream reached its shared buffer limit.');
      return false;
    }

    const client = {
      req,
      res,
      blocked: false,
      pending: null,
      bufferedBytes: 0,
      disposed: false,
      onClose: null,
      onError: null,
      onDrain: null,
      onAborted: null
    };
    client.onClose = () => this.#dispose(client, false);
    client.onError = () => this.#dispose(client, true);
    client.onDrain = () => {
      if (client.disposed) return;
      client.blocked = false;
      this.#pump(client);
    };
    client.onAborted = () => this.#dispose(client, true);

    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.flushHeaders?.();
      this.clients.set(res, client);
      res.once('close', client.onClose);
      res.once('error', client.onError);
      res.on('drain', client.onDrain);
      req.once('aborted', client.onAborted);
      this.#write(client, initialFrame, true);
    } catch {
      this.#dispose(client, true);
      this.#reportError();
      return false;
    }
    return true;
  }

  publish(state) {
    if (this.closed || this.clients.size === 0) return;
    let frame;
    try { frame = this.#frame(state); }
    catch {
      this.#reportError();
      return;
    }
    if (!frame) {
      for (const client of [...this.clients.values()]) this.#dispose(client, true);
      return;
    }
    for (const client of [...this.clients.values()]) this.#offer(client, frame);
  }

  #offer(client, frame) {
    if (client.disposed) return;
    if (client.blocked || client.pending) {
      this.#replacePending(client, frame);
      return;
    }
    if (client.bufferedBytes + frame.byteLength > this.maxBufferedBytes) {
      this.#replacePending(client, frame);
      return;
    }
    if (this.totalBufferedBytes + frame.byteLength > this.maxTotalBufferedBytes) {
      this.#dispose(client, true);
      return;
    }
    this.#write(client, frame, true);
  }

  #replacePending(client, frame) {
    if (client.disposed) return;
    const bytes = frame.byteLength;
    const oldBytes = client.pending?.byteLength || 0;
    if (client.bufferedBytes - oldBytes + bytes > this.maxBufferedBytes ||
        this.totalBufferedBytes - oldBytes + bytes > this.maxTotalBufferedBytes) {
      this.#dispose(client, true);
      return;
    }
    client.bufferedBytes += bytes - oldBytes;
    this.totalBufferedBytes += bytes - oldBytes;
    client.pending = frame;
  }

  #write(client, frame, account = true) {
    if (client.disposed) return;
    const bytes = frame.byteLength;
    if (account) {
      if (client.bufferedBytes + bytes > this.maxBufferedBytes ||
          this.totalBufferedBytes + bytes > this.maxTotalBufferedBytes) {
        this.#dispose(client, true);
        return;
      }
      client.bufferedBytes += bytes;
      this.totalBufferedBytes += bytes;
    }
    let writable;
    try {
      writable = client.res.write(frame, error => {
        if (client.disposed) return;
        client.bufferedBytes = Math.max(0, client.bufferedBytes - bytes);
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - bytes);
        if (error) this.#dispose(client, true);
        else this.#pump(client);
      });
    } catch {
      if (!client.disposed) {
        client.bufferedBytes = Math.max(0, client.bufferedBytes - bytes);
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - bytes);
        this.#dispose(client, true);
      }
      this.#reportError();
      return;
    }
    if (!writable) client.blocked = true;
  }

  #pump(client) {
    if (client.disposed || client.blocked || !client.pending) return;
    const frame = client.pending;
    client.pending = null;
    // The bytes were accounted when this latest snapshot entered the pending slot.
    this.#write(client, frame, false);
  }

  #heartbeat() {
    if (this.closed) return;
    const frame = Buffer.from(': keep-alive\n\n');
    for (const client of [...this.clients.values()]) {
      if (client.disposed || client.blocked || client.pending) continue;
      if (client.bufferedBytes + frame.byteLength > this.maxBufferedBytes ||
          this.totalBufferedBytes + frame.byteLength > this.maxTotalBufferedBytes) continue;
      this.#write(client, frame, true);
    }
  }

  #dispose(client, destroy) {
    if (client.disposed) return;
    client.disposed = true;
    this.clients.delete(client.res);
    this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - client.bufferedBytes);
    client.bufferedBytes = 0;
    client.pending = null;
    client.res.removeListener('close', client.onClose);
    client.res.removeListener('error', client.onError);
    client.res.removeListener('drain', client.onDrain);
    client.req.removeListener('aborted', client.onAborted);
    // A callback or socket can report a second error after disposal. Keep one
    // inert listener so that late transport events cannot become uncaught.
    client.res.on('error', () => {});
    if (destroy) {
      try { client.res.destroy(); } catch { /* already gone */ }
    }
  }

  #reportError() {
    try { this.onError(); } catch { /* diagnostics must not affect request handling */ }
  }

  stats() {
    let pendingBytes = 0;
    let blockedClients = 0;
    for (const client of this.clients.values()) {
      pendingBytes += client.pending?.byteLength || 0;
      if (client.blocked) blockedClients += 1;
    }
    return {
      clients: this.clients.size,
      bufferedBytes: this.totalBufferedBytes,
      pendingBytes,
      blockedClients,
      maxClients: this.maxClients,
      maxBufferedBytes: this.maxBufferedBytes,
      maxTotalBufferedBytes: this.maxTotalBufferedBytes
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearIntervalFn(this.heartbeat);
    for (const client of [...this.clients.values()]) this.#dispose(client, true);
  }
}
