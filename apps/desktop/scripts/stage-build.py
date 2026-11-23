"""Keep native CI packages in a private draft when Actions artifact storage is full.

Run by .github/workflows/desktop.yml from apps/desktop: python scripts/stage-build.py
create | upload <platform> | screenshots <platform>. Paths (dist, test-results) are relative to
the working directory. legacy/scripts/stage-build.py is a kept copy with the same behaviour;
change both.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request
import zipfile


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    if repository != 'teydra/proactive-agent-runtime':
        raise RuntimeError('Build storage must remain in the private source repository.')
    run_id = os.environ['GITHUB_RUN_ID']
    tag = 'desktop-build-' + run_id
    token = os.environ['GH_TOKEN']
    base = 'https://api.github.com/repos/' + repository

    def request(url, data=None):
        binary = isinstance(data, bytes)
        headers = {'Authorization': 'Bearer ' + token, 'User-Agent': 'Autark-build',
                   'Accept': 'application/vnd.github+json',
                   'Content-Type': 'application/octet-stream' if binary else 'application/json'}
        payload = data if binary or data is None else json.dumps(data).encode()
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers, data=payload), timeout=180) as response:
            return json.load(response)

    if sys.argv[1] == 'create':
        repo = request(base)
        if not repo['private']:
            raise RuntimeError('Refusing to store source build evidence in a public repository.')
        request(base + '/releases', {'tag_name': tag, 'target_commitish': os.environ['GITHUB_SHA'],
            'name': 'Private desktop build ' + run_id, 'draft': True, 'prerelease': True,
            'body': 'Private CI packages and UI evidence. Public distribution is a separate verified step.'})
        print('Private build storage created.')
        return

    platform = sys.argv[2]
    if platform not in {'windows', 'linux', 'macos'}:
        raise RuntimeError('Unknown build platform.')
    evidence = sys.argv[1] == 'screenshots'
    if sys.argv[1] not in {'upload', 'screenshots'}:
        raise RuntimeError('Unknown build storage action.')
    directory = Path('test-results' if evidence else 'dist')
    allowed = {'.png', '.json'} if evidence else {'.exe', '.AppImage', '.dmg', '.zip', '.yml', '.blockmap'}
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix in allowed
                   and p.name != 'builder-debug.yml') if directory.exists() else []
    if not files:
        if evidence:
            return
        raise RuntimeError('No native build files to store.')
    archive = Path(('screenshots-' if evidence else 'desktop-') + platform + '.zip')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as output:
        for file in files:
            output.write(file, file.name)
    matches = [release for release in request(base + '/releases?per_page=100') if release['tag_name'] == tag]
    if len(matches) != 1:
        raise RuntimeError('Missing or ambiguous private build storage.')
    release = matches[0]
    if not release['draft'] or release['target_commitish'] != os.environ['GITHUB_SHA']:
        raise RuntimeError('Build storage does not match this source commit.')
    url = release['upload_url'].split('{', 1)[0] + '?name=' + urllib.parse.quote(archive.name)
    content = archive.read_bytes()
    asset = request(url, content)
    if asset.get('digest') != 'sha256:' + hashlib.sha256(content).hexdigest():
        raise RuntimeError('Uploaded build archive digest mismatch.')
    print('Stored verified private build asset:', archive.name)


if __name__ == '__main__':
    main()
