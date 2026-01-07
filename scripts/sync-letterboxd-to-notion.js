require("dotenv").config();

const { Client } = require("@notionhq/client");
const xml2js = require("xml2js");
const { parse } = require("node-html-parser");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_ID = process.env.NOTION_DATABASE_ID;
const RSS_URL = process.env.LETTERBOXD_RSS_URL;
const TMDB_KEY = process.env.TMDB_API_KEY;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

// RSS title often looks like: "Stand by Me, 1986 - ★★★★"
function parseRssTitle(rawTitle) {
  const s = (rawTitle || "").trim();
  const [left, stars] = s.split(" - ").map((x) => x?.trim());
  // left often ends with ", YYYY"
  const m = left?.match(/^(.*),\s(\d{4})$/);
  return {
    title: (m ? m[1] : left) || s,
    year: m ? m[2] : null,
    stars: stars || null
  };
}

function starsToNumber(stars) {
  if (!stars) return null;
  let val = 0;
  for (const ch of stars) {
    if (ch === "★") val += 1;
    if (ch === "½") val += 0.5;
  }
  return val || null;
}

function posterFromRssDescription(html) {
  const root = parse(html || "");
  const img = root.querySelector("img");
  return img?.getAttribute("src") || null;
}

async function notionFindByLetterboxdUrl(letterboxdUrl) {
  const resp = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      property: "Letterboxd URL",
      url: { equals: letterboxdUrl }
    },
    page_size: 1
  });
  return resp.results?.[0] || null;
}

async function tmdbSearchMovie(title, year) {
  const url = new URL("https://api.themoviedb.org/3/search/movie");
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("query", title);
  if (year) url.searchParams.set("year", year);

  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json?.results?.[0] || null;
}

async function tmdbGetDirector(movieId) {
  const url = new URL(`https://api.themoviedb.org/3/movie/${movieId}/credits`);
  url.searchParams.set("api_key", TMDB_KEY);

  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const crew = json?.crew || [];
  const director = crew.find((c) => c.job === "Director");
  return director?.name || null;
}

function tmdbPosterUrl(posterPath) {
  if (!posterPath) return null;
  return `https://image.tmdb.org/t/p/w500${posterPath}`;
}

async function notionCreateMoviePage({
  title,
  director,
  watchedDate,
  rating,
  posterUrl,
  goals,
  status,
  mediaType,
  format,
  letterboxdUrl
}) {
  const props = {
    "Name": { title: [{ text: { content: title } }] },
    "Author": director ? { rich_text: [{ text: { content: director } }] } : { rich_text: [] },
    "Date Read/Watched": watchedDate ? { date: { start: watchedDate } } : undefined,
    "My Rating": rating != null ? { number: rating } : undefined,
    "Goals": { rich_text: [{ text: { content: goals } }] },
    "Status": { select: { name: status } },
    "media type": { select: { name: mediaType } },
    "Format": { select: { name: format } },
    "Letterboxd URL": { url: letterboxdUrl },
    "Image": posterUrl
      ? { files: [{ type: "external", name: "poster", external: { url: posterUrl } }] }
      : undefined
  };

  // remove undefined
  Object.keys(props).forEach((k) => props[k] === undefined && delete props[k]);

  await notion.pages.create({
    parent: { database_id: DB_ID },
    properties: props
  });
}

async function main() {
  // Hard fail early if dedupe property is missing
  // (If you forget to create "Letterboxd URL", Notion will return a clear error)
  const xml = await fetchText(RSS_URL);
  const feed = await xml2js.parseStringPromise(xml);
  const items = feed?.rss?.channel?.[0]?.item || [];

  for (const item of items) {
    const rawTitle = item?.title?.[0] || "";
    const link = item?.link?.[0] || "";
    const watchedDate = item?.["letterboxd:watchedDate"]?.[0] || null;
    const descriptionHtml = item?.description?.[0] || "";

    if (!link) continue;

    // Dedupe
    const exists = await notionFindByLetterboxdUrl(link);
    if (exists) continue;

    const { title, year, stars } = parseRssTitle(rawTitle);
    const rating = starsToNumber(stars);

    // Poster: prefer TMDB if available; fallback to RSS embedded img
    let posterUrl = posterFromRssDescription(descriptionHtml);
    let director = null;

    if (TMDB_KEY) {
      const tmdbHit = await tmdbSearchMovie(title, year);
      if (tmdbHit?.id) {
        director = await tmdbGetDirector(tmdbHit.id);
        const tmdbPoster = tmdbPosterUrl(tmdbHit.poster_path);
        if (tmdbPoster) posterUrl = tmdbPoster;
      }
    }

    console.log(`Adding: ${title} (${watchedDate || "no date"})`);

    await notionCreateMoviePage({
      title,
      director,
      watchedDate,
      rating,
      posterUrl,
      goals: "certified cinephile",
      status: "watched",
      mediaType: "movie",
      format: "movie",
      letterboxdUrl: link
    });

    await sleep(350);
  }

  console.log("Sync complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
