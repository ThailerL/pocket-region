import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PyodideAPI } from 'pyodide';
import {
  bootRegion,
  hostObserver,
  type Region,
  type RegionSettings,
  type VendorManifest,
} from './core.ts';
import { createProcessHost } from './lambda/process-host.ts';

export type { LambdaEvent, LambdaObserver, OutputStream, Region, RegionRequest, RegionResponse } from './core.ts';

export type NodeRegionOptions = RegionSettings & {
  // Only for hosts where Pyodide cannot locate itself from import.meta.url
  indexURL?: string;
  packageCacheDir?: string;
  // Where save() writes and a new region restores from; in memory only when absent
  stateDir?: string;
};

// Python file IO stays in MEMFS: under Vivari, writes through a node mount are corrupt
function copyDiskToMemfs(py: PyodideAPI, diskDir: string, memDir: string) {
  py.FS.mkdirTree(memDir);
  for (const entry of fs.readdirSync(diskDir, { withFileTypes: true })) {
    const disk = path.join(diskDir, entry.name);
    const mem = `${memDir}/${entry.name}`;
    if (entry.isDirectory()) copyDiskToMemfs(py, disk, mem);
    else py.FS.writeFile(mem, fs.readFileSync(disk));
  }
}

function listMemfsFiles(py: PyodideAPI, memDir: string, found: string[] = []) {
  for (const name of py.FS.readdir(memDir)) {
    if (name === '.' || name === '..') continue;
    const mem = `${memDir}/${name}`;
    if (py.FS.isDir(py.FS.stat(mem).mode)) listMemfsFiles(py, mem, found);
    else found.push(mem);
  }
  return found;
}

// Deletions count as much as writes: a deleted object whose file survived on disk would
// come back at the next boot
function mirrorToDisk(py: PyodideAPI, stateRoot: string, stateDir: string) {
  const written = new Set<string>();
  for (const mem of listMemfsFiles(py, stateRoot)) {
    const disk = path.join(stateDir, mem.slice(stateRoot.length + 1));
    written.add(disk);
    fs.mkdirSync(path.dirname(disk), { recursive: true });
    fs.writeFileSync(disk, py.FS.readFile(mem));
  }
  for (const entry of fs.readdirSync(stateDir, { recursive: true, withFileTypes: true })) {
    const disk = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && !written.has(disk)) fs.rmSync(disk);
  }
}

export function createRegion(options: NodeRegionOptions = {}): Promise<Region> {
  const packageCacheDir =
    options.packageCacheDir ?? fileURLToPath(new URL('../vendor', import.meta.url));
  const manifest: VendorManifest = JSON.parse(
    fs.readFileSync(path.join(packageCacheDir, 'meta.json'), 'utf8'),
  );
  const { stateDir } = options;

  return bootRegion(
    {
      indexURL: options.indexURL,
      packageCacheDir,
      stdLib: path.join(packageCacheDir, manifest.stdlib),
      wheels: manifest.wheels.map((file) => path.join(packageCacheDir, file)),
    },
    options,
    stateDir === undefined
      ? undefined
      : {
          restore(py, stateRoot) {
            fs.mkdirSync(stateDir, { recursive: true });
            copyDiskToMemfs(py, stateDir, stateRoot);
          },
          mirror(py, stateRoot) {
            mirrorToDisk(py, stateRoot, stateDir);
          },
        },
    (region) => createProcessHost({ ...region, lambda: hostObserver(options) }),
  );
}
