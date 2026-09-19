// AI layer: builds a scoped, classified database context for a question and
// hands it to the requested provider (Sarvam for /ask, Gemini for /tell).
// Deterministic questions never reach the provider (see
// answerWithDeterministicFirst).

import 'dotenv/config';
import {
  getPlayers, getCurrentWar, searchWars, getSnapshots, getCapitalSeasons, getCwlSeasons,
  getCwlWars, getWarAttacks, getWarMembers, getCwlAttacks, getCapitalAttacks
} from './retrieval.js';
import { getClan } from './cocApi.js';
import { capitalPlayerLeaderboard } from './analytics.js';
import { compactCapitalRaidContext, compactWarAttackContext, compactCwlAttackContext } from './eventGrouping.js';
import { executeIntent } from './queryEngine.js';
import { answerDeterministically } from './deterministicAnswer.js';
import { formatDiscordTimestamps } from './format.js';

const MONTHS = /january|february|march|april|may|june|july|august|september|october|november|december|month|year|trend|history|improv|declin/i;
const WAR = /war|attack|defen|star|opponent|miss|hit|battle|participat/i;
const CAPITAL = /capital|raid/i;
const CWL = /cwl|clan war league|league day/i;
const MEMBER = /member|player|donat|troph|town hall|inactive|role|elder|elders|co-?leader|leader|lowest|highest|who|tag|participat|clan/i;
const EVENT_GROUPING = /categor(?:ize|y)|categoris|group|grouping|breakdown|according to|by (?:the )?(?:capital )?raid|raid (?:period|weekend|season)|periods?|per (?:raid|war|round)/i;
const ROLE_NAMES = { leader: 'Leader', coleader: 'Co-Leader', admin: 'Elder', member: 'Member' };

function classify(question) {
  const q = question.toLowerCase();
  const capital = CAPITAL.test(q);
  const cwl = CWL.test(q);
  return {
    member: MEMBER.test(q),
    war: WAR.test(q) && !capital && !cwl,
    capital,
    cwl,
    history: MONTHS.test(q),
    eventGrouping: EVENT_GROUPING.test(q)
  };
}

function extractOpponent(question) {
  const match = question.match(/(?:against|vs\.?|versus)\s+["']?([^"'.!,]+)["']?/i);
  return match?.[1]?.trim() || null;
}

function extractPlayerName(question, players) {
  const normalized = question.toLowerCase();
  return [...players]
    .sort((a, b) => b.name.length - a.name.length)
    .find(p => normalized.includes(p.name.toLowerCase())) ?? null;
}

function normalizeRole(role) {
  const raw = String(role ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  return ROLE_NAMES[raw] || String(role ?? 'Unknown');
}

function normalizePlayers(players) {
  return players.map(p => ({ ...p, role_label: normalizeRole(p.role) }));
}

function enrichWarMembers(members) {
  return members.map(m => ({
    ...m,
    role_label: normalizeRole(m.role),
    missed_attacks: Math.max(Number(m.attacks_available ?? 0) - Number(m.attacks_used ?? 0), 0)
  }));
}

function buildMemberSummary(players) {
  const grouped = { Leader: [], 'Co-Leader': [], Elder: [], Member: [] };
  for (const p of players) {
    const label = normalizeRole(p.role);
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push({ name: p.name, tag: p.tag, role: p.role, role_label: label });
  }
  return {
    total: players.length,
    counts: Object.fromEntries(Object.entries(grouped).map(([role, list]) => [role, list.length])),
    leaders: grouped.Leader,
    co_leaders: grouped['Co-Leader'],
    elders: grouped.Elder,
    members: grouped.Member,
    role_mapping: "CoC API raw role 'leader' = Leader, 'coLeader' (case-insensitive) = Co-Leader, 'admin' = Elder, 'member' = Member."
  };
}

async function buildCapitalGrouping() {
  const seasons = await getCapitalSeasons(50);
  const attacks = await getCapitalAttacks({ limit: 1000 });
  return compactCapitalRaidContext(seasons, attacks);
}

async function buildWarGrouping() {
  const wars = await searchWars('', 100);
  const attackSets = await Promise.all(wars.map(w => getWarAttacks(w.war_key, 500)));
  return compactWarAttackContext(wars, attackSets.flat());
}

async function buildCwlGrouping() {
  const seasons = await getCwlSeasons(50);
  const wars = await getCwlWars(null, 100);
  const attacks = await getCwlAttacks({ limit: 1000 });
  return compactCwlAttackContext(seasons, wars, attacks);
}

async function getWarAttacksForHistory(playerTag) {
  if (!playerTag) return [];
  const wars = await searchWars('', 100);
  const attackSets = await Promise.all(wars.map(w => getWarAttacks(w.war_key, 500)));
  return attackSets.flat().filter(a => a.attacker_tag === playerTag);
}

async function buildContext(question) {
  const kind = classify(question);
  const context = { retrieval: kind };
  const players = kind.member || kind.history
    ? normalizePlayers(await getPlayers({ limit: 100 }))
    : [];

  if (players.length) context.players = players;

  // Clan identity is useful for clan-scoped questions, but must not compete
  // with current-war/CWL/Capital context when the question is about an event.
  if (kind.member && !kind.war && !kind.cwl && !kind.capital) {
    const clan = await getClan();
    context.clan = {
      name: clan.name ?? null,
      tag: clan.tag ?? null,
      members: Number(clan.members ?? clan.memberList?.length ?? players.length)
    };
  }

  if (kind.member && players.length) {
    context.member_summary = buildMemberSummary(players);
    const q = question.toLowerCase();
    if (/\belders?\b/.test(q)) context.requested_role = { label: 'Elder', raw_role: 'admin', requested_members: context.member_summary.elders };
    else if (/co-?leaders?/.test(q)) context.requested_role = { label: 'Co-Leader', raw_role: 'coLeader', requested_members: context.member_summary.co_leaders };
    else if (/\bleaders?\b/.test(q)) context.requested_role = { label: 'Leader', raw_role: 'leader', requested_members: context.member_summary.leaders };
  }

  const opponent = extractOpponent(question);

  if (kind.war) {
    const current = await getCurrentWar();
    context.current_war = current;
    if (current?.war_key) {
      context.current_war_members = enrichWarMembers(await getWarMembers(current.war_key));
      context.current_war_attacks = await getWarAttacks(current.war_key);
    }
    if (kind.eventGrouping) {
      context.war_event_categories = await buildWarGrouping();
    } else {
      let wars = opponent ? await searchWars(opponent, 25) : await searchWars('', 25);
      // Safe-expansion: a named opponent search with no hits expands to recent
      // war history instead of leaving the model with nothing.
      if (opponent && wars.length === 0) wars = await searchWars('', 25);
      context.wars = wars;
      if (opponent && wars.length) {
        context.war_details = [];
        for (const war of wars.slice(0, 5)) {
          context.war_details.push({
            war,
            members: enrichWarMembers(await getWarMembers(war.war_key)),
            attacks: await getWarAttacks(war.war_key)
          });
        }
      }
    }
  }

  if (kind.capital) {
    const seasons = await getCapitalSeasons(50);
    if (kind.eventGrouping) {
      context.capital_raid_categories = await buildCapitalGrouping();
    } else {
      context.capital_raids = seasons.map(row => {
        const d = row.data ?? {};
        return {
          season_key: row.season_key,
          start_time: d.startTime ?? null,
          end_time: d.endTime ?? null,
          state: d.state ?? null,
          capital_total_loot: d.capitalTotalLoot ?? 0,
          raids_completed: d.raidsCompleted ?? 0,
          total_attacks: d.totalAttacks ?? 0,
          enemy_districts_destroyed: d.enemyDistrictsDestroyed ?? 0,
          offensive_reward: d.offensiveReward ?? 0,
          defensive_reward: d.defensiveReward ?? 0
        };
      });
      context.capital_attacks = await getCapitalAttacks({ limit: 300 });
    }
    const leaderboard = await capitalPlayerLeaderboard(12);
    context.capital_player_rankings = {
      by_capital_gold: [...leaderboard].sort((a, b) => b.capital_gold - a.capital_gold).slice(0, 20),
      by_stars: [...leaderboard].sort((a, b) => b.stars - a.stars || b.capital_gold - a.capital_gold).slice(0, 20),
      note: 'capital_gold is capital resources looted by the member across synced raid seasons; stars is the sum of individual attack stars when attack details are available.'
    };
  }

  if (kind.cwl) {
    if (kind.eventGrouping) {
      context.cwl_event_categories = await buildCwlGrouping();
    } else {
      context.cwl = await getCwlSeasons(50);
      context.cwl_wars = await getCwlWars(null, 100);
      context.cwl_attacks = await getCwlAttacks({ limit: 500 });
    }
  }

  if (kind.history) {
    const player = extractPlayerName(question, players);
    if (player) context.player_snapshots = await getSnapshots(player.tag, null, 500);
    context.historical_war_attacks = await getWarAttacksForHistory(player?.tag);
    context.historical_cwl_attacks = await getCwlAttacks({ attackerTag: player?.tag, limit: 300 });
    context.historical_capital_attacks = await getCapitalAttacks({ attackerTag: player?.tag, limit: 300 });
  }

  // The structured query result is authoritative for the underlying filter,
  // count, ranking or ordering (see ANSWER_SCOPE below).
  context.structured_query = executeIntent(question, {
    players,
    currentWarMembers: context.current_war_members ?? []
  });

  if (Object.keys(context).length === 2 && !context.structured_query?.result) {
    context.players = players.length ? players : normalizePlayers(await getPlayers({ limit: 100 }));
    context.current_war = await getCurrentWar();
  }

  return context;
}

const ANSWER_SCOPE = `Answer the user's exact question and nothing more. Do not dump unrelated database rows. When DATABASE CONTEXT contains structured_query with intent 'structured_clan_query' or 'structured_query', its source and result are authoritative for the underlying clan-specific filter, count, ranking, ordering, or event fact; do not recompute or change that result. For all other clan-specific questions, use the relevant scoped context (clan, current_war, cwl, capital_raids, history) and answer directly from it. Do not require a dedicated intent for a question merely because the user asks for a different field. When the question is about a war/event, do not use the clan identity/name as the answer to an opponent/event question; use the relevant event context. Explain the result briefly and naturally. If result_count is zero, say no matching records were found. If the user asks for names, give names only unless more is requested. If the user asks for names and tags, give names with tags. Do not expose internal query-engine details unless asked.`;

const CLAN_CHAT_RULES = `CLAN CHAT / CLAN MAIL REFERENCE RULES: Each individual clan-chat message must be 128 characters or fewer; a single prompt/message may tag at most 5 clan members. If drafting a clan-chat message would exceed 128 characters, rewrite it to fit. Multiple separate clan-chat messages each have their own 128-character limit. Clan Mail uses the supplied reference limit of up to 500 characters and 14-day persistence. Do not confuse these limits.`;

const TIME_FORMAT_RULES = `DATE/TIME DISPLAY RULES: Database and CoC API timestamps are kept as source-of-truth timestamps. When presenting any date or time to the Discord user, ALWAYS convert it to India Standard Time (IST, Asia/Kolkata) and use DD/MM/YYYY for the date with 24-hour HH:mm time. Do not show raw ISO or UTC timestamps unless explicitly requested.`;

const SYSTEM_BASE = `You are a Clash of Clans clan analyst and general Clash of Clans knowledge assistant. Use database context for clan-specific facts. For general Clash of Clans rules, mechanics, limits and terminology not in the database, use your general knowledge and reasoning. Clearly distinguish general game knowledge from clan-specific database facts. Never invent clan-specific data.\n\n${ANSWER_SCOPE}\n\n${CLAN_CHAT_RULES}\n\n${TIME_FORMAT_RULES}\n\nROLE MAPPING: raw 'leader'=Leader, 'coLeader'=Co-Leader, 'admin'=Elder, 'member'=Member. Do not interpret 'admin' as a Discord/server administrator.\n\nClan War, CWL and Capital attacks are separate datasets and must never be mixed. attack_time is the source timestamp only when provided; observed_at is when sync first saw the attack.`;

async function generateGemini(model, key, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const message = await res.text();
    const error = new Error(`Gemini ${res.status}: ${message}`);
    error.status = res.status;
    throw error;
  }
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'No answer generated.';
}

async function askGemini(question, context) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is required');

  const configured = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const supported = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];
  const models = [supported.includes(configured) ? configured : 'gemini-3.8-flash', ...supported]
    .filter((m, i, a) => a.indexOf(m) === i);

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_BASE }] },
    contents: [{ role: 'user', parts: [{ text: `${question}\n\nDATABASE CONTEXT:\n${JSON.stringify(context)}` }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 1200 }
  };

  let last;
  for (const model of models) {
    try {
      return formatDiscordTimestamps(await generateGemini(model, key, body));
    } catch (error) {
      last = error;
      if ([404, 408, 429, 500, 502, 503, 504].includes(error.status)) continue;
      throw error;
    }
  }
  throw last || new Error('No Gemini model was available');
}

async function askSarvam(question, context) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is required for /ask');

  const configured = process.env.SARVAM_MODEL || 'sarvam-105b';
  const model = configured === 'sarvam-105b-conversations' ? 'sarvam-105b' : configured;

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_BASE },
      { role: 'user', content: `${question}\n\nDATABASE CONTEXT:\n${JSON.stringify(context)}` }
    ],
    temperature: 0.15,
    reasoning_effort: null,
    max_tokens: 800
  };

  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const message = await res.text();
    const error = new Error(`Sarvam ${res.status}: ${message}`);
    error.status = res.status;
    error.provider = 'Sarvam';
    error.providerBody = message;
    error.isQuotaOrRateLimit = res.status === 429 || /rate.?limit|quota|token limit|limit exceeded|too many requests/i.test(message);
    error.isContextWindow = /context window|prompt_tokens|max_tokens|exceeds the model context|too many tokens|payload.*large|request.*large/i.test(message);
    throw error;
  }
  const json = await res.json();
  return formatDiscordTimestamps(json.choices?.[0]?.message?.content || 'No answer generated.');
}

async function answerWithDeterministicFirst(question, generator) {
  const deterministic = await answerDeterministically(question);
  if (deterministic) return deterministic.text;
  return generator();
}

export async function answer(question) {
  if (!question?.trim()) throw new Error('Question cannot be empty');
  const clean = question.trim();
  return answerWithDeterministicFirst(clean, () => askSarvam(clean, buildContext(clean)));
}

export async function tell(question) {
  if (!question?.trim()) throw new Error('Question cannot be empty');
  const clean = question.trim();
  return answerWithDeterministicFirst(clean, () => askGemini(clean, buildContext(clean)));
}
