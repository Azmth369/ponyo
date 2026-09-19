// Deterministic question understanding: turn a natural-language question into
// a structured query plan, then filter member rows against that plan in code.
// The plan is pure (no database access) so it can be unit-tested.

const WORD_NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, twice: 2, thrice: 3 };
const NUMBER_WORD = 'zero|one|two|three|four|five|twice|thrice|[0-5]';

function normalize(text = '') {
  return String(text).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

function numberFrom(text) {
  if (text == null) return null;
  const raw = String(text).toLowerCase();
  if (/^\d$/.test(raw)) return Number(raw);
  return WORD_NUMBERS[raw] ?? null;
}

function detectScope(q) {
  if (/\b(?:cwl|clan war league|league day)\b/.test(q)) return 'cwl';
  if (/\b(?:capital raid|capital raids|raid weekend|capital)\b/.test(q)) return 'capital';
  if (/\b(?:current war|clan war|clan wars|war|wars|fighting|opponent|enemy clan|versus|vs\.?|against|attack|attacked|attacks)\b/.test(q)) return 'war';
  if (/\b(?:member|members|player|players|clan|donation|donations|trophies|town hall|role|elder|elders|leader|leaders|co-?leaders?)\b/.test(q)) return 'clan';
  return 'general';
}

function buildFilters(q) {
  // Negation phrasings that mean "used no attacks": contraction forms
  // ("hasn't used"), explicit forms ("has not attacked"), and misc forms.
  const unused =
    /\b(?:unused|un-used|no|zero) attacks?\b/.test(q) ||
    /\b(?:hasn'?t|haven'?t|didn'?t|didnt|has not|have not|did not|not)\s+(?:use|used|make|made|do|done|attack|attacked)\b/.test(q) ||
    /\b(?:yet to|without)\s+(?:use|make|do)\s+(?:any\s+)?attacks?\b/.test(q);

  // "one attack left/remaining" must be captured with a group, and it must be
  // resolved BEFORE the "used" patterns so "one attack left" is not misread
  // as "used one attack".
  const remainingMatch = q.match(new RegExp(`\\b(${NUMBER_WORD})\\s+attacks?\\s+(?:left|remaining)\\b`));
  const remaining = remainingMatch ? numberFrom(remainingMatch[1]) : null;

  const usedMatch = remaining !== null ? null : (
    q.match(new RegExp(`\\b(?:used|made|did|performed|completed)\\s+(${NUMBER_WORD})\\s+attacks?\\b`)) ||
    q.match(new RegExp(`\\b(?:attacked?|used|made|did)\\s+(${NUMBER_WORD})\\s+times?\\b`)) ||
    q.match(/\b(?:attacked?|used|made|did)\s+(twice|thrice)\b/) ||
    q.match(new RegExp(`\\b(${NUMBER_WORD})\\s+attacks?\\b`))
  );
  const used = usedMatch ? numberFrom(usedMatch[1]) : null;

  const asksLowest = /\b(?:lowest|least|minimum|min)\b/.test(q);
  const asksHighest = /\b(?:highest|most|maximum|max|top)\b/.test(q);
  const donation = /\bdonat(?:ion|ions|ed|e)?\b/.test(q);
  const trophies = /\btroph(?:y|ies)\b/.test(q);
  const roleMatch = /\b(elder|elders|leader|leaders|co-?leader|co-?leaders)\b/.exec(q)?.[1] ?? null;
  // "member(s)" only counts as a role when the question explicitly says "role",
  // so "how many members are in the clan" is a member-count question instead.
  const memberRole = /\brole\b/.test(q) ? 'member' : null;
  // clan_info stores raw CoC API role values: leader, coLeader, admin, member.
  const RAW_ROLE = { elder: 'admin', leader: 'leader', coleader: 'coLeader', member: 'member' };
  const singular = value => String(value ?? '').replace(/-/g, '').replace(/s$/, '');
  const role = roleMatch
    ? (RAW_ROLE[singular(roleMatch)] ?? singular(roleMatch))
    : memberRole;
  const count = /\b(?:how many|count|number of)\b/.test(q);

  return {
    unused,
    attacks_used: used,
    attacks_remaining: remaining,
    sort: asksLowest ? 'asc' : asksHighest ? 'desc' : null,
    metric: donation ? 'troops_donated' : trophies ? 'trophies' : null,
    role: role ? role.replace(/-/g, '').replace(/^coleader$/, 'coLeader') : null,
    asks_count: count
  };
}

export function buildQueryPlan(question = '') {
  const q = normalize(question);
  const scope = detectScope(q);
  const filters = buildFilters(q);

  const asksClanIdentity = /\b(?:what(?:'s| is)\s+(?:my|our)\s+clan(?:'s)?\s+(?:name|tag|id)|(?:my|our)\s+clan\s+(?:name|tag|id)|clan\s+(?:name|tag|id)|what\s+clan\s+am\s+i\s+in)\b/.test(q);
  const asksOpponent = /\b(?:opponent|enemy(?: clan)?|fighting|facing|against|versus|vs\.?)\b/.test(q) ||
    /\b(?:at|in)\s+(?:a\s+)?(?:clan\s+)?war\s+with\b/.test(q) ||
    /\b(?:war|wars)\s+with\s+(?:which|what|who|the)\b/.test(q) ||
    (/\bwhich\s+(?:clan|team)\b/.test(q) && /\b(?:war|fighting|battle)\b/.test(q));
  const identityField = /\b(?:tag|id)\b/.test(q) ? 'tag' : 'name';

  let operation = 'general';
  if (asksClanIdentity) operation = 'clan_identity';
  else if (scope === 'war' || scope === 'cwl' || scope === 'capital') {
    if (filters.unused || filters.attacks_used !== null || filters.attacks_remaining !== null) operation = 'member_attack_usage';
    else if (asksOpponent) operation = 'opponent';
    else if (/\b(?:state|status|phase)\b/.test(q)) operation = 'state';
    else if (/\b(?:when|date|time|start|started|end|ends|ended|duration|how long)\b/.test(q)) operation = 'timing';
    else if (/\b(?:star|stars|destruction|score|percentage|percent|result)\b/.test(q)) operation = 'statistics';
    else if (/\b(?:member|members|player|players|team|lineup|participants?)\b/.test(q)) operation = 'members';
  } else if (scope === 'clan') {
    if (filters.metric && (filters.sort || filters.asks_count)) operation = 'member_metric';
    else if (filters.role) operation = 'role_members';
    else if (/\b(?:member|members|player|players|how many)\b/.test(q)) operation = 'members';
  }

  const intent = operation === 'member_attack_usage' ? 'war_attack_usage'
    : operation === 'member_metric' ? `${filters.metric}_query`
    : operation === 'role_members' ? 'role_query'
    : 'general';

  return { scope, operation, intent, identity_field: identityField, ...filters, normalized: q };
}

export function understandQuestion(question = '') {
  return buildQueryPlan(question);
}

// Shared attack-usage filtering used by both the pure intent executor and the
// database-backed query router, so their results can never diverge.
export function applyAttackUsageFilters(rows, plan) {
  let filtered = [...(rows ?? [])];
  if (plan.unused) filtered = filtered.filter(r => Number(r.attacks_used ?? 0) === 0);
  if (plan.attacks_used !== null && plan.attacks_used !== undefined) {
    filtered = filtered.filter(r => Number(r.attacks_used ?? 0) === plan.attacks_used);
  }
  if (plan.attacks_remaining !== null && plan.attacks_remaining !== undefined) {
    filtered = filtered.filter(r => Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0) === plan.attacks_remaining);
  }
  filtered.sort((a, b) =>
    Number(a.map_position ?? 99999) - Number(b.map_position ?? 99999) ||
    String(a.player_name ?? '').localeCompare(String(b.player_name ?? '')));
  return filtered;
}

function toUsageRow(r) {
  return {
    name: r.player_name,
    tag: r.player_id,
    map_position: r.map_position,
    attacks_used: Number(r.attacks_used ?? 0),
    attacks_available: Number(r.attacks_available ?? 0),
    attacks_remaining: Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0),
    stars_earned: Number(r.stars_earned ?? 0),
    destruction_percentage: Number(r.destruction_percentage ?? 0)
  };
}

export function deterministicWarMembers(question, members = []) {
  const plan = buildQueryPlan(question);
  if (plan.operation !== 'member_attack_usage') return null;
  const rows = applyAttackUsageFilters(members, plan);
  return { plan, rows, remaining: rows.map(toUsageRow) };
}

export function deterministicMemberMetric(question, players = []) {
  const plan = buildQueryPlan(question);
  if (plan.operation !== 'member_metric') return null;
  const field = plan.metric;
  const rows = [...players].sort((a, b) =>
    (Number(a[field] ?? 0) - Number(b[field] ?? 0)) * (plan.sort === 'desc' ? -1 : 1));
  return { plan, rows };
}

export function deterministicRole(question, players = []) {
  const plan = buildQueryPlan(question);
  if (plan.operation !== 'role_members') return null;
  const target = String(plan.role ?? '').toLowerCase();
  const rows = players.filter(p => String(p.role ?? '').toLowerCase().replace(/[-_\s]/g, '') === target);
  return { plan, rows };
}

// Pure intent executor used to embed an authoritative structured result in the
// AI context (ai.js). The database-backed variant lives in queryRouter.js.
export function executeIntent(question, { players = [], currentWarMembers = [] } = {}) {
  const plan = buildQueryPlan(question);
  if (plan.operation === 'member_attack_usage') {
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
  if (plan.operation === 'member_metric') {
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
  if (plan.operation === 'role_members') {
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
