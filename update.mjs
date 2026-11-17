#!/usr/bin/env node
/* The Reckoning Clock updater. Runs every 15 minutes in GitHub Actions.
   Reads the live sources, scores them, applies the guardrails and writes docs/data/state.json.

   Guardrails:
   - Only the sources listed below and in config/feeds.json are read.
   - The headline score moves at most max_move_points_per_update per run.
   - Every news item and hazard carries its source link and time.
   - control.json can freeze the score (kill switch).
   - A source that fails keeps its last good value, marked stale. Nothing is invented. */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as P from './lib/parsers.mjs';
import { buildFeed } from './lib/news.mjs';
import { resolveIndicator, capMove, round } from './lib/guard.mjs';

const require = createRequire(import.meta.url);
const Core = require('../docs/clock-core.js');
const ROOT = process.env.RECKONING_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'docs/data/state.json');
const HISTORY_FILE = path.join(ROOT, 'docs/data/history.csv');
const DAY = 86400000;
const NOW = Date.now();

const URLS = {
  temp: 'https://sites.ecmwf.int/data/climatepulse/data/series/era5_daily_series_2t_global.csv',
  co2: [
    'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.txt',
    'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_weekly_mlo.txt'
  ],
  iceNorth: 'https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v3.0.csv',
  iceSouth: 'https://noaadata.apps.nsidc.org/NOAA/G02135/south/daily/data/S_seaice_extent_daily_v3.0.csv',
  sst: 'https://climatereanalyzer.org/clim/sst_daily/json/oisst2.1_world2_sst_day.json',
  gdacs: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH'
};

/* How old a reading may be and still count as fresh. Older means the source is not updating. */
const MAX_AGE_DAYS = { temp: 14, co2: 14, seaice: 14, sst: 14 };
/* A kept (stale) value older than this is dropped from the score. */
const DROP_AFTER_DAYS = 30;
/* ERA5 anomalies are against 1991-2020. Copernicus puts that period 0.88 C above 1850-1900. */
const ERA5_TO_PREINDUSTRIAL_C = 0.88;

const UA = 'ReckoningClock/1.0 (climate risk dashboard; +https://github.com/' + (process.env.GITHUB_REPOSITORY || 'unknown') + ')';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const warn = (msg) => console.log('::warning::' + msg);

async function getText(url, { timeout = 30000, retries = 1 } = {}) {
  let err;
  for (let a = 0; a <= retries; a++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: '*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      err = e.name === 'AbortError' ? new Error('timed out') : e;
      if (a < retries) await sleep(2000 * (a + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(url.replace(/^https?:\/\//, '').split('/')[0] + ': ' + err.message);
}

/* ---------- fetchers: each returns { value, as_of } or throws ---------- */
async function fetchTemp() {
  return P.parseCopernicusCsv(await getText(URLS.temp), { offset: ERA5_TO_PREINDUSTRIAL_C, window: 30 });
}
async function fetchCo2() {
  let last;
  for (const url of URLS.co2) {
    try { return P.parseNoaaCo2(await getText(url)); } catch (e) { last = e; }
  }
  throw last;
}
async function fetchSeaIce() {
  const [n, s] = await Promise.all([getText(URLS.iceNorth), getText(URLS.iceSouth)]);
  return P.seaIceBelowAverage(P.parseNsidcCsv(n), P.parseNsidcCsv(s));
}
async function fetchSst() {
  return P.parseOisst(JSON.parse(await getText(URLS.sst)));
}
async function fetchHazard(code) {
  const base = `${URLS.gdacs}?eventlist=${code}&alertlevel=Orange;Red`;
  const from = new Date(NOW - 30 * DAY).toISOString().slice(0, 10);
  const to = new Date(NOW + DAY).toISOString().slice(0, 10);
  try {
    return P.parseGdacs(JSON.parse(await getText(`${base}&fromdate=${from}&todate=${to}`, { retries: 0 })), NOW);
  } catch {
    return P.parseGdacs(JSON.parse(await getText(base)), NOW);
  }
}
async function fetchFeed(feed) {
  const items = P.parseRss(await getText(feed.url));
  return items.map((i) => ({ ...i, feed }));
}

/* Runs a fetcher and records the outcome without ever throwing. */
async function attempt(name, fn, health) {
  try {
    const v = await fn();
    health[name] = { ok: true };
    return v;
  } catch (e) {
    health[name] = { ok: false, error: String(e.message || e).slice(0, 160) };
    warn(`${name} failed: ${health[name].error}`);
    return null;
  }
}

/* ---------- previous published state ---------- */
async function loadPrevious() {
  const site = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (site) {
    const r = await fetch(`${site}/data/state.json?t=${NOW}`, { headers: { 'user-agent': UA, 'cache-control': 'no-cache' } });
    if (r.status === 404) return null; /* nothing published yet */
    if (!r.ok) throw new Error(`could not read the published state (HTTP ${r.status}); stopping so the cap is not skipped`);
    return await r.json();
  }
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

async function main() {
  const template = readJson('docs/data/state.json');
  const control = readJson('control.json');
  const manual = readJson('manual.json');
  const feedConfig = readJson('config/feeds.json');
  const prev = await loadPrevious();
  const prevLive = prev && prev.data_mode === 'live' ? prev : null;

  /* Kill switch: freeze everything and say so. */
  if (control.kill_switch) {
    const frozen = prevLive || template;
    const out = { ...frozen, kill_switch: true, kill_reason: control.reason || '' };
    writeState(out);
    console.log('Kill switch is on. Score and data are frozen.');
    return;
  }

  const health = {};
  const [temp, co2, seaice, sst, fl, tc, wf, ...feedResults] = await Promise.all([
    attempt('temp', fetchTemp, health),
    attempt('co2', fetchCo2, health),
    attempt('seaice', fetchSeaIce, health),
    attempt('sst', fetchSst, health),
    attempt('hazards_flood', () => fetchHazard('FL'), health),
    attempt('hazards_storm', () => fetchHazard('TC'), health),
    attempt('hazards_fire', () => fetchHazard('WF'), health),
    ...feedConfig.feeds.map((f) => attempt('feed_' + f.id, () => fetchFeed(f), health))
  ]);

  const prevInd = (list, id) => (prevLive ? prevLive.indicators[list].find((i) => i.id === id) : null);
  const defs = (list) => template.indicators[list];
  const fresh = { temp, co2, seaice, sst };

  const physical = defs('physical').map((d) => resolveIndicator(d, fresh[d.id], prevInd('physical', d.id), { now: NOW, maxAgeDays: MAX_AGE_DAYS[d.id], dropAfterDays: DROP_AFTER_DAYS }));
  const emissions = defs('emissions').map((d) => {
    if (d.id === 'flow') {
      const m = manual.flow;
      return { ...d, value: m.value, as_of: m.as_of, status: 'manual', source: m.source, url: m.url, cadence: 'Yearly' };
    }
    return resolveIndicator(d, fresh[d.id], prevInd('emissions', d.id), { now: NOW, maxAgeDays: MAX_AGE_DAYS[d.id], dropAfterDays: DROP_AFTER_DAYS });
  });

  /* The first live run needs at least temperature and CO2, or the what-if model has nothing to start from. */
  const tempOk = physical.find((i) => i.id === 'temp').value !== null;
  const co2Ok = emissions.find((i) => i.id === 'co2').value !== null;
  if (!prevLive && !(tempOk && co2Ok)) {
    warn('First live run could not read temperature and CO2. Leaving the sample data in place.');
    return;
  }

  /* Hazards. Flood and storm must work for the events score. Wildfire is optional. */
  const hazardSets = { flood: fl, storm: tc, fire: wf };
  const hazard_types = [
    { id: 'heat', label: 'Heat', connected: false, note: 'No verified heatwave feed is connected yet.' },
    { id: 'fire', label: 'Fires', connected: !!wf, note: wf ? '' : 'Wildfire alerts are unavailable right now.' },
    { id: 'flood', label: 'Floods', connected: !!fl, note: fl ? '' : 'Flood alerts are unavailable right now.' },
    { id: 'storm', label: 'Storms', connected: !!tc, note: tc ? '' : 'Cyclone alerts are unavailable right now.' }
  ];
  let allEvents = [];
  for (const k of Object.keys(hazardSets)) if (hazardSets[k]) allEvents = allEvents.concat(hazardSets[k]);
  const stalePrev = (type) => (prevLive ? prevLive.hotspots.filter((h) => h.type === type && NOW - Date.parse(h.published) <= 2 * DAY) : []);
  let hotspots = P.activeEvents(allEvents, NOW)
    .sort((a, b) => b.sev - a.sev || (b.published > a.published ? 1 : -1))
    .slice(0, 40)
    .map((e) => ({ id: e.key, type: e.type, lon: e.lon, lat: e.lat, sev: e.sev, alert: e.alert, people_m: null, region: e.region, title: e.title, source: e.source, published: e.published, url: e.url }));
  for (const t of ['fire', 'flood', 'storm']) {
    if (!hazardSets[t]) {
      const keep = stalePrev(t);
      if (keep.length) { hotspots = hotspots.concat(keep); hazard_types.find((x) => x.id === t).stale = true; }
    }
  }

  const eventsReady = !!fl && !!tc;
  let events;
  if (eventsReady) {
    const { points, score } = P.eventsScore(allEvents, NOW);
    events = {
      score: round(score, 1), points, status: 'live', as_of: iso(NOW).slice(0, 10),
      source: 'GDACS orange and red alerts', cadence: 'Every 15 minutes',
      note: 'Provisional rule. Each orange alert in the last 30 days counts 1 point and each red alert counts 3. A total of 40 points scores 100. Heatwaves are not included yet.'
    };
  } else if (prevLive && prevLive.indicators.events && prevLive.indicators.events.score !== null) {
    events = { ...prevLive.indicators.events, status: 'stale' };
  } else {
    events = { score: null, status: 'unavailable', as_of: null, source: 'GDACS orange and red alerts', cadence: 'Every 15 minutes', note: 'Hazard alerts are unavailable right now.' };
  }

  const pol = manual.policy;
  const policyScore = Core.scoreOf(pol.warming_2100_c, pol.zero_c, pol.midnight_c);
  const policy = {
    score: round(policyScore, 1), status: 'manual', as_of: pol.as_of, source: pol.source, url: pol.url, cadence: 'Yearly',
    note: `${pol.rule} Current reading: ${pol.warming_2100_c} °C by 2100.`
  };

  /* News: whitelisted feeds, rule-based sections. Plus GDACS alerts in the disasters section. */
  const sectionIds = template.sections.map((s) => s.id);
  const rssItems = feedResults.filter(Boolean).flat();
  const feedsOk = feedResults.filter(Boolean).length;
  let feed;
  if (feedsOk === 0 && prevLive && prevLive.feed) {
    feed = prevLive.feed;
  } else {
    feed = buildFeed(rssItems, sectionIds, { now: NOW });
    const gdacsItems = P.activeEvents(allEvents, NOW)
      .sort((a, b) => (b.published > a.published ? 1 : -1))
      .slice(0, 6)
      .map((e) => ({ title: e.title, region: e.region, source: 'GDACS', published: e.published, url: e.url }));
    feed.disasters = gdacsItems.concat(feed.disasters || [])
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, 8);
  }

  const state = {
    schema: 2,
    updated_at: iso(NOW),
    data_mode: 'live',
    kill_switch: false,
    refresh_minutes: template.refresh_minutes,
    max_move_points_per_update: template.max_move_points_per_update,
    scenario: template.scenario,
    weights: template.weights,
    pillars: template.pillars,
    sections: template.sections,
    indicators: { physical, emissions, policy, events },
    whatif: { ...template.whatif, emissions_now_gt: manual.flow.value, renewable_share_now: manual.renewable_share_now_pct.value },
    hazard_types,
    hotspots,
    feed,
    health: { checked_at: iso(NOW), sources: health, feeds_ok: feedsOk, feeds_total: feedConfig.feeds.length }
  };

  /* Score and the movement cap. */
  const raw = Core.compute(state);
  if (!(raw.coverage > 0.5)) throw new Error('Too little data to score (coverage ' + raw.coverage.toFixed(2) + ')');
  const cap = template.max_move_points_per_update;
  const moved = capMove(raw.risk, prevLive && prevLive.headline ? prevLive.headline.risk : NaN, cap);
  const risk = moved.risk, capped = moved.capped;
  state.headline = { risk: round(risk, 2), raw_risk: round(raw.risk, 2), capped, coverage: round(raw.coverage, 3) };

  writeState(state);
  appendHistory(state, raw);
  const bad = Object.entries(health).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(`Score ${state.headline.risk} (raw ${state.headline.raw_risk}${capped ? ', capped' : ''}). ${hotspots.length} hotspots. Feeds ${feedsOk}/${feedConfig.feeds.length}.` + (bad.length ? ' Failed: ' + bad.join(', ') : ''));
}

function writeState(state) {
  JSON.parse(JSON.stringify(state)); /* must serialise cleanly */
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

/* One row a day. The commit this creates also keeps the repository active, so GitHub
   does not switch off the schedule after 60 quiet days. */
function appendHistory(state, raw) {
  const today = state.updated_at.slice(0, 10);
  let text = '';
  try { text = fs.readFileSync(HISTORY_FILE, 'utf8'); } catch { text = 'date,risk,physical,emissions,policy,events,temp_c,co2_ppm\n'; }
  const lines = text.trimEnd().split('\n');
  if (lines[lines.length - 1].startsWith(today)) return;
  const f = (x) => (x === null || x === undefined ? '' : round(x, 2));
  const t = state.indicators.physical.find((i) => i.id === 'temp').value;
  const c = state.indicators.emissions.find((i) => i.id === 'co2').value;
  lines.push([today, state.headline.risk, f(raw.physical), f(raw.emissions), f(raw.policy), f(raw.events), f(t), f(c)].join(','));
  fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
}

main().catch((e) => {
  console.error('::error::Update stopped: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
