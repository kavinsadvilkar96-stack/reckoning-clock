import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../docs/clock-core.js');
const G = require('../../docs/game-core.js');
const read = (f) => JSON.parse(fs.readFileSync(new URL('../../docs/data/' + f, import.meta.url), 'utf8'));
const state = read('state.json');
const game = read('game.json');
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const ids = game.policies.map((p) => p.id);

test('game data is well formed', () => {
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const p of game.policies) {
    assert.ok(p.title && p.blurb, p.id);
    assert.ok(Number.isInteger(p.cost) && p.cost >= 1 && p.cost <= game.capital_per_term, p.id + ' cost');
    assert.ok(p.cut > 0 && p.cut < 30, p.id + ' cut');
    assert.ok(Number.isFinite(p.support), p.id + ' support');
  }
  assert.equal(game.terms * game.term_years, state.whatif.end_year - state.whatif.start_year, 'terms fill the years to 2050');
  const v = game.verdicts.map((x) => x.max_temp_2100);
  assert.deepEqual([...v].sort((a, b) => a - b), v, 'verdict tiers are in order');
});

test('with no policies the game matches the what-if default path', () => {
  const p = G.play(state, game, []);
  const w = C.whatIf(state, state.whatif.default_cut_pct, state.whatif.default_renewable_pct);
  near(p.risk, w.risk, 1e-9);
  near(p.projection.temp2050, w.projection.temp2050, 1e-9);
  near(p.projection.temp2100, w.projection.temp2100, 1e-9);
  near(p.projection.emissions2050, w.projection.emissions2050, 1e-9);
  assert.equal(p.years.length, 25);
  near(p.years[0].risk, C.compute(state).risk, 1e-9, 'starts at today');
});

test('every policy lowers emissions and warming, and earlier is better than later', () => {
  const base = G.play(state, game, []);
  for (const id of ids) {
    const early = G.play(state, game, [{ id, year: 2026 }]);
    const late = G.play(state, game, [{ id, year: 2044 }]);
    assert.ok(early.projection.temp2100 < base.projection.temp2100, id);
    assert.ok(late.projection.temp2100 < base.projection.temp2100, id);
    assert.ok(early.projection.temp2100 < late.projection.temp2100, id + ' early beats late');
    assert.ok(early.risk <= base.risk, id);
  }
  const stacked = G.play(state, game, ids.map((id) => ({ id, year: 2026 })));
  assert.ok(stacked.projection.emissions2050 > 0, 'emissions never go negative');
  assert.ok(stacked.projection.temp2100 > 2.0, 'the model never promises a miracle');
});

test('the model needs temperature and CO2', () => {
  const t = JSON.parse(JSON.stringify(state));
  t.indicators.physical[0].value = null;
  assert.equal(G.play(t, game, []), null);
});

test('rules: capital, carry-over, support and gridlock', () => {
  let g = G.start(game);
  assert.equal(g.capital, 4); assert.equal(g.support, 60); assert.equal(g.term, 0);
  assert.throws(() => G.finishTerm(state, game, g, ['carbon-price', 'coal-exit']), /capital/);
  assert.throws(() => G.finishTerm(state, game, g, ['nope']), /Unknown/);
  assert.throws(() => G.finishTerm(state, game, g, ['wind-solar', 'wind-solar']), /already/);
  /* spend 1 of 4: carry 2 at most */
  g = G.finishTerm(state, game, g, ['public-transport']);
  assert.equal(g.term, 1); assert.equal(g.capital, 4 + 2); assert.equal(g.support, 60 + 5 + 4);
  assert.equal(g.adopted[0].year, 2026);
  assert.throws(() => G.finishTerm(state, game, g, ['public-transport']), /already/);
  /* heavy, unpopular choices drive support below 30 and cost a point of capital */
  g = G.finishTerm(state, game, g, ['carbon-price', 'coal-exit']); /* spends 6, support 69-20+4=53 */
  assert.equal(g.support, 53); assert.equal(g.gridlock, false); assert.equal(g.capital, 4);
  g = G.finishTerm(state, game, g, ['end-subsidies', 'food-waste']); /* 53-6-1+4=50 */
  assert.equal(g.adopted[g.adopted.length - 1].year, 2038);
  const hard = { ...G.start(game), support: 33 };
  const h = G.finishTerm(state, game, hard, ['carbon-price']); /* 33-12+4=25 */
  assert.equal(h.support, 25); assert.equal(h.gridlock, true); assert.equal(h.capital, 4 + 1 - 1);
  const top = { ...G.start(game), support: 99 };
  assert.equal(G.finishTerm(state, game, top, ['public-transport']).support, 100, 'support is capped at 100');
});

test('a game lasts four terms, in six-year steps', () => {
  let g = G.start(game);
  const years = [];
  while (!g.done) { years.push(G.termYear(state, game, g.term)); g = G.finishTerm(state, game, g, []); }
  assert.deepEqual(years, [2026, 2032, 2038, 2044]);
  assert.equal(g.term, 4);
  assert.throws(() => G.finishTerm(state, game, g, []), /over/);
  assert.equal(g.capital, 4 + 2, 'unspent capital carries up to the limit');
});

test('verdicts cover the achievable range', () => {
  const none = G.play(state, game, []).projection.temp2100;
  assert.equal(G.verdict(game, none).title, 'Bystander');
  assert.equal(G.verdict(game, 2.28).title, 'Steward of the century');
  assert.equal(G.verdict(game, 2.45).title, 'Reluctant reformer');
  /* a sensible two-policy-a-term game lands in the middle tiers */
  let g = G.start(game);
  const plan = [['carbon-price', 'public-transport'], ['wind-solar', 'end-subsidies'], ['coal-exit', 'food-waste'], ['firm-power', 'electric-vehicles']];
  for (const picks of plan) g = G.finishTerm(state, game, g, picks);
  const t = G.play(state, game, g.adopted).projection.temp2100;
  assert.ok(t < 2.33, 'the best plan reaches the top tier: ' + t);
  assert.ok(g.support > 30, 'and stays out of gridlock');
});
