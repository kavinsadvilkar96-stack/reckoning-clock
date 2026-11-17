import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as P from '../lib/parsers.mjs';
import { classify, buildFeed } from '../lib/news.mjs';
import { resolveIndicator, capMove } from '../lib/guard.mjs';
import * as F from './fixtures.mjs';

const Core = createRequire(import.meta.url)('../../docs/clock-core.js');
const sample = JSON.parse(fs.readFileSync(new URL('../../docs/data/state.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('temperature: 30-day mean plus the 1850-1900 offset', () => {
  const r = P.parseCopernicusCsv(F.copernicus(NOW, { anomaly: 0.62 }), { offset: 0.88 });
  near(r.value, 1.5, 0.05);
  assert.equal(r.as_of, '2026-11-15');
});
test('temperature: rejects an unknown header, a short file and an absurd value', () => {
  assert.throws(() => P.parseCopernicusCsv('a,b,c\n1,2,3\n'), /header/);
  assert.throws(() => P.parseCopernicusCsv('date, 2t, clim_91-20, ano_91-20, status\n2026-01-01, 1, 1, 0.1, FINAL\n'), /rows/);
  assert.throws(() => P.parseCopernicusCsv(F.copernicus(NOW, { anomaly: 9 })), /out of range/);
});
test('temperature: a file that stops in 1967 parses but reports its old date', () => {
  const r = P.parseCopernicusCsv(F.copernicusTruncated());
  assert.equal(r.as_of.slice(0, 4), '1967');
});

test('CO2: skips missing values and averages the last 7 days', () => {
  const r = P.parseNoaaCo2(F.co2(NOW, { ppm: 428.4 }));
  near(r.value, 428.4 + 0.01 * 55, 0.1);
  assert.equal(r.as_of, '2026-11-15');
  assert.throws(() => P.parseNoaaCo2('# only comments\n'), /valid rows/);
});

test('sea ice: percent below the 1981-2010 average', () => {
  const n = P.parseNsidcCsv(F.nsidc('N', NOW)), s = P.parseNsidcCsv(F.nsidc('S', NOW));
  const r = P.seaIceBelowAverage(n, s);
  near(r.value, 8, 0.6);
  assert.equal(r.as_of, '2026-11-16');
  assert.throws(() => P.parseNsidcCsv('Year, Month\n'), /rows/);
});

test('ocean heat: anomaly against the 1982-2011 mean', () => {
  const r = P.parseOisst(JSON.parse(F.oisst(NOW, { anomaly: 0.41 })));
  near(r.value, 0.41, 0.02);
  assert.throws(() => P.parseOisst({}), /not a list/);
  assert.throws(() => P.parseOisst([{ name: '2026', data: [1] }]), /1982-2011 mean/);
});

test('hazards: keeps orange and red points, drops green, polygons and old events, merges episodes', () => {
  const ev = P.parseGdacs(JSON.parse(F.gdacs(NOW, 'FL')), NOW);
  assert.deepEqual(ev.map((e) => e.key).sort(), ['FL-1001', 'FL-1002']);
  const red = ev.find((e) => e.key === 'FL-1002');
  assert.equal(red.sev, 3); assert.equal(red.type, 'flood'); assert.equal(red.region, 'India');
  assert.match(red.url, /^https:\/\/www\.gdacs\.org/);
  assert.ok(red.title.includes('Yamuna'));
  assert.equal(P.parseGdacs(JSON.parse(F.gdacs(NOW, 'TC')), NOW)[0].type, 'storm');
  assert.equal(P.parseGdacs(JSON.parse(F.gdacs(NOW, 'WF')), NOW)[0].type, 'fire');
  assert.throws(() => P.parseGdacs({ type: 'x' }), /FeatureCollection/);
});
test('hazards: events score counts orange 1 and red 3', () => {
  const ev = P.parseGdacs(JSON.parse(F.gdacs(NOW, 'FL')), NOW);
  const r = P.eventsScore(ev, NOW);
  assert.equal(r.points, 4);
  assert.equal(r.score, 10);
  assert.equal(P.eventsScore([], NOW).score, 0);
  assert.equal(P.activeEvents(ev, NOW).length, 2);
});

test('news: reads RSS with CDATA and entities, and Atom', () => {
  const items = P.parseRss(F.rss('global', NOW));
  assert.equal(items.length, 6);
  assert.ok(items.some((i) => i.title === 'Solar output overtakes coal in the EU & UK'));
  assert.equal(P.parseRss(F.atom(NOW))[0].url, 'https://example.org/atom1');
  assert.throws(() => P.parseRss('<html></html>'), /not RSS/);
});
test('news: sections, India tag, dedupe, fallback and age limit', () => {
  const g = { name: 'Global Wire', region: 'Global', fallback: 'science' };
  const i = { name: 'India Daily', region: 'India', fallback: null };
  assert.equal(classify('Heatwave breaks records', g).section, 'disasters');
  assert.equal(classify('EU agrees tougher 2040 emissions target', g).section, 'policy');
  assert.equal(classify('Solar output overtakes coal', g).section, 'energy');
  assert.equal(classify('Delhi smog study', { name: 'x', fallback: null }).region, 'India');
  assert.equal(classify('Leopard sighted near a school', i).section, null);
  const items = [...P.parseRss(F.rss('global', NOW)).map((x) => ({ ...x, feed: g })), ...P.parseRss(F.rss('india', NOW)).map((x) => ({ ...x, feed: i }))];
  items.push({ ...items[0] });
  const out = buildFeed(items, ['policy', 'science', 'disasters', 'energy'], { now: NOW });
  const all = Object.values(out).flat();
  assert.ok(!all.some((x) => x.title.includes('Old story')), 'old items dropped');
  assert.ok(!all.some((x) => x.title.includes('Leopard')), 'off-topic Indian item dropped');
  assert.equal(all.filter((x) => x.title.startsWith('Heatwave')).length, 1, 'duplicates removed');
  assert.ok(out.disasters.some((x) => x.region === 'India'));
  assert.ok(all.every((x) => x.url && x.source && x.published), 'every item has link, source, time');
  assert.ok(all.every((x) => !('description' in x)), 'no article text kept');
});

test('guard: fresh, stale, too old and unavailable', () => {
  const def = { id: 'temp', decimals: 2 };
  const opt = { now: NOW, maxAgeDays: 14, dropAfterDays: 30 };
  assert.equal(resolveIndicator(def, { value: 1.5, as_of: '2026-11-15' }, null, opt).status, 'live');
  const prev = { value: 1.4, as_of: '2026-11-10' };
  const s = resolveIndicator(def, null, prev, opt);
  assert.equal(s.status, 'stale'); assert.equal(s.value, 1.4);
  assert.equal(resolveIndicator(def, { value: 1.5, as_of: '1967-04-29' }, prev, opt).status, 'stale', 'old data is treated as a failure');
  assert.equal(resolveIndicator(def, null, { value: 1.4, as_of: '2026-09-01' }, opt).status, 'unavailable');
  assert.equal(resolveIndicator(def, null, null, opt).value, null);
  assert.equal(resolveIndicator(def, { value: NaN, as_of: '2026-11-15' }, null, opt).status, 'unavailable');
});
test('guard: the headline moves at most the cap', () => {
  assert.deepEqual(capMove(60, 53, 0.5), { risk: 53.5, capped: true });
  assert.deepEqual(capMove(40, 53, 0.5), { risk: 52.5, capped: true });
  assert.deepEqual(capMove(53.3, 53, 0.5), { risk: 53.3, capped: false });
  assert.deepEqual(capMove(60, NaN, 0.5), { risk: 60, capped: false });
});

test('scoring: skips missing inputs and rescales the weights', () => {
  const full = Core.compute(sample);
  near(full.risk, 52.93, 0.05);
  near(full.coverage, 1, 1e-9);
  const t = JSON.parse(JSON.stringify(sample));
  t.indicators.physical[1].value = null;
  t.indicators.events.score = null;
  const part = Core.compute(t);
  assert.ok(part.coverage < 0.95 && part.coverage > 0.8);
  assert.ok(Number.isFinite(part.risk));
  t.indicators.physical[0].value = null;
  assert.equal(Core.whatIf(t, 20, 55), null);
});
