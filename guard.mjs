/* Guardrail logic kept apart from the network code so it can be tested. */
const DAY = 86400000;

export function round(x, d) {
  const k = Math.pow(10, d);
  return Math.round(x * k) / k;
}

/* Picks the value to publish for one measured input.
   fresh: a new reading { value, as_of } or null.   prev: the last published indicator or null.
   A reading older than maxAgeDays counts as a failure, so a source that stops updating cannot
   keep looking live. A kept value older than dropAfterDays is removed from the score. */
export function resolveIndicator(def, fresh, prev, { now, maxAgeDays, dropAfterDays = 30 }) {
  const age = (iso) => (now - Date.parse(iso)) / DAY;
  if (fresh && Number.isFinite(fresh.value) && fresh.as_of && age(fresh.as_of) <= maxAgeDays) {
    return { ...def, value: round(fresh.value, def.decimals + 2), as_of: fresh.as_of, status: 'live' };
  }
  if (prev && prev.value !== null && prev.value !== undefined && prev.as_of && age(prev.as_of) <= dropAfterDays) {
    return { ...def, value: prev.value, as_of: prev.as_of, status: 'stale' };
  }
  return { ...def, value: null, as_of: null, status: 'unavailable' };
}

/* Limits how far the headline score can move in one update. */
export function capMove(rawRisk, prevRisk, cap) {
  if (!Number.isFinite(prevRisk)) return { risk: rawRisk, capped: false };
  const delta = rawRisk - prevRisk;
  if (Math.abs(delta) <= cap) return { risk: rawRisk, capped: false };
  return { risk: prevRisk + Math.sign(delta) * cap, capped: true };
}
