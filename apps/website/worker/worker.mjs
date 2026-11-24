// Owns: the one thing the static site cannot do: /get/<id> answers with a redirect to the newest release file, so one click
// on openautark.com downloads the installer (no GitHub page in between). Everything else is the static site (ASSETS).
// Never: page copy, versions in text (the build writes those). Deploy: worker/README.md.
const REPO = 'teydra/OpenAutark';
// Same ids and files as src/config.mjs (downloads). Android is the Lite APK, like the platform page.
const FILES = {
  windows: 'autark-windows-x64.exe',
  mac: 'autark-mac-universal.dmg',
  'mac-zip': 'autark-mac-universal.zip',
  linux: 'autark-linux-x64.AppImage',
  android: 'autark-android-lite.apk',
  'android-full': 'autark-android.apk',
  checksums: 'SHA256SUMS.txt',
};

// The newest public release that really carries the file (an android-only tag at the top of the list has no installer).
async function newestTag(file) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openautark-site-worker' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) return null;
    const list = await r.json();
    const hit = list.find((x) => !x.draft && !x.prerelease && (x.assets || []).some((a) => a.name === file));
    return hit ? hit.tag_name : null;
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/get\/([a-z-]+)\/?$/.exec(url.pathname);
    const file = m && FILES[m[1]];
    if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) return env.ASSETS.fetch(request);
    const tag = await newestTag(file);
    // GitHub's own "latest" is the fallback when the API does not answer.
    const target = tag
      ? `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${file}`
      : `https://github.com/${REPO}/releases/latest/download/${file}`;
    return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
  },
};
