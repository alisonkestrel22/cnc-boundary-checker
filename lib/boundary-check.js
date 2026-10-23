// Shared by the map page (index.html) and the data build (scripts/build.mjs), so the
// check in the browser and the GitHub Action can never disagree about what counts as
// an overlap or a gap. Callers pass in turf: the page loads it from a CDN, the build
// from npm.
//
// Data comes from public iNaturalist endpoints:
//   api.inaturalist.org/v1/projects/<slugs>       project location rules (place_id / not_in_place)
//   api.inaturalist.org/v1/places/<ids>           simplified boundaries, used for outlines and screening
//   www.inaturalist.org/places/geometry/<id>.kml  full-precision boundaries, fetched only for places
//                                                 involved in a possible overlap or gap

export const SETTINGS = {
  API: 'https://api.inaturalist.org/v1',
  KML: 'https://www.inaturalist.org/places/geometry',
  PROJECTS_PER_REQUEST: 10,     // the API refuses more than 10 slugs per /projects request
  PLACES_PER_REQUEST: 100,      // ids per /places request
  REQUEST_INTERVAL_MS: 1000,    // iNat asks for <= 60 requests/minute
  SCREEN_PAD_DEG: 0.1,          // simplified outlines can be off by up to ~0.075 degrees
  NEARBY_PAD_DEG: 0.25,         // projects this close get different colors on the map
  TOUCH_KM2: 0.01,              // less shared area than this (1 hectare) counts as touching
  SLIVER_HOLE_KM2: 1,           // holes smaller than this are gaps between simplified outlines
  GAP_MIN_KM2: 1,               // smallest gap inside a project worth pointing out
  ALLOWED_STATUSES: ['approved', 'in umbrella'],
};
export const DEFAULT_THRESHOLD = { pct: 1, km2: 10 };

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
export const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;

export const classify = (pair, threshold) => pair.km2 < SETTINGS.TOUCH_KM2 ? 'touch'
  : (pair.pct >= threshold.pct || pair.km2 >= threshold.km2) ? 'overlap' : 'minor';

// ---------------------------------------------------------------- project lists

export function parseDelimited(text, delim) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Accepts a project link on any iNat network site (guatemala.inaturalist.org, ...), a slug or an id.
export function slugFrom(s) {
  const m = String(s).match(/\/projects\/([^\/?#\s]+)/);
  if (m) return decodeURIComponent(m[1]).toLowerCase();
  const t = String(s).trim();
  return /^[\w-]+$/.test(t) ? t.toLowerCase() : null;
}

// Reads a list of projects: links or slugs one per line, or a table (CSV, or rows pasted from
// a spreadsheet) with "Project Link" and "Project Status" columns. Table rows whose status is
// not Approved / In Umbrella are skipped.
// Returns { items: [{ slug, status }], skipped: [{ label, reason }] }.
export function parseProjectList(text) {
  const items = [], skipped = [], seen = new Set();
  const add = (slug, status) => { if (!seen.has(slug)) { seen.add(slug); items.push({ slug, status }); } };
  const delim = text.includes('\t') ? '\t' : ',';
  const rows = parseDelimited(text.trim(), delim);
  const header = rows.findIndex(r => r.some(c => /project link/i.test(c)));
  if (header < 0 && !rows.some(r => r.length >= 7)) {
    for (const tok of text.split(/[\r\n,]+/).map(t => t.trim()).filter(Boolean)) {
      const slug = slugFrom(tok);
      slug ? add(slug, '') : skipped.push({ label: tok, reason: 'not a project link or slug' });
    }
    return { items, skipped };
  }
  // without a header, assume the layout of the CNC submissions sheet (link in F, status in G)
  let linkCol = 5, statusCol = 6, start = 0;
  if (header >= 0) {
    linkCol = rows[header].findIndex(c => /project link/i.test(c));
    statusCol = rows[header].findIndex(c => /project status/i.test(c));
    start = header + 1;
  }
  for (const r of rows.slice(start)) {
    const link = (r[linkCol] || '').trim();
    if (!link) continue;
    const status = statusCol >= 0 ? (r[statusCol] || '').trim() : '';
    const slug = slugFrom(link);
    if (!slug) { skipped.push({ label: link, reason: 'not a project link' }); continue; }
    if (statusCol >= 0 && !SETTINGS.ALLOWED_STATUSES.includes(status.toLowerCase())) {
      skipped.push({ label: slug, reason: status ? `status “${status}”` : 'no status' });
      continue;
    }
    add(slug, status);
  }
  return { items, skipped };
}

export function summarizeSkips(skipped) {
  const by = {};
  skipped.forEach(s => { by[s.reason] = (by[s.reason] || 0) + 1; });
  return Object.entries(by).map(([r, n]) => `${n} with ${r}`).join(', ');
}

// ---------------------------------------------------------------- geometry helpers

// iNat's KML is regular enough to read without an XML parser, which keeps the build dependency-free.
export function kmlToGeometry(text) {
  const ring = s => s.trim().split(/\s+/).map(p => p.split(',').slice(0, 2).map(Number));
  const polys = [];
  for (const [, body] of text.matchAll(/<Polygon[^>]*>([\s\S]*?)<\/Polygon>/g)) {
    const outer = body.match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
    if (!outer) continue;
    const inners = [...body.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)];
    polys.push([ring(outer[1]), ...inners.map(m => ring(m[1]))]);
  }
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

// Round to `decimals` places (5 is about 1 m) to keep the data file small.
export function roundGeometry(g, decimals = 5) {
  if (!g) return null;
  const f = 10 ** decimals;
  const ring = coords => {
    const out = [];
    for (const [x, y] of coords) {
      const p = [Math.round(x * f) / f, Math.round(y * f) / f];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return out;
  };
  const poly = rings => {
    const [outer, ...holes] = rings.map(ring);
    return outer.length < 4 ? null : [outer, ...holes.filter(h => h.length >= 4)];
  };
  if (g.type === 'Polygon') { const p = poly(g.coordinates); return p && { type: 'Polygon', coordinates: p }; }
  const parts = g.coordinates.map(poly).filter(Boolean);
  return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
}

export const boxesMeet = (a, b, pad) => !!(a && b &&
  a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3]);

function hashOf(value) {
  const s = JSON.stringify(value) || '';
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}:${h}`;
}

// ---------------------------------------------------------------- the checker

// options:
//   turf           the turf library (required)
//   log(msg)       progress messages
//   beforeRequest  called before every request to iNaturalist; throw to stop (e.g. a daily budget)
//   onQueue(n)     number of requests waiting, for a progress display
//   fetchOptions   extra fetch() options, e.g. a User-Agent header in Node
export function createChecker({ turf, log = () => {}, beforeRequest = () => {}, onQueue = () => {}, fetchOptions = {} }) {
  const places = new Map();   // place id -> { id, name, simple, precise, bbox, simpleHash }
  let chain = Promise.resolve(), lastRequest = 0, queued = 0;

  // ------------------------------------------------ paced requests

  function request(url, as = 'json') {
    onQueue(++queued);
    const job = chain.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = lastRequest + SETTINGS.REQUEST_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequest = Date.now();
        beforeRequest(url);
        let res = null;
        try { res = await fetch(url, fetchOptions); } catch (e) { /* network hiccup: retry */ }
        if (res && res.ok) return as === 'json' ? res.json() : res.text();
        if (res && res.status === 404) return null;
        if (res && res.status < 500 && res.status !== 429) throw new Error(`iNaturalist returned ${res.status} for ${url}`);
        await sleep(5000 * (attempt + 1));   // rate limited or server hiccup: back off
      }
      throw new Error('iNaturalist kept refusing requests. Wait a few minutes and try again.');
    });
    chain = job.catch(() => {});
    return job.finally(() => onQueue(--queued));
  }

  // ------------------------------------------------ projects and places

  // Returns a Map keyed by both slug and id (as a string).
  async function fetchProjects(slugs) {
    const found = new Map();
    const groups = chunk(slugs, SETTINGS.PROJECTS_PER_REQUEST);
    for (const [i, group] of groups.entries()) {
      log(`Looking up projects (${i + 1} of ${groups.length})…`);
      const data = await request(`${SETTINGS.API}/projects/${group.map(encodeURIComponent).join(',')}`);
      for (const r of (data && data.results) || []) {
        const params = Object.fromEntries((r.search_parameters || []).map(p => [p.field, p.value]));
        const rec = {
          slug: r.slug.toLowerCase(), id: r.id, title: r.title, type: r.project_type,
          placeIds: [].concat(params.place_id || []).map(Number),
          excludeIds: [].concat(params.not_in_place || []).map(Number),
        };
        found.set(rec.slug, rec);
        found.set(String(r.id), rec);
      }
    }
    return found;
  }

  function loadPlaces(list) {
    for (const p of list || []) if (p && p.id) places.set(p.id, p);
  }

  // Places known only by name and bounding box (from the data file); boundaries are fetched when needed.
  function addPlaceStubs(list) {
    for (const p of list) if (!places.has(p.id)) places.set(p.id, { id: p.id, name: p.name, bbox: p.bbox, simple: null, precise: null });
  }

  // Fetch simplified boundaries. With refresh, re-fetch even cached places, and drop a cached
  // full-precision boundary when the place's outline has changed on iNaturalist.
  async function fetchPlaces(ids, { refresh = false } = {}) {
    const need = [...new Set(ids)].filter(id => refresh || !places.get(id)?.simple);
    const groups = chunk(need, SETTINGS.PLACES_PER_REQUEST);
    for (const [i, group] of groups.entries()) {
      log(`Downloading place outlines (${i + 1} of ${groups.length})…`);
      const data = await request(`${SETTINGS.API}/places/${group.join(',')}`);
      for (const r of (data && data.results) || []) {
        const old = places.get(r.id);
        const simpleHash = hashOf(r.geometry_geojson);
        const rec = { id: r.id, name: r.display_name, simple: r.geometry_geojson, simpleHash,
                      precise: old && old.simpleHash === simpleHash ? old.precise || null : null };
        if (!rec.simple) { rec.precise = rec.precise || await fetchPrecise(r.id); rec.simple = rec.precise; }
        rec.bbox = rec.simple ? turf.bbox(rec.simple) : null;
        places.set(r.id, rec);
      }
    }
  }

  async function fetchPrecise(id) {
    const text = await request(`${SETTINGS.KML}/${id}.kml`, 'text');
    return text ? kmlToGeometry(text) : null;
  }

  async function ensurePrecise(ids) {
    const need = [...new Set(ids)].filter(id => places.get(id) && !places.get(id).precise);
    for (const [i, id] of need.entries()) {
      log(`Downloading full-precision boundaries (${i + 1} of ${need.length}, about ${need.length - i} s left)…`);
      places.get(id).precise = await fetchPrecise(id);
    }
  }

  // ------------------------------------------------ polygon operations

  // Polygon operations can fail on floating-point noise ("Unable to complete output ring").
  // Retry with coordinates rounded to 7, then 6, then 5 decimals (about 1 cm to 1 m).
  const FAILED = Symbol('failed');
  function robust(op, feats) {
    for (const precision of [null, 7, 6, 5]) {
      try {
        const fs = precision === null ? feats : feats.map(f => turf.truncate(f, { precision, coordinates: 2 }));
        return op(turf.featureCollection(fs));
      } catch (e) { /* try the next precision */ }
    }
    log('Warning: a polygon operation failed at every precision');
    return FAILED;
  }

  function unionOf(geoms) {
    const feats = geoms.filter(Boolean).map(g => turf.feature(g));
    if (!feats.length) return null;
    if (feats.length === 1) return feats[0];
    const u = robust(turf.union, feats);
    if (u !== FAILED) return u;
    // merge one place at a time so a single bad shape only loses itself
    return feats.reduce((acc, f) => { const r = robust(turf.union, [acc, f]); return r === FAILED ? acc : r; });
  }

  function minus(a, b) {
    if (!a || !b) return a;
    const r = robust(turf.difference, [a, b]);
    return r === FAILED ? a : r;
  }

  function intersect(a, b) {
    if (!a || !b) return null;
    const r = robust(turf.intersect, [a, b]);
    return r === FAILED ? null : r;
  }

  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  // Neighbouring places' simplified outlines don't quite meet, so merging them leaves
  // hundreds of sliver holes. Drop the small ones; real holes are far larger.
  function fillSlivers(feature) {
    if (!feature) return feature;
    const g = feature.geometry;
    const keep = poly => [poly[0], ...poly.slice(1).filter(r => turf.area(turf.polygon([r])) / 1e6 >= SETTINGS.SLIVER_HOLE_KM2)];
    return turf.feature({ type: g.type, coordinates: g.type === 'MultiPolygon' ? g.coordinates.map(keep) : keep(g.coordinates) });
  }

  function holesOf(feature) {
    if (!feature) return [];
    const g = feature.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    return polys.flatMap(p => p.slice(1)).map(r => turf.polygon([r]).geometry);
  }

  const simpleGeom = id => { const p = places.get(id); return p && (p.simple || p.precise); };
  const preciseGeom = id => { const p = places.get(id); return p && (p.precise || p.simple); };

  // A project's outline: its places merged (from simplified boundaries), minus excluded places.
  // `holes` are candidate gaps, only for projects with several places, and never from exclusions.
  function buildShape(project) {
    const inc = fillSlivers(unionOf(project.placeIds.map(simpleGeom)));
    const feature = minus(inc, unionOf(project.excludeIds.map(simpleGeom)));
    if (!feature) return { feature: null, bbox: null, km2: 0, holes: [] };
    return { feature, bbox: turf.bbox(feature), km2: turf.area(feature) / 1e6,
             holes: project.placeIds.length > 1 ? holesOf(inc) : [] };
  }

  // Places of `project` whose outline could reach into `box`.
  function placesNear(project, box) {
    const near = ids => ids.filter(id => boxesMeet(places.get(id)?.bbox, box, SETTINGS.SCREEN_PAD_DEG));
    return { inc: near(project.placeIds), exc: near(project.excludeIds) };
  }

  // Compare two projects. Screens with the outlines, then confirms with full-precision
  // boundaries for just the places near the other project. Returns null when they don't meet.
  async function comparePair(a, sa, b, sb) {
    if (!sa?.feature || !sb?.feature || !boxesMeet(sa.bbox, sb.bbox, SETTINGS.SCREEN_PAD_DEG)) return null;
    const rough = intersect(sa.feature, sb.feature);
    if (!rough && !safe(() => turf.booleanIntersects(sa.feature, sb.feature), false)) return null;

    const na = placesNear(a, sb.bbox), nb = placesNear(b, sa.bbox);
    await ensurePrecise([...na.inc, ...na.exc, ...nb.inc, ...nb.exc]);
    const pa = minus(unionOf(na.inc.map(preciseGeom)), unionOf(na.exc.map(preciseGeom)));
    const pb = minus(unionOf(nb.inc.map(preciseGeom)), unionOf(nb.exc.map(preciseGeom)));
    if (!pa || !pb) return null;
    const geom = intersect(pa, pb);
    // simplified outlines can meet where the real boundaries don't
    if (!geom && !safe(() => turf.booleanIntersects(pa, pb), false)) return null;
    const km2 = geom ? turf.area(geom) / 1e6 : 0;
    const smaller = Math.min(sa.km2, sb.km2) || 1;
    // the overlap is precise but project areas come from simplified outlines, so cap at 100%
    return { key: pairKey(a.slug, b.slug), a: a.slug, b: b.slug, km2, pct: Math.min(100, 100 * km2 / smaller),
             geom: km2 >= SETTINGS.TOUCH_KM2 ? geom.geometry : null };
  }

  // Confirm each candidate hole against full-precision boundaries of the places around it.
  // Whatever is still uncovered by the project's included or excluded places is a gap.
  async function findGaps(project, shape) {
    const gaps = [];
    for (const hole of shape?.holes || []) {
      const box = turf.bbox(hole);
      const near = [...project.placeIds, ...project.excludeIds]
        .filter(id => boxesMeet(places.get(id)?.bbox, box, SETTINGS.SCREEN_PAD_DEG));
      await ensurePrecise(near);
      const rest = minus(turf.feature(hole), unionOf(near.map(preciseGeom)));
      if (!rest) continue;
      const parts = rest.geometry.type === 'MultiPolygon' ? rest.geometry.coordinates.map(c => turf.polygon(c)) : [rest];
      for (const part of parts) {
        const km2 = turf.area(part) / 1e6;
        if (km2 >= SETTINGS.GAP_MIN_KM2) gaps.push({ km2, geom: part.geometry });
      }
    }
    return gaps.sort((x, y) => y.km2 - x.km2);
  }

  return { places, request, fetchProjects, loadPlaces, addPlaceStubs, fetchPlaces, ensurePrecise,
           buildShape, comparePair, findGaps };
}
