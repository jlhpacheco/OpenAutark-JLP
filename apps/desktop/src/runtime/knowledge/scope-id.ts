// The normal ids of the shared operational scopes: a website is its host (lowercase, without
// "www." – browser/hosts.ts normalHost, the same rule the browser tools judge pages by), an app is
// its process name (lowercase, without folder and ".exe"/".app"). KnowledgeStore.save and
// memory.write (company/websites/<host>, company/apps/<name>) store these and knowledge.find finds them, so 'https://www.x.com/feed', 'www.x.com' and 'x.com'
// are one site.
// Owns: those rules. Never: touches the database or treats an id as a permission.

import { normalHost } from '../browser/hosts.ts';

export type SiteScope = 'website' | 'app';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 'https://www.GitHub.com/feed', 'www.github.com:443' or 'github.com/x' → 'github.com'; undefined without a host. */
export function websiteId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  if (SCHEME.test(value)) {
    try { return normalHost(new URL(value).hostname); } catch { return undefined; }
  }
  return normalHost(value.split(/[/?#]/, 1)[0]);
}

/** 'C:\\Program Files\\Office\\EXCEL.EXE', 'excel.exe' or 'Excel' → 'excel'; undefined for no name. */
export function appId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const base = raw.trim().split(/[\\/]/).pop() ?? '';
  const name = base.toLowerCase().replace(/\.(exe|app)$/, '').trim();
  return name && name.length <= 120 ? name : undefined;
}

/** The stored form of a scope id: website and app ids normalised, every other scope's id unchanged. */
export function normalScopeId(scope: string, scopeId: string | undefined): string | undefined {
  if (scope === 'website') return websiteId(scopeId);
  if (scope === 'app') return appId(scopeId);
  return scopeId;
}

/** What a website or app scope id must look like (refusals of save and remember). */
export function scopeIdHint(scope: SiteScope): string {
  return scope === 'website' ? "the site's host (e.g. github.com) or a page URL" : "the app's process name (e.g. excel)";
}
