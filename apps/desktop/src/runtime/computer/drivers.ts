// Desktop control drivers per platform (decision 23.10.2026, concept-native-resilient-computer-use /
// concept-cross-platform-device-connectivity): one JSON-line protocol (protocol.ts) and one helper
// process per PC, so ComputerService, the tools, recipes and linked PCs stay the same everywhere.
//   Windows: UI Automation through resources/computer/windows-helper.ps1 (PowerShell 5.1) – or, whenever the desktop
//            broker is installed and listening (computer/broker.ts), the same protocol from its SYSTEM worker, which
//            also reaches the locked screen and UAC prompts. Chosen at each helper start.
//   Linux:   AT-SPI 2 through resources/computer/linux-helper.py (python3 with python3-gi and
//            gir1.2-atspi-2.0, the desktop accessibility stack); element actions on X11 and Wayland,
//            pointer/keyboard input only on X11 (Wayland answers 'unavailable'); screenshots come from
//            the desktop app's capture. Run with -E -s -B: no PYTHONPATH, no user site packages, no
//            bytecode written next to the scripts.
//   macOS:   the Accessibility API (AXUIElement) and CGEvent input through resources/computer/darwin/autark-mac-helper
//            (Swift, apps/mac-steuerung, universal binary, signed with the app). It runs as a child of the app, so the
//            person's Accessibility permission (TCC) for Autark covers it – and only a stable signature keeps that
//            permission across updates. Without the permission every control op answers 'unavailable' with the way
//            to grant it; screenshots stay with the desktop app's capture (the helper has none).
// Owns: which platform has which driver and how its helper is started. Never: decides permissions
// or human priority (ComputerService), or guesses a platform's abilities it cannot check.

import path from 'node:path';
import type { Logger } from '../contracts.ts';
import type { Supervisor } from '../system/supervisor.ts';
import { WindowsHelper, type HelperClient } from './helper.ts';
import { brokerState, localBroker, type BrokerAccess } from './broker.ts';

/** What a platform's driver can do: element semantics, pointer/keyboard input, and what it needs. */
export interface DriverInfo { name: string; semantic: boolean; input: 'full' | 'x11' | 'none'; needs?: string }

export const DRIVERS: Partial<Record<NodeJS.Platform, DriverInfo>> = {
  win32: { name: 'Windows UI Automation', semantic: true, input: 'full' },
  linux: { name: 'Linux AT-SPI', semantic: true, input: 'x11', needs: 'python3, python3-gi and gir1.2-atspi-2.0' },
  darwin: { name: 'macOS Accessibility (AX)', semantic: true, input: 'full', needs: 'the Accessibility permission for Autark (System Settings › Privacy & Security › Accessibility)' },
};

/** The platform's driver, or undefined when this PC can only be watched (screenshots). */
export function driverFor(platform: NodeJS.Platform): DriverInfo | undefined {
  return DRIVERS[platform];
}

export interface HelperDeps {
  supervisor: Pick<Supervisor, 'spawn'>;
  resourcesDir: string;
  log: Logger;
  /** Path → path the helper's interpreter can read (app.asar.unpacked in a packaged build). */
  unpacked: (file: string) => string;
  /** Python interpreter (default python3). */
  python?: string;
  /** The desktop broker (default: the installed one, computer/broker.ts). */
  broker?: BrokerAccess;
  secureWindows?: boolean;
  allowRequest?: () => boolean;
  /** macOS: the helper binary (default resources/computer/darwin/autark-mac-helper, unpacked from the asar). */
  macHelper?: string;
}

/** The helper process client of `platform` (Windows default, Linux AT-SPI, macOS AX). */
export function createHelper(platform: NodeJS.Platform, deps: HelperDeps): HelperClient {
  const base = { supervisor: deps.supervisor, log: deps.log };
  if (platform === 'darwin') {
    const scriptPath = deps.macHelper ?? deps.unpacked(path.join(deps.resourcesDir, 'computer', 'darwin', 'autark-mac-helper'));
    return new WindowsHelper({
      ...base, scriptPath, command: scriptPath, args: [], startTimeoutMs: 15_000,
      startFailure: {
        exit: 'The macOS computer-use helper could not start: it is part of the app and may be missing or not allowed to run (reinstall the app).',
        timeout: 'The macOS computer-use helper did not start in time.',
        repeated: 'The macOS computer-use helper failed to start several times. Try again in a minute.',
      },
    });
  }
  if (platform === 'linux') {
    const scriptPath = deps.unpacked(path.join(deps.resourcesDir, 'computer', 'linux-helper.py'));
    return new WindowsHelper({
      ...base, scriptPath, command: deps.python ?? 'python3', args: ['-E', '-s', '-B', scriptPath], startTimeoutMs: 20_000,
      startFailure: {
        exit: `The Linux computer-use helper could not start: it needs ${DRIVERS.linux!.needs} (the desktop accessibility stack).`,
        timeout: 'The Linux computer-use helper did not start in time.',
        repeated: 'The Linux computer-use helper failed to start several times. Try again in a minute.',
      },
    });
  }
  const scriptPath = deps.unpacked(path.join(deps.resourcesDir, 'computer', 'windows-helper.ps1'));
  if (deps.secureWindows) {
    // This process never uses the broker transport; the switch is set at launch, not in request args.
    return new WindowsHelper({ ...base, scriptPath, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-DefaultDesktopOnly'] });
  }
  const broker = deps.broker ?? localBroker();
  const supervisor: HelperDeps['supervisor'] = {
    spawn: (input) => {
      if (broker.reachable()) return broker.lease(deps.log);
      brokerState.via = 'powershell';
      brokerState.desktop = undefined;
      deps.log.info('desktop helper selected', { via: 'powershell' });
      return deps.supervisor.spawn(input);
    },
  };
  return new WindowsHelper({ ...base, supervisor, scriptPath, allowRequest: deps.allowRequest });
}
