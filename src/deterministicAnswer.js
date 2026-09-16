import { runDeterministicQuery } from './queryRouter.js';

function metricLabel(metric) {
  if (metric === 'troops_donated') return 'troops donated';
  if (metric === 'trophies') return 'trophies';
  return metric;
}

function formatRows(rows, query) {
  if (!rows.length) return 'No matching records were found.';
  if (query === 'role') return rows.map(r => r.name).join('\n');
  if (query === 'attack_usage') return rows.map(r => `${r.name} — ${r.attacks_used}/${r.attacks_available} attacks used (${r.attacks_remaining} remaining)`).join('\n');
  return rows.map(r => `${r.name} — ${r.value} ${metricLabel(r.metric)}`).join('\n');
}

export async function answerDeterministically(question) {
  const result = await runDeterministicQuery(question);
  if (!result) return null;
  const lines = [];
  if (result.event?.opponent) lines.push(`War vs ${result.event.opponent} (${result.event.state}).`);
  if (result.query === 'role') lines.push(`${result.role}: ${result.result_count} member${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query === 'attack_usage') lines.push(`${result.result_count} matching player${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query) lines.push(`${result.result_count} matching result${result.result_count === 1 ? '' : 's'}.`);
  if (result.note) lines.push(result.note);
  const body = formatRows(result.result ?? [], result.query);
  return { text: `${lines.join('\n')}${lines.length ? '\n' : ''}${body}`.trim(), query: result };
}
