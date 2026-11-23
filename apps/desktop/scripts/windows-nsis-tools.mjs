// Owns: build-private NSIS plugin signing before electron-builder loads the compiler.
// Never: mutates shared tool caches or executes a generated installer.
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { completeTree, inspectFile } from './windows-signing.mjs';
const require = createRequire(import.meta.url);

export async function treeHashes(root) {
  const result = {};
  async function visit(file, relative) {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected NSIS resource link: ${file}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) result[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
    else throw new Error(`Unexpected NSIS resource type: ${file}`);
  }
  await visit(root, '');
  return result;
}

export async function prepareNsisTools({ config, projectDir, reportDir = path.resolve('test-results'),
  inspector = inspectFile, tools = require('app-builder-lib/out/toolsets/windows.js'), env = process.env }) {
  if (require('app-builder-lib/package.json').version !== '26.15.3') throw new Error('Review NSIS tool preparation for this builder version.');
  // This reviewed path covers builder's default plugins, not arbitrary !addplugindir in custom scripts.
  for (const key of ['customNsisBinary', 'customNsisResources', 'script']) {
    if (config.nsis?.[key]) throw new Error(`Custom NSIS ${key} needs explicit plugin coverage review.`);
  }
  for (const key of ['ELECTRON_BUILDER_NSIS_DIR', 'ELECTRON_BUILDER_NSIS_RESOURCES_DIR']) {
    if (env[key]) throw new Error(`Unexpected NSIS tool override: ${key}`);
  }
  const resources = path.resolve(projectDir, config.directories?.buildResources ?? 'build');
  const reviewedInclude = path.resolve(projectDir, 'assets/installer.nsh');
  const include = config.nsis?.include;
  if (include && path.resolve(projectDir, include) !== reviewedInclude) throw new Error('Custom NSIS include needs explicit plugin coverage review.');
  let includeHash = null;
  try {
    const stat = await lstat(path.join(resources, 'installer.nsh'));
    if (stat.isSymbolicLink() || !stat.isFile() || path.join(resources, 'installer.nsh') !== reviewedInclude) throw new Error('Installer include path needs explicit coverage review.');
    includeHash = createHash('sha256').update(await readFile(reviewedInclude)).digest('hex');
    if (includeHash !== '4e4224ef4189e3ebcb9f73c8e4fcf6cf590d71069d055e63022f9fadd2e26125') throw new Error('Installer include bytes need explicit coverage review.');
    // Reviewed exact bytes use nsExec; no nested includes, plugin directories or File sources.
    config.nsis = { ...config.nsis, include: reviewedInclude };
  } catch (error) { if (error.code !== 'ENOENT') throw error; if (include) throw error; }
  for (const arch of ['x86-unicode', 'x86-ansi', 'installer.nsi']) {
    try { await lstat(path.join(resources, arch)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`User NSIS plugin directory needs explicit coverage review: ${arch}`);
  }
  const version = config.toolsets?.nsis;
  const compiler = await tools.getMakeNsisPath(version);
  const toolRoot = compiler.env?.NSISDIR ?? path.dirname(compiler.path);
  const pluginRoot = await tools.getNsisPluginsPath(version);
  const before = { tool: await treeHashes(toolRoot), plugins: await treeHashes(pluginRoot) };
  await mkdir(reportDir, { recursive: true });
  const privateRoot = await mkdtemp(path.join(reportDir, 'nsis-tools-'));
  const privateTool = path.join(privateRoot, 'tool');
  const privateResources = path.join(privateRoot, 'resources');
  await cp(toolRoot, privateTool, { recursive: true, errorOnExist: true, force: false });
  await mkdir(privateResources);
  await cp(pluginRoot, path.join(privateResources, 'plugins'), { recursive: true, errorOnExist: true, force: false });
  const pluginDirs = [];
  // Legacy NSIS uses Plugins; unified toolsets use windows/Plugins. Both are copied with NSISDIR.
  for (const relative of ['Plugins', 'windows/Plugins']) {
    try { await lstat(path.join(privateTool, relative)); pluginDirs.push(path.join(privateTool, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!pluginDirs.length) throw new Error('NSIS compiler default plugin directory not found.');
  pluginDirs.push(path.join(privateResources, 'plugins'));
  const records = [];
  for (const dir of pluginDirs) records.push(...await completeTree(dir, 'Sign', inspector));
  // Verify again before exposing either path to the compiler.
  for (const dir of pluginDirs) await completeTree(dir, 'Verify', inspector);
  const after = { tool: await treeHashes(toolRoot), plugins: await treeHashes(pluginRoot) };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Original NSIS tool cache changed.');
  if (includeHash && createHash('sha256').update(await readFile(reviewedInclude)).digest('hex') !== includeHash) throw new Error('Installer include changed during preparation.');
  const result = { reviewedInclude: includeHash ? { path: reviewedInclude, sha256: includeHash } : null, source: { toolRoot, pluginRoot, hashes: before }, privateTool, privateResources, records,
    signedCopies: { tool: await treeHashes(privateTool), plugins: await treeHashes(path.join(privateResources, 'plugins')) },
    originalCachesUnchanged: true, preparedBeforeCompiler: true };
  await writeFile(path.join(reportDir, 'windows-nsis-tools.json'), JSON.stringify(result, null, 2));
  env.ELECTRON_BUILDER_NSIS_DIR = privateTool;
  env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = privateResources;
  return result;
}
