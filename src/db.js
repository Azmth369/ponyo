import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

export const db = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const conflictKeys = {
  clans: 'tag',
  players: 'tag',
  wars: 'war_key',
  war_members: 'war_key,clan_tag,player_tag',
  war_attacks: 'war_key,clan_tag,attacker_tag,order_no',
  cwl_attacks: 'war_tag,clan_tag,attacker_tag,order_no',
  capital_attacks: 'season_key,attacker_tag,district_id,attack_number,opponent_clan_tag',
  cwl_seasons: 'season_key',
  cwl_rounds: 'season_key,round_no',
  cwl_wars: 'war_tag',
  capital_raids: 'season_key'
};

export async function upsert(table, rows) {
  if (!rows?.length) return;
  const onConflict = conflictKeys[table];
  const options = onConflict ? { onConflict } : undefined;
  const { error } = await db.from(table).upsert(rows, options);
  if (error) throw error;
}
