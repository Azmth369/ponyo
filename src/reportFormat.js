// Pure formatters for automatic Discord event reports. All dates are displayed in India Standard Time.
const istDate = value => {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
};
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const sorted = rows => [...(rows ?? [])].sort((a, b) => String(a.player_name ?? '').localeCompare(String(b.player_name ?? ''), undefined, { sensitivity: 'base' }));

export function buildWarReport(session, participants) {
  if (!session?.cw_uid || !session.battle_end || session.our_clan_score == null || session.opponent_clan_score == null) return null;
  if (!Array.isArray(participants) || !participants.length || Number(session.participants_size ?? 0) > participants.length) return null;
  const ownStars = num(session.our_clan_score), foeStars = num(session.opponent_clan_score);
  const ownDestruction = num(session.our_clan_destruction), foeDestruction = num(session.opponent_clan_destruction);
  let result, suffix = '';
  if (ownStars !== foeStars) result = ownStars > foeStars ? 'WIN' : 'LOSS';
  else if (ownDestruction !== foeDestruction) {
    result = ownDestruction > foeDestruction ? 'WIN' : 'LOSS';
    suffix = ` (decided by destruction: ${ownDestruction.toFixed(2)}% vs ${foeDestruction.toFixed(2)}%)`;
  } else result = 'DRAW';
  const lines = [
    '##Clan War',
    `Opponent Clan: ${session.opponent_clan_name ?? 'Unknown'}`,
    `Date of Battle: ${istDate(session.battle_start)}`,
    `Result: (${ownStars} : ${foeStars}) stars — ${result}${suffix}`,
    ''
  ];
  for (const [i, p] of sorted(participants).entries()) {
    const name = String(p.player_name ?? 'Unknown').replace(/[\r\n]/g, ' ').trim();
    lines.push(`${i + 1}. ${name} — ${num(p.attacks_used)} out of ${num(p.attacks_available ?? 2)}`);
  }
  return lines.join('\n');
}

export function buildCapitalRaidReport(season, participants, rosterSize = 44) {
  if (!season?.generated_uid || !season.battle_end || !Array.isArray(participants)) return null;
  const names = Array.isArray(season.participants_name) ? [...new Set(season.participants_name.filter(Boolean))] : [];
  const usedRows = participants.filter(p => num(p.attacks_used) > 0);
  const count = num(season.participants_no ?? names.length);
  if (count > usedRows.length || (names.length > 0 && names.length < count)) return null;
  const total = Math.max(1, num(rosterSize) || 44);
  const lines = [
    'Capital Raid',
    `Raid Weekend Date: ${istDate(season.battle_start)}`,
    `Participants no.: ${count}/${total} (${(count / total * 100).toFixed(2)}%)`,
    ''
  ];
  const byName = new Map(usedRows.map(p => [String(p.player_name ?? '').toLowerCase(), p]));
  const reportNames = names.length ? names : usedRows.map(p => p.player_name).filter(Boolean);
  reportNames.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  for (const [i, value] of reportNames.entries()) {
    const name = String(value).replace(/[\r\n]/g, ' ').trim();
    const p = byName.get(name.toLowerCase());
    if (!p) return null;
    lines.push(`${i + 1}. ${name} — ${num(p.attacks_used)}/${num(p.attacks_available ?? 6)} attacks`);
  }
  return lines.join('\n');
}
