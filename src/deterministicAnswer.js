import { runDeterministicQuery } from './queryRouter.js';

function metricLabel(metric) {
  if (metric === 'troops_donated') return 'troops donated';
  if (metric === 'trophies') return 'trophies';
  return metric;
}

function formatRows(rows, query) {
  if (!rows.length) return 'No matching records were found.';
  if (query === 'clan_identity') {
    const r = rows[0];
    return `${r.name ?? 'Unknown clan'} (${r.tag ?? 'unknown tag'}) — ${r.members ?? 0} members.`;
  }
  if (query === 'opponent') {
    const r = rows[0];
    return `You are currently at war with ${r.name ?? 'an unknown clan'}${r.tag ? ` (${r.tag})` : ''}.`;
  }
  if (query === 'state') return `The current war state is ${rows[0].state}.`;
  if (query === 'timing') {
    const r = rows[0];
    const start = r.start_time ?? 'unknown';
    const end = r.end_time ?? 'unknown';
    return `War start: ${start}\nWar end: ${end}\nState: ${r.state}.`;
  }
  if (query === 'members') return rows.map(r => `${r.name}${r.tag ? ` (${r.tag})` : ''} — ${r.attacks_used}/${r.attacks_available} attacks used`).join('\n');
  if (query === 'statistics') {
    const r = rows[0];
    return `Team size: ${r.team_size}\nAttacks used: ${r.attacks_used}/${r.attacks_available}\nAttacks remaining: ${r.attacks_remaining}\nStars earned: ${r.stars_earned}\nDestruction total: ${r.destruction_percentage_sum.toFixed(2)}%.`;
  }
  if (query === 'role') return rows.map(r => r.name).join('\n');
  if (query === 'attack_usage') return rows.map(r => `${r.name} — ${r.attacks_used}/${r.attacks_available} attacks used (${r.attacks_remaining} remaining)`).join('\n');
  return rows.map(r => `${r.name} — ${r.value} ${metricLabel(r.metric)}`).join('\n');
}

export async function answerDeterministically(question) {
  const result = await runDeterministicQuery(question);
  if (!result) return null;
  const lines = [];
  if (result.event?.opponent && result.query !== 'opponent') lines.push(`War vs ${result.event.opponent} (${result.event.state}).`);
  if (result.query === 'role') lines.push(`${result.role}: ${result.result_count} member${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query === 'attack_usage') lines.push(`${result.result_count} matching player${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query === 'members') lines.push(`${result.result_count} war member${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query && !['opponent', 'state', 'timing', 'statistics', 'clan_identity'].includes(result.query)) lines.push(`${result.result_count} matching result${result.result_count === 1 ? '' : 's'}.`);
  if (result.note) lines.push(result.note);
  const body = formatRows(result.result ?? [], result.query);
  return { text: `${lines.join('\n')}${lines.length ? '\n' : ''}${body}`.trim(), query: result };
}
