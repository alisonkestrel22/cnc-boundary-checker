// Builds data/projects.json from projects.csv. scripts/build.mjs runs it in the GitHub
// Action; `io` supplies file access, so the same build can also run elsewhere.
//
// io:
//   readProjectList()        -> text of projects.csv
//   readPreviousData()       -> the current data/projects.json, or null
//   writeData(data)          writes data/projects.json
//   loadCachedPlaces()       -> place records saved by the last run ([] if none)
//   saveCachedPlaces(list)   saves place records, including full-precision boundaries
//   fetchOptions             optional extra fetch() options

import { SETTINGS, parseProjectList, parseDelimited, slugFrom, summarizeSkips, createChecker, roundGeometry, pairKey }
  from './boundary-check.js';

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// Outlines in the data file are for drawing and for screening the page's checks, so ~20 m
// of simplification is invisible and keeps the file small. Results above it use full boundaries.
const DISPLAY_TOLERANCE_DEG = 0.0002;
function forDisplay(turf, feature) {
  if (!feature) return null;
  try { return roundGeometry(turf.simplify(feature, { tolerance: DISPLAY_TOLERANCE_DEG }).geometry); }
  catch (e) { return roundGeometry(feature.geometry); }
}

// ---------------------------------------------------------------- data file entries
// Used by the build and by the page when it saves a change, so both write the same format.

// `places`: the checker's place records; `shape` from checker.buildShape; `gaps` from checker.findGaps.
export function projectEntry(turf, places, p, shape, gaps) {
  const placeSummary = (id, excluded) => {
    const pl = places.get(id);
    return { id, name: pl?.name || null, bbox: pl?.bbox ? pl.bbox.map(n => round(n, 5)) : null, ...(excluded ? { excluded: true } : {}) };
  };
  return {
    slug: p.slug, id: p.id, title: p.title, status: p.status,
    placeIds: p.placeIds, excludeIds: p.excludeIds,
    places: [...p.placeIds.map(id => placeSummary(id, false)), ...p.excludeIds.map(id => placeSummary(id, true))],
    km2: round(shape.km2), bbox: shape.bbox && shape.bbox.map(n => round(n, 5)),
    geometry: forDisplay(turf, shape.feature),
    gaps: (gaps || []).map(g => ({ km2: round(g.km2), geometry: roundGeometry(g.geom) })),
  };
}

export const pairEntry = p => ({ a: p.a, b: p.b, km2: round(p.km2), pct: round(p.pct), geometry: roundGeometry(p.geom) });

// ---------------------------------------------------------------- changes made from the page

const csvCell = v => /[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');

// Applies one change to the current projects.csv text and data/projects.json object.
//   add:    [{ entry, pairs }]  entry from projectEntry; pairs (from pairEntry) with projects in the list
//   remove: [slug]
// Projects being removed take their overlaps with them; re-adding a listed project replaces it.
export function applyListChange(csvText, data, { add = [], remove = [], status = 'Approved' }) {
  const gone = new Set([...remove, ...add.map(a => a.entry.slug)]);

  const rows = parseDelimited(csvText.trim(), ',');
  let header = rows.findIndex(r => r.some(c => /project link/i.test(c)));
  if (header < 0) { rows.unshift(['Project Name', 'Project Link', 'Project Status']); header = 0; }
  const col = re => rows[header].findIndex(c => re.test(c));
  const [nameCol, linkCol, statusCol] = [col(/project name/i), col(/project link/i), col(/project status/i)];
  const kept = rows.filter((r, i) => i <= header || !gone.has(slugFrom(r[linkCol] || '')));
  for (const { entry } of add) {
    const row = rows[header].map(() => '');
    if (nameCol >= 0) row[nameCol] = entry.title;
    row[linkCol] = `https://www.inaturalist.org/projects/${entry.slug}`;
    if (statusCol >= 0) row[statusCol] = status;
    kept.push(row);
  }
  // keep the file's own line endings so each change shows as just the rows that changed
  const eol = csvText.includes('\r\n') ? '\r\n' : '\n';
  const csv = kept.map(r => r.map(csvCell).join(',')).join(eol) + eol;

  const listed = new Set([...data.projects.filter(p => !gone.has(p.slug)).map(p => p.slug), ...add.map(a => a.entry.slug)]);
  const pairKeys = new Set();
  const pairs = [...data.pairs.filter(p => !gone.has(p.a) && !gone.has(p.b)),
                 ...add.flatMap(a => a.pairs).filter(p => listed.has(p.a) && listed.has(p.b))]
    .filter(p => { const k = pairKey(p.a, p.b); return !pairKeys.has(k) && pairKeys.add(k); });
  const next = {
    ...data,
    projects: [...data.projects.filter(p => !gone.has(p.slug)), ...add.map(a => ({ ...a.entry, status }))],
    pairs,
    problems: (data.problems || []).filter(p => !gone.has(p.slug)),
    updatedAt: new Date().toISOString(),
  };
  return { csv, data: next };
}

// ---------------------------------------------------------------- the build

export async function runBuild({ turf, io, log = console.log }) {
  const started = Date.now();
  const say = msg => log(`[${Math.round((Date.now() - started) / 1000)}s] ${msg}`);
  let requests = 0;
  const checker = createChecker({ turf, log: say, beforeRequest: () => { requests++; }, fetchOptions: io.fetchOptions });

  const { items, skipped } = parseProjectList(await io.readProjectList());
  say(`${items.length} projects in projects.csv` + (skipped.length ? ` (skipped ${skipped.length} rows: ${summarizeSkips(skipped)})` : ''));
  checker.loadPlaces(await io.loadCachedPlaces());
  say(`${checker.places.size} place boundaries in the cache`);

  // ------------------------------------------------ projects

  const found = await checker.fetchProjects(items.map(i => i.slug));
  const projects = [], problems = [];
  for (const item of items) {
    const r = found.get(item.slug);
    if (!r) { problems.push({ slug: item.slug, issue: 'Not found on iNaturalist' }); continue; }
    if (projects.some(p => p.slug === r.slug)) continue;   // listed twice, e.g. by slug and by id
    if (r.type !== 'collection') { problems.push({ slug: r.slug, title: r.title, issue: 'Not a collection project' }); continue; }
    if (!r.placeIds.length) { problems.push({ slug: r.slug, title: r.title, issue: 'No location set' }); continue; }
    projects.push({ ...r, status: item.status });
  }
  say(`${projects.length} projects to check, ${problems.length} with problems`);

  // ------------------------------------------------ boundaries and checks

  await checker.fetchPlaces(projects.flatMap(p => [...p.placeIds, ...p.excludeIds]), { refresh: true });
  const shapes = new Map(projects.map(p => [p.slug, checker.buildShape(p)]));

  const pairs = [];
  for (const [i, a] of projects.entries()) {
    say(`Checking overlaps for ${a.title} (${i + 1} of ${projects.length})`);
    for (const b of projects.slice(i + 1)) {
      const pair = await checker.comparePair(a, shapes.get(a.slug), b, shapes.get(b.slug));
      if (pair) pairs.push(pair);
    }
  }

  const gaps = new Map();
  for (const p of projects) {
    if (shapes.get(p.slug).holes.length) say(`Checking gaps inside ${p.title}`);
    gaps.set(p.slug, await checker.findGaps(p, shapes.get(p.slug)));
  }

  // ------------------------------------------------ write

  const data = {
    app: 'cnc-boundary-check',
    version: 2,
    settings: { touchKm2: SETTINGS.TOUCH_KM2, gapMinKm2: SETTINGS.GAP_MIN_KM2, sliverHoleKm2: SETTINGS.SLIVER_HOLE_KM2 },
    projects: projects.map(p => projectEntry(turf, checker.places, p, shapes.get(p.slug), gaps.get(p.slug))),
    pairs: pairs.map(pairEntry),
    problems,
    skippedRows: skipped.length,
  };

  // keep the old date when nothing changed, so a quiet week makes no commit
  const previous = await io.readPreviousData();
  const strip = d => JSON.stringify({ ...d, updatedAt: undefined });
  data.updatedAt = previous && strip(previous) === strip(data) ? previous.updatedAt : new Date().toISOString();
  await io.writeData(data);

  const used = new Set(projects.flatMap(p => [...p.placeIds, ...p.excludeIds]));
  await io.saveCachedPlaces([...checker.places.values()].filter(p => used.has(p.id)));

  const count = kind => pairs.filter(p => kind === 'touch' ? p.km2 < SETTINGS.TOUCH_KM2 : p.km2 >= SETTINGS.TOUCH_KM2).length;
  say(`Done: ${projects.length} projects, ${count('overlap')} overlapping pairs, ${count('touch')} touching, ` +
      `${[...gaps.values()].flat().length} gaps, ${problems.length} problems; ${requests} iNaturalist requests; ` +
      (data.updatedAt === previous?.updatedAt ? 'no changes.' : 'data updated.'));
  return data;
}
