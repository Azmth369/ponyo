import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

export const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const conflictKeys = {
  clan_info: 'player_id',
  cw_session: 'cw_uid',
  cw_session_participants: 'cw_uid,player_id',
  cw_attacklog: 'cw_attack_uid',
  cwl_seasons: 'generated_cwl_id',
  cwl_season_participants: 'cwl_day_uid,player_id',
  cwl_daywise_attacklog: 'generated_cwl_day_id',
  cwl_attacklog: 'generated_cwl_attack_uid',
  capital_raid_season: 'generated_uid',
  capital_raid_participants: 'capital_raid_uid,player_id',
  capital_raid_attacklog: 'generated_uid'
};

export async function upsert(table, rows) {
  if (!rows?.length) return;
  const onConflict = conflictKeys[table];
  const options = onConflict ? { onConflict } : undefined;
  const { error } = await db.from(table).upsert(rows, options);
  if (error) throw error;
}
