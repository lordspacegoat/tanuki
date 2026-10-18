/**
 * The seam between a credential store that needs a passphrase and the
 * interface that can ask for one.
 *
 * The store cannot draw anything and the interface cannot unlock a vault, so
 * the question is brokered here: the store calls `request`, which parks a
 * promise, and the interface answers it when the user types something. `boot`
 * builds one prompter and hands it to both sides.
 *
 * A **queue**, not a slot. Nothing stops two reads from being in flight — a
 * second `enter` on the configuration list is enough — and a single slot would
 * silently strand the first promise forever. Requests are answered in the order
 * they were asked, so the earliest credential a user reached for is the one
 * they are asked about.
 */
import type { PassphrasePrompt, PassphrasePromptContext } from "./passphrase.ts";

export interface PassphraseRequest {
  readonly context: PassphrasePromptContext;
  /**
   * Distinguishes one prompt from the next, so the interface can give each a
   * fresh field. A retry after a failed attempt is a new request, not the same
   * one with a different message.
   */
  readonly sequence: number;
  /** Supply the passphrase. */
  answer(passphrase: string): void;
  /** Give up. The store sees `null` and the caller is put back where it was. */
  dismiss(): void;
}

export type PassphraseRequestListener = (request: PassphraseRequest | null) => void;

export class PassphrasePrompter {
  private readonly queue: PassphraseRequest[] = [];
  private readonly listeners = new Set<PassphraseRequestListener>();
  private counter = 0;

  /**
   * The `PassphrasePrompt` the store is constructed with. Satisfies the
   * contract exactly: `null` means the user dismissed the question.
   */
  readonly request: PassphrasePrompt = (context: PassphrasePromptContext) =>
    new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        const index = this.queue.indexOf(request);
        if (index !== -1) this.queue.splice(index, 1);
        this.emit();
        resolve(value);
      };

      const request: PassphraseRequest = {
        context,
        sequence: (this.counter += 1),
        answer: (passphrase) => finish(passphrase),
        dismiss: () => finish(null),
      };

      this.queue.push(request);
      this.emit();
    });

  /** The question currently on screen, or null when there is none. */
  get current(): PassphraseRequest | null {
    return this.queue[0] ?? null;
  }

  /**
   * Observes the pending question. The listener is called immediately with the
   * current value, so a component that subscribes late is not left blind.
   */
  subscribe(listener: PassphraseRequestListener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const pending = this.current;
    for (const listener of this.listeners) listener(pending);
  }
}
