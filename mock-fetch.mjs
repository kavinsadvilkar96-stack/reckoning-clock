/* Preloaded with: node --import ./scripts/test/mock-fetch.mjs scripts/update.mjs
   Replaces fetch with the sample files. MOCK_FAIL is a comma list of names to make fail:
   temp, co2, nsidc, sst, gdacs, gdacs_FL, feeds, temp_old. */
import * as F from './fixtures.mjs';

const fail = new Set((process.env.MOCK_FAIL || '').split(',').filter(Boolean));
const now = Date.now();
const body = (text, status = 200) => new Response(text, { status });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('era5_daily_series_2t_global')) {
    if (fail.has('temp')) return body('nope', 503);
    return body(fail.has('temp_old') ? F.copernicusTruncated() : F.copernicus(now));
  }
  if (u.includes('co2_daily_mlo') || u.includes('co2_weekly_mlo')) return fail.has('co2') ? body('nope', 500) : body(F.co2(now));
  if (u.includes('N_seaice_extent')) return fail.has('nsidc') ? body('nope', 500) : body(F.nsidc('N', now));
  if (u.includes('S_seaice_extent')) return fail.has('nsidc') ? body('nope', 500) : body(F.nsidc('S', now));
  if (u.includes('oisst2.1_world2_sst_day')) return fail.has('sst') ? body('nope', 500) : body(F.oisst(now));
  if (u.includes('geteventlist/SEARCH')) {
    const code = /eventlist=([A-Z]{2})/.exec(u)[1];
    if (fail.has('gdacs') || fail.has('gdacs_' + code)) return body('nope', 500);
    return body(F.gdacs(now, code));
  }
  if (u.includes('/data/state.json')) {
    if (process.env.MOCK_PREV_STATUS) return body('error', Number(process.env.MOCK_PREV_STATUS));
    if (process.env.MOCK_PREV) return body(process.env.MOCK_PREV);
    return body('missing', 404);
  }
  if (/\.(in|org|com|net)\b/.test(u) || u.includes('rss') || u.includes('feed')) {
    if (fail.has('feeds')) return body('nope', 500);
    return body(u.includes('thehindu') || u.includes('mongabay') ? F.rss('india', now) : F.rss('global', now));
  }
  return body('unexpected url ' + u, 404);
};
