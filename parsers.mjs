/* Pure parsers for the data sources. No network access here, so they can be tested on sample files.
   Every parser throws a clear Error when the data does not look right. The caller treats a throw as
   "this source failed" and keeps the last good value. Nothing here ever guesses a value. */

const DAY = 86400000;

export function mean(list) {
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(iso) {
  return Date.parse(iso + 'T00:00:00Z');
}

/* ---------- Temperature: Copernicus Climate Pulse (ERA5), daily CSV ----------
   Comment lines start with #. Header: date, 2t, clim_91-20, ano_91-20, status.
   The anomaly is against 1991-2020, so a fixed offset converts it to 1850-1900.
   Returns the mean of the last `window` days. */
export function parseCopernicusCsv(text, { offset = 0.88, window = 30 } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) throw new Error('temperature file is empty');
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const iDate = header.indexOf('date');
  const iAno = header.findIndex((h) => h.startsWith('ano'));
  if (iDate < 0 || iAno < 0) throw new Error('temperature header not recognised: ' + lines[0].slice(0, 80));
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const date = (c[iDate] || '').trim();
    const ano = Number(c[iAno]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(ano) && c[iAno].trim() !== '') rows.push({ date, ano });
  }
  if (rows.length < 365) throw new Error('temperature file has only ' + rows.length + ' rows');
  const last = rows.slice(-window);
  const span = (dayMs(last[last.length - 1].date) - dayMs(last[0].date)) / DAY;
  if (span > window + 4) throw new Error('temperature rows are not continuous (span ' + span + ' days)');
  const value = mean(last.map((r) => r.ano)) + offset;
  if (!(value > -0.5 && value < 3.5)) throw new Error('temperature out of range: ' + value.toFixed(2));
  return { value, as_of: last[last.length - 1].date };
}

/* ---------- CO2: NOAA Mauna Loa daily (or weekly) text file ----------
   Comment lines start with #. Data columns: year month day decimal-date value ...
   Missing values are -999.99. Returns the mean of the last 7 valid days. */
export function parseNoaaCo2(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const f = t.split(/\s+/);
    if (f.length < 5) continue;
    const y = +f[0], m = +f[1], d = +f[2], v = +f[4];
    if (!(y > 1950 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) continue;
    if (!(v > 300 && v < 650)) continue;
    rows.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, v });
  }
  if (rows.length < 7) throw new Error('CO2 file has only ' + rows.length + ' valid rows');
  const last = rows.slice(-7);
  const span = (dayMs(last[6].date) - dayMs(last[0].date)) / DAY;
  if (span > 40) throw new Error('CO2 rows are not recent enough to average');
  return { value: mean(last.map((r) => r.v)), as_of: last[6].date };
}

/* ---------- Sea ice: NSIDC Sea Ice Index daily extent, north and south ----------
   Rows: Year, Month, Day, Extent (million km2), Missing, Source. Non-numeric lines are skipped. */
export function parseNsidcCsv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 4) continue;
    const y = +c[0], m = +c[1], d = +c[2], e = +c[3];
    if (!(y > 1970 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && e > 0 && e < 30)) continue;
    out.set(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, e);
  }
  if (out.size < 1000) throw new Error('sea ice file has only ' + out.size + ' rows');
  return out;
}

/* Global extent now, as a percent below the 1981-2010 average for the same time of year.
   The average is built from the same files, so no extra climatology file is needed. */
export function seaIceBelowAverage(north, south, { from = 1981, to = 2010, windowDays = 3 } = {}) {
  const dates = [...north.keys()].filter((k) => south.has(k)).sort();
  if (!dates.length) throw new Error('sea ice: north and south files share no dates');
  const latest = dates[dates.length - 1];
  const total = north.get(latest) + south.get(latest);
  const [, mm, dd] = latest.split('-').map(Number);
  const perYear = [];
  for (let y = from; y <= to; y++) {
    const vals = [];
    for (let o = -windowDays; o <= windowDays; o++) {
      const key = isoDay(Date.UTC(y, mm - 1, dd + o));
      if (north.has(key) && south.has(key)) vals.push(north.get(key) + south.get(key));
    }
    if (vals.length) perYear.push(mean(vals));
  }
  if (perYear.length < 20) throw new Error('sea ice: baseline has only ' + perYear.length + ' years');
  const clim = mean(perYear);
  const value = ((clim - total) / clim) * 100;
  if (!(value > -40 && value < 60)) throw new Error('sea ice out of range: ' + value.toFixed(1));
  return { value, as_of: latest, extent: total, baseline: clim };
}

/* ---------- Ocean heat: NOAA OISST via Climate Reanalyzer daily JSON ----------
   An array of { name, data }: one entry per year (name "2026") and a "1982-2011 mean" entry,
   each with one value per day of the year (null when there is no data yet). */
export function parseOisst(json, { window = 7 } = {}) {
  if (!Array.isArray(json)) throw new Error('ocean file is not a list');
  const years = json
    .filter((e) => e && /^\d{4}$/.test(String(e.name)) && Array.isArray(e.data))
    .sort((a, b) => Number(b.name) - Number(a.name));
  const base = json.find((e) => e && /mean/i.test(String(e.name)) && /^19\d\d/.test(String(e.name)) && Array.isArray(e.data));
  if (!base) throw new Error('ocean file has no 1982-2011 mean');
  const entry = years.find((e) => e.data.some((v) => Number.isFinite(v)));
  if (!entry) throw new Error('ocean file has no recent year');
  const idx = [];
  for (let i = 0; i < entry.data.length; i++) {
    if (Number.isFinite(entry.data[i]) && Number.isFinite(base.data[i])) idx.push(i);
  }
  if (idx.length < window) throw new Error('ocean file has too few days');
  const lastIdx = idx.slice(-window);
  const value = mean(lastIdx.map((i) => entry.data[i] - base.data[i]));
  if (!(value > -1.5 && value < 3)) throw new Error('ocean heat out of range: ' + value.toFixed(2));
  const asOf = isoDay(Date.UTC(Number(entry.name), 0, 1 + lastIdx[lastIdx.length - 1]));
  return { value, as_of: asOf };
}

/* ---------- Hazards: GDACS GeoJSON event list ---------- */
const TYPE = { FL: 'flood', TC: 'storm', WF: 'fire' };
const TYPE_WORD = { flood: 'Flood', storm: 'Tropical cyclone', fire: 'Wildfire' };
const ALERT_SEV = { orange: 2, red: 3 };

function utc(s) {
  if (!s) return NaN;
  const t = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z';
  return Date.parse(t);
}

export function parseGdacs(json, now = Date.now()) {
  if (!json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) throw new Error('hazard file is not a FeatureCollection');
  const best = new Map();
  for (const f of json.features) {
    const p = f && f.properties;
    const g = f && f.geometry;
    if (!p || !g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const type = TYPE[String(p.eventtype || '').toUpperCase()];
    const sev = ALERT_SEV[String(p.alertlevel || '').toLowerCase()];
    const [lon, lat] = g.coordinates.map(Number);
    if (!type || !sev || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90)) continue;
    const from = utc(p.fromdate), to = utc(p.todate), mod = utc(p.datemodified);
    const published = Number.isFinite(mod) ? mod : Number.isFinite(from) ? from : NaN;
    if (!Number.isFinite(published)) continue;
    const url = p.url && (p.url.report || p.url.details);
    const where = String(p.country || '').trim();
    const name = String(p.name || p.eventname || '').trim();
    const ev = {
      key: `${p.eventtype}-${p.eventid}`,
      type, sev, alert: sev === 3 ? 'Red' : 'Orange', lon, lat,
      region: where || 'Unspecified',
      title: `${TYPE_WORD[type]}, ${sev === 3 ? 'red' : 'orange'} alert${name ? ': ' + name : where ? ': ' + where : ''}`,
      source: 'GDACS',
      published: new Date(published).toISOString(),
      from: Number.isFinite(from) ? new Date(from).toISOString() : null,
      to: Number.isFinite(to) ? new Date(to).toISOString() : null,
      url: typeof url === 'string' && /^https?:\/\//.test(url) ? url : null,
      score: Number(p.alertscore) || 0
    };
    const old = best.get(ev.key);
    if (!old || ev.published > old.published) best.set(ev.key, ev);
  }
  const events = [...best.values()].filter((e) => {
    const end = e.to ? Date.parse(e.to) : Date.parse(e.published);
    return end >= now - 30 * DAY;
  });
  return events;
}

/* Events in the last 30 days become a 0-100 score. Orange = 1 point, Red = 3. 40 points = 100. */
export function eventsScore(events, now = Date.now(), { pointsAtMax = 40 } = {}) {
  let points = 0;
  for (const e of events) {
    const end = e.to ? Date.parse(e.to) : Date.parse(e.published);
    const start = e.from ? Date.parse(e.from) : end;
    if (end >= now - 30 * DAY && start <= now) points += e.sev === 3 ? 3 : 1;
  }
  return { points, score: Math.min(100, Math.max(0, (points / pointsAtMax) * 100)) };
}

/* Active means it ended less than 3 days ago, or has not ended. */
export function activeEvents(events, now = Date.now()) {
  return events.filter((e) => {
    const end = e.to ? Date.parse(e.to) : Date.parse(e.published) + 3 * DAY;
    return end >= now - 3 * DAY;
  });
}

/* ---------- News: RSS 2.0 and Atom ---------- */
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}

export function parseRss(xml) {
  if (typeof xml !== 'string' || !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('feed is not RSS or Atom');
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const title = decode(tag(b, 'title'));
    let link = decode(tag(b, 'link'));
    if (!link) {
      const m = b.match(/<link[^>]*\shref=["']([^"']+)["']/i);
      if (m) link = decode(m[1]);
    }
    const dateRaw = decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = Date.parse(dateRaw);
    if (!title || !/^https?:\/\//.test(link) || !Number.isFinite(t)) continue;
    items.push({ title, url: link, published: new Date(t).toISOString() });
  }
  if (!items.length) throw new Error('feed has no readable items');
  return items;
}
