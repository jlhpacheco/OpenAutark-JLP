// The app window: hardened BrowserWindow (sandbox, context isolation, no node), hidden title
// bar with the native window-controls overlay in the header row's colors and height
// (title-bar.ts), app://app/index.html, navigation and window-open guards, bounds persistence
// and crash recovery (window-recovery.ts decides: reload, or stop and tell the person). Closing it
// destroys the renderer (frees its memory); agents keep running in the runtime and the tray stays.
// Feedback 16.11.2026: the caption controls dim while the page says a modal's backdrop dims it (setTitleBarDim; a
// reload starts undimmed), and the feedback shortcut pressed in the page goes to the page as IPC feedbackKey
// (shared/api/workspace-browser-keys.ts FeedbackKey) – read before the page, so it works under every dialog.
// Owner 19.11.2026: load() makes the page without showing the window (the floating bubble's call runs in it), and while
// the page's voice is live (setVoiceLive) its background throttling is off, so a call or dictation goes on hidden;
// onPageGone tells the bubble that a call held by the page ended with it (window closed, renderer gone). Closing the
// window while voice is live only hides it, and the close happens once the voice ends (window-voice.ts); letGo() is
// the quit's and the system's (sign-out, shutdown): from then on a close closes.
// Owns: one BrowserWindow at a time and its event wiring. Never: decides whether closing quits
// the app (desktop.ts does), grants permissions (session-guards.ts), talks RPC.

import { BrowserWindow, dialog, nativeTheme, powerMonitor, screen, shell } from 'electron';
import { IPC } from '../shared/api/desktop.ts';
import type { TitleBarLayout } from '../shared/api/desktop.ts';
import { FeedbackKey } from '../shared/api/workspace-browser-keys.ts';
import type { AppPaths } from './app-paths.ts';
import type { RendererLink } from './renderer-link.ts';
import { mainFrameNavigation, subFrameNavigationAllowed, windowOpenDecision } from './security.ts';
import { titleBarColors, titleBarOverlay, trafficLightPosition } from './title-bar.ts';
import { MIN_HEIGHT, MIN_WIDTH, clampBounds } from './window-state.ts';
import { RendererRecovery, stuckDialog, type CrashStep } from './window-recovery.ts';
import { VoiceHold } from './window-voice.ts';
import type { ThemePreference, WindowState } from './window-state.ts';

export const APP_URL = 'app://app/index.html';

export interface MainWindowDeps {
  paths: AppPaths;
  title: string;
  platform: string;
  devTools: boolean; // F12 / Ctrl+Shift+I in development builds
  renderer: RendererLink;
  state: WindowState;
  saveState(state: WindowState): void;
  onClosed(): void;
  onVisibilityChange(visible: boolean): void;
  onFocus(): void;
  log(line: string): void;
}

export class MainWindow {
  private readonly deps: MainWindowDeps;
  private window: BrowserWindow | null = null;
  private state: WindowState;
  private readonly recovery = new RendererRecovery({ now: () => Date.now() });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The UI's layout (IPC titleBarLayout); a new window starts in columns until its page reports. */
  private captionLayout: TitleBarLayout = 'columns';
  /** A modal's backdrop dims the page (IPC titleBarDim); a new or reloaded page starts undimmed. */
  private captionDim = false;
  /** A window loaded hidden (load) maximizes at its first show – maximize() would show it at once. */
  private maximizeOnShow = false;
  private readonly pageGone = new Set<() => void>();
  private readonly voice = new VoiceHold();

  constructor(deps: MainWindowDeps) {
    this.deps = deps;
    this.state = deps.state;
    nativeTheme.themeSource = this.state.theme ?? 'system';
    nativeTheme.on('updated', () => this.recolor());
    powerMonitor.on('shutdown', () => this.voice.letGo()); // the system ends: a close during a call never holds it up
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  get contentsId(): number | null { return this.browserWindow?.webContents.id ?? null; }
  get mainFrame(): unknown { return this.browserWindow?.webContents.mainFrame ?? null; }
  get focused(): boolean {
    const window = this.browserWindow;
    return Boolean(window && window.isVisible() && !window.isMinimized() && window.isFocused());
  }

  /** Shows the window, creating it when it was closed. */
  show(): void {
    const window = this.browserWindow;
    if (!window) { this.create(true); return; }
    // A renderer that crashed too often (or was killed) stays blank until the user asks again.
    if (window.webContents.isCrashed()) {
      this.recovery.reset();
      void window.loadURL(APP_URL).catch(error => this.deps.log(`window reload failed: ${(error as Error).message}`));
    }
    this.voice.shown(); // brought back: a close that waited for the voice is off
    if (this.maximizeOnShow) { this.maximizeOnShow = false; window.maximize(); }
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  /** Owner 19.11.2026: the page loaded without showing the window (a call from the floating bubble runs in it); an
   *  existing window stays as it is – hidden, minimized or behind. */
  load(): void {
    if (!this.browserWindow) this.create(false);
  }

  /** A call, conversation or dictation of the page is live: its timers keep full speed while the window is hidden,
   *  minimized or behind another app (voice goes on); without voice the page is throttled again. */
  setVoiceLive(on: boolean): void {
    try { this.browserWindow?.webContents.setBackgroundThrottling(!on); } catch { /* window closing */ }
    if (this.voice.setLive(on)) this.browserWindow?.close(); // the close the person asked for while voice was live
  }

  /** A quit is under way (desktop.ts before-quit, an update's quit): a close closes, even while voice is live. */
  letGo(): void { this.voice.letGo(); }

  /** `listener` runs whenever the page is gone – the window closed or its renderer died (a call it held ended with it). */
  onPageGone(listener: () => void): void {
    this.pageGone.add(listener);
  }

  close(): void {
    this.browserWindow?.close();
  }

  /** Applies the appearance preference (native controls, background; the UI styles itself). */
  applyTheme(theme: ThemePreference): void {
    if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
    if (this.state.theme !== theme) {
      this.state = { ...this.state, theme };
      this.deps.saveState(this.state);
    }
    this.recolor();
  }

  /** The page's layout changed (column header row ↔ compact top bar): re-apply the overlay. */
  setTitleBarLayout(layout: TitleBarLayout): void {
    if (layout === this.captionLayout) return;
    this.captionLayout = layout;
    this.recolor();
  }

  /** A modal's backdrop dims the page (true) or none is open: the caption controls follow (title-bar.ts dimmedColors). */
  setTitleBarDim(dim: boolean): void {
    if (dim === this.captionDim) return;
    this.captionDim = dim;
    this.recolor();
  }

  private create(visible: boolean): void {
    const { deps } = this;
    this.captionLayout = 'columns';
    this.captionDim = false;
    this.recovery.reset();
    const bounds = clampBounds(this.state.bounds, screen.getAllDisplays().map(display => display.workArea), screen.getPrimaryDisplay().workArea);
    const dark = nativeTheme.shouldUseDarkColors;
    const mac = deps.platform === 'darwin';
    const window = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      title: deps.title,
      backgroundColor: titleBarColors(dark).color,
      ...(mac ? {} : { icon: deps.paths.icon }),
      titleBarStyle: 'hidden',
      // Expose the same caption geometry on every OS, including the left-hand macOS controls.
      titleBarOverlay: titleBarOverlay(dark, this.captionLayout),
      ...(mac ? { trafficLightPosition: trafficLightPosition() } : {}),
      webPreferences: {
        preload: deps.paths.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: true,
        navigateOnDragDrop: false,
        safeDialogs: true,
        spellcheck: true,
        devTools: deps.devTools,
      },
    });
    this.window = window;
    this.maximizeOnShow = !visible && this.state.maximized === true;
    if (visible && this.state.maximized) window.maximize();
    const contents = window.webContents;
    deps.renderer.attach(contents);

    contents.setWindowOpenHandler(details => {
      const decision = windowOpenDecision(details.url);
      if (decision.openExternal) void shell.openExternal(decision.openExternal).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', event => {
      const decision = mainFrameNavigation(event.url);
      if (decision.allow) return;
      event.preventDefault();
      if (decision.openExternal) void shell.openExternal(decision.openExternal).catch(() => {});
    });
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame) {
        if (!mainFrameNavigation(event.url).allow) event.preventDefault();
      } else if (!subFrameNavigationAllowed(event.url)) {
        event.preventDefault();
      }
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    // A committed main-frame document change (reload) drops the page state. Not did-start-navigation:
    // that also fires for navigations will-navigate cancels (a web link), which would leave the
    // link "loading" forever – pushes queued, readiness lost.
    contents.on('did-navigate', () => { deps.renderer.loading(); this.setTitleBarDim(false); }); // a reloaded page has no dialog open
    contents.on('did-finish-load', () => deps.renderer.finishedLoading());
    contents.on('render-process-gone', (_event, details) => { this.goneNow(); this.recover(details.reason); });
    const feedbackKey = new FeedbackKey(); // the feedback cell's press from the keyboard, also under a modal dialog
    contents.on('before-input-event', (event, input) => {
      const step = feedbackKey.step(input, mac);
      if (!step) return;
      event.preventDefault();
      if (step !== 'swallow') contents.send(IPC.feedbackKey, step);
    });
    if (deps.devTools) {
      contents.on('before-input-event', (_event, input) => {
        const toggle = input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'));
        if (toggle) contents.toggleDevTools();
      });
    }

    window.once('ready-to-show', () => { if (visible && !window.isDestroyed()) window.show(); });
    window.on('show', () => deps.onVisibilityChange(true));
    window.on('hide', () => deps.onVisibilityChange(false));
    window.on('focus', () => deps.onFocus());
    window.on('resize', () => this.scheduleSave());
    window.on('move', () => this.scheduleSave());
    // Windows sign-out/shutdown: the session's end lets go before the windows close (never blocked by the voice hold)
    window.on('query-session-end', () => this.voice.letGo());
    window.on('session-end', () => this.voice.letGo());
    window.on('close', event => {
      this.saveNow();
      if (this.voice.close() === 'close') return;
      event.preventDefault(); // voice is live: the page goes on hidden
      window.hide();
    });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      deps.renderer.detach();
      deps.onVisibilityChange(false);
      this.goneNow();
      deps.onClosed();
    });
    void window.loadURL(APP_URL).catch(error => deps.log(`window load failed: ${(error as Error).message}`));
  }

  private goneNow(): void {
    this.voice.pageGone();
    for (const listener of this.pageGone) { try { listener(); } catch { /* a listener's failure stays its own */ } }
  }

  private recolor(): void {
    const window = this.browserWindow;
    if (!window) return;
    const dark = nativeTheme.shouldUseDarkColors;
    window.setBackgroundColor(titleBarColors(dark).color);
    if (this.deps.platform !== 'darwin') {
      try { window.setTitleBarOverlay(titleBarOverlay(dark, this.captionLayout, this.captionDim)); } catch { /* no overlay on this platform */ }
    }
  }

  /** Renderer gone: reload, or stop and ask after repeated crashes (window-recovery.ts). */
  private recover(reason: string): void {
    this.deps.renderer.loading();
    const step = this.recovery.gone(reason);
    if (step.kind === 'ignore') return;
    this.deps.log(`renderer gone (${reason}): ${step.kind === 'reload' ? 'reload' : `stopped (${step.why})`}`);
    const window = this.browserWindow;
    if (!window) return;
    if (step.kind === 'reload') {
      setTimeout(() => { if (!window.isDestroyed()) void window.loadURL(APP_URL).catch(() => {}); }, step.delayMs).unref?.();
      return;
    }
    this.askAfterCrashes(window, step.why);
  }

  /** The page cannot be shown: say so; "Try again" starts fresh, "Close window" keeps agents running. */
  private askAfterCrashes(window: BrowserWindow, why: Extract<CrashStep, { kind: 'stuck' }>['why']): void {
    const text = stuckDialog(why);
    void dialog.showMessageBox(window, { type: 'warning', title: this.deps.title, message: text.message, detail: text.detail, buttons: text.buttons, defaultId: 0, cancelId: 1, noLink: true })
      .then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 0) { this.recovery.reset(); void window.loadURL(APP_URL).catch(() => {}); } else this.close();
      })
      .catch(error => this.deps.log(`crash dialog failed: ${(error as Error).message}`));
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    const window = this.browserWindow;
    if (!window) return;
    this.state = { ...this.state, bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    this.deps.saveState(this.state);
  }
}
