import 'dotenv/config';

const base = 'https://api.clashofclans.com/v1';
const token = process.env.COC_API_TOKEN;
if (!token) throw new Error('COC_API_TOKEN is required');

function encodeTag(tag) {
  return encodeURIComponent(String(tag).startsWith('#') ? String(tag) : `#${tag}`);
}

export async function cocGet(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`CoC API ${res.status}: ${body}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
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
