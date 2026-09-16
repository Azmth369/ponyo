// Deterministic intent/query layer for clan-specific questions.
// The LLM presents these results; it does not decide the underlying filter/sort.

const numberWords = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5 };
const toNumber = value => numberWords[value] ?? Number(value);

function metric(question) {
  const q = question.toLowerCase();
  if (/donat/.test(q)) return 'troops_donated';
  if (/receiv/.test(q)) return 'troops_received';
  if (/troph/.test(q)) return 'trophies';
  if (/town hall|th\d+/.test(q)) return 'th';
  return null;
}

function attackCount(question) {
  const q = question.toLowerCase();
  const numeric = q.match(/\b([0-9]+)\s*(?:attack|attacks|times)\b/);
  if (numeric) return Number(numeric[1]);
  const word = q.match(/\b(one|two|three|four|five)\s*(?:attack|attacks|times)\b/);
  if (word) return toNumber(word[1]);
  const attacked = q.match(/\b(?:attacked|used|made|did)\s+(one|two|three|four|five|[0-9]+)\b/);
  if (attacked) return toNumber(attacked[1]);
  return null;
}

export function parseIntent(question) {
  const q = question.toLowerCase();
  const currentWar = /current war|this war|war right now|ongoing war|today.?s war/.test(q);
  const unused = /unused|haven.?t used|hasn.?t used|didn.?t use|not used|no attack|missed attack|left.*attack|attack.*left|remaining attack/.test(q);
  const count = attackCount(question);
  const rankingMetric = metric(question);
  const ascending = /lowest|least|fewest|minimum|min\b|smallest|bottom/.test(q);
  const descending = /highest|most|maximum|max\b|largest|top/.test(q);
  const role = /\b(elder|elders|co-?leader|co-?leaders|leader|leaders|member|members)\b/.exec(q)?.[1] ?? null;
  return {
    currentWar,
    unused,
    attacksUsed: count,
    rankingMetric,
    ranking: ascending || descending,
    direction: ascending ? 'asc' : 'desc',
    role,
    oneAttackLeft: /one.*attack.*left|left.*one.*attack|1.*attack.*left/.test(q),
    intent: unused || count !== null || rankingMetric || role ? 'structured_clan_query' : 'general'
  };
}

function roleMatches(role, requested) {
  if (!requested) return true;
  const raw = String(role ?? '').toLowerCase().replace(/[\s_-]/g, '');
  const want = requested.replace(/[\s_-]/g, '');
  if (want.startsWith('elder')) return raw === 'admin';
  if (want.startsWith('coleader')) return raw === 'coleader';
  return raw === want;
}

export function executeIntent(question, { players = [], currentWarMembers = [] } = {}) {
  const intent = parseIntent(question);
  const members = currentWarMembers.map(m => ({
    name: m.player_name,
    tag: m.player_tag,
    map_position: Number(m.map_position ?? 9999),
    attacks_used: Number(m.attacks_used ?? 0),
    attacks_available: Number(m.attacks_available ?? 0),
    attacks_remaining: Math.max(Number(m.attacks_available ?? 0) - Number(m.attacks_used ?? 0), 0),
    stars: Number(m.stars_earned ?? 0),
    destruction: Number(m.destruction_percentage ?? 0)
  }));

  let result = null;
  let source = null;

  if (intent.currentWar && intent.unused) {
    result = members.filter(m => m.attacks_remaining > 0).sort((a, b) => a.map_position - b.map_position);
    source = 'CW_SESSION_PARTICIPANTS';
  } else if (intent.currentWar && intent.oneAttackLeft) {
    result = members.filter(m => m.attacks_remaining === 1).sort((a, b) => a.map_position - b.map_position);
    source = 'CW_SESSION_PARTICIPANTS';
  } else if (intent.currentWar && intent.attacksUsed !== null) {
    result = members.filter(m => m.attacks_used === intent.attacksUsed).sort((a, b) => a.map_position - b.map_position);
    source = 'CW_SESSION_PARTICIPANTS';
  } else if (intent.rankingMetric) {
    const filtered = players.filter(p => roleMatches(p.role, intent.role));
    const field = intent.rankingMetric;
    result = filtered.map(p => ({ name: p.name, tag: p.tag, value: Number(p[field] ?? 0) })).sort((a, b) => intent.direction === 'asc' ? a.value - b.value || a.name.localeCompare(b.name) : b.value - a.value || a.name.localeCompare(b.name));
    source = 'CLAN_INFO';
  } else if (intent.role) {
    result = players.filter(p => roleMatches(p.role, intent.role)).map(p => ({ name: p.name, tag: p.tag, role: p.role }));
    source = 'CLAN_INFO';
  }

  return { ...intent, source, result_count: result?.length ?? 0, result };
}
