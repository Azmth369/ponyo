import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_READONLY_KEY;
if (!process.env.SUPABASE_URL || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_READONLY_KEY) are required');
const db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false } });
const bounded = (value, fallback, max) => Math.min(Math.max(Number(value || fallback), 1), max);

export async function getPlayers(filters = {}) {
  let q = db.from('clan_info').select('player_id,name,role,th,lvl,trophies,troops_donated,troops_received,last_active,date_time,data');
  if (filters.role) q = q.eq('role', filters.role);
  if (filters.tag) q = q.eq('player_id', filters.tag);
  const { data, error } = await q.order('name').limit(bounded(filters.limit, 100, 100));
  if (error) throw error;
  return (data ?? []).map(p => ({ ...p, tag: p.player_id, town_hall_level: p.th, level: p.lvl, donations: p.troops_donated, donations_received: p.troops_received }));
}

// The latest preparation/inWar/warEnded CW session is the current normal war.
export async function getCurrentWar() {
  const { data, error } = await db.from('cw_session').select('*').order('battle_start', { ascending: false }).limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  const end = row.battle_end ? new Date(row.battle_end) : null;
  const now = new Date();
  const state = end && now > end ? 'warEnded' : (row.battle_start && now >= new Date(row.battle_start) ? 'inWar' : 'preparation');
  return { war_key: row.cw_uid, state, start_time: row.battle_start, end_time: row.battle_end, data: row.data, opponent_clan_name: row.opponent_clan_name, opponent_clan_id: row.opponent_clan_id };
}

export async function searchWars(term = '', maxRows = 25) {
  const { data, error } = await db.from('cw_session').select('*').order('battle_end', { ascending: false }).limit(200);
  if (error) throw error;
  const needle = String(term).trim().toLowerCase();
  return (data ?? []).filter(w => !needle || JSON.stringify(w).toLowerCase().includes(needle)).slice(0, bounded(maxRows, 25, 100)).map(row => ({ war_key: row.cw_uid, state: 'warEnded', start_time: row.battle_start, end_time: row.battle_end, data: row.data, ...row }));
}

export async function getSnapshots(playerTag, since = null, maxRows = 200) {
  let q = db.from('clan_info_snap').select('player_id,date_time,data,th,lvl,trophies,troops_donated,troops_received,role,name').eq('player_id', playerTag).order('date_time', { ascending: false });
  if (since) q = q.gte('date_time', since);
  const { data, error } = await q.limit(bounded(maxRows, 200, 1000));
  if (error) throw error;
  return (data ?? []).map(row => ({ player_tag: row.player_id, captured_at: row.date_time, data: row.data && Object.keys(row.data).length ? row.data : { name: row.name, role: row.role, townHallLevel: row.th, level: row.lvl, trophies: row.trophies, donations: row.troops_donated, donationsReceived: row.troops_received } }));
}

export async function getWarMembers(warKeyValue, maxRows = 100) {
  const { data, error } = await db.from('cw_session_participants').select('*').eq('cw_uid', warKeyValue).order('player_map_position').limit(bounded(maxRows, 100, 100));
  if (error) throw error;
  return (data ?? []).map(r => ({ war_key: r.cw_uid, player_tag: r.player_id, player_name: r.player_name, map_position: r.player_map_position, attacks_available: r.attacks_available, attacks_used: r.attacks_used, stars_earned: r.stars_scored, destruction_percentage: r.destruction_caused, data: r.data }));
}

export async function getWarAttacks(warKeyValue, maxRows = 100) {
  const { data, error } = await db.from('cw_attacklog').select('*').eq('cw_uid', warKeyValue).order('attacking_date_time').limit(bounded(maxRows, 100, 500));
  if (error) throw error;
  return (data ?? []).map(r => ({ war_key: r.cw_uid, attacker_tag: r.attacker_id, attacker_name: r.attacker_name_with_map_position, defender_tag: null, defender_name: r.defender_name_with_map_position, stars: r.star_scored, destruction_percentage: r.destruction_caused, order_no: r.index_no, attack_time: r.attacking_date_time, data: r.data }));
}

export async function getCwlAttacks(filters = {}) {
  let q = db.from('cwl_attacklog').select('*').order('attacking_date_time', { ascending: false });
  if (filters.seasonKey) q = q.eq('cwl_day_uid', filters.seasonKey);
  if (filters.attackerTag) q = q.eq('attacker_id', filters.attackerTag);
  if (filters.limit) q = q.limit(bounded(filters.limit, 200, 1000)); else q = q.limit(500);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(r => ({ season_key: r.cwl_day_uid, war_tag: r.cwl_day_uid, round_no: r.battle_day, attacker_tag: r.attacker_id, attacker_name: r.attacker_name_with_map_position, defender_tag: null, defender_name: r.defender_name_with_map_position, stars: r.star_scored, destruction_percentage: r.destruction_caused, order_no: r.index_no, attack_time: r.attacking_date_time, data: r.data }));
}

export async function getCapitalAttacks(filters = {}) {
  let q = db.from('capital_raid_attacklog').select('*').order('attacking_date_time', { ascending: false });
  if (filters.seasonKey) q = q.eq('capital_raid_uid', filters.seasonKey);
  if (filters.attackerTag) q = q.eq('attacker_id', filters.attackerTag);
  if (filters.opponentTag) q = q.eq('data->>opponentClanTag', filters.opponentTag);
  if (filters.limit) q = q.limit(bounded(filters.limit, 200, 1000)); else q = q.limit(500);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(r => ({ season_key: r.capital_raid_uid, opponent_clan_tag: r.data?.opponentClanTag ?? null, opponent_clan_name: r.data?.opponentClanName ?? null, attacker_tag: r.attacker_id, attacker_name: r.attacker_name, district_id: null, district_name: r.district_name, attack_number: r.raid_no, stars: r.star_scored, destruction_percentage: r.destruction_caused, attack_time: r.attacking_date_time, data: r.data }));
}

export async function getCapitalSeasons(maxRows = 50) {
  const { data, error } = await db.from('capital_raid_season').select('*').order('battle_start', { ascending: false }).limit(bounded(maxRows, 50, 100));
  if (error) throw error;
  return (data ?? []).map(r => ({ season_key: r.generated_uid, data: { startTime: r.battle_start, endTime: r.battle_end, capitalTotalLoot: r.total_loot, raidsCompleted: r.raids_won, totalAttacks: r.total_attacks, members: r.data?.members ?? [] } }));
}

export async function getCwlSeasons(maxRows = 50) {
  const { data, error } = await db.from('cwl_seasons').select('*').order('battle_start', { ascending: false }).limit(bounded(maxRows, 50, 100));
  if (error) throw error;
  return (data ?? []).map(r => ({ season_key: r.generated_cwl_id, data: r.data ?? r }));
}

export async function getCwlRounds(seasonKey = null, maxRows = 200) {
  let q = db.from('cwl_daywise_attacklog').select('*').order('battle_day').order('battle_start');
  if (seasonKey) q = q.eq('generated_cwl_day_id', seasonKey);
  const { data, error } = await q.limit(bounded(maxRows, 200, 500));
  if (error) throw error;
  return (data ?? []).map(r => ({ season_key: seasonKey, round_no: r.battle_day, opponent_tag: r.opponent_clan_id, opponent_name: r.opponent_clan_name, state: 'warEnded', data: r.data }));
}

export async function getCwlWars(seasonKey = null, maxRows = 100) {
  // CWL spreadsheet design stores each league battle as a daywise record.
  let q = db.from('cwl_daywise_attacklog').select('*').order('battle_day');
  if (seasonKey) q = q.eq('generated_cwl_day_id', seasonKey);
  const { data, error } = await q.limit(bounded(maxRows, 100, 200));
  if (error) throw error;
  return (data ?? []).map(r => ({ season_key: seasonKey, war_tag: r.generated_cwl_day_id, opponent_clan_tag: r.opponent_clan_id, opponent_name: r.opponent_clan_name, state: 'warEnded', data: r.data }));
}
