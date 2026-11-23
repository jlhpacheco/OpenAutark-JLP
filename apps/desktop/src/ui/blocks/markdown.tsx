// Hardened Markdown for agent text: marked (GFM) → DOMPurify → innerHTML, plus a delegated
// click handler so links open through the host, '#…' links navigate in the app (never by their
// URL) and remote images load
// only on click. B-081: an absolute path as a link target or code span – and since 20.11.2026 one
// written bare in the text – is a file chip carrying `data-path`, and a click, tap or Enter on it
// opens it in the side pane or the chat's area (path-links.ts; the message body's `data-author`
// names whose PC to try first) – not while text is selected, so selecting still copies. Inside a
// button or label (<Inline> in an option or card) the control keeps its click: the path is plain text.
// Owns: the sanitizer config, the small render cache, <Markdown> and <Inline>.
// Never: lets raw HTML, scripts, styles, forms, iframes or non-http(s)/mailto links through (a path
// is never an href), or fetches remote images without a click (no exfiltration beacons from agent text).

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { navigate, parseRoute } from '../lib/router.ts';
import { openPathLink, pathExtension, pathRenderer, pathTokenizer, plainInControl } from '../workspace/path-links.ts';
import { pathStart } from '../workspace/path-text.ts';
import { openLink } from './host.ts';

const marked = new Marked({ gfm: true, breaks: false, async: false });

// Raw HTML in agent Markdown is shown as text, never parsed as HTML.
marked.use({
  renderer: {
    html(token) { return escapeHtml(token.text); },
  },
});
// Links, code spans and bare text that hold an absolute path become a file chip with data-path instead of an href.
marked.use({ renderer: pathRenderer, tokenizer: pathTokenizer, extensions: [pathExtension] });

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

const SAFE_URI = /^(?:https?:|mailto:|#)/i;

let hooked = false;
function purifier(): typeof DOMPurify {
  if (hooked) return DOMPurify;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    const el = node as Element;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!SAFE_URI.test(href)) el.removeAttribute('href');
      el.setAttribute('rel', 'noopener noreferrer');
      el.removeAttribute('target');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) {
        // Remote images are click-to-load: keep the URL in a data attribute only.
        el.setAttribute('data-remote-src', src);
        el.removeAttribute('src');
        el.setAttribute('alt', el.getAttribute('alt') || 'Image');
        el.classList.add('md-remote-image');
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('title', 'Load image');
      } else if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) {
        el.removeAttribute('src');
      }
    }
    if (el.hasAttribute('data-path')) { // set here: the URI check above drops tabindex="0"
      el.setAttribute('role', 'link');
      el.setAttribute('tabindex', '0');
    }
    if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') el.remove();
    if (el.tagName === 'INPUT') el.setAttribute('disabled', '');
  });
  return DOMPurify;
}

const CONFIG = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'source', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset', 'action', 'formaction'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/)/i,
  ADD_ATTR: ['data-remote-src', 'data-path', 'data-folder', 'data-dir'],
};

const cache = new Map<string, string>();
const CACHE_MAX = 400;

function remember(key: string, html: string): string {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, html);
  return html;
}

/** Block Markdown → sanitized HTML (cached by text). */
export function renderMarkdown(text: string): string {
  const key = `b:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = marked.parse(text) as string;
  return remember(key, purifier().sanitize(html, CONFIG) as unknown as string);
}

/** Inline Markdown (bold, code, links) → sanitized HTML for strings inside blocks. */
export function renderInline(text: string): string {
  const key = `i:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = marked.parseInline(text) as string;
  return remember(key, purifier().sanitize(html, CONFIG) as unknown as string);
}

/** Delegated clicks: links via the host, paths in the side pane, remote images load on click. */
function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const image = target?.closest?.('img[data-remote-src]') as HTMLImageElement | null;
  if (image) {
    event.preventDefault();
    image.src = image.dataset.remoteSrc ?? '';
    image.removeAttribute('data-remote-src');
    image.classList.remove('md-remote-image');
    image.removeAttribute('role');
    return;
  }
  const path = target?.closest?.('[data-path]') as HTMLElement | null;
  if (path) {
    event.preventDefault();
    if (getSelection()?.isCollapsed === false) return; // a selection is for copying
    void openPathLink(path.dataset.path ?? '', (path.closest('[data-author]') as HTMLElement | null)?.dataset.author);
    return;
  }
  const link = target?.closest?.('a') as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  event.preventDefault();
  if (href.startsWith('#')) { navigate(parseRoute(href)); return; }
  if (href) openLink(href);
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  const enter = event.key === 'Enter';
  if (((enter || event.key === ' ') && target.matches?.('img[data-remote-src]')) || (enter && target.matches?.('[data-path]'))) {
    onClick(event as unknown as MouseEvent);
  }
}

export function Markdown(props: { text: string; class?: string }) {
  return (
    <div
      class={`md${props.class ? ` ${props.class}` : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text) }}
    />
  );
}

/** Inline Markdown in a span (block titles, cells, option labels); in a button or label a path is plain text. */
export function Inline(props: { text: string | undefined; class?: string }) {
  if (!props.text) return null;
  // Plain strings skip the parser entirely (most cells and labels); a bare posix path needs it.
  if (!/[*_`[~<&\\]/.test(props.text) && pathStart(` ${props.text}`) < 0) return <span class={props.class}>{props.text}</span>;
  return <span ref={(span) => plainInControl(span)} class={props.class} onClick={onClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: renderInline(props.text) }} />;
}
