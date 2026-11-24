// Which helper process a computer step runs through (Secure-Gate 20.11.2026, Konrad): in Trust AI mode the normal helper,
// on Windows with the broker route and the helper's Guard (on macOS the AX helper with its Guard, 24.11.2026); in Secure mode on Windows a helper of its own, started with
// -DefaultDesktopOnly, that checks before every request that its desktop is 'Default' and receives input (no lock
// screen, UAC or Ctrl-Alt-Del) and has no broker route. The mode is read per call; a call that started in Trust and
// finds Secure on when it returns is refused.
// Owns: the two clients, the choice per call and the helper's Guard from the security settings. Never: decides a
// capability (security/policy.ts), validates coordinates or acts itself (service.ts).

import type { Logger, RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { CLOSED_GUARD, withGuardConfig, type HelperClient, type HelperGuard } from './helper.ts';
import { guardConfig, WINDOWS_DESKTOP_REFUSAL } from '../security/policy.ts';
import { createHelper, type HelperDeps } from './drivers.ts';

export interface HelperRouteDeps {
  platform: NodeJS.Platform;
  supervisor: HelperDeps['supervisor'];
  resourcesDir: string;
  log: Logger;
  unpacked: (file: string) => string;
  /** A given helper (tests): used for both modes. */
  helper?: HelperClient;
  services?: () => RuntimeServices;
  /** Whether this call runs in Secure mode's Windows helper (ComputerService.usesSecureWindowsHelper). */
  secure: () => boolean;
}

export class HelperRoute {
  private trust: HelperClient | undefined;
  private secureClient: HelperClient | undefined;
  private trustGuarded: HelperClient | undefined;
  private secureGuarded: HelperClient | undefined;

  private readonly deps: HelperRouteDeps;

  constructor(deps: HelperRouteDeps) { this.deps = deps; this.trust = deps.helper; }

  /** One client for the service: each call goes to the helper of the mode in force when it starts. */
  client(): HelperClient {
    return {
      call: async <T>(...args: Parameters<HelperClient['call']>) => {
        const secure = this.deps.secure();
        const result = await this.active(secure).call<T>(...args);
        if (!secure && this.deps.secure()) throw new WorkforceError('forbidden', WINDOWS_DESKTOP_REFUSAL);
        return result;
      },
      running: () => this.active(this.deps.secure()).running(),
      dispose: () => this.dispose(),
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([this.trust?.dispose(), this.secureClient === this.trust ? undefined : this.secureClient?.dispose()]);
  }

  private active(secure: boolean): HelperClient {
    const { platform, supervisor, resourcesDir, log, unpacked } = this.deps;
    const base = { supervisor, resourcesDir, log, unpacked };
    if (secure) {
      this.secureClient ??= this.deps.helper ?? createHelper(platform, { ...base, secureWindows: true });
      return this.secureGuarded ??= withGuardConfig(this.secureClient, () => this.guard() ?? CLOSED_GUARD);
    }
    this.trust ??= createHelper(platform, { ...base, allowRequest: () => !this.deps.secure() });
    // The Windows and the macOS helper both keep the Guard (Autark's own windows, the allowed apps); Linux has none yet.
    return platform === 'win32' || platform === 'darwin' ? this.trustGuarded ??= withGuardConfig(this.trust, () => this.guard()) : this.trust;
  }

  /** Sicher-Runde: the helper's guard from the security settings (undefined before the runtime is wired); settings that cannot be read close input (fail closed). */
  private guard(): HelperGuard | undefined {
    let services: RuntimeServices | undefined;
    try { services = this.deps.services?.(); } catch { services = undefined; }
    if (!services?.security) return undefined;
    const pids = [services.host?.app?.pid, process.pid, process.ppid].filter((pid): pid is number => typeof pid === 'number');
    try { return guardConfig(services.security.current(), pids, services.security.openApps?.() ?? []); }
    catch { return { ...CLOSED_GUARD, appPids: pids }; }
  }
}
