// Database-backed deterministic query router. Turns a query plan into real
// rows from the Ponyo schema and returns a structured result. Filtering is
// delegated to queryEngine.applyAttackUsageFilters so the pure intent executor
// and this router can never disagree.

import {
  getPlayers,
  getCurrentWar,
  getWarMembers,
  getCwlParticipants,
  getCapitalParticipants
} from './retrieval.js';
import { getClan } from './cocApi.js';
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
    filter: { unused: plan.unused, attacks_used: plan.attacks_used, attacks_remaining: plan.attacks_remaining },
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

function currentWarStatistics(members) {
  return {
    team_size: members.length,
    attacks_available: members.reduce((sum, r) => sum + Number(r.attacks_available ?? 0), 0),
    attacks_used: members.reduce((sum, r) => sum + Number(r.attacks_used ?? 0), 0),
    attacks_remaining: members.reduce((sum, r) => sum + Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0), 0),
    stars_earned: members.reduce((sum, r) => sum + Number(r.stars_earned ?? 0), 0),
    destruction_percentage_sum: members.reduce((sum, r) => sum + Number(r.destruction_percentage ?? 0), 0)
  };
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
    const current = await getCurrentWar();
    if (!current?.war_key) return { intent: 'structured_query', scope: 'war', query: plan.operation, result_count: 0, result: [], note: 'No current normal clan war is available.' };

    if (plan.operation === 'opponent') {
      const opponent = opponentFromCurrentWar(current);
      return {
        intent: 'structured_query', scope: 'war', query: 'opponent',
        result_count: opponent.name || opponent.tag ? 1 : 0,
        result: [opponent],
        event: { war_key: current.war_key, state: current.state }
      };
    }

    if (plan.operation === 'state') {
      return {
        intent: 'structured_query', scope: 'war', query: 'state', result_count: 1,
        result: [{ state: current.state }],
        event: { war_key: current.war_key, state: current.state }
      };
    }

    const members = await getWarMembers(current.war_key, 100);

    if (plan.operation === 'timing') {
      return {
        intent: 'structured_query', scope: 'war', query: 'timing', result_count: 1,
        result: [{ start_time: current.start_time, end_time: current.end_time, state: current.state }],
        event: { war_key: current.war_key, state: current.state }
      };
    }

    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'war', query: 'members', result_count: members.length,
        result: members.map(r => ({
          name: r.player_name, tag: r.player_tag, map_position: r.map_position,
          attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0),
          stars_earned: Number(r.stars_earned ?? 0), destruction_percentage: Number(r.destruction_percentage ?? 0)
        })),
        event: { war_key: current.war_key, opponent: current.opponent_clan_name, state: current.state }
      };
    }

    if (plan.operation === 'statistics') {
      return {
        intent: 'structured_query', scope: 'war', query: 'statistics', result_count: 1,
        result: [currentWarStatistics(members)],
        event: { war_key: current.war_key, opponent: current.opponent_clan_name, state: current.state }
      };
    }

    if (plan.operation === 'member_attack_usage') {
      const result = deterministicWarMembers(question, members);
      if (!result) return null;
      return {
        ...attackUsageResult(result.plan, members),
        event: {
          war_key: current.war_key,
          opponent: current.opponent_clan_name,
          state: current.state,
          start_time: current.start_time,
          end_time: current.end_time
        }
      };
    }
  }

  if (plan.scope === 'cwl' && plan.operation === 'member_attack_usage') {
    return attackUsageResult(plan, await getCwlParticipants({ limit: 1000 }));
  }
  if (plan.scope === 'capital' && plan.operation === 'member_attack_usage') {
    return attackUsageResult(plan, await getCapitalParticipants({ limit: 1000 }));
  }

  return null;
}
