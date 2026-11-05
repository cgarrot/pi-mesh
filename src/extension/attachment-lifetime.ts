// One owner for work that must not outlive a client/session attachment.
export class AttachmentLifetime {
  private stopped = false;
  private readonly cleanups = new Set<() => void>();

  constructor(private readonly owns: () => boolean = () => true) {}

  get active(): boolean {
    return !this.stopped && this.owns();
  }

  onStop(cleanup: () => void): () => void {
    if (!this.active) {
      cleanup();
      return () => {};
    }
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* one failed cleanup must not strand others */ }
    }
    this.cleanups.clear();
  }

  fork(): AttachmentLifetime {
    const child = new AttachmentLifetime(() => this.active);
    const remove = this.onStop(() => child.stop());
    child.onStop(remove);
    return child;
  }

  after(ms: number, fn: () => void): () => void {
    if (!this.active) return () => {};
    const timer = setTimeout(() => {
      remove();
      if (this.active) fn();
    }, ms);
    timer.unref();
    const remove = this.onStop(() => clearTimeout(timer));
    return () => { clearTimeout(timer); remove(); };
  }

  /** Cancellation settles the continuation as well as clearing its timer. */
  wait(ms: number): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      // A pending control operation retains the loop, as its original sleep did.
      const timer = setTimeout(() => { remove(); resolve(this.active); }, ms);
      const remove = this.onStop(() => { clearTimeout(timer); resolve(false); });
    });
  }
}
