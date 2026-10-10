// Anime data via AniList GraphQL (https://anilist.co) — no API key. Higher rate
// limits than Jikan and gives exact next-episode airing times directly, so we no
// longer parse JST broadcast strings by hand.
import { fetchJson } from '../lib/helpers.js';

const ENDPOINT = 'https://graphql.anilist.co';

async function gql(query, variables) {
  const j = await fetchJson(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, 12000);
  if (j.errors?.length) throw new Error(`anilist: ${j.errors[0].message}`);
  return j.data;
}

const pickTitle = (t) => (t?.english || t?.romaji || '').trim();
const toScore = (s) => (s ? +(s / 10).toFixed(1) : null); // AniList 0-100 → 0-10

function normalize(m) {
  if (!m) return null;
  return {
    id: m.id,
    title: pickTitle(m.title),
    score: toScore(m.averageScore),
    format: m.format || null,
    episodes: m.episodes || null,
    status: m.status || null, // RELEASING | FINISHED | NOT_YET_RELEASED | CANCELLED | HIATUS
    nextAt: m.nextAiringEpisode?.airingAt ? m.nextAiringEpisode.airingAt * 1000 : null,
    nextEp: m.nextAiringEpisode?.episode || null,
    startDate: m.startDate || null,
  };
}

const MEDIA_FIELDS = `id title { romaji english } averageScore format episodes status
  nextAiringEpisode { airingAt episode } startDate { year month day }`;

export async function searchAnime(query) {
  const data = await gql(
    `query ($s: String) { Media(search: $s, type: ANIME, sort: POPULARITY_DESC) { ${MEDIA_FIELDS} } }`,
    { s: query },
  );
  return normalize(data?.Media);
}

export async function animeById(id) {
  const data = await gql(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`,
    { id: Number(id) },
  );
  return normalize(data?.Media);
}

// Shows airing between two unix-SECOND bounds. Returns [{ id, title, score, airingAt(ms) }].
export async function airingBetween(startSec, endSec) {
  const seen = new Set();
  const out = [];
  for (let page = 1; page <= 4; page++) {
    let data;
    try {
      data = await gql(
        `query ($start: Int, $end: Int, $page: Int) {
          Page(page: $page, perPage: 50) {
            pageInfo { hasNextPage }
            airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
              airingAt media { id title { romaji english } averageScore isAdult } } } }`,
        { start: startSec, end: endSec, page },
      );
    } catch { break; } // AniList hiccup/rate-limit — use what we have
    const sched = data?.Page?.airingSchedules || [];
    for (const s of sched) {
      const m = s.media;
      if (!m || m.isAdult || seen.has(m.id)) continue;
      const title = pickTitle(m.title);
      if (!title) continue;
      seen.add(m.id);
      out.push({ id: m.id, title, score: toScore(m.averageScore), airingAt: s.airingAt * 1000 });
    }
    if (!data?.Page?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 300)); // be polite to the API
  }
  return out;
}
