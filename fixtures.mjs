/* Sample files in the formats the sources are expected to use. They are written from the
   documented formats, not downloaded, so the first real run is the true test of each source. */
const DAY = 86400000;
const d2 = (n) => String(n).padStart(2, '0');
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export function copernicus(now, { lagDays = 2, anomaly = 0.62, days = 800 } = {}) {
  const out = ['# Copernicus Climate Pulse sample', '# Daily surface air temperature', 'date, 2t, clim_91-20, ano_91-20, status'];
  const end = now - lagDays * DAY;
  for (let i = days; i >= 0; i--) {
    const t = end - i * DAY;
    const ano = anomaly + 0.05 * Math.sin(i / 3);
    out.push(`${ymd(t)}, ${(14.2 + ano).toFixed(2)}, 14.20, ${ano.toFixed(2)}, ${i < 5 ? 'PRELIMINARY' : 'FINAL'}`);
  }
  return out.join('\n') + '\n';
}

/* A file that stops in 1967, as in a reported download fault. */
export function copernicusTruncated() {
  return copernicus(Date.UTC(1967, 3, 29), { lagDays: 0 });
}

export function co2(now, { ppm = 428.4 } = {}) {
  const out = ['# NOAA GML Mauna Loa daily CO2 sample', '# year month day decimal  value'];
  for (let i = 60; i >= 2; i--) {
    const t = new Date(now - i * DAY);
    const v = i === 30 ? -999.99 : ppm + (60 - i) * 0.01;
    out.push(`${t.getUTCFullYear()} ${d2(t.getUTCMonth() + 1)} ${d2(t.getUTCDate())} 2026.8000 ${v.toFixed(2)}`);
  }
  return out.join('\n') + '\n';
}

/* Seasonal extent in million km2. Recent years are 8 percent lower than the baseline. */
export function nsidc(hemisphere, now, { recentFactor = 0.92 } = {}) {
  const out = ['Year, Month, Day,     Extent,    Missing, Source Data', 'YYYY, MM, DD,     10^6 sq km,     10^6 sq km, Source data product(s)'];
  const start = Date.UTC(1978, 9, 26);
  for (let t = start; t <= now - DAY; t += DAY) {
    const dt = new Date(t), y = dt.getUTCFullYear();
    const doy = Math.floor((t - Date.UTC(y, 0, 0)) / DAY);
    const season = Math.cos((2 * Math.PI * (doy - 60)) / 365);
    let e = hemisphere === 'N' ? 11 + 4 * season : 11 - 7 * season;
    if (y >= 2024) e *= recentFactor;
    out.push(`${y}, ${dt.getUTCMonth() + 1}, ${dt.getUTCDate()}, ${e.toFixed(3)}, 0.000, sample`);
  }
  return out.join('\n') + '\n';
}

export function oisst(now, { anomaly = 0.41 } = {}) {
  const year = new Date(now).getUTCFullYear();
  const today = Math.floor((now - Date.UTC(year, 0, 1)) / DAY);
  const base = Array.from({ length: 366 }, (_, i) => 20.5 + 0.8 * Math.cos((2 * Math.PI * i) / 365));
  const list = [];
  for (let y = year - 2; y <= year; y++) {
    list.push({ name: String(y), data: base.map((b, i) => (y < year || i < today - 1 ? +(b + anomaly).toFixed(2) : null)) });
  }
  list.push({ name: '1982-2011 mean', data: base.map((b) => +b.toFixed(2)) });
  list.push({ name: 'plus 2σ', data: base.map((b) => +(b + 0.3).toFixed(2)) });
  return JSON.stringify(list);
}

function feature(type, id, alert, lon, lat, country, fromDaysAgo, toDaysAgo, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      eventtype: type, eventid: id, episodeid: 1, alertlevel: alert, alertscore: alert === 'Red' ? 2.5 : 1.5,
      country, name: extra.name || '', fromdate: extra.fromdate, todate: extra.todate,
      datemodified: extra.datemodified,
      url: { report: `https://www.gdacs.org/report.aspx?eventtype=${type}&eventid=${id}` },
      severitydata: { severity: 0, severitytext: '', severityunit: '' }
    }
  };
}

export function gdacs(now, code) {
  const at = (daysAgo) => new Date(now - daysAgo * DAY).toISOString().slice(0, 19);
  const f = [];
  const mk = (type, id, alert, lon, lat, country, from, to, name = '') =>
    f.push(feature(type, id, alert, lon, lat, country, from, to, { name, fromdate: at(from), todate: at(to), datemodified: at(Math.min(from, 1)) }));
  if (code === 'FL') {
    mk('FL', 1001, 'Orange', 90.4, 23.8, 'Bangladesh', 5, -3, 'Brahmaputra floods');
    mk('FL', 1002, 'Red', 77.2, 28.6, 'India', 4, -2, 'Yamuna floods');
    mk('FL', 1003, 'Orange', 30, 10, 'Sudan', 60, 55, 'Old flood');
    f.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { eventtype: 'FL', eventid: 1004, alertlevel: 'Orange', fromdate: at(2), todate: at(0), datemodified: at(0) } });
    mk('FL', 1005, 'Green', 10, 10, 'Niger', 2, 0);
    mk('FL', 1001, 'Orange', 90.4, 23.8, 'Bangladesh', 5, -4, 'Brahmaputra floods');
  }
  if (code === 'TC') mk('TC', 2001, 'Red', 125.2, 14.1, 'Philippines', 3, -2, 'Typhoon Example');
  if (code === 'WF') mk('WF', 3001, 'Orange', 147.5, -34.2, 'Australia', 6, -1, 'Bushfire near Sydney');
  return JSON.stringify({ type: 'FeatureCollection', features: f });
}

const rssItem = (title, link, daysAgo, now) =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${new Date(now - daysAgo * DAY).toUTCString()}</pubDate><description>Body text that must never be copied</description></item>`;

export function rss(kind, now) {
  const items = {
    global: [
      ['Heatwave breaks records across southern Europe', 'https://example.org/a1', 1],
      ['EU agrees tougher 2040 emissions target', 'https://example.org/a2?utm=x', 2],
      ['Study finds Greenland ice loss is accelerating', 'https://example.org/a3', 3],
      ['Solar output overtakes coal in the EU &amp; UK', 'https://example.org/a4', 1],
      ['A column about gardening', 'https://example.org/a5', 1],
      ['Old story from last year', 'https://example.org/a6', 400]
    ],
    india: [
      ['India approves new carbon market rules', 'https://example.in/b1', 1],
      ['Cloudburst in Uttarakhand leaves villages cut off', 'https://example.in/b2', 2],
      ['Leopard sighted near a school', 'https://example.in/b3', 1]
    ]
  }[kind];
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Sample</title>${items.map((i) => rssItem(i[0], i[1], i[2], now)).join('')}</channel></rss>`;
}

export function atom(now) {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom entry about the climate treaty</title><link href="https://example.org/atom1"/><updated>${new Date(now - DAY).toISOString()}</updated></entry></feed>`;
}
