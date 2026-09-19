// Live CoC API lookups used at answer time. The Supabase sync runs every
// 10 minutes, so it cannot reliably answer "what is the war state right
// now", "how much time is left", or give live star/destruction scores.
// These helpers fetch the same data directly from the CoC API with a short
// TTL cache so that several questions in a row do not hammer the API.

import { getCurrentWar, getCapitalRaids } from './cocApi.js';

const TTL_MS = Number(process.env.LIVE_DATA_TTL_MS || 45000);
const ERROR_TTL_MS = 10000;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), ttl: TTL_MS, value });
    return value;
  } catch (error) {
    console.error(`[live-data] ${key} fetch failed`, error?.message ?? error);
    // Cache the previous value briefly so one failed fetch cannot break
    // several answers in a row; never cache errors longer than necessary.
    const previous = hit ? hit.value : null;
    cache.set(key, { at: Date.now(), ttl: ERROR_TTL_MS, value: previous });
    return previous;
  }
}

function resolveWarState(war, now = Date.now()) {
  // The CoC API reports notInWar | preparation | inWar | warEnded, but the
  // returned state can lag around the boundaries, so the battle window is
  // used as the source of truth whenever it is available.
  let state = war?.state ?? 'notInWar';
  const startMs = war?.startTime ? Date.parse(war.startTime) : null;
  const endMs = war?.endTime ? Date.parse(war.endTime) : null;
  if (state === 'preparation' && startMs != null && now >= startMs) state = 'inWar';
  if (state === 'inWar' && endMs != null && now > endMs) state = 'warEnded';
  return state;
}

function liveTeam(team, now = Date.now()) {
  const members = team?.memberList ?? [];
  const attacksUsed = members.reduce((n, m) => n + (Array.isArray(m.attacks) ? m.attacks.length : 0), 0);
  return {
    name: team?.name ?? null,
    tag: team?.tag ?? null,
    badge_id: team?.badgeId ?? null,
    stars: Number(team?.stars ?? 0),
    destruction_percentage: Number(team?.destructionPercentage ?? 0),
    attacks_used: attacksUsed,
    attacks_available: members.length * 2,
    members: members.length
  };
}

// Normalized member rows shaped like the Supabase war-member rows so that
// queryEngine.applyAttackUsageFilters works on them unchanged.
function liveMembers(team) {
  return (team?.memberList ?? []).map(m => ({
    player_id: m.tag,
    player_name: m.name,
    player_tag: m.tag,
    map_position: m.mapPosition,
    attacks_available: 2,
    attacks_used: Array.isArray(m.attacks) ? m.attacks.length : 0,
    stars_earned: (Array.isArray(m.attacks) ? m.attacks : []).reduce((s, a) => s + Number(a.stars ?? 0), 0),
    destruction_percentage: (Array.isArray(m.attacks) ? m.attacks : []).reduce((s, a) => s + Number(a.destructionPercentage ?? 0), 0),
    data: m
  });
}

export function normalizeLiveWar(war, now = Date.now()) {
  if (!war || !war?.clan?.tag || war.state === 'notInWar') return null;
  const state = resolveWarState(war, now);
  const endMs = war.endTime ? Date.parse(war.endTime) : null;
  const startMs = war.startTime ? Date.parse(war.startTime) : null;
  const timeLeftMs = state === 'warEnded'
    ? 0
    : endMs != null && endMs > now ? endMs - now : 0;
  return {
    source: 'coc-api',
    state,
    preparation_ends_in_ms: state === 'preparation' && startMs != null && startMs > now ? startMs - now : 0,
    time_left_ms: timeLeftMs,
    start_time: war.startTime ?? null,
    end_time: war.endTime ?? null,
    team_size: war.teamSize ?? null,
    our_clan: liveTeam(war.clan, now),
    opponent: liveTeam(war.opponent, now),
    our_members: liveMembers(war.clan)
  };
}

export function normalizeLiveCapital(seasons, now = Date.now()) {
  const season = Array.isArray(seasons) ? seasons[0] : null;
  if (!season) return null;
  const startMs = season.startTime ? Date.parse(season.startTime) : null;
  const endMs = season.endTime ? Date.parse(season.endTime) : null;
  let state = 'ended';
  if (startMs != null && now < startMs) state = 'upcoming';
  else if (endMs == null || now <= endMs) state = 'ongoing';
  return {
    source: 'coc-api',
    state,
    start_time: season.startTime ?? null,
    end_time: season.endTime ?? null,
    time_left_ms: state === 'ongoing' && endMs != null && endMs > now ? endMs - now : 0,
    raids_completed: Number(season.raidsCompleted ?? 0),
    total_attacks: Number(season.totalAttacks ?? 0),
    capital_total_loot: Number(season.capitalTotalLoot ?? 0),
    enemy_districts_destroyed: Number(season.enemyDistrictsDestroyed ?? 0),
    offensive_reward: Number(season.offensiveReward ?? 0),
    defensive_reward: Number(season.defensiveReward ?? 0)
  };
}

// Live normal-war snapshot: state, time left and both clans' scores.
export async function getLiveWar() {
  return cached('war', async () => normalizeLiveWar(await getCurrentWar()));
}

// Live capital-raid-weekend snapshot (latest season from the API).
export async function getLiveCapital() {
  return cached('capital', async () => normalizeLiveCapital(await getCapitalRaids(1)));
}
