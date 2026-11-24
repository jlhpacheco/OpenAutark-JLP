# Cloudflare worker for openautark.com

`worker.mjs` answers `/get/<id>` (windows, android, android-full, mac, mac-zip, linux, checksums) with a 302 to the newest
public GitHub release that carries the file. The browser downloads it directly (GitHub sets `attachment` and the file name).
Every other path is the static site. Nothing in the worker names a version: **a release needs no change here.**

Deploy (live folder `C:\Users\Heess\Workforce\openautark-site`, wrangler is signed in there):

1. Back up `dist` as `dist-backup-<time>` next to it.
2. Build: `node apps/website/build.mjs` (online, reads versions from GitHub) and copy the new `dist` over the live one.
3. Copy `worker.mjs` and `wrangler.jsonc` from this folder into the live folder, then
   `node node_modules/wrangler/bin/wrangler.js deploy`.
4. Check: `curl.exe -sSIL https://openautark.com/get/windows` (302 to github.com/teydra/OpenAutark/releases/download/<tag>/autark-windows-x64.exe, then 200 with `content-disposition: attachment`).

Limits: the GitHub API answer is cached 5 minutes (unauthenticated: 60 requests/hour per address); when it fails the worker
redirects to `releases/latest/download/<file>`. Pre-releases and drafts are never offered.
