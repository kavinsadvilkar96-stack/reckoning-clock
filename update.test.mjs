import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reckoning-'));
  fs.mkdirSync(path.join(dir, 'docs/data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'));
  fs.copyFileSync(path.join(REPO, 'docs/data/state.json'), path.join(dir, 'docs/data/state.json'));
  for (const f of ['control.json', 'manual.json', 'config/feeds.json']) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  return dir;
}
function run(dir, env = {}) {
  const r = spawnSync(process.execPath, ['--import', path.join(REPO, 'scripts/test/mock-fetch.mjs'), path.join(REPO, 'scripts/update.mjs')], {
    env: { ...process.env, RECKONING_ROOT: dir, SITE_URL: '', MOCK_FAIL: '', ...env }, encoding: 'utf8'
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'docs/data/state.json'), 'utf8'));
const ind = (s, id) => s.indicators.physical.concat(s.indicators.emissions).find((i) => i.id === id);

test('first run with every source working goes live', () => {
  const dir = sandbox();
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  const s = read(dir);
  assert.equal(s.data_mode, 'live');
  assert.equal(s.schema, 2);
  assert.ok(Math.abs(ind(s, 'temp').value - 1.5) < 0.06, 'temp ' + ind(s, 'temp').value);
  assert.ok(Math.abs(ind(s, 'seaice').value - 8) < 0.7);
  assert.ok(Math.abs(ind(s, 'sst').value - 0.41) < 0.03);
  assert.equal(ind(s, 'flow').status, 'manual');
  assert.equal(ind(s, 'temp').status, 'live');
  assert.equal(s.indicators.policy.status, 'manual');
  assert.ok(s.indicators.policy.score > 50 && s.indicators.policy.score < 65);
  assert.ok(Number.isFinite(s.headline.risk) && s.headline.capped === false);
  assert.ok(s.hotspots.length >= 4);
  assert.ok(s.hotspots.every((h) => h.people_m === null && h.source && h.published));
  assert.deepEqual(s.hazard_types.map((h) => [h.id, h.connected]), [['heat', false], ['fire', true], ['flood', true], ['storm', true]]);
  assert.ok(s.feed.disasters.length > 0 && s.feed.policy.length > 0);
  assert.ok(Object.values(s.feed).flat().every((i) => i.url && i.source && i.published));
  assert.ok(Object.values(s.feed).flat().some((i) => i.region === 'India'));
  assert.equal(s.whatif.emissions_now_gt, 38.2);
  const hist = fs.readFileSync(path.join(dir, 'docs/data/history.csv'), 'utf8').trim().split('\n');
  assert.equal(hist.length, 2);
  /* a second run on the same day does not add a row */
  run(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'docs/data/history.csv'), 'utf8').trim().split('\n').length, 2);
});

test('the headline score moves at most 0.5 points per update', () => {
  const dir = sandbox();
  run(dir);
  const s = read(dir);
  s.headline.risk = s.headline.raw_risk - 10;
  fs.writeFileSync(path.join(dir, 'docs/data/state.json'), JSON.stringify(s));
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  const t = read(dir);
  assert.equal(t.headline.capped, true);
  assert.ok(Math.abs(t.headline.risk - (s.headline.risk + 0.5)) < 0.011, `${t.headline.risk} vs ${s.headline.risk + 0.5}`);
  assert.ok(Math.abs(t.headline.raw_risk - s.headline.raw_risk) < 0.2);
});

test('a failing source keeps its last good value and is marked stale', () => {
  const dir = sandbox();
  run(dir);
  const first = read(dir);
  const r = run(dir, { MOCK_FAIL: 'temp,sst,feeds,gdacs_WF' });
  assert.equal(r.code, 0, r.out);
  const s = read(dir);
  assert.equal(ind(s, 'temp').status, 'stale');
  assert.equal(ind(s, 'temp').value, ind(first, 'temp').value);
  assert.equal(ind(s, 'sst').status, 'stale');
  assert.equal(ind(s, 'co2').status, 'live');
  assert.deepEqual(s.feed, first.feed, 'news list kept when every feed fails');
  assert.equal(s.hazard_types.find((h) => h.id === 'fire').connected, false);
  assert.equal(s.indicators.events.status, 'live', 'wildfire is optional');
  assert.equal(s.health.sources.temp.ok, false);
});

test('flood alerts failing makes the events score stale instead of wrong', () => {
  const dir = sandbox();
  run(dir);
  const first = read(dir);
  run(dir, { MOCK_FAIL: 'gdacs_FL' });
  const s = read(dir);
  assert.equal(s.indicators.events.status, 'stale');
  assert.equal(s.indicators.events.score, first.indicators.events.score);
});

test('a source that stops updating is treated as failed', () => {
  const dir = sandbox();
  run(dir);
  const first = read(dir);
  run(dir, { MOCK_FAIL: 'temp_old' });
  const s = read(dir);
  assert.equal(ind(s, 'temp').status, 'stale');
  assert.equal(ind(s, 'temp').value, ind(first, 'temp').value);
});

test('first run without temperature leaves the sample data in place', () => {
  const dir = sandbox();
  const before = fs.readFileSync(path.join(dir, 'docs/data/state.json'), 'utf8');
  const r = run(dir, { MOCK_FAIL: 'temp' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning::First live run/);
  assert.equal(fs.readFileSync(path.join(dir, 'docs/data/state.json'), 'utf8'), before);
});

test('kill switch freezes the last live state', () => {
  const dir = sandbox();
  run(dir);
  const first = read(dir);
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ kill_switch: true, reason: 'bad source' }));
  const r = run(dir, { MOCK_PREV: JSON.stringify(first) , SITE_URL: 'https://example.github.io/clock' });
  assert.equal(r.code, 0, r.out);
  const s = read(dir);
  assert.equal(s.kill_switch, true);
  assert.equal(s.updated_at, first.updated_at);
  assert.equal(s.headline.risk, first.headline.risk);
  assert.deepEqual(s.indicators, first.indicators);
});

test('a server error reading the published state stops the run without writing', () => {
  const dir = sandbox();
  const before = fs.readFileSync(path.join(dir, 'docs/data/state.json'), 'utf8');
  const r = run(dir, { SITE_URL: 'https://example.github.io/clock', MOCK_PREV_STATUS: '503' });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::Update stopped/);
  assert.equal(fs.readFileSync(path.join(dir, 'docs/data/state.json'), 'utf8'), before);
});

test('a missing published state (404) counts as the first run', () => {
  const dir = sandbox();
  const r = run(dir, { SITE_URL: 'https://example.github.io/clock' });
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir).data_mode, 'live');
});

test('the published state is used as the previous state', () => {
  const dir = sandbox();
  run(dir);
  const first = read(dir);
  first.headline.risk = first.headline.raw_risk - 5;
  const r = run(dir, { SITE_URL: 'https://example.github.io/clock', MOCK_PREV: JSON.stringify(first) });
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir).headline.capped, true);
});
