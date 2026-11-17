/* The Reckoning Clock: scoring and what-if maths.
   Used by the page in the browser and by the Node updater job. No dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClockCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  /* 0 at the starting line, 100 at the 2050 worst-case value. */
  function scoreOf(value, zero, midnight) {
    return clamp(((value - zero) / (midnight - zero)) * 100, 0, 100);
  }

  /* Minutes left on a 60-minute dial. Squared so each point matters more near midnight. */
  function minutesToMidnight(risk) {
    return 60 * Math.pow(1 - clamp(risk, 0, 100) / 100, 2);
  }

  function mean(list) {
    return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* An input with no reading (null) is left out, and the remaining weights are scaled up to 100%.
     over: optional map of indicator id to replacement value (used by what-if). */
  function compute(state, over) {
    over = over || {};
    var items = {};
    function pillarScore(list) {
      var s = [];
      list.forEach(function (i) {
        var v = has(over, i.id) ? over[i.id] : i.value;
        if (v === null || v === undefined || !isFinite(v)) return;
        var sc = scoreOf(v, i.zero, i.midnight);
        items[i.id] = sc;
        s.push(sc);
      });
      return s.length ? mean(s) : null;
    }
    function direct(ind) {
      return ind && ind.score !== null && ind.score !== undefined && isFinite(ind.score) ? clamp(ind.score, 0, 100) : null;
    }
    var parts = {
      physical: pillarScore(state.indicators.physical),
      emissions: pillarScore(state.indicators.emissions),
      policy: direct(state.indicators.policy),
      events: direct(state.indicators.events)
    };
    var w = state.weights, num = 0, den = 0;
    Object.keys(parts).forEach(function (k) {
      if (parts[k] !== null) { num += w[k] * parts[k]; den += w[k]; }
    });
    var risk = den ? num / den : 0;
    return {
      physical: parts.physical, emissions: parts.emissions, policy: parts.policy, events: parts.events,
      risk: risk, minutes: minutesToMidnight(risk), items: items, coverage: den
    };
  }

  function valueOf(state, id) {
    var all = state.indicators.physical.concat(state.indicators.emissions);
    for (var k = 0; k < all.length; k++) if (all[k].id === id) return all[k].value;
    return null;
  }

  /* Illustrative carbon-budget model: warming tracks cumulative CO2. Not a forecast. */
  function project(state, cutPct, renewPct) {
    var w = state.whatif;
    var years = w.end_year - w.start_year;
    var post = w.outlook_year - w.end_year;
    var e0 = w.emissions_now_gt;
    var extra = w.power_emissions_gt * (renewPct - w.default_renewable_pct) / (100 - w.renewable_share_now);
    var e50 = Math.max(0, e0 * (1 - cutPct / 100) - extra);
    var cum50 = years * (e0 + e50) / 2;
    var cum00 = cum50 + post * e50;
    var tNow = valueOf(state, 'temp');
    return {
      emissions2050: e50,
      cumulative2050: cum50,
      temp2050: tNow + w.committed_c + w.tcre_c_per_gt * cum50,
      temp2100: tNow + w.committed_c + w.tcre_c_per_gt * cum00,
      co2ppm2050: valueOf(state, 'co2') + w.ppm_per_gt * cum50
    };
  }

  /* Reading in 2050 for a chosen path. Policy and events are held at today's score.
     Returns null when today's temperature or CO2 is missing, because the model needs both. */
  function whatIf(state, cutPct, renewPct) {
    var tNow = valueOf(state, 'temp');
    if (tNow === null || valueOf(state, 'co2') === null) return null;
    var p = project(state, cutPct, renewPct);
    var ratio = p.temp2050 / tNow;
    var over = { temp: p.temp2050, co2: p.co2ppm2050, flow: p.emissions2050 };
    ['seaice', 'sst'].forEach(function (id) {
      var v = valueOf(state, id);
      if (v !== null) over[id] = v * ratio;
    });
    var r = compute(state, over);
    r.projection = p;
    return r;
  }

  /* Dial position: 60 minutes on the face, midnight at the top. Degrees clockwise from 12. */
  function angleOf(minutes) {
    return (60 - clamp(minutes, 0, 60)) * 6;
  }

  function clockFace(minutes) {
    var remaining = Math.round(clamp(minutes, 0, 60) * 60);
    if (remaining === 0) return { text: 'Midnight', remaining: 0 };
    var elapsed = 3600 - remaining;
    var mm = Math.floor(elapsed / 60);
    var ss = elapsed % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return { text: '11:' + pad(mm) + ':' + pad(ss) + ' PM', remaining: remaining };
  }

  return {
    clamp: clamp, scoreOf: scoreOf, minutesToMidnight: minutesToMidnight, compute: compute,
    project: project, whatIf: whatIf, angleOf: angleOf, clockFace: clockFace, valueOf: valueOf
  };
});
