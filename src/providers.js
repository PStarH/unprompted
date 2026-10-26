export class UncertainDeliveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UncertainDeliveryError';
  }
}

export class ReadOnlyDeliveryProvider {
  constructor(kind) { this.kind = kind; this.live = true; this.canSend = false; }
  send() { throw new Error('This source is read-only; no delivery was attempted.'); }
  lookup() { return { status: 'unknown', receipt: null, detail: 'This source has no authorized delivery transport.' }; }
  verifyReceipt() { return this.lookup(); }
}

/** Select by the request's source; an Outlook request can never use Gmail. */
export class SourceDeliveryRouter {
  constructor(providers, fallback = new ReadOnlyDeliveryProvider('unavailable')) {
    this.providers = providers; this.fallback = fallback; this.kind = 'connected-sources'; this.live = true;
  }
  forSource(source) { return this.providers[source] || this.fallback; }
}

/**
 * Mail provider contract (async):
 *   kind                        'simulated' | 'gmail'
 *   live                        true when a real external effect is possible
 *   send(payload, options)      -> receipt { id, provider, status, ... }
 *                                  throws UncertainDeliveryError when the
 *                                  provider may or may not have accepted
 *   lookup(idempotencyKey, { receiptId })
 *                               -> { status: 'found'|'not_found'|'unknown', receipt, detail }
 *   verifyReceipt(receipt)      -> { status: 'found'|'not_found'|'unknown', receipt, detail }
 *                                  reads the accepted message back from the
 *                                  provider. An acceptance receipt is not a
 *                                  verification; only this call can claim the
 *                                  message exists.
 *
 * The engine awaits every call, so a synchronous provider is also valid.
 */

/** Writes to a durable local outbox. Never contacts an external service. */
export class SimulatedMailProvider {
  constructor(store) {
    this.store = store;
    this.kind = 'simulated';
    this.live = false;
    this.lookupOverride = null;
  }

  send({ idempotencyKey, to, subject, body, documentUrl }, failureMode = null) {
    const existing = this.store.state.outbox.find(message => message.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    if (failureMode === 'timeout_before_accept') {
      throw new UncertainDeliveryError('The simulated provider timed out before confirming acceptance.');
    }
    const receipt = {
      id: `sim-${this.store.state.outbox.length + 1}`,
      idempotencyKey, to, subject, body, documentUrl,
      acceptedAt: new Date().toISOString(),
      provider: 'simulated-mail',
      status: 'accepted_simulation'
    };
    this.store.mutate(state => { state.outbox.push(receipt); });
    if (failureMode === 'timeout_after_accept') {
      throw new UncertainDeliveryError('The simulated provider accepted the message but the response timed out.');
    }
    return receipt;
  }

  lookup(idempotencyKey) {
    if (this.lookupOverride === 'unknown') return { status: 'unknown' };
    const receipt = this.store.state.outbox.find(message => message.idempotencyKey === idempotencyKey);
    return receipt ? { status: 'found', receipt } : { status: 'not_found' };
  }

  /**
   * Re-read the durable outbox after a send. This is independent of the send
   * call itself: the receipt only counts once it is found in persisted state.
   */
  verifyReceipt(receipt) {
    if (!receipt?.id) return { status: 'unknown', receipt: null, detail: 'The receipt has no id to verify.' };
    const stored = this.store.state.outbox.find(message => message.id === receipt.id || message.idempotencyKey === receipt.idempotencyKey);
    if (!stored) return { status: 'not_found', receipt: null, detail: 'The simulated outbox does not hold this receipt.' };
    return { status: 'found', receipt: stored, detail: 'The durable local outbox holds this receipt.' };
  }
}

/**
 * Adapts the Google Workspace connector to the mail provider contract.
 *
 * Deliberately does NOT fall back to the simulated outbox on failure. A live
 * send that fails must surface as a failure, never as a simulated success.
 */
export class GoogleMailAdapter {
  constructor(connector) {
    if (!connector) throw new Error('GoogleMailAdapter requires a connector');
    this.connector = connector;
    this.kind = 'gmail';
    this.live = true;
  }

  get canSend() { return this.connector.sendEnabled === true && this.connector.shadow === false && this.connector.live === true; }

  async send({ idempotencyKey, to, subject, body, threadId = null }) {
    if (this.connector.shadow) {
      throw new Error('Shadow mode is read-only. Gmail send was not attempted.');
    }
    try {
      const result = await this.connector.execute({ to, subject, body, idempotencyKey, threadId });
      if (!result?.receiptId) {
        throw new Error('Gmail accepted the request but returned no message id; the send cannot be verified.');
      }
      return {
        id: result.receiptId,
        provider: 'gmail',
        status: 'accepted_live',
        messageId: result.messageId,
        threadId: result.threadId,
        idempotencyKey
      };
    } catch (error) {
      // Network faults are ambiguous: the message may have been accepted.
      if (error.retryable) throw new UncertainDeliveryError(`Gmail send outcome is unknown: ${error.message}`);
      throw error;
    }
  }

  /**
   * Read the accepted message back from Gmail by its provider id.
   *
   * A definitive 404 or a transient failure both block completion: the email is
   * never reported as verified on the strength of the send response alone.
   */
  async verifyReceipt(receipt) {
    if (!receipt?.id) return { status: 'unknown', receipt: null, detail: 'Gmail returned no message id, so the message cannot be read back.' };
    const result = await this.connector.verifyMessage(receipt.id);
    if (result.status === 'found') {
      return { status: 'found', receipt: { ...result.receipt, idempotencyKey: receipt.idempotencyKey }, detail: result.detail };
    }
    return { status: result.status, receipt: null, detail: result.detail };
  }

  /**
   * Search the mailbox for this idempotency key. When a receipt id is known,
   * read that message directly first: a search index can lag behind a send,
   * while a direct read cannot.
   */
  async lookup(idempotencyKey, options = {}) {
    if (options.receiptId) {
      try {
        const direct = await this.connector.verifyMessage(options.receiptId);
        if (direct.status === 'found') {
          return { status: 'found', receipt: { ...direct.receipt, idempotencyKey }, detail: direct.detail };
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        // Fall through to the Message-ID search; both paths are read-only.
      }
    }
    const result = await this.connector.verify(idempotencyKey);
    if (result.status === 'found') return { status: 'found', receipt: result.receipt, detail: result.detail };
    return { status: result.status, receipt: null, detail: result.detail };
  }
}

export const providersApi = { UncertainDeliveryError, SimulatedMailProvider, GoogleMailAdapter };
