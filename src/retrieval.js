import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_READONLY_KEY;
if (!process.env.SUPABASE_URL || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_READONLY_KEY) are required');
const db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false } });
const bounded = (value, fallback, max) => Math.min(Math.max(Number(value || fallback), 1), max);

export async function getPlayers(filters = {}) {
  let q = db.from('players').select('tag,name,role,town_hall_level,trophies,donations,donations_received,attack_wins,defense_wins,data');
  if (filters.role) q = q.eq('role', filters.role);
  if (filters.tag) q = q.eq('tag', filters.tag);
  const { data, error } = await q.order('name').limit(bounded(filters.limit, 100, 100));
  if (error) throw error;
  return data ?? [];
}

// currentwar is the only source for individual normal Clan War attacks.
// Keep warEnded so the final attack snapshot is captured before the API moves to notInWar.
export async function getCurrentWar() {
  const { data, error } = await db.from('wars').select('war_key,state,start_time,end_time,data').in('state', ['preparation', 'inWar', 'warEnded']).order('start_time', { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function searchWars(term = '', maxRows = 25) {
  const { data, error } = await db.from('wars').select('war_key,state,start_time,end_time,data').order('end_time', { ascending: false }).limit(200);
  if (error) throw error;
  const needle = String(term).trim().toLowerCase();
  return (data ?? []).filter(w => !needle || JSON.stringify(w.data ?? {}).toLowerCase().includes(needle) || String(w.war_key).toLowerCase().includes(needle)).slice(0, bounded(maxRows, 25, 100));
}

export async function getSnapshots(playerTag, since = null, maxRows = 200) {
  let q = db.from('player_snapshots').select('player_tag,captured_at,data').eq('player_tag', playerTag).order('captured_at', { ascending: false });
  if (since) q = q.gte('captured_at', since);
  const { data, error } = await q.limit(bounded(maxRows, 200, 1000));
  if (error) throw error;
  return data ?? [];
}

export async function getWarMembers(warKeyValue, maxRows = 100) {
  const { data, error } = await db.from('war_members').select('player_tag,player_name,map_position,attacks_available,attacks_used,stars_earned,destruction_percentage,data').eq('war_key', warKeyValue).order('map_position').limit(bounded(maxRows, 100, 100));
  if (error) throw error;
  return data ?? [];
}

export async function getWarAttacks(warKeyValue, maxRows = 100) {
  const { data, error } = await db.from('war_attacks').select('war_key,attacker_tag,attacker_name,defender_tag,defender_name,stars,destruction_percentage,order_no,duration_seconds,attack_time,observed_at,data').eq('war_key', warKeyValue).order('order_no').limit(bounded(maxRows, 100, 500));
  if (error) throw error;
  return data ?? [];
}

export async function getCwlAttacks(filters = {}) {
  let q = db.from('cwl_attacks').select('season_key,war_tag,round_no,attacker_tag,attacker_name,defender_tag,defender_name,stars,destruction_percentage,order_no,duration_seconds,attack_time,observed_at,data').order('observed_at', { ascending: false });
  if (filters.seasonKey) q = q.eq('season_key', filters.seasonKey);
  if (filters.warTag) q = q.eq('war_tag', filters.warTag);
  if (filters.attackerTag) q = q.eq('attacker_tag', filters.attackerTag);
  if (filters.limit) q = q.limit(bounded(filters.limit, 200, 1000));
  else q = q.limit(500);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function getCapitalAttacks(filters = {}) {
  let q = db.from('capital_attacks').select('season_key,opponent_clan_tag,opponent_clan_name,attacker_tag,attacker_name,district_id,district_name,attack_number,stars,destruction_percentage,duration_seconds,attack_time,observed_at,data').order('observed_at', { ascending: false });
  if (filters.seasonKey) q = q.eq('season_key', filters.seasonKey);
  if (filters.attackerTag) q = q.eq('attacker_tag', filters.attackerTag);
  if (filters.opponentTag) q = q.eq('opponent_clan_tag', filters.opponentTag);
  if (filters.limit) q = q.limit(bounded(filters.limit, 200, 1000));
  else q = q.limit(500);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function getCapitalSeasons(maxRows = 50) {
  const { data, error } = await db.from('capital_raids').select('season_key,data').order('season_key', { ascending: false }).limit(bounded(maxRows, 50, 100));
  if (error) throw error;
  return data ?? [];
}

export async function getCwlSeasons(maxRows = 50) {
  const { data, error } = await db.from('cwl_seasons').select('season_key,data').order('season_key', { ascending: false }).limit(bounded(maxRows, 50, 100));
  if (error) throw error;
  return data ?? [];
}

export async function getCwlRounds(seasonKey = null, maxRows = 200) {
  let q = db.from('cwl_rounds').select('season_key,round_no,opponent_tag,opponent_name,state,data').order('season_key').order('round_no');
  if (seasonKey) q = q.eq('season_key', seasonKey);
  const { data, error } = await q.limit(bounded(maxRows, 200, 500));
  if (error) throw error;
  return data ?? [];
}

export async function getCwlWars(seasonKey = null, maxRows = 100) {
  let q = db.from('cwl_wars').select('season_key,war_tag,opponent_clan_tag,opponent_name,state,data').order('war_tag');
  if (seasonKey) q = q.eq('season_key', seasonKey);
  const { data, error } = await q.limit(bounded(maxRows, 100, 200));
  if (error) throw error;
  return data ?? [];
}
