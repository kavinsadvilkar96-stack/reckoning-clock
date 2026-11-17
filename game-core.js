/* Be the world leader: the year-by-year model and the rules of the game.
   Used by the page and by the tests. Depends only on ClockCore. Illustrative, not a forecast. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clock-core.js'));
  else root.GameCore = factory(root.ClockCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  var clamp = C.clamp;

  function byId(game) {
    var m = {};
    game.policies.forEach(function (p) { m[p.id] = p; });
    return m;
  }

  function termYear(state, game, term) { return state.whatif.start_year + term * game.term_years; }

  /* The current path is the same default path the what-if sliders start from (20% cut, 55% renewables).
     Each adopted policy then removes a share of that path's emissions, ramping in over ramp_years.
     adopted: [{ id, year }]. Returns null when today's temperature or CO2 is missing. */
  function play(state, game, adopted) {
    var w = state.whatif, t0 = C.valueOf(state, 'temp'), c0 = C.valueOf(state, 'co2');
    if (t0 === null || c0 === null) return null;
    var pol = byId(game), n = w.end_year - w.start_year, e0 = w.emissions_now_gt;
    var base50 = C.project(state, w.default_cut_pct, w.default_renewable_pct).emissions2050;
    var seaice = C.valueOf(state, 'seaice'), sst = C.valueOf(state, 'sst');
    var years = [], cum = 0, prevE = e0, last = null;

    function score(temp, ppm, e) {
      var ratio = temp / t0, over = { temp: temp, co2: ppm, flow: e };
      if (seaice !== null) over.seaice = seaice * ratio;
      if (sst !== null) over.sst = sst * ratio;
      return C.compute(state, over);
    }

    for (var y = w.start_year; y <= w.end_year; y++) {
      var eb = e0 + (base50 - e0) * (y - w.start_year) / n, f = 1;
      adopted.forEach(function (a) {
        var p = pol[a.id];
        if (p) f *= 1 - (p.cut / 100) * clamp((y - a.year) / game.ramp_years, 0, 1);
      });
      var e = eb * f;
      if (y > w.start_year) cum += (prevE + e) / 2;
      prevE = e;
      var temp = t0 + w.committed_c * (y - w.start_year) / n + w.tcre_c_per_gt * cum;
      var ppm = c0 + w.ppm_per_gt * cum;
      last = score(temp, ppm, e);
      years.push({ year: y, emissions: e, base: eb, temp: temp, risk: last.risk });
    }
    var fin = years[years.length - 1];
    var post = w.outlook_year - w.end_year;
    last.years = years;
    last.projection = {
      emissions2050: fin.emissions,
      cumulative2050: cum,
      temp2050: fin.temp,
      temp2100: t0 + w.committed_c + w.tcre_c_per_gt * (cum + post * fin.emissions),
      co2ppm2050: c0 + w.ppm_per_gt * cum
    };
    return last;
  }

  /* ---------- rules ---------- */
  function start(game) {
    return { term: 0, capital: game.capital_per_term, support: game.support_start, adopted: [], history: [], done: false, gridlock: false };
  }

  function cost(game, ids) {
    var pol = byId(game);
    return ids.reduce(function (a, id) { return a + (pol[id] ? pol[id].cost : 0); }, 0);
  }

  function isAdopted(g, id) {
    return g.adopted.some(function (a) { return a.id === id; });
  }

  /* Ends the current term with the chosen policies. Returns the next game state. */
  function finishTerm(state, game, g, picks) {
    var pol = byId(game);
    if (g.done) throw new Error('The game is over');
    var seen = {};
    picks.forEach(function (id) {
      if (!pol[id]) throw new Error('Unknown policy ' + id);
      if (isAdopted(g, id) || seen[id]) throw new Error('Policy already in place: ' + id);
      seen[id] = true;
    });
    var spent = cost(game, picks);
    if (spent > g.capital) throw new Error('Not enough political capital');
    var year = termYear(state, game, g.term);
    var support = clamp(
      g.support + picks.reduce(function (a, id) { return a + pol[id].support; }, 0) + game.support_recovery, 0, 100);
    var left = Math.min(game.carry_max, g.capital - spent);
    var gridlock = support < game.gridlock_below;
    var nextTerm = g.term + 1;
    return {
      term: nextTerm,
      capital: Math.max(1, game.capital_per_term + left - (gridlock ? 1 : 0)),
      support: support,
      adopted: g.adopted.concat(picks.map(function (id) { return { id: id, year: year, term: g.term }; })),
      history: g.history.concat([{ term: g.term, year: year, picks: picks.slice(), spent: spent, support: support }]),
      done: nextTerm >= game.terms,
      gridlock: gridlock
    };
  }

  /* First tier whose max_temp_2100 is at or above the result. */
  function verdict(game, temp2100) {
    for (var i = 0; i < game.verdicts.length; i++) {
      if (temp2100 <= game.verdicts[i].max_temp_2100) return game.verdicts[i];
    }
    return game.verdicts[game.verdicts.length - 1];
  }

  return { play: play, start: start, cost: cost, isAdopted: isAdopted, finishTerm: finishTerm, verdict: verdict, termYear: termYear, byId: byId };
});
