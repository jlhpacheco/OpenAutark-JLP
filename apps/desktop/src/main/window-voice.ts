// Owner 19.11.2026 ("Call läuft weiter, wenn man die App verlässt"): closing the app window (X) while the page's voice is
// live – a call, a conversation, a dictation or a recording – only hides it, so the page and its microphone live on (the
// floating bubble's pill shows the call). Once the voice ends while the window is still hidden, the close that was asked
// for happens after all, with the window's normal close behaviour (to the tray, desktop.ts). A quit (tray,
// menu, update, the system) lets go first: from then on a close is a close.
// Owns: that decision (window.ts asks it). Never: touches a window or decides what a close means afterwards.

export class VoiceHold {
  private live = false;
  private waiting = false; // a close was turned into hide and waits for the voice to end
  private released = false;

  /** The person closed the window: 'hide' while voice is live (and nobody quits), else 'close'. */
  close(): 'hide' | 'close' {
    if (!this.live || this.released) return 'close';
    this.waiting = true;
    return 'hide';
  }

  /** The page's voice changed; true when the close that waited for it is due now. */
  setLive(on: boolean): boolean {
    this.live = on;
    if (on || !this.waiting) return false;
    this.waiting = false;
    return true;
  }

  /** The person brought the window back: the close that waited is off. */
  shown(): void { this.waiting = false; }

  /** The page is gone (closed, renderer died): its voice is over. */
  pageGone(): void { this.live = false; this.waiting = false; }

  /** A quit is under way: every close from now on closes. */
  letGo(): void { this.released = true; }
}
