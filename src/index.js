import 'dotenv/config';
import { syncClan, syncWar, syncHistory, syncCwl, run } from './sync.js';
import { syncCapital } from './capitalSync.js';
import { syncCapitalContributionSnapshots } from './contributionSync.js';
import { processEventReports } from './reporting.js';
import { migrateLegacyUids } from './migrateUids.js';

const bool = (name, fallback = true) => {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return !['false', '0', 'no', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
};

const interval = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// All recurring sync controls are environment-configurable. Change these in Render
// without editing the code. Values are milliseconds.
const schedules = [
  ['clan', bool('ENABLE_CLAN_SYNC'), interval('CLAN_POLL_MS', 600000), () => syncClan(false)],
  ['war', bool('ENABLE_WAR_SYNC'), interval('WAR_POLL_MS', 60000), syncWar],
  ['history', bool('ENABLE_HISTORY_SYNC'), interval('HISTORY_POLL_MS', 1800000), syncHistory],
  ['capital', bool('ENABLE_CAPITAL_SYNC'), interval('CAPITAL_POLL_MS', 60000), syncCapital],
  ['cwl', bool('ENABLE_CWL_SYNC'), interval('CWL_POLL_MS', 60000), syncCwl],
  ['player-snapshot', bool('ENABLE_PLAYER_SNAPSHOT_SYNC'), interval('PLAYER_POLL_MS', 1800000), async () => ({ clanSnapshot: await syncClan(true), capitalContributions: await syncCapitalContributionSnapshots() })],
  ['event-reports', bool('ENABLE_EVENT_REPORTS'), interval('REPORT_POLL_MS', 60000), processEventReports]
];

const startupJobs = [
  ['clan', bool('STARTUP_CLAN_SYNC'), () => syncClan(false)],
  ['war', bool('STARTUP_WAR_SYNC'), syncWar],
  ['history', bool('STARTUP_HISTORY_SYNC'), syncHistory],
  ['capital', bool('STARTUP_CAPITAL_SYNC'), syncCapital],
  ['cwl', bool('STARTUP_CWL_SYNC'), syncCwl],
  ['player-snapshot', bool('STARTUP_PLAYER_SNAPSHOT_SYNC'), async () => ({ clanSnapshot: await syncClan(true), capitalContributions: await syncCapitalContributionSnapshots() })],
  ['event-reports', bool('ENABLE_EVENT_REPORTS'), processEventReports]
];

let syncRunning = false;
// Coalesce repeated ticks by job name. No scheduled sync is silently discarded;
// at most one pending run per job is retained while another sync is in progress.
const pendingJobs = new Map();

async function flushPendingJobs() {
  if (syncRunning || pendingJobs.size === 0) return;
  const [name, fn] = pendingJobs.entries().next().value;
  pendingJobs.delete(name);
  syncRunning = true;
  try {
    await run(name, fn);
  } finally {
    syncRunning = false;
    if (pendingJobs.size) await flushPendingJobs();
  }
}

async function scheduleJob(name, fn) {
  if (syncRunning) {
    pendingJobs.set(name, fn);
    console.log(`[sync] queued ${name}; another sync is running`);
    return;
  }
  syncRunning = true;
  try {
    await run(name, fn);
  } finally {
    syncRunning = false;
    await flushPendingJobs();
  }
}

// Run a manual refresh through the same lock as scheduled jobs, so requests cannot overlap.
export async function refreshNow() {
  if (syncRunning) return { busy: true, message: 'A sync is already running; try again shortly.' };
  syncRunning = true;
  const results = {};
  try {
    for (const [name, fn] of [
      ['clan', () => syncClan(false)], ['war', syncWar], ['history', syncHistory],
      ['capital', syncCapital], ['cwl', syncCwl], ['player-snapshot', async () => ({ clanSnapshot: await syncClan(true), capitalContributions: await syncCapitalContributionSnapshots() })]
    ]) {
      results[name] = await run('manual-' + name, fn);
    }
    return { busy: false, completedAt: new Date().toISOString(), results };
  } finally {
    syncRunning = false;
    await flushPendingJobs();
  }
}

export async function startSyncScheduler() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    try {
      const migrated = await migrateLegacyUids();
      if (migrated) console.log('[sync] legacy UID migration complete', migrated);
    } catch (error) {
      console.error('[sync] legacy UID migration failed; continuing with existing UIDs', error);
    }

    await run('startup', async () => {
      for (const [name, enabled, fn] of startupJobs) {
        if (!enabled) {
          console.log(`[sync] startup ${name} disabled`);
          continue;
        }
        try {
          const details = await fn();
          console.log(`[sync] startup ${name} complete`, details);
        } catch (error) {
          console.error(`[sync] startup ${name} failed`, error);
        }
      }
    });
  } finally {
    syncRunning = false;
  }

  if (!bool('ENABLE_SYNC_SCHEDULER')) {
    console.log('[sync] recurring scheduler disabled by ENABLE_SYNC_SCHEDULER');
    return;
  }

  for (const [name, enabled, ms, fn] of schedules) {
    if (!enabled) {
      console.log(`[sync] recurring ${name} disabled`);
      continue;
    }
    setInterval(() => { void scheduleJob(name, fn); }, ms);
    console.log(`[sync] recurring ${name} every ${ms}ms`);
  }
  console.log('[sync] scheduler started');
}

if (process.argv[1]?.endsWith('/index.js')) await startSyncScheduler();
