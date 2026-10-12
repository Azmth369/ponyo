import { db } from './db.js';
import { getClan as fetchClan, getCurrentWar as fetchCurrentWar, getPlayer as fetchPlayer } from './cocApi.js';
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
      // Use the live clan roster so old members left in the database cannot
      // inflate the roster or appear as current members.
      const clan = await fetchClan();
      const roster = (clan.memberList ?? []).map(m => ({
        player_id: m.tag,
        name: m.name,
        role: m.role ?? null,
        th: m.townHallLevel ?? null,
        lvl: m.expLevel ?? null,
        trophies: m.trophies ?? null,
        troops_donated: m.donations ?? null,
        troops_received: m.donationsReceived ?? null
      }));
      const search = (url.searchParams.get('search') ?? '').trim().slice(0, 80).toLowerCase();
      const filtered = search ? roster.filter(m => m.name.toLowerCase().includes(search)) : roster;
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const data = filtered.slice(0, limit);
      send(res, 200, {
        data,
        count: data.length,
        totalMembers: roster.length,
        filteredMembers: filtered.length,
        limit,
        source: 'clash_of_clans_api',
        clanName: clan.name,
        refreshedAt: new Date().toISOString()
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/clan/player-capital-contribution') {
      const search = (url.searchParams.get('player') ?? '').trim().slice(0, 80);
      if (!search) {
        send(res, 400, { error: 'Missing required player query parameter. Provide a player name or tag.' });
        return true;
      }

      // A supplied player tag is authoritative: fetch the live profile directly.
      // Do not require a player-tag lookup to match the current clan roster.
      if (/^#?[0289PYLQGRJCUV]+$/i.test(search) && search.replace(/^#/, '').length >= 3) {
        const playerTag = search.startsWith('#') ? search : `#${search}`;
        const player = await fetchPlayer(playerTag);
        send(res, 200, {
          data: {
            name: player.name,
            playerTag: player.tag ?? playerTag,
            clanName: player.clan?.name ?? null,
            townHallLevel: player.townHallLevel ?? null,
            totalClanCapitalContribution: Number(player.clanCapitalContributions ?? 0)
          },
          metric: 'lifetime_clan_capital_contribution',
          source: 'clash_of_clans_player_api',
          checkedAt: new Date().toISOString(),
          note: 'This is the player profile total Clan Capital contribution, not loot gained in a single Capital Raid Weekend.'
        });
        return true;
      }

      const clan = await fetchClan();
      const roster = clan.memberList ?? [];
      const normalized = search.toLowerCase().replace(/^#/, '');
      const exact = roster.filter(m =>
        m.name.toLowerCase() === search.toLowerCase() ||
        m.tag.toLowerCase().replace(/^#/, '') === normalized
      );
      const matches = exact.length ? exact : roster.filter(m =>
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.tag.toLowerCase().replace(/^#/, '').includes(normalized)
      );

      let playerTag = null;
      let matchedName = null;
      let townHallLevel = null;

      if (matches.length > 1) {
        send(res, 200, {
          data: null,
          ambiguous: true,
          message: 'Multiple clan members matched. Ask the user to choose one.',
          matches: matches.map(m => ({ name: m.name, playerTag: m.tag, townHallLevel: m.townHallLevel }))
        });
        return true;
      }

      if (matches.length === 1) {
        playerTag = matches[0].tag;
        matchedName = matches[0].name;
        townHallLevel = matches[0].townHallLevel ?? null;
      } else {
        // The player may have left the clan after appearing in a stored raid.
        // Use the stored player tag only as a lookup fallback; the live player
        // profile remains the source of truth for lifetime contribution.
        const historical = await rows(
          db.from('capital_raid_participants')
            .select('player_name,player_id')
            .ilike('player_name', search)
            .not('player_id', 'is', null)
            .order('player_name', { ascending: true })
            .limit(20)
        );
        const unique = [...new Map(historical
          .filter(p => p.player_id)
          .map(p => [String(p.player_id).toUpperCase(), p])).values()];
        if (unique.length === 1) {
          playerTag = unique[0].player_id;
          matchedName = unique[0].player_name;
        } else if (unique.length > 1) {
          send(res, 200, {
            data: null,
            ambiguous: true,
            message: 'Multiple stored raid participants matched. Ask the user for the player tag.',
            matches: unique.map(p => ({ name: p.player_name, playerTag: p.player_id }))
          });
          return true;
        } else {
          send(res, 404, {
            error: 'No current clan member or stored raid participant matched that player name. Provide the player tag.',
            clanName: clan.name
          });
          return true;
        }
      }

      const player = await fetchPlayer(playerTag);
      send(res, 200, {
        data: {
          name: player.name ?? matchedName,
          playerTag: player.tag ?? playerTag,
          clanName: player.clan?.name ?? clan.name,
          townHallLevel: player.townHallLevel,
          totalClanCapitalContribution: Number(player.clanCapitalContributions ?? 0)
        },
        metric: 'lifetime_clan_capital_contribution',
        source: 'clash_of_clans_player_api',
        checkedAt: new Date().toISOString(),
        note: 'This is the player profile total Clan Capital contribution, not loot gained in a single Capital Raid Weekend.'
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/clan/activity') {
      const clan = await fetchClan();
      const roster = clan.memberList ?? [];
      const stored = await rows(
        db.from('clan_info').select('player_id,last_active,date_time').limit(1000)
      );
      const activityByTag = new Map(stored.map(row => [row.player_id, row]));
      const data = roster.map(member => {
        const record = activityByTag.get(member.tag);
        return {
          playerTag: member.tag,
          name: member.name,
          role: member.role ?? null,
          townHallLevel: member.townHallLevel ?? null,
          xpLevel: member.expLevel ?? null,
          trophies: member.trophies ?? null,
          troopsDonated: member.donations ?? null,
          troopsReceived: member.donationsReceived ?? null,
          lastObservedActivityAt: record?.last_active ?? null,
          lastCheckedAt: record?.date_time ?? null,
          activityStatus: record?.last_active ? 'activity_observed' : 'not_enough_snapshot_history',
          interpretation: record?.last_active
            ? 'A tracked stat changed between snapshots at or before this time; this is not an exact last-login timestamp.'
            : 'No tracked activity timestamp is available yet. More successful snapshots are needed.'
        };
      }).sort((x, y) => {
        if (!x.lastObservedActivityAt) return 1;
        if (!y.lastObservedActivityAt) return -1;
        return y.lastObservedActivityAt.localeCompare(x.lastObservedActivityAt);
      });
      send(res, 200, {
        clanName: clan.name,
        clanTag: clan.tag,
        count: data.length,
        source: 'clash_of_clans_api_plus_snapshots',
        generatedAt: new Date().toISOString(),
        note: 'Last observed activity is inferred from changes in trophies, XP level, Town Hall level, and troop donation/received counters. Trophy changes alone can occur from defensive battles; this is not a true online timestamp.',
        data
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/clan/summary') {
      // Derive all headline figures from the same live roster as getClanMembers.
      const clan = await fetchClan();
      const members = clan.memberList ?? [];
      const summary = {
        clanName: clan.name,
        clanTag: clan.tag,
        members: members.length,
        totalDonations: members.reduce((n, m) => n + (Number(m.donations) || 0), 0),
        totalReceived: members.reduce((n, m) => n + (Number(m.donationsReceived) || 0), 0),
        averageTrophies: members.length ? Math.round(members.reduce((n, m) => n + (Number(m.trophies) || 0), 0) / members.length) : 0,
        townHallCounts: members.reduce((o, m) => { const k = String(m.townHallLevel ?? 'unknown'); o[k] = (o[k] || 0) + 1; return o; }, {}),
        roles: members.reduce((o, m) => { const k = m.role ?? 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}),
        generatedAt: new Date().toISOString()
      };
      send(res, 200, { data: summary, source: 'clash_of_clans_api' });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/war/current') {
      // Current-war questions must use the live Clash of Clans API, not the
      // newest stored session (which may be a completed war from weeks ago).
      const war = await fetchCurrentWar();
      send(res, 200, {
        data: war,
        source: 'clash_of_clans_api',
        checkedAt: new Date().toISOString(),
        isLive: war?.state !== 'warEnded' && war?.state !== 'notInWar'
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/war/history') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      const stored = await rows(db.from('cw_session').select('cw_uid,opponent_clan_name,opponent_clan_id,size,battle_start,battle_end,result,our_clan_score,opponent_clan_score,our_clan_destruction,opponent_clan_destruction').order('battle_start', { ascending: false }).limit(limit));
      // This endpoint reads cw_session only: these are regular Clan War records,
      // not CWL rounds. Older rows may contain invalid destruction values; never
      // present a value outside the API's 0-100 percentage range as a percentage.
      const data = stored.map(war => ({
        ...war,
        warType: 'Clan War',
        our_clan_destruction: Number.isFinite(Number(war.our_clan_destruction)) &&
          Number(war.our_clan_destruction) >= 0 && Number(war.our_clan_destruction) <= 100
          ? Number(war.our_clan_destruction) : null,
        opponent_clan_destruction: Number.isFinite(Number(war.opponent_clan_destruction)) &&
          Number(war.opponent_clan_destruction) >= 0 && Number(war.opponent_clan_destruction) <= 100
          ? Number(war.opponent_clan_destruction) : null
      }));
      send(res, 200, {
        data, count: data.length, source: 'supabase',
        warType: 'regular_clan_war',
        note: 'This endpoint returns regular Clan War history from cw_session, not Clan War League (CWL) rounds. Invalid stored destruction percentages are returned as null.'
      });
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
