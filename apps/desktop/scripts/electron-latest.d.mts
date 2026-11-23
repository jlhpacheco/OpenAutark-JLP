// Types of scripts/electron-latest.mjs (keeps Electron at the newest stable release).

export function parse(version: unknown): [number, number, number] | null;
export function plan(current: string, latest: string): { behind: boolean; majors: number[] };
export function headlines(markdown: string, major: number): string[];
