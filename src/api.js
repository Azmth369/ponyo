import { db } from './db.js';
import { refreshNow } from './index.js';

const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
};

function authorized(req) {
  const expected = process.env.PONYO_API_KEY;
  if (!expected || expected.length < 32) return false;
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice(7) === expected;
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function handleApi(req, res, url) {
  if (!url.pathname.startsWith('/api/v1/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Allow': 'GET, POST, OPTIONS' });
    res.end();
    return true;
  }
  if (!authorized(req)) {
    send(res, process.env.PONYO_API_KEY ? 401 : 503, {
      error: process.env.PONYO_API_KEY ? 'Unauthorized' : 'API not configured'
    });
    return true;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/clan/members') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const search = (url.searchParams.get('search') ?? '').trim().slice(0, 80);
      let q = db.from('clan_info')
        .select('player_id,name,role,th,lvl,trophies,troops_donated,troops_received,last_active,date_time')
        .order('name', { ascending: true }).limit(limit);
      if (search) q = q.ilike('name', '%' + search.replace(/[%,()]/g, '') + '%');
      const data = await rows(q);
      send(res, 200, { data, count: data.length, source: 'supabase', refreshedAt: data[0]?.date_time ?? null });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/clan/summary') {
      const members = await rows(db.from('clan_info').select('player_id,role,th,trophies,troops_donated,troops_received'));
      const summary = {
        members: members.length,
        totalDonations: members.reduce((n, m) => n + (Number(m.troops_donated) || 0), 0),
        totalReceived: members.reduce((n, m) => n + (Number(m.troops_received) || 0), 0),
        averageTrophies: members.length ? Math.round(members.reduce((n, m) => n + (Number(m.trophies) || 0), 0) / members.length) : 0,
        townHallCounts: members.reduce((o, m) => { const k = String(m.th ?? 'unknown'); o[k] = (o[k] || 0) + 1; return o; }, {}),
        roles: members.reduce((o, m) => { const k = m.role ?? 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {})
      };
      send(res, 200, { data: summary, source: 'supabase', generatedAt: new Date().toISOString() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/war/current') {
      const sessions = await rows(db.from('cw_session').select('*').order('battle_start', { ascending: false }).limit(1));
      if (!sessions.length) {
        send(res, 200, { data: null, message: 'No synced war session found' });
        return true;
      }
      const session = sessions[0];
      const participants = await rows(db.from('cw_session_participants').select('player_name,player_id,attacks_used,attacks_available,stars_scored,destruction_caused,player_map_position').eq('cw_uid', session.cw_uid).order('player_map_position', { ascending: true }));
      const attacks = await rows(db.from('cw_attacklog').select('cw_attack_uid,attacker_name_with_map_position,defender_name_with_map_position,star_scored,destruction_caused,attacking_date_time,attacker_id').eq('cw_uid', session.cw_uid).order('attacking_date_time', { ascending: false }).limit(100));
      send(res, 200, { data: { session, participants, attacks }, source: 'supabase' });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/war/history') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      const data = await rows(db.from('cw_session').select('cw_uid,opponent_clan_name,opponent_clan_id,size,battle_start,battle_end,result,our_clan_score,opponent_clan_score,our_clan_destruction,opponent_clan_destruction').order('battle_start', { ascending: false }).limit(limit));
      send(res, 200, { data, count: data.length, source: 'supabase' });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/capital-raids/latest') {
      const seasons = await rows(db.from('capital_raid_season').select('*').order('battle_start', { ascending: false }).limit(1));
      if (!seasons.length) { send(res, 200, { data: null }); return true; }
      const season = seasons[0];
      const participants = await rows(db.from('capital_raid_participants').select('player_name,player_id,attacks_used,attacks_available,total_loot_gained').eq('capital_raid_uid', season.generated_uid).order('total_loot_gained', { ascending: false }).limit(100));
      send(res, 200, { data: { season, participants }, source: 'supabase' });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/sync/status') {
      const data = await rows(db.from('sync_runs').select('job,status,details,message,started_at,finished_at').order('id', { ascending: false }).limit(30));
      send(res, 200, { data });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/sync/refresh') {
      const details = await refreshNow();
      send(res, details.busy ? 409 : 200, { data: details });
      return true;
    }

    send(res, 404, { error: 'Not found' });
    return true;
  } catch (error) {
    console.error('[api] request failed:', error?.message ?? 'unknown error');
    send(res, 500, { error: 'Internal server error' });
    return true;
  }
}
