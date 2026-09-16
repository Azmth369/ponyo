function parseCoCTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z?/);
  if (!match) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
}

function getStart(row) {
  return parseCoCTimestamp(row?.data?.startTime) || parseCoCTimestamp(row?.season_key) || parseCoCTimestamp(row?.war_key);
}

function getEnd(row) {
  return parseCoCTimestamp(row?.data?.endTime) || parseCoCTimestamp(row?.end_time);
}

function periodKey(date) {
  return date ? date.toISOString() : null;
}

function formatDate(date) {
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function formatRange(start, end) {
  const a = formatDate(start);
  const b = formatDate(end);
  if (!a) return 'Unknown period';
  return b ? `${a} – ${b}` : a;
}

function formatWarPeriod(start, end) {
  if (start && end) return formatRange(start, end);
  if (end) return `Ended ${formatDate(end)}`;
  if (start) return `Started ${formatDate(start)}`;
  return 'Unknown period';
}

function normalizeResult(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'win') return 'win';
  if (raw === 'lose' || raw === 'loss') return 'loss';
  if (raw === 'tie' || raw === 'draw') return 'tie';
  return raw || null;
}

function getWarEndFromKey(warKey) {
  const match = String(warKey ?? '').match(/:(\d{8}T\d{6}(?:\.\d+)?Z?)$/);
  return match ? parseCoCTimestamp(match[1]) : null;
}

function getWarResult(data, clan) {
  return normalizeResult(data?.result ?? clan?.result ?? data?.clanResult);
}

export function groupCapitalAttacksByRaidPeriod(seasons = [], attacks = []) {
  const periods = new Map();
  for (const season of seasons) {
    const start = getStart(season);
    const key = periodKey(start) || `season:${season.season_key}`;
    const existing = periods.get(key);
    const data = season.data ?? {};
    const candidate = {
      period_key: key, start_time: start?.toISOString() ?? null, end_time: getEnd(season)?.toISOString() ?? null,
      label: formatRange(start, getEnd(season)), season_keys: [season.season_key], attack_count: 0,
      attack_data_available: false, capital_total_loot: Number(data.capitalTotalLoot ?? 0),
      raids_completed: Number(data.raidsCompleted ?? 0), total_attacks_reported_by_api: Number(data.totalAttacks ?? 0),
      source_seasons: [data.source ?? 'api']
    };
    if (!existing) periods.set(key, candidate);
    else {
      existing.season_keys.push(season.season_key);
      if (!existing.end_time && candidate.end_time) existing.end_time = candidate.end_time;
      if (!existing.capital_total_loot && candidate.capital_total_loot) existing.capital_total_loot = candidate.capital_total_loot;
      if (!existing.raids_completed && candidate.raids_completed) existing.raids_completed = candidate.raids_completed;
      if (!existing.total_attacks_reported_by_api && candidate.total_attacks_reported_by_api) existing.total_attacks_reported_by_api = candidate.total_attacks_reported_by_api;
      existing.source_seasons.push(...candidate.source_seasons);
    }
  }
  const attackCounts = new Map();
  for (const attack of attacks) {
    const key = String(attack.season_key || '');
    let matched = null;
    const timestampMatch = key.match(/(\d{8}T\d{6}(?:\.\d+)?Z?)/);
    if (timestampMatch) matched = periodKey(parseCoCTimestamp(timestampMatch[1]));
    if (!matched && periods.has(key)) matched = key;
    if (!matched) {
      const observed = parseCoCTimestamp(attack.observed_at);
      if (observed) for (const [candidateKey, period] of periods) {
        const start = parseCoCTimestamp(period.start_time); const end = parseCoCTimestamp(period.end_time);
        if (start && end && observed >= start && observed <= end) { matched = candidateKey; break; }
      }
    }
    if (matched) attackCounts.set(matched, (attackCounts.get(matched) || 0) + 1);
  }
  for (const period of periods.values()) {
    period.attack_count = attackCounts.get(period.period_key) || 0;
    period.attack_data_available = period.attack_count > 0;
    period.label = formatRange(parseCoCTimestamp(period.start_time), parseCoCTimestamp(period.end_time));
    period.source_seasons = [...new Set(period.source_seasons)];
    period.season_keys = [...new Set(period.season_keys)];
  }
  return [...periods.values()].sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
}

export function compactCapitalRaidContext(seasons = [], attacks = []) {
  const periods = groupCapitalAttacksByRaidPeriod(seasons, attacks);
  return {
    event_type: 'capital_raid',
    periods,
    totals: { raid_periods: periods.length, periods_with_attack_data: periods.filter(p => p.attack_data_available).length, attack_rows_available: periods.reduce((sum, p) => sum + p.attack_count, 0) },
    note: 'Capital Raid is its own event dataset. A raid period can exist in capital_raids without individual attack rows. Only periods with attack_data_available=true contain captured individual attacks. Legacy imports sharing the same real-world start time are merged into that raid period.'
  };
}

export function compactWarAttackContext(wars = [], attacks = []) {
  const byWar = new Map();
  const warEndKeys = new Map();

  for (const war of wars) {
    const data = war.data ?? {};
    const clan = data.clan ?? {};
    const opponent = data.opponent ?? {};
    const start = parseCoCTimestamp(war.start_time) || parseCoCTimestamp(data.startTime);
    const end = parseCoCTimestamp(war.end_time) || parseCoCTimestamp(data.endTime);
    const result = getWarResult(data, clan);
    const row = {
      event_type: 'clan_war',
      war_key: war.war_key,
      label: formatWarPeriod(start, end),
      start_time: start?.toISOString() ?? war.start_time ?? null,
      end_time: end?.toISOString() ?? war.end_time ?? null,
      state: war.state,
      result,
      opponent: opponent.name ?? data.opponentName ?? data.opponentClanName ?? data.defenderName ?? null,
      opponent_tag: opponent.tag ?? null,
      team_size: data.teamSize ?? null,
      attacks_per_member: data.attacksPerMember ?? null,
      clan_attacks: clan.attacks ?? null,
      clan_stars: clan.stars ?? null,
      clan_destruction_percentage: clan.destructionPercentage ?? null,
      opponent_attacks: opponent.attacks ?? null,
      opponent_stars: opponent.stars ?? null,
      opponent_destruction_percentage: opponent.destructionPercentage ?? null,
      attack_count: 0,
      attack_data_available: false
    };
    byWar.set(war.war_key, row);
    if (end) warEndKeys.set(end.toISOString(), war.war_key);
  }

  for (const attack of attacks) {
    const directKey = attack.war_key || attack.data?.war_key;
    let war = directKey ? byWar.get(directKey) : null;
    if (!war) {
      const end = getWarEndFromKey(directKey);
      const fallbackKey = end ? warEndKeys.get(end.toISOString()) : null;
      war = fallbackKey ? byWar.get(fallbackKey) : null;
    }
    if (war) war.attack_count += 1;
  }

  const grouped = [...byWar.values()];
  for (const row of grouped) row.attack_data_available = row.attack_count > 0;

  return {
    event_type: 'clan_war',
    wars: grouped.sort((a, b) => String(a.start_time || a.end_time || '').localeCompare(String(b.start_time || b.end_time || ''))),
    totals: {
      wars: grouped.length,
      wars_with_attack_data: grouped.filter(w => w.attack_data_available).length,
      attack_rows_available: grouped.reduce((sum, w) => sum + w.attack_count, 0),
      wars_without_attack_data: grouped.filter(w => !w.attack_data_available).length
    },
    note: 'This context contains NORMAL CLAN WAR records only, not CWL and not Capital Raid. A warlog entry can exist without individual attack rows. Individual attack data is only available when the currentwar response was captured while the war was active or ended. Missing historical attack rows are reported as unavailable rather than invented.'
  };
}

export function compactCwlAttackContext(seasons = [], wars = [], attacks = []) {
  const attacksByWar = new Map();
  const attackRoundByWar = new Map();
  for (const attack of attacks) {
    const key = String(attack.war_tag ?? '');
    if (!key) continue;
    attacksByWar.set(key, (attacksByWar.get(key) || 0) + 1);
    if (attack.round_no != null && !attackRoundByWar.has(key)) attackRoundByWar.set(key, Number(attack.round_no));
  }

  // The CWL group response already contains the ordered daily rounds and their
  // warTags. Use that as the primary round mapping because cwl_wars itself does
  // not require a round_no column. Attack rows are a secondary fallback.
  const roundByWar = new Map();
  const seasonRoundCounts = new Map();
  for (const season of seasons) {
    const rounds = season.data?.rounds ?? [];
    seasonRoundCounts.set(season.season_key, rounds.length);
    rounds.forEach((round, index) => {
      const roundNo = Number(round.roundNo ?? round.round_no ?? index + 1) || index + 1;
      for (const warTag of round.warTags ?? []) {
        if (warTag && warTag !== '#0') roundByWar.set(String(warTag), roundNo);
      }
    });
  }

  const warRows = wars.map(war => {
    const data = war.data ?? {};
    const clan = data.clan ?? {};
    const opponent = data.opponent ?? {};
    const start = parseCoCTimestamp(data.startTime) || parseCoCTimestamp(data.start_time);
    const end = parseCoCTimestamp(data.endTime) || parseCoCTimestamp(data.end_time);
    const warTag = String(war.war_tag ?? '');
    const attackCount = attacksByWar.get(warTag) || 0;
    const roundNo = Number(data.roundNo ?? data.round_no ?? roundByWar.get(warTag) ?? attackRoundByWar.get(warTag) ?? 0) || null;
    return {
      event_type: 'cwl',
      season_key: war.season_key,
      round_no: roundNo,
      war_tag: war.war_tag,
      label: formatWarPeriod(start, end),
      start_time: start?.toISOString() ?? null,
      end_time: end?.toISOString() ?? null,
      state: war.state ?? data.state ?? null,
      result: getWarResult(data, clan),
      opponent_clan_tag: war.opponent_clan_tag ?? opponent.tag ?? null,
      opponent_name: war.opponent_name ?? opponent.name ?? null,
      team_size: data.teamSize ?? null,
      attacks_per_member: data.attacksPerMember ?? null,
      clan_attacks: clan.attacks ?? null,
      clan_stars: clan.stars ?? null,
      clan_destruction_percentage: clan.destructionPercentage ?? null,
      opponent_attacks: opponent.attacks ?? null,
      opponent_stars: opponent.stars ?? null,
      opponent_destruction_percentage: opponent.destructionPercentage ?? null,
      attack_count: attackCount,
      attack_data_available: attackCount > 0
    };
  });

  const seasonMap = new Map();
  for (const season of seasons) {
    const seasonKey = season.season_key;
    const data = season.data ?? {};
    seasonMap.set(seasonKey, {
      event_type: 'cwl',
      season_key: seasonKey,
      label: formatRange(parseCoCTimestamp(data.startTime), parseCoCTimestamp(data.endTime)),
      start_time: parseCoCTimestamp(data.startTime)?.toISOString() ?? null,
      end_time: parseCoCTimestamp(data.endTime)?.toISOString() ?? null,
      rounds: [],
      round_count: 0,
      attack_rows_available: 0,
      expected_round_count: seasonRoundCounts.get(seasonKey) || 0
    });
  }

  // Every CWL war belongs to one season and one numbered round/day. Keep that
  // hierarchy explicit so the model cannot treat the daily wars as one normal
  // Clan War.
  for (const war of warRows) {
    if (!seasonMap.has(war.season_key)) {
      seasonMap.set(war.season_key, {
        event_type: 'cwl', season_key: war.season_key, label: 'Unknown period', start_time: null, end_time: null,
        rounds: [], round_count: 0, attack_rows_available: 0, expected_round_count: 0
      });
    }
    const season = seasonMap.get(war.season_key);
    let round = season.rounds.find(r => r.round_no === war.round_no);
    if (!round) {
      round = {
        event_type: 'cwl_round',
        round_no: war.round_no,
        label: war.label,
        start_time: war.start_time,
        end_time: war.end_time,
        wars: [],
        war_count: 0,
        attack_rows_available: 0
      };
      season.rounds.push(round);
    }
    round.wars.push(war);
    round.war_count += 1;
    round.attack_rows_available += war.attack_count;
    season.attack_rows_available += war.attack_count;
  }

  const nestedSeasons = [...seasonMap.values()].map(season => {
    season.rounds.sort((a, b) => Number(a.round_no ?? 0) - Number(b.round_no ?? 0));
    season.round_count = season.rounds.length;
    const allWars = season.rounds.flatMap(round => round.wars);
    if (!season.start_time) {
      const starts = allWars.map(w => w.start_time).filter(Boolean).sort();
      season.start_time = starts[0] ?? null;
    }
    if (!season.end_time) {
      const ends = allWars.map(w => w.end_time).filter(Boolean).sort();
      season.end_time = ends.at(-1) ?? null;
    }
    if (season.start_time || season.end_time) season.label = formatRange(parseCoCTimestamp(season.start_time), parseCoCTimestamp(season.end_time));
    return season;
  });

  const sortedWars = [...warRows].sort((a, b) =>
    String(a.season_key || '').localeCompare(String(b.season_key || '')) ||
    Number(a.round_no ?? 0) - Number(b.round_no ?? 0) ||
    String(a.start_time || '').localeCompare(String(b.start_time || ''))
  );

  return {
    event_type: 'cwl',
    seasons: nestedSeasons,
    wars: sortedWars,
    totals: {
      seasons: nestedSeasons.length,
      rounds: nestedSeasons.reduce((sum, season) => sum + season.round_count, 0),
      expected_rounds: nestedSeasons.reduce((sum, season) => sum + season.expected_round_count, 0),
      wars: sortedWars.length,
      wars_with_attack_data: sortedWars.filter(w => w.attack_data_available).length,
      wars_without_attack_data: sortedWars.filter(w => !w.attack_data_available).length,
      attack_rows_available: sortedWars.reduce((sum, w) => sum + w.attack_count, 0)
    },
    note: 'CWL is a separate event type from normal Clan War. A CWL season contains separate daily rounds/wars; each round has its own opponent, result, score, destruction and attack records. The CWL group response warTags are used to map each war to its correct round/day, with attack round_no as a fallback. Never combine the rounds into one normal Clan War. Only wars with attack_data_available=true contain captured individual attack rows; missing attack rows are reported as unavailable rather than invented.'
  };
}
