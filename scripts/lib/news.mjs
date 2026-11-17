/* News list: fixed keyword rules decide the topic section and the India tag.
   Only the headline, link, source and time are kept. Nothing is copied from the article body. */

const DAY = 86400000;

/* Checked in this order, so "government approves solar subsidy" lands in Policy. */
const RULES = [
  ['disasters', /\b(heat ?wave|heat dome|flood|flooding|wildfire|bushfire|cyclone|hurricane|typhoon|drought|landslide|cloudburst|extreme weather|storm|tornado|monsoon|evacuat|deadly heat|heat-related deaths?)\b/i],
  ['policy', /\b(polic(y|ies)|law|laws|bill|legislation|parliament|minister|ministry|government|govt|cabinet|court|ruling|treaty|cop ?\d{2}|unfccc|ndc|net[- ]zero|target|pledge|subsid(y|ies)|tariff|carbon (price|pricing|tax|market)|regulation|rules?|ban|mandate|summit|negotiat\w*|talks|agreement|commission|senate|congress|epa|moefcc|niti aayog)\b/i],
  ['energy', /\b(emissions?|solar|wind|coal|oil|gas|lng|renewables?|electricity|power (plant|grid|sector|demand)|grid|ev|evs|electric vehicles?|nuclear|hydrogen|fossil|battery|batteries|storage|methane|carbon capture|decarboni[sz]\w*|clean energy|energy transition|co2)\b/i],
  ['science', /\b(study|studies|research|researchers|scientists?|paper|analysis|data show\w*|record (high|low|warm|hot)|hottest|warmest|sea ice|ice sheet|glacier|ocean|coral|tipping point|ipcc|wmo|copernicus|noaa|nasa|temperature|sea level|warming|climate change)\b/i]
];

const INDIA = /\b(india|indian|delhi|mumbai|kolkata|chennai|bengaluru|bangalore|hyderabad|modi|himalaya\w*|kerala|assam|odisha|gujarat|rajasthan|punjab|uttarakhand|himachal|maharashtra|tamil nadu|bihar|uttar pradesh|west bengal|karnataka|andhra|telangana|ladakh|sikkim|moefcc|niti aayog|bharat)\b/i;

export function classify(title, feed) {
  let section = null;
  for (const [id, re] of RULES) {
    if (re.test(title)) { section = id; break; }
  }
  if (!section) section = feed.fallback || null;
  const india = feed.region === 'India' || INDIA.test(title);
  return { section, region: india ? 'India' : 'Global' };
}

/* items: [{ feed, title, url, published }] -> { sectionId: [...] }, newest first, limited. */
export function buildFeed(items, sectionIds, { now = Date.now(), maxAgeDays = 14, perSection = 8 } = {}) {
  const seen = new Set();
  const out = Object.fromEntries(sectionIds.map((id) => [id, []]));
  const sorted = items
    .filter((i) => {
      const t = Date.parse(i.published);
      return Number.isFinite(t) && t <= now + 3600000 && t >= now - maxAgeDays * DAY;
    })
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  for (const i of sorted) {
    const { section, region } = classify(i.title, i.feed);
    if (!section || !out[section]) continue;
    const key = i.url.replace(/[?#].*$/, '').toLowerCase();
    const tkey = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key) || seen.has(tkey)) continue;
    seen.add(key); seen.add(tkey);
    out[section].push({ title: i.title, region, source: i.feed.name, published: i.published, url: i.url });
  }
  for (const id of sectionIds) {
    /* Show India items first within the cap only if they are recent; otherwise keep time order. */
    const list = out[id];
    const india = list.filter((x) => x.region === 'India').slice(0, 3);
    const rest = list.filter((x) => !india.includes(x));
    out[id] = india.concat(rest).slice(0, perSection).sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  }
  return out;
}
