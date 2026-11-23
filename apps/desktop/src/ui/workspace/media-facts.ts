// Pure helpers of the pane's Media and Video tabs: how a stored file is shown (image, video, audio,
// PDF or any other file, from its type and name) and its one-line facts ("1280×720 · 0:42 · 3.2 MB").
// Owns: these conversions. Never: the DOM or RPC (tested in test/unit/ui/workspace-tabs.test.ts).

import { fileSize } from '../lib/format.ts';

export type ViewKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export function viewKind(mime: string, name: string): ViewKind {
  const type = mime.toLowerCase();
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)) return 'image';
  if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

/** 17.11.2026 (the owner: an agent's .md attachment would not open on the phone): a stored text file the Media tab
 *  shows as its text – Markdown rendered, any other text as it is. By its type or its name; a viewKind 'file' first. */
export type TextKind = 'markdown' | 'plain';
const MARKDOWN_EXT = ['md', 'markdown', 'mdx'];
const PLAIN_EXT = ['txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml', 'ts', 'tsx', 'js', 'mjs', 'py', 'ps1', 'sh', 'sql', 'css', 'html', 'htm', 'srt', 'vtt'];
export function textKind(mime: string, name: string): TextKind | null {
  if (viewKind(mime, name) !== 'file') return null;
  const type = mime.toLowerCase().split(';')[0]!.trim();
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (type === 'text/markdown' || type === 'text/x-markdown' || MARKDOWN_EXT.includes(ext)) return 'markdown';
  if (type.startsWith('text/') || PLAIN_EXT.includes(ext)) return 'plain';
  if (['application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/x-ndjson'].includes(type)) return 'plain';
  return null;
}
/** The most of a text file the Media tab reads (files.read); a longer one says so and offers Save. */
export const TEXT_VIEW_MAX = 2 * 1024 * 1024;

/** "0:42", "3:05", "1:02:09". Whole seconds rounded down, as a player's own clock shows them (14.9 s is 0:14 there and here). */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Measured facts joined by " · "; empty when nothing is known. */
export function mediaFacts(info: { width?: number; height?: number; durationMs?: number; pages?: number; size?: number }): string {
  const parts: string[] = [];
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`);
  if (info.durationMs) parts.push(durationLabel(info.durationMs));
  if (info.pages) parts.push(info.pages === 1 ? '1 page' : `${info.pages} pages`);
  if (info.size !== undefined) parts.push(fileSize(info.size));
  return parts.join(' · ');
}
