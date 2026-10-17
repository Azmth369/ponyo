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

function authorized(req, expected = process.env.PONYO_API_KEY) {
  if (!expected || expected.length < 32) return false;
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice(7) === expected;
}

async function readRequestJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > 8192) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
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
  const controlRoute = url.pathname.startsWith('/api/v1/dashboard/');
  const expectedKey = controlRoute ? process.env.PONYO_CONTROL_API_KEY : process.env.PONYO_API_KEY;
  if (!authorized(req, expectedKey)) {
    send(res, expectedKey ? 401 : 503, {
      error: expectedKey ? 'Unauthorized' : (controlRoute ? 'Control API not configured' : 'API not configured')
    });
    return true;
  }

  try {
    if (url.pathname.startsWith('/api/v1/dashboard/')) {
      const ownerEmail = String(process.env.DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase();
      const actorEmail = String(req.headers['x-dashboard-user-email'] || '').trim().toLowerCase();
      const isOwner = Boolean(ownerEmail && actorEmail === ownerEmail);
      const validEmail = value => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(value || ''));
      const getAccess = async email => {
        if (email === ownerEmail && ownerEmail) return { email, permissions: ['*'], is_active: true, role: 'owner' };
        const { data, error } = await db.from('dashboard_access')
          .select('email,permissions,is_active,created_at,updated_at,created_by')
          .eq('email', email).maybeSingle();
        if (error) throw error;
        return data || null;
      };
      const audit = async (action, targetEmail, details = {}) => {
        const { error } = await db.from('dashboard_audit_log').insert({
          actor_email: actorEmail, action, target_email: targetEmail || null, details
        });
        if (error) throw error;
      };

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/access/check') {
        const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
        if (!validEmail(email)) { send(res, 400, { error: 'A valid email is required.' }); return true; }
        const access = await getAccess(email);
        return send(res, 200, access && access.is_active !== false
          ? { approved: true, email, role: access.role || 'viewer', permissions: access.permissions || [] }
          : { approved: false, email, role: null, permissions: [] });
      }

      if (!actorEmail || !validEmail(actorEmail)) {
        send(res, 403, { error: 'Dashboard identity is missing.' }); return true;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/access') {
        if (!isOwner) { send(res, 403, { error: 'Only the dashboard owner can manage access.' }); return true; }
        const access = await rows(db.from('dashboard_access')
          .select('email,permissions,is_active,created_at,updated_at,created_by')
          .order('email', { ascending: true }).limit(200));
        send(res, 200, { data: access }); return true;
      }

      if (req.method === 'PUT' && url.pathname === '/api/v1/dashboard/access') {
        if (!isOwner) { send(res, 403, { error: 'Only the dashboard owner can grant permissions.' }); return true; }
        const body = await readRequestJson(req);
        const email = String(body.email || '').trim().toLowerCase();
        const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
        if (!validEmail(email) || email === ownerEmail) {
          send(res, 400, { error: 'Enter a valid non-owner email address.' }); return true;
        }
        if (permissions.some(permission => permission !== 'sync.run')) {
          send(res, 400, { error: 'Only currently implemented permission is sync.run.' }); return true;
        }
        const { error } = await db.from('dashboard_access').upsert({
          email, permissions, is_active: true, updated_at: new Date().toISOString(), created_by: actorEmail
        }, { onConflict: 'email' });
        if (error) throw error;
        await audit('access.granted_or_updated', email, { permissions });
        const access = await getAccess(email);
        send(res, 200, { data: access }); return true;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/v1/dashboard/access') {
        if (!isOwner) { send(res, 403, { error: 'Only the dashboard owner can revoke access.' }); return true; }
        const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
        if (!validEmail(email) || email === ownerEmail) {
          send(res, 400, { error: 'A valid non-owner email is required.' }); return true;
        }
        const { data, error } = await db.from('dashboard_access')
          .update({ is_active: false, permissions: [], updated_at: new Date().toISOString() })
          .eq('email', email).select('email').maybeSingle();
        if (error) throw error;
        await audit('access.revoked', email);
        send(res, data ? 200 : 404, data ? { ok: true } : { error: 'Access record not found.' }); return true;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/audit') {
        if (!isOwner) { send(res, 403, { error: 'Only the dashboard owner can view the audit log.' }); return true; }
        const data = await rows(db.from('dashboard_audit_log')
          .select('actor_email,action,target_email,details,created_at')
          .order('created_at', { ascending: false }).limit(100));
        send(res, 200, { data }); return true;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/dashboard/sync/refresh') {
        const access = await getAccess(actorEmail);
        const canRun = isOwner || Boolean(access?.is_active && (access.permissions || []).includes('sync.run'));
        if (!canRun) { send(res, 403, { error: 'You do not have permission to run syncs.' }); return true; }
        const body = await readRequestJson(req);
        if (body.confirmation !== 'RUN_FULL_SYNC') {
          send(res, 400, { error: 'Explicit full-sync confirmation is required.' }); return true;
        }
        const runId = crypto.randomUUID();
        const lockOwner = 'dashboard:' + runId;
        const { data: claimed, error: lockError } = await db.rpc('claim_dashboard_sync_lock', {
          p_owner: lockOwner, p_lease_seconds: 3600
        });
        if (lockError) throw lockError;
        if (claimed !== true) {
          send(res, 409, { error: 'Another sync operation is running. Try again after it finishes.' }); return true;
        }
        const { error: insertError } = await db.from('dashboard_control_runs').insert({
          id: runId, action: 'full_sync', requested_by: actorEmail, status: 'running', started_at: new Date().toISOString()
        });
        if (insertError) {
          await db.rpc('release_dashboard_sync_lock', { p_owner: lockOwner });
          throw insertError;
        }
        await audit('sync.full_refresh.started', actorEmail, { runId });
        void (async () => {
          let status = 'failed';
          let message = 'Sync did not finish.';
          try {
            const result = await refreshNow();
            if (result?.busy) { status = 'busy'; message = result.message || 'Ponyo is busy.'; }
            else {
              const values = Object.values(result?.results || {});
              const failures = values.filter(value => value == null).length;
              status = failures ? 'failed' : 'completed';
              message = failures ? 'Full sync finished with ' + failures + ' failed job(s).' : 'Full sync completed successfully.';
            }
          } catch (error) {
            message = String(error?.message || 'Sync failed').slice(0, 200);
          } finally {
            await db.from('dashboard_control_runs').update({
              status, message, finished_at: new Date().toISOString()
            }).eq('id', runId);
            await db.rpc('release_dashboard_sync_lock', { p_owner: lockOwner });
            await audit('sync.full_refresh.' + status, actorEmail, { runId, message }).catch(() => {});
          }
        })();
        send(res, 202, { data: { id: runId, status: 'running', message: 'Full sync accepted. Check status for progress.' } }); return true;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/sync/refresh-status') {
        const runId = String(url.searchParams.get('id') || '');
        if (!/^[0-9a-f-]{36}$/i.test(runId)) { send(res, 400, { error: 'A valid run ID is required.' }); return true; }
        const access = await getAccess(actorEmail);
        if (!isOwner && !(access?.is_active && (access.permissions || []).includes('sync.run'))) {
          send(res, 403, { error: 'You do not have permission to view control-run status.' }); return true;
        }
        const { data, error } = await db.from('dashboard_control_runs')
          .select('id,action,requested_by,status,message,started_at,finished_at').eq('id', runId).maybeSingle();
        if (error) throw error;
        if (!data) { send(res, 404, { error: 'Run not found.' }); return true; }
        send(res, 200, { data }); return true;
      }

      send(res, 404, { error: 'Not found' }); return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/operations/summary') {
      // Read-only operational view for the private control panel. Never expose
      // raw details or Discord identifiers from the publication ledger.
      const safeMessage = value => String(value ?? '')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/(token|secret|password|apikey|api_key)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]')
        .slice(0, 220);
      const syncRuns = await rows(
        db.from('sync_runs')
          .select('job,status,started_at,finished_at,message')
          .order('started_at', { ascending: false })
          .limit(25)
      );
      const reports = await rows(
        db.from('event_report_publications')
          .select('event_type,event_uid,expected_end,state,attempts,last_error,published_at,created_at,updated_at')
          .order('expected_end', { ascending: false })
          .limit(30)
      );
      send(res, 200, {
        generatedAt: new Date().toISOString(),
        syncRuns: syncRuns.map(run => ({
          job: run.job,
          status: run.status,
          started_at: run.started_at,
          finished_at: run.finished_at,
          message: safeMessage(run.message)
        })),
        reports: reports.map(report => ({
          event_type: report.event_type,
          event_uid: report.event_uid,
          expected_end: report.expected_end,
          state: report.state,
          attempts: report.attempts,
          last_error: safeMessage(report.last_error),
          published_at: report.published_at,
          created_at: report.created_at,
          updated_at: report.updated_at
        }))
      });
      return true;
    }

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

    if (req.method === 'GET' && url.pathname === '/api/v1/clan/capital-contribution-activity') {
      const normalizeTag = value => String(value ?? '').replace(/^#/, '').toUpperCase();
      const configuredTag = normalizeTag(process.env.COC_CLAN_TAG);
      const seasons = await rows(
        db.from('capital_raid_season')
          .select('generated_uid,battle_start,battle_end')
          .not('battle_end', 'is', null)
          .order('battle_end', { ascending: false })
          .limit(20)
      );
      const latestSeason = seasons[0] ?? null;
      if (!latestSeason?.battle_end) {
        send(res, 200, {
          data: [],
          baselineAt: null,
          comparisonAt: null,
          error: 'No stored Capital Raid Weekend end time is available.',
          note: 'Contribution deltas require a stored raid end time and snapshots before and after it.'
        });
        return true;
      }

      const snapshots = await rows(
        db.from('player_capital_contribution_snap')
          .select('clan_tag,player_tag,player_name,contribution,observed_at')
          .eq('clan_tag', process.env.COC_CLAN_TAG)
          .order('observed_at', { ascending: false })
          .limit(6000)
      );
      const raidEnd = new Date(latestSeason.battle_end).getTime();
      const beforeByTag = new Map();
      const afterByTag = new Map();
      for (const snap of snapshots) {
        const time = new Date(snap.observed_at).getTime();
        const tag = normalizeTag(snap.player_tag);
        if (!tag) continue;
        if (time <= raidEnd && !beforeByTag.has(tag)) beforeByTag.set(tag, snap);
        if (time > raidEnd && !afterByTag.has(tag)) afterByTag.set(tag, snap);
      }

      const data = [];
      for (const [tag, latest] of afterByTag.entries()) {
        const baseline = beforeByTag.get(tag);
        const currentClanTag = normalizeTag(latest.clan_tag);
        if (configuredTag && currentClanTag !== configuredTag) continue;
        const delta = baseline ? Number(latest.contribution) - Number(baseline.contribution) : null;
        data.push({
          playerTag: latest.player_tag,
          name: latest.player_name,
          contributionAtRaidEnd: baseline ? Number(baseline.contribution) : null,
          contributionNow: Number(latest.contribution),
          contributionIncrease: delta != null && delta >= 0 ? delta : null,
          counterDecreased: delta != null && delta < 0,
          baselineAt: baseline?.observed_at ?? null,
          comparisonAt: latest.observed_at,
          baselineMissing: !baseline
        });
      }
      data.sort((a, b) => (b.contributionIncrease ?? -1) - (a.contributionIncrease ?? -1));
      send(res, 200, {
        clanTag: process.env.COC_CLAN_TAG,
        raidSeasonId: latestSeason.generated_uid,
        raidEndedAt: latestSeason.battle_end,
        baselineRule: 'latest stored contribution snapshot at or before the latest stored Capital Raid Weekend end time',
        comparisonRule: 'latest stored contribution snapshot after that raid end time',
        snapshotCount: snapshots.length,
        matchedPlayers: data.filter(row => row.contributionIncrease != null).length,
        data,
        source: 'player_capital_contribution_snap',
        note: 'Contribution increases are lifetime player-profile counter deltas, not loot gained during that raid. A missing baseline or a decreased counter is not treated as a positive increase. Results are limited to players represented in snapshots; departed players may be absent from the current roster but remain in stored history.'
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/clan/activity') {
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const clan = await fetchClan();
      const roster = clan.memberList ?? [];

      // Read enough snapshots to find a baseline at or before the requested window.
      const snapshots = await rows(
        db.from('clan_info_snap')
          .select('date_time,player_id,name,th,lvl,trophies,troops_donated,troops_received')
          .order('date_time', { ascending: false })
          .limit(6000)
      );
      const latestSnapshotTime = snapshots[0]?.date_time ?? null;
      const baselineByTag = new Map();
      const allSnapshotsByTag = new Map();
      for (const snap of snapshots) {
        if (!allSnapshotsByTag.has(snap.player_id)) allSnapshotsByTag.set(snap.player_id, []);
        allSnapshotsByTag.get(snap.player_id).push(snap);
        if (snap.date_time <= cutoff && !baselineByTag.has(snap.player_id)) baselineByTag.set(snap.player_id, snap);
      }

      // Join lifetime Clan Capital contribution snapshots to the same activity window.
      const contributionSnapshots = await rows(
        db.from('player_capital_contribution_snap')
          .select('player_tag,player_name,contribution,observed_at')
          .eq('clan_tag', clan.tag)
          .order('observed_at', { ascending: false })
          .limit(6000)
      );
      const contributionBaselineByTag = new Map();
      const contributionLatestByTag = new Map();
      for (const snap of contributionSnapshots) {
        const tag = String(snap.player_tag ?? '').replace(/^#/, '').toUpperCase();
        const time = new Date(snap.observed_at).getTime();
        if (!tag || !Number.isFinite(time)) continue;
        if (time <= new Date(cutoff).getTime() && !contributionBaselineByTag.has(tag)) contributionBaselineByTag.set(tag, snap);
        if (!contributionLatestByTag.has(tag)) contributionLatestByTag.set(tag, snap);
      }
      const normalizePlayerTag = value => String(value ?? '').replace(/^#/, '').toUpperCase();

      const lastChangeByTag = new Map();
      const orderedSnapshots = [...snapshots].sort((a, b) => new Date(a.date_time) - new Date(b.date_time));
      const previousByTag = new Map();
      const tagKey = value => String(value ?? '').replace(/^#/, '').toUpperCase();
      for (const snap of orderedSnapshots) {
        const key = tagKey(snap.player_id);
        const previous = previousByTag.get(key);
        if (previous) {
          const changes = [];
          if (Number(previous.th) !== Number(snap.th)) changes.push({ metric: 'townHallLevel', previous: previous.th, current: snap.th });
          if (Number(previous.lvl) !== Number(snap.lvl)) changes.push({ metric: 'xpLevel', previous: previous.lvl, current: snap.lvl });
          if (Number(previous.trophies) !== Number(snap.trophies)) changes.push({ metric: 'trophies', previous: previous.trophies, current: snap.trophies });
          if (Number(previous.troops_donated) !== Number(snap.troops_donated)) changes.push({ metric: 'donations', previous: previous.troops_donated, current: snap.troops_donated });
          if (Number(previous.troops_received) !== Number(snap.troops_received)) changes.push({ metric: 'troopsReceived', previous: previous.troops_received, current: snap.troops_received });
          if (changes.length) lastChangeByTag.set(key, { at: snap.date_time, changes });
        }
        previousByTag.set(key, snap);
      }

      const activityRows = roster.map(member => {
        const baseline = baselineByTag.get(member.tag);
        const donationsNow = Number(member.donations ?? 0);
        const receivedNow = Number(member.donationsReceived ?? 0);
        const previousDonations = baseline?.troops_donated == null ? null : Number(baseline.troops_donated);
        const previousReceived = baseline?.troops_received == null ? null : Number(baseline.troops_received);
        const donationCounterReset = previousDonations != null && donationsNow < previousDonations;
        const donationIncrease = previousDonations == null || donationCounterReset ? null : donationsNow - previousDonations;
        const receivedIncrease = previousReceived == null || receivedNow < previousReceived ? null : receivedNow - previousReceived;
        const previousTh = baseline?.th == null ? null : Number(baseline.th);
        const currentTh = member.townHallLevel ?? null;
        const upgraded = previousTh != null && currentTh != null && Number(currentTh) > previousTh;
        const contributionBaseline = contributionBaselineByTag.get(normalizePlayerTag(member.tag));
        const contributionLatest = contributionLatestByTag.get(normalizePlayerTag(member.tag));
        const contributionBaselineValue = contributionBaseline?.contribution == null ? null : Number(contributionBaseline.contribution);
        const contributionCurrentValue = contributionLatest?.contribution == null ? null : Number(contributionLatest.contribution);
        const contributionDelta = contributionBaselineValue != null && contributionCurrentValue != null ? contributionCurrentValue - contributionBaselineValue : null;
        const observedChange = lastChangeByTag.get(tagKey(member.tag)) ?? null;
        const contributionChanged = contributionDelta != null && contributionDelta !== 0;
        const observedChanges = [...(observedChange?.changes ?? [])];
        if (contributionChanged) observedChanges.push({ metric: 'lifetimeClanCapitalContribution', previous: contributionBaselineValue, current: contributionCurrentValue });
        return {
          playerTag: member.tag,
          name: member.name,
          role: member.role ?? null,
          previousTownHallLevel: previousTh,
          townHallLevel: currentTh,
          townHallUpgradeObserved: upgraded,
          townHallUpgradeDelta: upgraded ? Number(currentTh) - previousTh : 0,
          previousDonations: previousDonations,
          currentDonations: donationsNow,
          donationsInWindow: donationIncrease,
          previousReceived: previousReceived,
          currentReceived: receivedNow,
          receivedInWindow: receivedIncrease,
          lifetimeClanCapitalContributionAtWindowStart: contributionBaselineValue,
          lifetimeClanCapitalContributionNow: contributionCurrentValue,
          contributionIncreaseInWindow: contributionDelta != null && contributionDelta >= 0 ? contributionDelta : null,
          contributionCounterDecreased: contributionDelta != null && contributionDelta < 0,
          contributionBaselineAt: contributionBaseline?.observed_at ?? null,
          contributionComparisonAt: contributionLatest?.observed_at ?? null,
          contributionBaselineMissing: !contributionBaseline,
          donationCounterReset,
          baselineSnapshotAt: baseline?.date_time ?? null,
          lastObservedActivityAt: observedChange?.at ?? (contributionChanged ? contributionLatest?.observed_at ?? null : null),
          lastObservedChanges: observedChanges,
          lastCheckedAt: latestSnapshotTime
        };
      });

      const upgrades = activityRows
        .filter(row => row.townHallUpgradeObserved)
        .sort((a, b) => b.townHallLevel - a.townHallLevel || b.townHallUpgradeDelta - a.townHallUpgradeDelta);
      const donors = activityRows
        .filter(row => row.donationsInWindow != null && row.donationsInWindow > 0)
        .sort((a, b) => b.donationsInWindow - a.donationsInWindow);
      const recipients = activityRows
        .filter(row => row.receivedInWindow != null && row.receivedInWindow > 0)
        .sort((a, b) => b.receivedInWindow - a.receivedInWindow);
      const capitalContributors = activityRows
        .filter(row => row.contributionIncreaseInWindow != null && row.contributionIncreaseInWindow > 0)
        .sort((a, b) => b.contributionIncreaseInWindow - a.contributionIncreaseInWindow);
      const capitalContributionCoverage = activityRows.filter(row => row.contributionBaselineAt).length;
      const covered = activityRows.filter(row => row.baselineSnapshotAt).length;
      const latestSnapshotAgeHours = latestSnapshotTime
        ? Math.round((Date.now() - new Date(latestSnapshotTime).getTime()) / 3600000 * 10) / 10
        : null;

      send(res, 200, {
        clanName: clan.name,
        clanTag: clan.tag,
        windowHours: hours,
        windowStart: cutoff,
        windowEnd: new Date().toISOString(),
        snapshotCoverage: { membersWithBaseline: covered, currentMembers: roster.length, latestSnapshotAt: latestSnapshotTime, latestSnapshotAgeHours },
        townHallUpgrades: upgrades,
        donationLeaders: donors,
        receivedLeaders: recipients,
        capitalContributionLeaders: capitalContributors,
        capitalContributionCoverage: {
          membersWithBaseline: capitalContributionCoverage,
          currentMembers: roster.length,
          latestSnapshotAt: contributionSnapshots[0]?.observed_at ?? null
        },
        data: activityRows,
        count: activityRows.length,
        source: 'clash_of_clans_api_plus_snapshots',
        generatedAt: new Date().toISOString(),
        note: 'lastObservedActivityAt is the latest timestamp at which consecutive stored snapshots showed an actual tracked-statistic change; it is not the latest check time. lastObservedChanges identifies those changed statistics. Contribution comparisons use lifetime profile snapshots. Coverage and snapshot retention limit historical certainty. Donation counters may reset; observed changes do not prove exact login times.'
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

    if (req.method === 'GET' && url.pathname === '/api/v1/cwl/history') {
      const seasonLimit = Math.min(12, Math.max(1, Number(url.searchParams.get('seasons')) || 3));
      const roundLimit = Math.min(7, Math.max(1, Number(url.searchParams.get('rounds')) || 7));
      const normalizeTag = value => String(value ?? '').replace(/^#/, '').toUpperCase();
      const configuredTag = normalizeTag(process.env.COC_CLAN_TAG);

      // Do not assume every row in shared CWL tables belongs to this clan.
      // Filter by the clan tags captured in the original league-group payload
      // before applying the requested season limit.
      const allSeasonRows = await rows(
        db.from('cwl_seasons')
          .select('generated_cwl_id,battle_start,battle_end,stars_scored,clan_participants_no,data')
          .order('battle_start', { ascending: false, nullsFirst: false })
          .limit(500)
      );
      const matchingSeasonRows = allSeasonRows.filter(season =>
        Array.isArray(season.data?.clans) &&
        season.data.clans.some(clan => normalizeTag(clan.tag) === configuredTag)
      );
      const seasonRows = matchingSeasonRows.slice(0, seasonLimit);
      const seasons = [];

      for (const season of seasonRows) {
        const prefix = `${season.generated_cwl_id}-D`;
        const dayRows = await rows(
          db.from('cwl_daywise_attacklog')
            .select('generated_cwl_day_id,battle_day,battle_start,battle_end,size,opponent_clan_name,opponent_clan_id,our_clan_score,opponent_clan_score,data')
            .like('generated_cwl_day_id', `${prefix}%`)
            .order('battle_day', { ascending: true })
            .limit(roundLimit)
        );
        const ids = dayRows.map(day => day.generated_cwl_day_id);
        let participants = [];
        if (ids.length) {
          participants = await rows(
            db.from('cwl_season_participants')
              .select('cwl_day_uid,player_name,player_id,attacks_used,attacks_available,stars_scored,destruction_caused,player_map_position')
              .in('cwl_day_uid', ids)
              .order('stars_scored', { ascending: false })
              .limit(500)
          );
        }
        const rounds = dayRows.map(day => ({
          ...day,
          warType: 'CWL',
          result: day.our_clan_score == null || day.opponent_clan_score == null
            ? 'unknown'
            : Number(day.our_clan_score) > Number(day.opponent_clan_score)
              ? 'win'
              : Number(day.our_clan_score) < Number(day.opponent_clan_score)
                ? 'loss' : 'draw',
          participants: participants.filter(p => p.cwl_day_uid === day.generated_cwl_day_id)
        }));
        seasons.push({
          seasonId: season.generated_cwl_id,
          season: season.data?.season ?? null,
          battleStart: season.battle_start,
          battleEnd: season.battle_end,
          starsScored: season.stars_scored,
          clanParticipants: season.clan_participants_no,
          rounds
        });
      }

      send(res, 200, {
        data: seasons,
        count: seasons.length,
        source: 'supabase',
        warType: 'CWL',
        excludedUnverifiedSeasons: allSeasonRows.length - matchingSeasonRows.length,
        note: matchingSeasonRows.length
          ? 'Only CWL seasons whose stored league-group payload includes the configured clan tag are returned. Historical seasons without a verifiable clan tag are excluded rather than risking another clan\'s data.'
          : 'No stored CWL season could be verified against the configured clan tag. This does not prove that no CWL history exists; older records may lack clan identity and need reconciliation or a fresh sync.'
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/capital-raids/history') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      const includeAttacks = ['true', '1', 'yes'].includes(String(url.searchParams.get('includeAttacks') ?? '').toLowerCase());
      const seasons = await rows(
        db.from('capital_raid_season')
          .select('generated_uid,battle_start,battle_end,total_loot,raids_won,total_attacks,participants_no,absentees_no,participants_name,absentees_name')
          .order('battle_start', { ascending: false, nullsFirst: false })
          .limit(limit)
      );
      const data = [];
      for (const season of seasons) {
        const uid = season.generated_uid;
        const participants = await rows(
          db.from('capital_raid_participants')
            .select('player_name,player_id,attacks_used,attacks_available,total_loot_gained')
            .eq('capital_raid_uid', uid)
            .order('total_loot_gained', { ascending: false })
            .limit(50)
        );
        let attacks = [];
        if (includeAttacks) {
          attacks = await rows(
            db.from('capital_raid_attacklog')
              .select('generated_uid,capital_raid_uid,attacker_id,attacker_name,defender_id,defender_name,stars,destruction_percentage,capital_resources_looted,data')
              .eq('capital_raid_uid', uid)
              .order('generated_uid', { ascending: true })
              .limit(500)
          );
        }
        data.push({
          ...season,
          participants,
          attacks: includeAttacks ? attacks : undefined,
          attackDetailsAvailable: includeAttacks ? attacks.length > 0 : null,
          warType: 'Capital Raid Weekend'
        });
      }
      send(res, 200, {
        data, count: data.length, limit, includeAttacks, source: 'supabase',
        historyType: 'capital_raid_weekend',
        note: includeAttacks
          ? 'Returns compact season summaries, participant summaries and attack rows where stored. A season with no attack rows may not have captured attack-level data.'
          : 'Compact history mode returns season summaries and participant leaderboards. Attack-level logs are excluded to keep responses small; request includeAttacks=true for attack details.'
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
