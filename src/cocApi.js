// Clash of Clans API client with retry, backoff and request timeouts.

import 'dotenv/config';

const base = 'https://api.clashofclans.com/v1';
const token = process.env.COC_API_TOKEN;
if (!token) throw new Error('COC_API_TOKEN is required');

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isNetworkError(error) {
  return error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

async function cocGetOnce(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`CoC API ${res.status}: ${body}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function cocGet(path) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await cocGetOnce(path);
    } catch (error) {
      lastError = error;
      const retryable = isNetworkError(error) || error.status === 429 || (error.status ?? 0) >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      const retryAfter = Number(error.headers?.['retry-after']);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500;
      console.warn(`[coc-api] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${path} (${error.message}); retrying in ${Math.round(wait)}ms`);
      await sleep(Math.min(wait, 30000));
    }
  }
  throw lastError;
}

function encodeTag(tag) {
  return encodeURIComponent(String(tag).startsWith('#') ? String(tag) : `#${tag}`);
}

const clan = () => encodeTag(process.env.COC_CLAN_TAG);
const query = (limit) => limit ? `?limit=${Math.max(1, Math.min(Number(limit) || 1, 100))}` : '';

export const getClan = () => cocGet(`/clans/${clan()}`);
export const getCurrentWar = () => cocGet(`/clans/${clan()}/currentwar`);
export const getWarLog = (limit = process.env.WARLOG_PAGE_LIMIT || 100) => cocGet(`/clans/${clan()}/warlog${query(limit)}`);
export const getCapitalRaids = (limit = process.env.CAPITAL_PAGE_LIMIT || 100) => cocGet(`/clans/${clan()}/capitalraidseasons${query(limit)}`);
export const getCwlGroup = () => cocGet(`/clans/${clan()}/currentwar/leaguegroup`);
export const getCwlWar = (warTag) => cocGet(`/clanwarleagues/wars/${encodeTag(warTag)}`);
export const getPlayer = (tag) => cocGet(`/players/${encodeTag(tag)}`);
