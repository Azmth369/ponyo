const $ = selector => document.querySelector(selector);
let dashboard = null;
let toastTimer;
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function number(value) { return Number(value || 0).toLocaleString('en-US'); }
function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) + ' IST';
}
function shortDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function statusClass(value) {
  const normalized = String(value || '').toLowerCase();
  if (['ok', 'published', 'complete', 'completed', 'success', 'active'].includes(normalized)) return 'ok';
  if (['failed', 'error', 'stale', 'abandoned'].includes(normalized)) return 'bad';
  return 'warn';
}
function stateLabel(value) {
  return '<span class="state ' + statusClass(value) + '">● ' + escapeHtml(value || 'unknown') + '</span>';
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || 'Request failed'); error.status = response.status; throw error; }
  return body;
}
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}
function showLogin(message = '') {
  $('#app-view').classList.add('hidden'); $('#login-view').classList.remove('hidden'); $('#login-error').textContent = message;
}
function showApp(user) {
  $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
  $('#user-email').textContent = user.email || ''; $('#user-role').textContent = user.role === 'owner' ? 'Owner' : 'Clan admin';
}
function setSection(section) {
  document.querySelectorAll('.dashboard-section').forEach(node => node.classList.add('hidden'));
  const target = $('#section-' + section); if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach(node => node.classList.toggle('active', node.dataset.section === section));
  const titles = { overview: 'Overview', syncs: 'Sync health', reports: 'Discord reports', clan: 'Clan analytics', history: 'War & raid history' };
  $('#page-title').textContent = titles[section] || 'Overview';
}
function metric(label, value, sub) {
  return '<article class="metric-card"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(value) + '</div><div class="metric-sub">' + escapeHtml(sub || '') + '</div></article>';
}
function table(headers, rows, emptyMessage) {
  if (!rows || !rows.length) return '<div class="empty">' + escapeHtml(emptyMessage || 'No records available yet.') + '</div>';
  return '<table><thead><tr>' + headers.map(header => '<th>' + escapeHtml(header) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + row.map(cell => '<td>' + (cell == null ? '—' : String(cell)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
function unavailable(key) {
  const message = dashboard && dashboard.errors && dashboard.errors[key];
  return message ? '<div class="empty">Unavailable: ' + escapeHtml(message) + '</div>' : '';
}
function renderOperations() {
  const ops = dashboard.data.operations;
  const syncRuns = ops && ops.syncRuns || [];
  const reports = ops && ops.reports || [];
  const okCount = syncRuns.filter(run => String(run.status).toLowerCase() === 'ok').length;
  const failedCount = syncRuns.filter(run => ['failed', 'error'].includes(String(run.status).toLowerCase())).length;
  const publishedCount = reports.filter(report => report.state === 'published').length;
  const pendingCount = reports.filter(report => ['active', 'pending', 'publishing'].includes(String(report.state).toLowerCase())).length;
  const attentionCount = reports.filter(report => ['failed', 'error', 'abandoned'].includes(String(report.state).toLowerCase())).length;
  const clan = dashboard.data.clanSummary && dashboard.data.clanSummary.data;
  $('#overview-cards').innerHTML = [
    metric('Clan members', clan ? number(clan.members) : '—', clan ? clan.clanName : 'Live roster unavailable'),
    metric('Syncs successful', number(okCount), 'Of latest ' + number(syncRuns.length) + ' recorded runs'),
    metric('Recent sync errors', number(failedCount), failedCount ? 'Review sync health' : 'No failures in recent runs'),
    metric('Reports published', number(publishedCount), number(pendingCount) + ' active or waiting')
  ].join('');
  $('#health-summary').innerHTML = unavailable('operations') || (
    '<div class="status-line"><strong>Latest sync</strong><span>' + escapeHtml(syncRuns[0] ? syncRuns[0].job + ' · ' + date(syncRuns[0].finished_at || syncRuns[0].started_at) : 'No sync history yet') + '</span></div>' +
    '<div class="status-line"><strong>Latest result</strong><span>' + (syncRuns[0] ? stateLabel(syncRuns[0].status) : '—') + '</span></div>' +
    '<div class="status-line"><strong>Reports awaiting completion</strong><span>' + number(pendingCount) + '</span></div>' +
    '<div class="status-line"><strong>Reports needing attention</strong><span>' + number(attentionCount) + '</span></div>'
  );
  $('#sync-table').innerHTML = unavailable('operations') || table(
    ['Job', 'Status', 'Started (IST)', 'Finished (IST)', 'Message'],
    syncRuns.map(run => [escapeHtml(run.job), stateLabel(run.status), escapeHtml(date(run.started_at)), escapeHtml(date(run.finished_at)), escapeHtml(run.message || '—')]),
    'No sync runs have been recorded yet.'
  );
  $('#report-summary').innerHTML = [
    metric('Published', number(publishedCount), 'Recently tracked reports'),
    metric('Active / waiting', number(pendingCount), 'Not yet published'),
    metric('Needs attention', number(attentionCount), 'Failed or abandoned records')
  ].join('');
  $('#report-table').innerHTML = unavailable('operations') || table(
    ['Event', 'Type', 'State', 'Attempts', 'Expected end', 'Published at', 'Latest error'],
    reports.map(report => [escapeHtml(report.event_uid), escapeHtml(report.event_type), stateLabel(report.state), escapeHtml(number(report.attempts)), escapeHtml(date(report.expected_end)), escapeHtml(date(report.published_at)), escapeHtml(report.last_error || '—')]),
    'No report publications have been tracked yet.'
  );
}
function renderWar() {
  const payload = dashboard.data.currentWar; const war = payload && payload.data;
  if (!war) { $('#current-war').innerHTML = unavailable('currentWar') || '<p class="muted">No live war details available.</p>'; return; }
  $('#current-war').innerHTML =
    '<div class="status-line"><strong>State</strong><span>' + stateLabel(war.state || 'unknown') + '</span></div>' +
    '<div class="status-line"><strong>Opponent</strong><span>' + escapeHtml(war.opponent && war.opponent.name || '—') + '</span></div>' +
    '<div class="status-line"><strong>Score</strong><span>' + escapeHtml((war.clan && war.clan.stars != null ? war.clan.stars : '—') + ' : ' + (war.opponent && war.opponent.stars != null ? war.opponent.stars : '—')) + '</span></div>' +
    '<div class="status-line"><strong>Ends</strong><span>' + escapeHtml(date(war.endTime)) + '</span></div>';
}
function renderRaid() {
  const payload = dashboard.data.capitalHistory; const raid = payload && payload.data && payload.data[0];
  if (!raid) { $('#current-raid').innerHTML = unavailable('capitalHistory') || '<p class="muted">No stored Capital Raid weekend available.</p>'; return; }
  $('#current-raid').innerHTML =
    '<div class="status-line"><strong>Weekend</strong><span>' + escapeHtml(raid.generated_uid || 'Latest stored raid') + '</span></div>' +
    '<div class="status-line"><strong>Total loot</strong><span>' + escapeHtml(number(raid.total_loot)) + '</span></div>' +
    '<div class="status-line"><strong>Total attacks</strong><span>' + escapeHtml(number(raid.total_attacks)) + '</span></div>' +
    '<div class="status-line"><strong>Participants</strong><span>' + escapeHtml(number(raid.participants_no)) + '</span></div>' +
    '<div class="status-line"><strong>Weekend ended</strong><span>' + escapeHtml(date(raid.battle_end)) + '</span></div>';
}
function renderClan() {
  const payload = dashboard.data.clanSummary; const clan = payload && payload.data;
  if (!clan) { $('#clan-cards').innerHTML = unavailable('clanSummary'); return; }
  $('#clan-cards').innerHTML = [
    metric('Clan', clan.clanName || '—', clan.clanTag || 'Clan tag unavailable'),
    metric('Members', number(clan.members), 'Current live roster'),
    metric('Donations', number(clan.totalDonations), 'Current donation counter total'),
    metric('Average trophies', number(clan.averageTrophies), 'Current live roster')
  ].join('');
  const counts = Object.entries(clan.townHallCounts || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const max = Math.max(1, ...counts.map(item => Number(item[1])));
  $('#townhall-chart').innerHTML = counts.length ? counts.map(([level, count]) =>
    '<div class="bar-row"><span>TH ' + escapeHtml(level) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, Number(count) / max * 100) + '%"></div></div><span class="bar-count">' + escapeHtml(count) + '</span></div>'
  ).join('') : '<p class="muted">No Town Hall counts available.</p>';
  const activity = dashboard.data.activity;
  const upgrades = activity && activity.townHallUpgrades || [];
  const donors = activity && activity.donationLeaders || [];
  const contributors = activity && activity.capitalContributionLeaders || [];
  $('#activity-highlights').innerHTML = unavailable('activity') || (
    '<div class="status-line"><strong>Observed Town Hall upgrades</strong><span>' + number(upgrades.length) + '</span></div>' +
    '<div class="status-line"><strong>Members with donation increases</strong><span>' + number(donors.length) + '</span></div>' +
    '<div class="status-line"><strong>Capital contribution increases</strong><span>' + number(contributors.length) + '</span></div>' +
    '<p class="muted">Snapshot coverage: ' + escapeHtml(activity && activity.snapshotCoverage ? number(activity.snapshotCoverage.membersWithBaseline) + ' / ' + number(activity.snapshotCoverage.currentMembers) + ' members' : 'unknown') + ' have a baseline.</p>'
  );
  $('#donor-table').innerHTML = donors.length ? table(['Player', 'Donations added', 'Town Hall'],
    donors.slice(0, 10).map(player => [escapeHtml(player.name), escapeHtml(number(player.donationsInWindow)), escapeHtml(player.townHallLevel == null ? '—' : player.townHallLevel)]),
    'No donation increases found.') : '<div class="empty">No donation increases found, or a usable baseline is not available.</div>';
}
function renderHistory() {
  const wars = dashboard.data.warHistory;
  $('#war-history-table').innerHTML = unavailable('warHistory') || table(
    ['Opponent', 'Result', 'Our score', 'Opponent score', 'Started'],
    (wars && wars.data || []).map(war => [escapeHtml(war.opponent_clan_name), escapeHtml(war.result), escapeHtml(war.our_clan_score), escapeHtml(war.opponent_clan_score), escapeHtml(shortDate(war.battle_start))]),
    'No regular Clan War history available.'
  );
  const raids = dashboard.data.capitalHistory;
  $('#raid-history-table').innerHTML = unavailable('capitalHistory') || table(
    ['Weekend', 'Total loot', 'Attacks', 'Participants', 'Ended'],
    (raids && raids.data || []).map(raid => [escapeHtml(raid.generated_uid), escapeHtml(number(raid.total_loot)), escapeHtml(number(raid.total_attacks)), escapeHtml(number(raid.participants_no)), escapeHtml(shortDate(raid.battle_end))]),
    'No stored Capital Raid history available.'
  );
  const cwl = dashboard.data.cwlHistory; const seasons = cwl && cwl.data || [];
  $('#cwl-history').innerHTML = unavailable('cwlHistory') || (seasons.length ? seasons.map(season =>
    '<div class="status-line"><strong>' + escapeHtml(season.season || season.seasonId || 'CWL season') + '</strong><span>' + escapeHtml(date(season.battleStart)) + ' · ' + number((season.rounds || []).length) + ' rounds</span></div>'
  ).join('') : '<p class="muted">No verifiable CWL season is available in stored history.</p>');
}
function render() {
  if (!dashboard) return;
  $('#last-updated').textContent = 'Data checked ' + date(dashboard.generatedAt) + ' · Timestamps displayed in India Standard Time';
  const errors = Object.keys(dashboard.errors || {});
  $('#page-error').classList.toggle('hidden', errors.length === 0);
  $('#page-error').textContent = errors.length ? 'Some data sources could not be reached: ' + errors.join(', ') + '. Other panels may still be available.' : '';
  renderOperations(); renderWar(); renderRaid(); renderClan(); renderHistory();
}
async function loadDashboard() {
  $('#refresh-button').disabled = true; $('#refresh-button').textContent = 'Loading…';
  try { dashboard = await api('/api/dashboard'); render(); showToast('Dashboard refreshed'); }
  catch (error) { if (error.status === 401) return showLogin('Your session has expired. Please sign in again.'); $('#page-error').textContent = error.message; $('#page-error').classList.remove('hidden'); }
  finally { $('#refresh-button').disabled = false; $('#refresh-button').textContent = '↻ Refresh'; }
}
async function boot() {
  try {
    const status = await api('/api/status');
    if (!status.configured) { $('#setup-notice').textContent = 'Dashboard setup is incomplete. The owner must configure the required Render environment variables before sign-in is available.'; $('#setup-notice').classList.remove('hidden'); }
    const session = await api('/api/session'); showApp(session.user); await loadDashboard();
  } catch (error) {
    if (error.status === 503) { $('#setup-notice').textContent = 'Dashboard setup is incomplete. The owner must configure the required Render environment variables before sign-in is available.'; $('#setup-notice').classList.remove('hidden'); }
    showLogin();
  }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#login-button');
  const email = $('#email').value.trim(); const password = $('#password').value;
  $('#login-error').textContent = ''; button.disabled = true; button.textContent = 'Signing in…';
  try { const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }); showApp(result.user); await loadDashboard(); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Sign in securely'; }
});
$('#refresh-button').addEventListener('click', loadDashboard);
$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  dashboard = null; $('#password').value = ''; showLogin('You have signed out.');
});
document.querySelectorAll('[data-section]').forEach(link => link.addEventListener('click', () => setSection(link.dataset.section)));
window.addEventListener('hashchange', () => {
  const section = location.hash.replace('#', '');
  if (['overview', 'syncs', 'reports', 'clan', 'history'].includes(section)) setSection(section);
});
setSection(location.hash.replace('#', '') || 'overview');
boot();
