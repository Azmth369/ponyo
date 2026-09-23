import { getPlayers, getCurrentWar, getWarMembers, getWarAttacks, getSnapshots, getCapitalSeasons, getCapitalAttacks } from './retrieval.js';

export async function currentWarAnalysis() {
  const war = await getCurrentWar();
  if (!war?.war_key) return { state: 'notInWar', members: [], attacks: [] };
  const members = await getWarMembers(war.war_key);
  const attacks = await getWarAttacks(war.war_key);
  return { state: war.state, war_key: war.war_key, start_time: war.start_time, end_time: war.end_time, members, attacks, missed_attacks: members.filter(m => Number(m.attacks_available || 0) > Number(m.attacks_used || 0)) };
}

export async function playerTrend(playerTag, since = null) {
  const snapshots = await getSnapshots(playerTag, since, 1000);
  if (snapshots.length < 2) return { snapshots, changes: null };
  const newest = snapshots[0]?.data ?? {};
  const oldest = snapshots[snapshots.length - 1]?.data ?? {};
  const num = (obj, key) => Number(obj[key] ?? 0);
  return { snapshots, changes: { trophies: num(newest, 'trophies') - num(oldest, 'trophies'), donations: num(newest, 'donations') - num(oldest, 'donations'), donationsReceived: num(newest, 'donationsReceived') - num(oldest, 'donationsReceived'), attackWins: num(newest, 'attackWins') - num(oldest, 'attackWins'), defenseWins: num(newest, 'defenseWins') - num(oldest, 'defenseWins') } };
}

export async function memberLeaderboard(metric = 'donations', descending = true) {
  const allowed = new Set(['donations', 'donations_received', 'trophies', 'attack_wins', 'defense_wins']);
  const field = allowed.has(metric) ? metric : 'donations';
  const players = await getPlayers({ limit: 100 });
  return players.map(p => ({ name: p.name, tag: p.tag, value: Number(p[field] ?? 0) })).sort((a, b) => descending ? b.value - a.value : a.value - b.value);
}

export function summarizeWarMembers(members = []) {
  return members.map(m => ({ name: m.player_name, tag: m.player_tag, attacks_used: Number(m.attacks_used ?? 0), attacks_available: Number(m.attacks_available ?? 0), missed_attacks: Math.max(Number(m.attacks_available ?? 0) - Number(m.attacks_used ?? 0), 0), stars: Number(m.stars_earned ?? 0), destruction: Number(m.destruction_percentage ?? 0) }));
}

function addPlayer(map, player, seasonKey) {
  if (!player?.tag && !player?.name) return;
  const key = player.tag || player.name;
  const row = map.get(key) ?? { tag: player.tag ?? null, name: player.name ?? 'Unknown', seasons: 0, attacks: 0, capital_gold: 0, stars: 0, destruction: 0, attack_records: 0, season_keys: [] };
  if (seasonKey && !row.season_keys.includes(seasonKey)) { row.seasons += 1; row.season_keys.push(seasonKey); }
  row.attacks += Number(player.attacks ?? player.attackCount ?? 0);
  row.capital_gold += Number(player.capitalResourcesLooted ?? player.capital_gold ?? 0);
  map.set(key, row);
  return row;
}

export async function capitalPlayerLeaderboard(seasons = 12) {
  const seasonRows = await getCapitalSeasons(seasons);
  const players = new Map();
  const seasonKeys = seasonRows.map(row => row.season_key).filter(Boolean);
  for (const seasonRow of seasonRows) {
    const data = seasonRow?.data ?? {};
    const seasonKey = seasonRow?.season_key ?? data.startTime ?? data.endTime ?? null;
    for (const member of data.members ?? []) addPlayer(players, member, seasonKey);
  }

  const attacks = await getCapitalAttacks({ limit: 1000 });
  for (const attack of attacks) {
    if (seasonKeys.length && !seasonKeys.includes(attack.season_key)) continue;
    const row = addPlayer(players, { tag: attack.attacker_tag, name: attack.attacker_name }, attack.season_key);
    if (!row) continue;
    row.stars += Number(attack.stars ?? 0);
    row.destruction += Number(attack.destruction_percentage ?? 0);
    row.attack_records += 1;
  }

  return [...players.values()]
    .map(row => ({ ...row, avg_destruction: row.attack_records ? row.destruction / row.attack_records : 0 }))
    .sort((a, b) => b.capital_gold - a.capital_gold || b.stars - a.stars || b.attacks - a.attacks)
    .slice(0, 100);
}
