import {
  getPlayers,
  getCurrentWar,
  getWarMembers,
  getCwlParticipants,
  getCapitalParticipants
} from './retrieval.js';
import { getClan } from './cocApi.js';
import { understandQuestion, deterministicWarMembers, deterministicMemberMetric, deterministicRole } from './queryEngine.js';

const nameOnly = row => ({ name: row.player_name ?? row.name, tag: row.player_id ?? row.tag });

function metricRows(result) {
  return result.rows.map(p => ({ name: p.name, tag: p.tag, value: Number(p[result.plan.metric] ?? 0), metric: result.plan.metric }));
}

function roleRows(result) { return result.rows.map(nameOnly); }

function usageRows(rows, plan) {
  let filtered = [...rows];
  if (plan.unused) filtered = filtered.filter(r => Number(r.attacks_used ?? 0) === 0);
  if (plan.attacks_used !== null) filtered = filtered.filter(r => Number(r.attacks_used ?? 0) === plan.attacks_used);
  if (plan.attacks_remaining !== null) filtered = filtered.filter(r => Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0) === plan.attacks_remaining);
  filtered.sort((a, b) => Number(a.map_position ?? 99999) - Number(b.map_position ?? 99999) || String(a.player_name ?? '').localeCompare(String(b.player_name ?? '')));
  return filtered.map(r => ({ name: r.player_name, tag: r.player_id, map_position: r.map_position, attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0), attacks_remaining: Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0) }));
}

function attackUsagePlan(plan, rows) {
  const result = usageRows(rows, plan);
  return { intent: 'structured_clan_query', scope: plan.scope, query: 'attack_usage', filter: { unused: plan.unused, attacks_used: plan.attacks_used, attacks_remaining: plan.attacks_remaining }, result_count: result.length, result };
}

export async function runDeterministicQuery(question) {
  const plan = understandQuestion(question);

  if (plan.intent === 'current_war_opponent') {
    const current = await getCurrentWar();
    const opponent = current?.opponent_clan_name ?? null;
    return {
      intent: 'current_war_opponent',
      scope: 'war',
      query: 'current_war_opponent',
      result_count: opponent ? 1 : 0,
      result: opponent ? [{ name: opponent, tag: current.opponent_clan_id ?? null }] : [],
      event: current ? { war_key: current.war_key, state: current.state, start_time: current.start_time, end_time: current.end_time } : null,
      note: opponent ? null : 'No current normal clan war opponent is available.'
    };
  }

  if (plan.intent === 'clan_identity') {
    // Identity is authoritative from the same configured clan endpoint used by
    // the sync service. This avoids adding redundant clan_name/clan_id columns
    // to every member row and keeps Supabase schema unchanged.
    const clan = await getClan();
    return {
      intent: 'clan_identity',
      scope: 'clan',
      query: 'clan_identity',
      field: plan.identity_field,
      result_count: 1,
      result: [{ name: clan.name ?? null, tag: clan.tag ?? null, members: Number(clan.members ?? clan.memberList?.length ?? 0) }]
    };
  }

  if (plan.intent === 'donation_query' || plan.intent === 'trophy_query') {
    const players = await getPlayers({ limit: 100 });
    const normalized = players.map(p => ({ ...p, tag: p.player_id, name: p.name }));
    const result = deterministicMemberMetric(question, normalized);
    if (!result) return null;
    let rows = metricRows(result);
    if (!plan.asks_count && plan.sort) rows = rows.slice(0, 1);
    return { intent: 'structured_clan_query', scope: 'clan', query: plan.metric, sort: plan.sort, result_count: rows.length, result: rows };
  }

  if (plan.intent === 'role_query') {
    const players = await getPlayers({ limit: 100 });
    const result = deterministicRole(question, players);
    if (!result) return null;
    return { intent: 'structured_clan_query', scope: 'clan', query: 'role', role: plan.role, result_count: result.rows.length, result: roleRows(result) };
  }

  if (plan.intent === 'war_attack_usage') {
    if (plan.scope === 'war') {
      const current = await getCurrentWar();
      if (!current?.war_key) return { intent: 'structured_clan_query', scope: 'war', query: 'attack_usage', result_count: 0, result: [], note: 'No current normal clan war is available.' };
      const members = await getWarMembers(current.war_key, 100);
      const result = deterministicWarMembers(question, members);
      if (!result) return null;
      return { ...attackUsagePlan(result.plan, members), event: { war_key: current.war_key, opponent: current.opponent_clan_name, state: current.state, start_time: current.start_time, end_time: current.end_time } };
    }
    if (plan.scope === 'cwl') return attackUsagePlan(plan, await getCwlParticipants({ limit: 1000 }));
    if (plan.scope === 'capital') return attackUsagePlan(plan, await getCapitalParticipants({ limit: 1000 }));
  }

  return null;
}

export async function deterministicContext(question) {
  const result = await runDeterministicQuery(question);
  return result ? { deterministic: true, structured_query: result } : null;
}
