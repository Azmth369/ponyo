// AI layer: builds a scoped, classified database + live context for a
// question and hands it to the requested provider (Sarvam for /ask, Gemini
// for /tell). Every answer passes through the provider for the final
// judgement; the structured query result (Supabase + live CoC API) is
// embedded as the authoritative source. If the provider fails, the
// deterministic text is used as a fallback.

import 'dotenv/config';
import {
  getPlayers, getCurrentWar, searchWars, getSnapshots, getCapitalSeasons, getCwlSeasons,
  getCwlWars, getWarAttacks, getWarMembers, getCwlAttacks, getCapitalAttacks,
  getLatestCwlDay, getCwlParticipants, getLatestCapitalSeason, getCapitalParticipants
} from './retrieval.js';
import { getClan } from './cocApi.js';
import { capitalPlayerLeaderboard } from './analytics.js';
import { compactCapitalRaidContext, compactWarAttackContext, compactCwlAttackContext } from './eventGrouping.js';
import { runDeterministicQuery } from './queryRouter.js';
import { stripNegatedDatasets } from './queryEngine.js';
import { WAR, CAPITAL, CWL, MEMBER, MONTHS, hasDatasetSignal, resolveRetrievalQuestion } from './scopeSignals.js';
import { answerDeterministically } from './deterministicAnswer.js';
import { getLiveWar, getLiveCapital } from './liveData.js';
import { formatDiscordTimestamps } from './format.js';

const EVENT_GROUPING = /categor(?:ize|y)|categoris|group|grouping|breakdown|according to|by (?:the )?(?:capital )?raid|raid (?:period|weekend|season)|periods?|per (?:raid|war|round)/i;
const ROLE_NAMES = { leader: 'Leader', coleader: 'Co-Leader', admin: 'Elder', member: 'Member' };

function classify(question) {
  // Negated dataset mentions ("not capital raid") must not flip the scope.
  const q = stripNegatedDatasets(question.toLowerCase());
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
  const context = { retrieval: kind, data_notes: [] };
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
    // Real-time war snapshot: state, time left and live scores straight from
    // the CoC API (the synced rows can be up to 10 minutes old).
    context.live_war = await getLiveWar();
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
    // Real-time capital raid weekend snapshot + the participants of exactly
    // one weekend, so players are never duplicated across seasons.
    context.live_capital = await getLiveCapital();
    const currentSeason = await getLatestCapitalSeason();
    if (currentSeason) {
      const participants = await getCapitalParticipants({ seasonKey: currentSeason.season_key, limit: 60 });
      context.capital_current_season = {
        season_key: currentSeason.season_key,
        state: context.live_capital?.state ?? currentSeason.state,
        start_time: currentSeason.start_time,
        end_time: currentSeason.end_time,
        participants: participants.map(p => ({
          name: p.player_name,
          tag: p.player_id,
          attacks_used: Number(p.attacks_used ?? 0),
          attacks_available: Number(p.attacks_available ?? 0),
          total_loot: Number(p.total_loot ?? 0)
        })),
        // The CoC API only lists members who already attacked; absentees are
        // the roster members (when the weekend began) who have not attacked.
        // "Who has not attacked" must be answered from this list.
        absentees: currentSeason.absentees ?? []
      };
    }
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
    // Latest synced league day + its participants, so players are never
    // duplicated across days or seasons.
    const currentDay = await getLatestCwlDay();
    if (currentDay) {
      const participants = await getCwlParticipants({ dayUid: currentDay.day_uid, limit: 60 });
      context.cwl_current_day = {
        day_uid: currentDay.day_uid,
        battle_day: currentDay.battle_day,
        opponent: currentDay.opponent_clan_name,
        start_time: currentDay.start_time,
        end_time: currentDay.end_time,
        participants: participants.map(p => ({
          name: p.player_name,
          tag: p.player_id,
          attacks_used: Number(p.attacks_used ?? 0),
          attacks_available: Number(p.attacks_available ?? 0)
        }))
      };
    }
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

  if (kind.war && !kind.eventGrouping) {
    context.data_notes.push('Past wars only have summary rows (result, stars, opponent); attack-level detail exists only for wars that were captured live. If asked for per-player detail of an older war and it is missing, say that clearly.');
  }
  if (kind.capital) context.data_notes.push('Capital raid members with 0 attacks are not in the participants list; use capital_current_season.absentees for who has not attacked.');
  if (!context.data_notes.length) delete context.data_notes;

  // The structured query result (Supabase + live CoC API) is authoritative
  // for the underlying filter, count, ranking or ordering (see ANSWER_SCOPE
  // below).
  try {
    context.structured_query = await runDeterministicQuery(question);
  } catch (error) {
    console.error('[ai] structured query failed; continuing without it', error?.message ?? error);
    context.structured_query = null;
  }

  if (Object.keys(context).filter(k => k !== 'retrieval' && k !== 'data_notes').length === 0 && !context.structured_query?.result) {
    context.players = players.length ? players : normalizePlayers(await getPlayers({ limit: 100 }));
    context.current_war = await getCurrentWar();
  }

  return context;
}

// Keep the prompt inside the provider's context window instead of failing with
// a "context window" error: drop the heaviest, least essential keys first.
const CONTEXT_LIMIT_CHARS = Number(process.env.AI_CONTEXT_MAX_CHARS || 60000);
const DROP_ORDER = [
  'historical_cwl_attacks', 'historical_capital_attacks', 'historical_war_attacks', 'player_snapshots',
  'cwl_attacks', 'capital_attacks', 'cwl_wars', 'war_details', 'capital_raids', 'cwl', 'wars', 'current_war_attacks'
];
export function fitContext(context, limit = CONTEXT_LIMIT_CHARS) {
  const fitted = { ...context };
  const dropped = [];
  for (const key of DROP_ORDER) {
    if (JSON.stringify(fitted).length <= limit) break;
    if (key in fitted) {
      if (Array.isArray(fitted[key]) && fitted[key].length > 40) {
        fitted[key] = fitted[key].slice(0, 40);      // keep the newest slice first
        dropped.push(`${key} (trimmed)`);
        if (JSON.stringify(fitted).length <= limit) break;
      }
      delete fitted[key];
      dropped.push(key);
    }
  }
  if (dropped.length) fitted.data_notes = [...(fitted.data_notes ?? []), `Some detail was left out to fit the size limit: ${dropped.join(', ')}. Say so if it affects the answer.`];
  return fitted;
}

const ANSWER_SCOPE = `HOW TO ANSWER: (1) Answer the user's actual question first, in the first line or two, then add at most a short useful insight or next step. (2) When DATABASE CONTEXT contains structured_query with intent 'structured_clan_query' or 'structured_query', its result is authoritative for the underlying filter, count, ranking, ordering or event fact; do not recompute or change it, but DO explain what it means in plain language (for example: 'everyone has used their attacks' instead of a bare 'no matching records'). (3) When live_war or live_capital is present it is a real-time snapshot and takes priority over synced rows for state, time remaining and live scores. (4) Questions asking why, how to improve, what to do, or who should be promoted/kicked are ADVICE questions: reason from the relevant data (attack usage, stars, donations, activity) and give concrete, specific suggestions grounded in the numbers; do not just list rows. (5) General Clash of Clans questions (strategy, troops, base layout, rules) that are not about this clan are answered from game knowledge even when clan data is present; say briefly when something is general game knowledge rather than clan data. (6) If the question is ambiguous (which war, which player, which weekend), answer the most likely reading and state that assumption in one short line, and offer the alternative. (7) If the needed data is missing or incomplete, say exactly what is missing (see data_notes) and what you can answer instead; never reply with only 'no data'. (8) Reply in the language the user wrote in (English, Hindi, Hinglish). (9) Names only unless the user asks for tags or more; summarise before listing. Do not expose internal query-engine details unless asked. Do not use the clan identity as the answer to an opponent/event question.`;

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
    contents: [{ role: 'user', parts: [{ text: `${question}\n\nDATABASE CONTEXT:\n${JSON.stringify(fitContext(context))}` }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 1500 }
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
      { role: 'user', content: `${question}\n\nDATABASE CONTEXT:\n${JSON.stringify(fitContext(context))}` }
    ],
    temperature: 0.15,
    reasoning_effort: null,
    max_tokens: 1200
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

// Every answer goes through the AI provider for the final judgement (the
// structured database + live result is embedded in the context as the
// authoritative source). If the provider fails, the deterministic text is
// used as a fallback so the user still gets a correct, if plain, answer.
//
// The context and the structured query are built from the CURRENT question
// only; the conversation history is passed to the provider separately so old
// turns mentioning other datasets ("capital raid") cannot hijack scope
// detection for follow-up questions.
async function answerWithAi(question, contextualQuestion, provider, previousQuestions = []) {
  const retrievalQuestion = resolveRetrievalQuestion(question, previousQuestions);
  const context = await buildContext(retrievalQuestion);
  try {
    return await provider(contextualQuestion, context);
  } catch (error) {
    try {
      const deterministic = await answerDeterministically(retrievalQuestion);
      if (deterministic?.text) {
        return `${deterministic.text}\n\n(Answered from structured clan data because the AI provider was unavailable — ask again shortly for a fuller reply.)`;
      }
    } catch (fallbackError) {
      console.error('[ai] deterministic fallback failed', fallbackError);
    }
    throw error;
  }
}

export async function answer(question, contextualQuestion, previousQuestions = []) {
  if (!question?.trim()) throw new Error('Question cannot be empty');
  const clean = question.trim();
  return answerWithAi(clean, contextualQuestion?.trim() || clean, askSarvam, previousQuestions);
}

export async function tell(question, contextualQuestion, previousQuestions = []) {
  if (!question?.trim()) throw new Error('Question cannot be empty');
  const clean = question.trim();
  return answerWithAi(clean, contextualQuestion?.trim() || clean, askGemini, previousQuestions);
}
