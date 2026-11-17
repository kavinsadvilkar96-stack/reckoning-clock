/* Be the world leader: the interface. The model and rules live in game-core.js. */
(function () {
  'use strict';
  var C = window.ClockCore, G = window.GameCore, page = window.ReckoningPage;
  var sec = document.getElementById('gameSec'), host = document.getElementById('game');
  if (!C || !G || !page || !host) { if (sec) sec.hidden = true; return; }

  var NS = 'http://www.w3.org/2000/svg', MINUS = '−';
  var calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var state = page.getState(), game = null, g = null, picks = [], shown = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svgEl(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function fmt(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function signed(n, d) { var k = Math.pow(10, d), r = Math.round(Math.abs(n) * k) / k; return r === 0 ? fmt(0, d) : (n < 0 ? MINUS : '+') + fmt(r, d); }
  function plate(cls) { var p = el('div', 'plate ' + cls); for (var i = 0; i < 4; i++) p.appendChild(el('i')); return p; }
  function pips(n, total) {
    var w = el('span', 'pips'); w.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < total; i++) w.appendChild(el('span', 'pip' + (i < n ? '' : ' off')));
    return w;
  }
  function scrollToGame() { sec.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' }); }
  function pickYear() { return G.termYear(state, game, g.term); }
  function withPicks() { var y = pickYear(); return g.adopted.concat(picks.map(function (id) { return { id: id, year: y }; })); }

  /* ---------- chart: emissions on your path against the current path ---------- */
  function chart(base, mine) {
    var W = 360, H = 190, L = 34, R = 52, T = 18, B = 26, pw = W - L - R, ph = H - T - B;
    var y0 = base.years[0].year, y1 = base.years[base.years.length - 1].year, n = base.years.length;
    var ymax = Math.max(10, Math.ceil(base.years[0].emissions / 10) * 10);
    function X(y) { return L + (y - y0) / (y1 - y0) * pw; }
    function Y(e) { return T + ph * (1 - e / ymax); }
    var eb = base.years[n - 1].emissions, em = mine.years[n - 1].emissions;
    var wrap = el('div', 'g-chartwrap');
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Emissions in billion tonnes of CO2 a year. They fall from ' + fmt(base.years[0].emissions, 0) + ' in ' + y0 + ' to ' + fmt(em, 0) + ' in ' + y1 + ' on your path, against ' + fmt(eb, 0) + ' on the current path.' });
    [0, ymax / 2, ymax].forEach(function (v) {
      svg.appendChild(svgEl('line', { x1: L, x2: L + pw, y1: Y(v), y2: Y(v), class: 'cg' }));
      var t = svgEl('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'ct' }); t.textContent = fmt(v, 0); svg.appendChild(t);
    });
    [[y0, 'start'], [Math.round((y0 + y1) / 2), 'middle'], [y1, 'end']].forEach(function (a) {
      var t = svgEl('text', { x: X(a[0]) + (a[1] === 'start' ? -2 : a[1] === 'end' ? 2 : 0), y: H - 6, 'text-anchor': a[1], class: 'ct' }); t.textContent = a[0]; svg.appendChild(t);
    });
    var unit = svgEl('text', { x: L, y: 10, class: 'ct' }); unit.textContent = 'Gt CO₂ a year'; svg.appendChild(unit);
    function path(s) { return s.years.map(function (p, i) { return (i ? 'L' : 'M') + X(p.year).toFixed(1) + ' ' + Y(p.emissions).toFixed(1); }).join(''); }
    svg.appendChild(svgEl('path', { d: path(base), class: 'c-base' }));
    svg.appendChild(svgEl('path', { d: path(mine), class: 'c-you' }));
    svg.appendChild(svgEl('circle', { cx: X(y1), cy: Y(em), r: 3.5, fill: 'var(--hot)', stroke: 'var(--plate)', 'stroke-width': 2 }));
    var same = Math.abs(Y(eb) - Y(em)) < 14;
    function endLabel(v, y, color) { var t = svgEl('text', { x: X(y1) + 8, y: y + 4, class: 'cv', fill: color }); t.textContent = fmt(v, 0); svg.appendChild(t); }
    if (Math.abs(Y(eb) - Y(em)) < 1) endLabel(em, Y(em), 'var(--ink)');
    else if (same) { endLabel(eb, Y(eb) - 7, 'var(--ink-2)'); endLabel(em, Y(em) + 8, 'var(--ink)'); }
    else { endLabel(eb, Y(eb), 'var(--ink-2)'); endLabel(em, Y(em), 'var(--ink)'); }

    var cross = svgEl('line', { class: 'c-cross', y1: T, y2: T + ph, visibility: 'hidden' });
    svg.appendChild(cross);
    var hit = svgEl('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent' });
    svg.appendChild(hit);
    var tip = el('div', 'g-tip'); tip.hidden = true;
    function move(ev) {
      var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * W;
      var yr = clamp(Math.round(y0 + (px - L) / pw * (y1 - y0)), y0, y1), i = yr - y0;
      cross.setAttribute('x1', X(yr)); cross.setAttribute('x2', X(yr)); cross.setAttribute('visibility', 'visible');
      tip.textContent = yr + ': ' + fmt(mine.years[i].emissions, 0) + ' Gt on your path, ' + fmt(base.years[i].emissions, 0) + ' Gt on the current path';
      tip.hidden = false; tip.style.left = clamp(X(yr) / W * 100, 22, 78) + '%';
    }
    function leave() { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', leave);
    wrap.appendChild(svg); wrap.appendChild(tip);
    return wrap;
  }

  function chartPlate(base, mine, title) {
    var p = plate('g-chart');
    p.appendChild(el('p', 'ph', title));
    p.appendChild(chart(base, mine));
    var lg = el('p', 'lg');
    var a = el('span'); a.appendChild(el('i')); a.appendChild(document.createTextNode('Your path'));
    var b = el('span'); b.appendChild(el('i', 'b')); b.appendChild(document.createTextNode('Current path'));
    lg.appendChild(a); lg.appendChild(b); p.appendChild(lg);
    p.appendChild(el('p', 'fine', game.note));
    return p;
  }

  /* ---------- a term ---------- */
  function renderTerm(base) {
    var pol = G.byId(game), year = pickYear(), spent = G.cost(game, picks), left = g.capital - spent;
    var mine = G.play(state, game, withPicks());
    var supportAfter = clamp(g.support + picks.reduce(function (a, id) { return a + pol[id].support; }, 0) + game.support_recovery, 0, 100);
    var last = g.term === game.terms - 1;

    var dash = plate('g-dash');
    var h = el('h3', 'g-term', 'Term ' + (g.term + 1) + ' of ' + game.terms); h.id = 'gTermH'; h.tabIndex = -1; dash.appendChild(h);
    dash.appendChild(el('p', 'g-years', year + ' to ' + (year + game.term_years)));
    var r1 = el('div', 'g-row'); r1.appendChild(el('b', null, 'Political capital'));
    var cap = el('span', null, left + ' of ' + g.capital + ' left'); r1.appendChild(cap); dash.appendChild(r1);
    var pw = el('div'); pw.style.marginTop = '6px'; pw.appendChild(pips(left, g.capital)); dash.appendChild(pw);
    var r2 = el('div', 'g-row'); r2.appendChild(el('b', null, 'Public support')); r2.appendChild(el('span', null, String(Math.round(g.support)))); dash.appendChild(r2);
    var bar = el('div', 'bar'), fill = el('i'); fill.style.width = Math.round(g.support) + '%'; fill.style.background = g.support < game.gridlock_below ? 'var(--hot)' : 'var(--cold)';
    bar.appendChild(fill); dash.appendChild(bar);
    var note = g.gridlock && g.term > 0
      ? 'Gridlock: low support cost you 1 political capital this term.'
      : 'Below ' + game.gridlock_below + ' and your next term loses 1 political capital.';
    dash.appendChild(el('p', 'hint', note));
    var after = el('p', 'hint', 'If you finish now, support will be ' + Math.round(supportAfter) + (supportAfter < game.gridlock_below ? '. That is gridlock.' : '.'));
    after.style.marginTop = '4px'; dash.appendChild(after);

    var main = el('div', 'g-main');
    if (g.adopted.length) {
      var inn = el('p', 'g-in', 'In place:');
      g.adopted.forEach(function (a) { var t = el('span', 'tag', pol[a.id].title); t.title = 'Term ' + (a.term + 1) + ', ' + a.year; inn.appendChild(t); });
      main.appendChild(inn);
    }
    var list = el('div', 'g-cards');
    game.policies.forEach(function (p) {
      if (G.isAdopted(g, p.id)) return;
      var on = picks.indexOf(p.id) >= 0, afford = on || p.cost <= left;
      var b = el('button', 'g-card'); b.type = 'button'; b.setAttribute('data-k', 'p:' + p.id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = !afford;
      if (!afford) b.title = 'Costs more than the political capital you have left';
      b.setAttribute('aria-label', p.title + '. ' + p.blurb + ' Costs ' + p.cost + '. Cuts about ' + p.cut + ' percent of emissions. Support ' + (p.support < 0 ? 'minus ' + Math.abs(p.support) : 'plus ' + p.support) + '.');
      var top = el('div', 'g-top'); top.appendChild(el('span', 'g-name', p.title)); top.appendChild(pips(p.cost, p.cost));
      b.appendChild(top); b.appendChild(el('span', 'g-blurb', p.blurb));
      var meta = el('span', 'g-meta'); meta.appendChild(el('span', null, 'Cuts about ' + p.cut + '% of emissions')); meta.appendChild(el('span', null, 'Support ' + (p.support < 0 ? MINUS : '+') + Math.abs(p.support)));
      b.appendChild(meta);
      b.addEventListener('click', function () {
        var i = picks.indexOf(p.id);
        if (i >= 0) picks.splice(i, 1); else picks.push(p.id);
        render();
      });
      list.appendChild(b);
    });
    main.appendChild(list);
    main.appendChild(el('p', 'hint', 'Each policy takes ' + game.ramp_years + ' years to reach full effect, so early moves count most. Unspent capital carries over, up to ' + game.carry_max + '.'));
    main.lastChild.style.margin = '0 0 14px';

    var dW = mine.projection.temp2100 - base.projection.temp2100, dS = mine.risk - base.risk;
    var bar2 = el('div', 'g-bar');
    var nums = el('dl', 'g-nums'); nums.setAttribute('aria-live', 'polite');
    function num(label, value, sub) { var d = el('div'); d.appendChild(el('dt', null, label)); var dd = el('dd', null, value); dd.appendChild(el('small', null, sub)); d.appendChild(dd); nums.appendChild(d); }
    num('Warming in 2100', fmt(mine.projection.temp2100, 2) + ' °C', Math.abs(dW) < 0.005 ? 'same as current path' : signed(dW, 2) + ' °C vs current path');
    num('Score in 2050', Math.round(mine.risk) + ' of 100', Math.abs(dS) < 0.5 ? 'same as current path' : signed(Math.round(dS), 0) + ' vs current path');
    bar2.appendChild(nums);
    var fin = el('button', 'btn pri', last ? 'Finish and see 2050' : picks.length ? 'Finish term ' + (g.term + 1) : 'Finish term ' + (g.term + 1) + ' with no new policies');
    fin.type = 'button'; fin.setAttribute('data-k', 'finish');
    fin.addEventListener('click', function () {
      g = G.finishTerm(state, game, g, picks); picks = [];
      render(); scrollToGame();
      var t = $(g.done ? 'gEndH' : 'gTermH'); if (t) t.focus({ preventScroll: true });
    });
    bar2.appendChild(fin);
    main.appendChild(bar2);

    host.appendChild(dash); host.appendChild(main); host.appendChild(chartPlate(base, mine, 'Emissions on your path'));
  }

  /* ---------- the ending ---------- */
  function renderEnd(base) {
    var res = G.play(state, game, g.adopted), v = G.verdict(game, res.projection.temp2100), pol = G.byId(game);
    var dW = res.projection.temp2100 - base.projection.temp2100;
    var main = el('div', 'g-main'), end = plate('g-end');
    var h = el('h3', 'g-verdict', v.title); h.id = 'gEndH'; h.tabIndex = -1; end.appendChild(h);
    end.appendChild(el('p', 'help', v.line));
    var dl = el('dl', 'results');
    function stat(label, value, sub) { var d = el('div'); d.appendChild(el('dt', null, label)); d.appendChild(el('dd', null, value)); d.appendChild(el('dd', 'sm', sub)); dl.appendChild(d); }
    stat('Warming in 2100 if emissions then hold', fmt(res.projection.temp2100, 2) + ' °C', Math.abs(dW) < 0.005 ? 'same as the current path' : signed(dW, 2) + ' °C vs ' + fmt(base.projection.temp2100, 2) + ' °C on the current path');
    stat('Score in 2050', Math.round(res.risk) + ' of 100', 'current path: ' + Math.round(base.risk));
    stat('Emissions in 2050', fmt(res.projection.emissions2050, 0) + ' Gt a year', 'current path: ' + fmt(base.projection.emissions2050, 0) + ', today: ' + fmt(state.whatif.emissions_now_gt, 0));
    end.appendChild(dl);
    var hist = el('ul', 'g-hist');
    g.history.forEach(function (t) {
      var li = el('li'); li.appendChild(el('b', null, 'Term ' + (t.term + 1) + ', ' + t.year + ': '));
      li.appendChild(document.createTextNode(t.picks.length ? t.picks.map(function (id) { return pol[id].title; }).join(', ') : 'No new policies'));
      hist.appendChild(li);
    });
    end.appendChild(hist);
    end.appendChild(el('p', 'hint', 'Public support at the end: ' + Math.round(g.support) + ' out of 100.'));
    var acts = el('div', 'g-actions');
    var map = el('button', 'btn pri', 'See it on the map'); map.type = 'button'; map.setAttribute('data-k', 'map');
    map.addEventListener('click', function () { shown = true; page.showPath(G.play(state, game, g.adopted)); });
    var copy = el('button', 'btn', 'Copy my result'); copy.type = 'button'; copy.setAttribute('data-k', 'copy');
    var status = el('span'); status.setAttribute('role', 'status'); status.style.color = 'var(--ink-2)'; status.style.fontSize = '0.875rem';
    copy.addEventListener('click', function () {
      var text = 'I led the world in The Reckoning Clock and ended as "' + v.title + '". In the model, warming reaches ' + fmt(res.projection.temp2100, 2) + ' °C by 2100, against ' + fmt(base.projection.temp2100, 2) + ' °C on the current path. ' + location.href.split('#')[0];
      function ok() { status.textContent = 'Copied.'; }
      function fail() { status.textContent = 'Copying is blocked here. Select and copy this instead: ' + text; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fail); else fail();
    });
    var again = el('button', 'btn', 'Play again'); again.type = 'button'; again.setAttribute('data-k', 'again');
    again.addEventListener('click', function () {
      g = G.start(game); picks = []; shown = false; render(); scrollToGame();
      var t = $('gTermH'); if (t) t.focus({ preventScroll: true });
    });
    acts.appendChild(map); acts.appendChild(copy); acts.appendChild(again); acts.appendChild(status);
    end.appendChild(acts);
    main.appendChild(end);
    host.appendChild(main); host.appendChild(chartPlate(base, res, 'Emissions on your path'));
  }

  function render() {
    if (!game || !state) return;
    var ae = document.activeElement, key = ae && host.contains(ae) ? ae.getAttribute('data-k') : null;
    clear(host);
    var base = G.play(state, game, []);
    if (!base) {
      host.className = '';
      host.appendChild(el('p', 'help', 'The game needs a current temperature and CO₂ reading, which are unavailable right now. Try again later.'));
      return;
    }
    host.className = 'game';
    if (g.done) renderEnd(base); else renderTerm(base);
    if (key) { var t = host.querySelector('[data-k="' + key + '"]'); if (t && !t.disabled) t.focus({ preventScroll: true }); }
  }

  window.addEventListener('reckoning:state', function (e) {
    state = e.detail;
    if (!game) return;
    render();
    if (shown && g.done) page.showPath(G.play(state, game, g.adopted), true);
  });

  fetch('data/game.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (j) { game = j; g = G.start(game); sec.hidden = false; render(); })
    .catch(function () { sec.hidden = true; });
})();
