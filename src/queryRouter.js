// Database-backed deterministic query router. Turns a query plan into real
// rows from the Ponyo schema and returns a structured result. Filtering is
// delegated to queryEngine.applyAttackUsageFilters so the pure intent executor
// and this router can never disagree.
//
// Normal-war questions prefer the live CoC API snapshot (state, time left,
// live scores, fresh attacks); the Supabase sync (up to 10 minutes old) is
// the fallback. Capital and CWL questions are scoped to the latest synced
// season/day so participants from different weekends are never mixed.

import {
  getPlayers,
  getCurrentWar,
  getWarMembers,
  getCwlParticipants,
  getCapitalParticipants,
  getLatestCwlDay,
  getLatestCapitalSeason
} from './retrieval.js';
import { getClan } from './cocApi.js';
import { getLiveWar, getLiveCapital } from './liveData.js';
import {
  buildQueryPlan,
  deterministicWarMembers,
  deterministicMemberMetric,
  deterministicRole,
  applyAttackUsageFilters
} from './queryEngine.js';

function metricRows(result) {
  return result.rows.map(p => ({ name: p.name, tag: p.tag, value: Number(p[result.plan.metric] ?? 0), metric: result.plan.metric }));
}

const nameOnly = row => ({ name: row.player_name ?? row.name, tag: row.player_id ?? row.tag });
const roleRows = result => result.rows.map(nameOnly);

function attackUsageResult(plan, rows) {
  const filtered = applyAttackUsageFilters(rows, plan);
  return {
    intent: 'structured_clan_query',
    scope: plan.scope,
    query: 'attack_usage',
    filter: {
      unused: plan.unused,
      attacks_used: plan.attacks_used,
      attacks_used_min: plan.attacks_used_min ?? null,
      attacks_remaining: plan.attacks_remaining
    },
    result_count: filtered.length,
    result: filtered.map(r => ({
      name: r.player_name,
      tag: r.player_id,
      map_position: r.map_position,
      attacks_used: Number(r.attacks_used ?? 0),
      attacks_available: Number(r.attacks_available ?? 0),
      attacks_remaining: Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0),
      stars_earned: Number(r.stars_earned ?? 0),
      destruction_percentage: Number(r.destruction_percentage ?? 0)
    }))
  };
}

function currentWarStatistics(members, live = null) {
  const stats = {
    team_size: members.length,
    attacks_available: members.reduce((sum, r) => sum + Number(r.attacks_available ?? 0), 0),
    attacks_used: members.reduce((sum, r) => sum + Number(r.attacks_used ?? 0), 0),
    attacks_remaining: members.reduce((sum, r) => sum + Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0), 0),
    stars_earned: members.reduce((sum, r) => sum + Number(r.stars_earned ?? 0), 0),
    destruction_percentage_sum: members.reduce((sum, r) => sum + Number(r.destruction_percentage ?? 0), 0)
  };
  if (live?.opponent) {
    stats.opponent = {
      name: live.opponent.name,
      tag: live.opponent.tag,
      stars: live.opponent.stars,
      destruction_percentage: live.opponent.destruction_percentage,
      attacks_used: live.opponent.attacks_used,
      attacks_available: live.opponent.attacks_available
    };
  }
  return stats;
}

function opponentFromCurrentWar(current) {
  const data = current?.data ?? {};
  const opponent = data.opponent ?? data.opponentClan ?? {};
  return {
    name: current?.opponent_clan_name ?? opponent.name ?? null,
    tag: current?.opponent_clan_id ?? opponent.tag ?? null
  };
}

export async function runDeterministicQuery(question) {
  const plan = buildQueryPlan(question);

  if (plan.operation === 'clan_identity') {
    const clan = await getClan();
    return {
      intent: 'structured_query', scope: 'clan', query: 'clan_identity', field: plan.identity_field,
      result_count: 1,
      result: [{ name: clan.name ?? null, tag: clan.tag ?? null, members: Number(clan.members ?? clan.memberList?.length ?? 0) }]
    };
  }

  if (plan.operation === 'member_metric') {
    const players = await getPlayers({ limit: 100 });
    const normalized = players.map(p => ({ ...p, tag: p.player_id, name: p.name }));
    const result = deterministicMemberMetric(question, normalized);
    if (!result) return null;
    let rows = metricRows(result);
    if (!plan.asks_count && plan.sort) rows = rows.slice(0, 1);
    return { intent: 'structured_query', scope: 'clan', query: plan.metric, sort: plan.sort, result_count: rows.length, result: rows };
  }

  if (plan.operation === 'role_members') {
    const players = await getPlayers({ limit: 100 });
    const result = deterministicRole(question, players);
    if (!result) return null;
    return { intent: 'structured_query', scope: 'clan', query: 'role', role: plan.role, result_count: result.rows.length, result: roleRows(result) };
  }

  if (plan.scope === 'war') {
    // Live CoC API first: correct state, time left and fresh attack usage.
    // Fall back to the synced Supabase session when the API is unavailable.
    const live = await getLiveWar();
    const current = live ?? await getCurrentWar();
    if (!current) return { intent: 'structured_query', scope: 'war', query: plan.operation, result_count: 0, result: [], note: 'No current normal clan war is available.' };

    const event = live
      ? {
          source: 'live',
          state: live.state,
          time_left_ms: live.time_left_ms,
          preparation_ends_in_ms: live.preparation_ends_in_ms,
          start_time: live.start_time,
          end_time: live.end_time,
          opponent: live.opponent?.name ?? null,
          opponent_tag: live.opponent?.tag ?? null
        }
      : { war_key: current.war_key, state: current.state, start_time: current.start_time, end_time: current.end_time, opponent: current.opponent_clan_name };

    if (plan.operation === 'opponent') {
      const opponent = live
        ? { name: live.opponent?.name ?? null, tag: live.opponent?.tag ?? null }
        : opponentFromCurrentWar(current);
      return {
        intent: 'structured_query', scope: 'war', query: 'opponent',
        result_count: opponent.name || opponent.tag ? 1 : 0,
        result: [opponent],
        event
      };
    }

    if (plan.operation === 'state') {
      return {
        intent: 'structured_query', scope: 'war', query: 'state', result_count: 1,
        result: [{ state: event.state, time_left_ms: event.time_left_ms ?? null, end_time: event.end_time ?? null }],
        event
      };
    }

    if (plan.operation === 'timing') {
      return {
        intent: 'structured_query', scope: 'war', query: 'timing', result_count: 1,
        result: [{ start_time: event.start_time, end_time: event.end_time, state: event.state, time_left_ms: event.time_left_ms ?? null }],
        event
      };
    }

    const members = live ? live.our_members : await getWarMembers(current.war_key, 100);

    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'war', query: 'members', result_count: members.length,
        result: members.map(r => ({
          name: r.player_name, tag: r.player_tag ?? r.player_id, map_position: r.map_position,
          attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0),
          stars_earned: Number(r.stars_earned ?? 0), destruction_percentage: Number(r.destruction_percentage ?? 0)
        })),
        event
      };
    }

    if (plan.operation === 'statistics') {
      const stats = currentWarStatistics(members, live);
      return {
        intent: 'structured_query', scope: 'war', query: 'statistics', result_count: 1,
        result: [stats],
        event
      };
    }

    if (plan.operation === 'member_attack_usage') {
      const result = deterministicWarMembers(question, members);
      if (!result) return null;
      return {
        ...attackUsageResult(result.plan, members),
        event
      };
    }
  }

  if (plan.scope === 'cwl') {
    const day = await getLatestCwlDay();
    if (!day) return { intent: 'structured_query', scope: 'cwl', query: plan.operation, result_count: 0, result: [], note: 'No CWL data has been synced yet.' };
    const members = await getCwlParticipants({ dayUid: day.day_uid, limit: 200 });
    const event = {
      dataset: 'cwl',
      cwl_day: day.battle_day,
      day_uid: day.day_uid,
      opponent: day.opponent_clan_name ?? null,
      start_time: day.start_time,
      end_time: day.end_time
    };
    if (plan.operation === 'member_attack_usage') {
      return { ...attackUsageResult(plan, members), event };
    }
    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'cwl', query: 'members', result_count: members.length,
        result: members.map(r => ({
          name: r.player_name, tag: r.player_id, map_position: r.map_position,
          attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0),
          stars_earned: Number(r.stars_earned ?? 0), destruction_percentage: Number(r.destruction_percentage ?? 0)
        })),
        event
      };
    }
    if (plan.operation === 'statistics') {
      return {
        intent: 'structured_query', scope: 'cwl', query: 'statistics', result_count: 1,
        result: [currentWarStatistics(members, null)],
        event
      };
    }
    if (plan.operation === 'state' || plan.operation === 'timing') {
      return {
        intent: 'structured_query', scope: 'cwl', query: plan.operation, result_count: 1,
        result: [{ state: 'synced', start_time: day.start_time, end_time: day.end_time }],
        event
      };
    }
    if (plan.operation === 'opponent') {
      return {
        intent: 'structured_query', scope: 'cwl', query: 'opponent', result_count: day.opponent_clan_name ? 1 : 0,
        result: [{ name: day.opponent_clan_name, tag: day.opponent_clan_id }],
        event
      };
    }
  }

  if (plan.scope === 'capital') {
    const liveCapital = await getLiveCapital();
    const season = await getLatestCapitalSeason();
    if (!season) return { intent: 'structured_query', scope: 'capital', query: plan.operation, result_count: 0, result: [], note: 'No capital raid data has been synced yet.' };
    // Participants are scoped to a single raid weekend; without this filter
    // every synced weekend is mixed together and players appear duplicated.
    const members = await getCapitalParticipants({ seasonKey: season.season_key, limit: 200 });
    const event = {
      dataset: 'capital',
      season_key: season.season_key,
      state: liveCapital?.state ?? season.state,
      start_time: liveCapital?.start_time ?? season.start_time,
      end_time: liveCapital?.end_time ?? season.end_time,
      time_left_ms: liveCapital?.time_left_ms ?? null,
      raids_completed: liveCapital?.raids_completed ?? season.raids_completed ?? null,
      total_attacks: liveCapital?.total_attacks ?? season.total_attacks ?? null,
      total_loot: liveCapital?.capital_total_loot ?? season.total_loot ?? null
    };
    if (plan.operation === 'member_attack_usage') {
      // The CoC API only lists capital members who already attacked, so
      // participant rows can never answer "who has not attacked". That
      // answer comes from the season's absentees: the clan roster when the
      // weekend began, minus everyone who has attacked.
      if (plan.unused) {
        return {
          intent: 'structured_clan_query',
          scope: 'capital',
          query: 'attack_usage',
          filter: { unused: true, attacks_used: null, attacks_used_min: null, attacks_remaining: null },
          result_count: (season.absentees ?? []).length,
          result: (season.absentees ?? []).map(name => ({ name, attacks_used: 0, attacks_available: 0, attacks_remaining: 0 })),
          event,
          note: 'Members of the roster when the raid weekend began who have not used any attacks in this weekend.'
        };
      }
      return { ...attackUsageResult(plan, members), event };
    }
    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'capital', query: 'members', result_count: members.length,
        result: members.map(r => ({
          name: r.player_name, tag: r.player_id,
          attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0),
          total_loot: Number(r.total_loot ?? 0)
        })),
        event
      };
    }
    if (plan.operation === 'statistics') {
      return {
        intent: 'structured_query', scope: 'capital', query: 'statistics', result_count: 1,
        result: [{
          participants: members.length,
          attacks_used: members.reduce((sum, r) => sum + Number(r.attacks_used ?? 0), 0),
          attacks_available: members.reduce((sum, r) => sum + Number(r.attacks_available ?? 0), 0),
          total_loot: event.total_loot,
          raids_completed: event.raids_completed
        }],
        event
      };
    }
    if (plan.operation === 'state' || plan.operation === 'timing') {
      return {
        intent: 'structured_query', scope: 'capital', query: plan.operation, result_count: 1,
        result: [{ state: event.state, start_time: event.start_time, end_time: event.end_time, time_left_ms: event.time_left_ms }],
        event
      };
    }
  }

  return null;
}
