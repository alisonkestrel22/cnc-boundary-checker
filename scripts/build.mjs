#!/usr/bin/env node
// Rebuilds data/projects.json from projects.csv. The GitHub Action runs this after every
// change to projects.csv and once a week. To run it yourself (Node 20 or newer):
//
//   npm install
//   node scripts/build.mjs
//
// Full-precision boundaries are cached in .cache/places/ (kept out of git) so later runs
// only download what changed.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { runBuild } from '../lib/build.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache', 'places');
const dataFile = path.join(root, 'data', 'projects.json');

const io = {
  fetchOptions: { headers: { 'User-Agent': 'cnc-boundary-check (City Nature Challenge boundary checker)' } },

  readProjectList: () => readFile(path.join(root, 'projects.csv'), 'utf8'),

  async readPreviousData() {
    try { return JSON.parse(await readFile(dataFile, 'utf8')); } catch { return null; }
  },

  async writeData(data) {
    await mkdir(path.dirname(dataFile), { recursive: true });
    await writeFile(dataFile, JSON.stringify(data) + '\n');
  },

  async loadCachedPlaces() {
    let names;
    try { names = await readdir(cacheDir); } catch { return []; }
    return Promise.all(names.filter(n => n.endsWith('.json'))
      .map(async n => JSON.parse(await readFile(path.join(cacheDir, n), 'utf8'))));
  },

  async saveCachedPlaces(places) {
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
    await Promise.all(places.map(p => writeFile(path.join(cacheDir, `${p.id}.json`), JSON.stringify(p))));
  },
};

runBuild({ turf, io }).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
