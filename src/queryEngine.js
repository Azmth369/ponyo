const WORD_NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5 };

function normalize(text = '') {
  return String(text).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

function numberFrom(text) {
  const digit = text.match(/\b([0-5])\b/);
  if (digit) return Number(digit[1]);
  return WORD_NUMBERS[text.toLowerCase()] ?? null;
}

export function understandQuestion(question = '') {
  const q = normalize(question);
  const scope = /\b(?:cwl|clan war league|league day)\b/.test(q) ? 'cwl'
    : /\b(?:capital raid|capital raids|raid weekend|capital)\b/.test(q) ? 'capital'
    : /\b(?:war|wars|clan war|current war|cw)\b/.test(q) ? 'war'
    : /\b(?:member|members|player|players|clan|donation|donations|trophies|town hall|role|elder|leader|co-leader)\b/.test(q) ? 'clan'
    : 'general';

  const unused = /\b(?:unused|un-used|no|zero) attacks?\b/.test(q)
    || /\b(?:hasn['’]?t|haven['’]?t|didn['’]?t|didnt) (?:use|used|make|made|do|done|attack|attacked)/.test(q)
    || /\b(?:yet to|without) (?:use|make|do) (?:any )?attacks?\b/.test(q);
  const usedMatch = q.match(/\b(?:used|made|did|performed|completed)\s+([0-5]|zero|one|two|three|four|five)\s+attacks?\b/) || q.match(/\b([0-5]|zero|one|two|three|four|five)\s+attacks?\b/);
  const used = usedMatch ? numberFrom(usedMatch[1]) : null;
  const remaining = /\b(?:one|1)\s+(?:attack|attacks?)\s+(?:left|remaining)\b/.test(q);
  const asksLowest = /\b(?:lowest|least|minimum|min)\b/.test(q);
  const asksHighest = /\b(?:highest|most|maximum|max|top)\b/.test(q);
  const donation = /\bdonat(?:ion|ions|ed|e)?\b/.test(q);
  const trophies = /\btroph(?:y|ies)\b/.test(q);
  const role = /\b(elder|elders|leader|leaders|co-?leader|co-?leaders|member|members)\b/.exec(q)?.[1] ?? null;
  const count = /\b(?:how many|count|number of)\b/.test(q);

  let intent = 'general';
  if ((scope === 'war' || scope === 'cwl' || scope === 'capital') && (unused || remaining || used !== null)) intent = 'war_attack_usage';
  else if (donation && (asksLowest || asksHighest || count)) intent = 'donation_query';
  else if (trophies && (asksLowest || asksHighest || count)) intent = 'trophy_query';
  else if (role) intent = 'role_query';

  return {
    scope,
    intent,
    attacks_used: used,
    attacks_remaining: remaining ? 1 : null,
    unused,
    sort: asksLowest ? 'asc' : asksHighest ? 'desc' : null,
    metric: donation ? 'troops_donated' : trophies ? 'trophies' : null,
    role: role ? role.replace(/-/g, '').replace(/^coleader$/, 'coLeader') : null,
    asks_count: count,
    normalized: q
  };
}

export function deterministicWarMembers(question, members = []) {
  const plan = understandQuestion(question);
  if (plan.intent !== 'war_attack_usage') return null;
  let rows = [...members];
  if (plan.unused) rows = rows.filter(r => Number(r.attacks_used ?? 0) === 0);
  if (plan.attacks_used !== null) rows = rows.filter(r => Number(r.attacks_used ?? 0) === plan.attacks_used);
  if (plan.attacks_remaining !== null) rows = rows.filter(r => Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0) === plan.attacks_remaining);
  rows.sort((a, b) => Number(a.map_position ?? 99999) - Number(b.map_position ?? 99999) || String(a.player_name ?? '').localeCompare(String(b.player_name ?? '')));
  return { plan, rows, remaining: rows.map(r => ({ name: r.player_name, attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0), attacks_remaining: Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0), map_position: r.map_position })) };
}

export function deterministicMemberMetric(question, players = []) {
  const plan = understandQuestion(question);
  if (!['donation_query', 'trophy_query'].includes(plan.intent)) return null;
  const field = plan.metric;
  const rows = [...players].sort((a, b) => (Number(a[field] ?? 0) - Number(b[field] ?? 0)) * (plan.sort === 'desc' ? -1 : 1));
  return { plan, rows };
}

export function deterministicRole(question, players = []) {
  const plan = understandQuestion(question);
  if (plan.intent !== 'role_query') return null;
  const target = String(plan.role ?? '').toLowerCase();
  const rows = players.filter(p => String(p.role ?? '').toLowerCase().replace(/[-_\s]/g, '') === target);
  return { plan, rows };
}

export function executeIntent(question, { players = [], currentWarMembers = [] } = {}) {
  const plan = understandQuestion(question);
  if (plan.intent === 'war_attack_usage' && plan.scope === 'war') {
    const result = deterministicWarMembers(question, currentWarMembers);
    return result ? {
      intent: 'structured_clan_query',
      scope: plan.scope,
      query: 'attack_usage',
      filter: { unused: plan.unused, attacks_used: plan.attacks_used, attacks_remaining: plan.attacks_remaining },
      result_count: result.rows.length,
      result: result.remaining
    } : null;
  }
  if (plan.intent === 'donation_query' || plan.intent === 'trophy_query') {
    const result = deterministicMemberMetric(question, players);
    if (!result) return null;
    return {
      intent: 'structured_clan_query',
      scope: 'clan',
      query: plan.metric,
      sort: plan.sort,
      result_count: result.rows.length,
      result: result.rows.map(p => ({ name: p.name, tag: p.tag, value: Number(p[plan.metric] ?? 0) }))
    };
  }
  if (plan.intent === 'role_query') {
    const result = deterministicRole(question, players);
    if (!result) return null;
    return {
      intent: 'structured_clan_query',
      scope: 'clan',
      query: 'role',
      role: plan.role,
      result_count: result.rows.length,
      result: result.rows.map(p => ({ name: p.name, tag: p.tag }))
    };
  }
  return null;
}
