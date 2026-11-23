// The hidden windows of the main process, built with their Electron seams (desktop.ts wires them):
// keyframes of stored videos in an on-demand hidden window of its own session (MM4,
// media-analyzer.ts) and the light preview copies of videos in another one (17.11.2026, media-preview.ts); one dispose at quit.
// Owns: constructing them and disposing them. Never: shows a window, uses the person's window or
// session, or decides what is analyzed (host services ask).

import { BrowserWindow, session } from 'electron';
import { MediaAnalyzer } from './media-analyzer.ts';
import { electronAnalyzerWindows } from './media-analyzer-window.ts';
import { MediaPreview } from './media-preview.ts';
import { PREVIEW_ORIGIN } from './media-preview-routes.ts';

export interface HiddenWindowsDeps {
  blobsDir: string;
  /** 17.11.2026: main's folder for the video preview copies and the preview page's script (app-paths.ts previews, previewPage). */
  previewDir: string;
  previewScript(): string;
}

export interface HiddenWindows {
  mediaAnalyzer: MediaAnalyzer;
  mediaPreview: MediaPreview;
  dispose(): void;
}

export function hiddenWindows(deps: HiddenWindowsDeps): HiddenWindows {
  const fromPartition = (partition: string, partitionOptions: { cache: boolean }) => session.fromPartition(partition, partitionOptions);
  const mediaAnalyzer = new MediaAnalyzer({ open: electronAnalyzerWindows({ BrowserWindow, fromPartition }), blobsDir: deps.blobsDir });
  const mediaPreview = new MediaPreview({
    open: electronAnalyzerWindows({ BrowserWindow, fromPartition }, { partition: 'wf-media-preview', origin: PREVIEW_ORIGIN }),
    blobsDir: deps.blobsDir, dir: deps.previewDir, script: deps.previewScript,
  });
  return { mediaAnalyzer, mediaPreview, dispose: () => { mediaAnalyzer.dispose(); mediaPreview.dispose(); } };
}
