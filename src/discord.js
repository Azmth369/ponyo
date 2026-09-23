import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import { answer, tell } from './ai.js';
import {
  attachAiAnswerMessage,
  cleanupAiState,
  createAiAnswer,
  getAiAnswer,
  getConversationTurns,
  logAiChat,
  saveConversationTurn
} from './aiState.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const ponyoAlertChannelId = process.env.PONYO_ALERT_CHANNEL_ID;
const cleanupGuildCommands = process.env.DISCORD_CLEANUP_GUILD_COMMANDS === 'true';

if (!token || !clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const fallbackAnswers = new Map();
const fallbackConversationMemory = new Map();
const MEMORY_TTL_MS = 60 * 60 * 1000;
const MAX_MEMORY_TURNS = 5;
const PAGINATION_THRESHOLD = 1800;
const PAGE_SIZE = PAGINATION_THRESHOLD;
const MAX_LIST_ITEMS_PER_PAGE = 10;

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the fast Sarvam Clash of Clans analyst')
    .addStringOption(option => option
      .setName('question')
      .setDescription('Ask a data-backed question about the clan')
      .setRequired(true)
      .setMaxLength(1000))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('tell')
    .setDescription('Ask the deeper Gemini Clash of Clans analyst')
    .addStringOption(option => option
      .setName('question')
      .setDescription('Ask a data-backed question about the clan')
      .setRequired(true)
      .setMaxLength(1000))
    .toJSON()
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);

  if (cleanupGuildCommands) {
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
        console.log(`[discord] cleared guild-local commands in ${guild.name} (${guild.id})`);
      } catch (error) {
        console.error(`[discord] failed to clear guild-local commands in ${guild.name} (${guild.id})`, error);
      }
    }
  }

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log(`[discord] registered ${commands.length} ${guildId ? 'guild' : 'global'} slash commands`);
}

function isListItem(line) {
  return /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
}

function numberListBlocks(text) {
  const lines = String(text ?? '').split('\n');
  let inList = false;
  let number = 0;
  return lines.map(line => {
    if (!isListItem(line)) {
      inList = false;
      number = 0;
      return line;
    }
    const body = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!inList) {
      inList = true;
      number = 1;
    } else {
      number += 1;
    }
    return `${number}. ${body}`;
  }).join('\n');
}

function splitDiscordMessage(text, max = PAGE_SIZE) {
  const normalized = numberListBlocks(String(text ?? 'No answer generated.').trim());
  const lines = normalized.split('\n');
  const pages = [];
  let current = [];
  let listItems = 0;

  const flush = () => {
    const value = current.join('\n').trim();
    if (value) pages.push(value);
    current = [];
    listItems = 0;
  };

  for (const line of lines) {
    const listItem = isListItem(line);
    if (listItem && listItems >= MAX_LIST_ITEMS_PER_PAGE) flush();
    if (current.length && current.join('\n').length + line.length + 1 > max) flush();

    current.push(line);
    if (listItem) listItems += 1;
    else if (line.trim()) listItems = 0;
  }

  flush();
  return pages.length ? pages : ['No answer generated.'];
}

function memoryKey(interaction) {
  return `${interaction.guildId || 'dm'}:${interaction.channelId || 'unknown'}:${interaction.user.id}`;
}

function fallbackMemoryTurns(key) {
  const entry = fallbackConversationMemory.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    fallbackConversationMemory.delete(key);
    return [];
  }
  return entry.turns;
}

function buildContextualQuestion(question, turns) {
  if (!turns.length) return question;
  const history = turns.map((turn, index) =>
    `TURN ${index + 1}\nUSER: ${turn.question}\nASSISTANT: ${String(turn.answer ?? '').slice(0, 700)}`
  ).join('\n\n');
  return `RECENT CONVERSATION CONTEXT (use this only to resolve follow-ups such as they/them/their/those/that player/that war; answer the CURRENT QUESTION, not the old questions):\n${history}\n\nCURRENT QUESTION: ${question}`;
}

function rememberFallbackConversation(key, question, answerText) {
  const turns = [...fallbackMemoryTurns(key), {
    question,
    answer: String(answerText || '').slice(0, 4000)
  }].slice(-MAX_MEMORY_TURNS);
  fallbackConversationMemory.set(key, { turns, expiresAt: Date.now() + MEMORY_TTL_MS });
}

function rememberFallbackAnswer(id, question, result, userId, provider, elapsed) {
  fallbackAnswers.set(id, {
    id,
    question,
    full_answer: String(result || ''),
    user_id: userId,
    provider,
    elapsed,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  });
}

function getFallbackAnswer(id, userId) {
  const saved = fallbackAnswers.get(id);
  if (!saved || saved.expiresAt < Date.now() || saved.user_id !== userId) {
    if (saved?.expiresAt < Date.now()) fallbackAnswers.delete(id);
    return null;
  }
  return saved;
}

function viewerRow(id, page, total) {
  const row = new ActionRowBuilder();
  if (page > 0) {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`ai-page:${id}:${page}:less`)
      .setLabel('See less')
      .setStyle(ButtonStyle.Secondary));
  }
  if (page < total - 1) {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`ai-page:${id}:${page}:more`)
      .setLabel('See more')
      .setStyle(ButtonStyle.Secondary));
  }
  return row;
}

function pageContent(provider, elapsed, chunks, page) {
  return `**${provider} • ${elapsed}s**\n${chunks[page]}`;
}

function formatISTTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.day}/${values.month}/${values.year} ${values.hour}:${values.minute}:${values.second} IST`;
}

function classifyProviderError(provider, error) {
  const raw = String(error?.providerBody || error?.message || 'Unknown error');
  const status = error?.status ?? 'unknown';
  const lower = raw.toLowerCase();

  if (/context window|prompt_tokens|max_tokens|exceeds the model context|too many tokens|context length|request.*large|payload.*large/i.test(raw)) {
    return {
      kind: 'context_window',
      title: `${provider} context window exceeded`,
      userMessage: `${provider} could not process that request because too much data was sent to it. Please use /tell (Gemini) for this question.`
    };
  }
  if (Number(status) === 402 || /insufficient_quota_error|no credits available|credits? (?:are )?(?:exhausted|unavailable)/i.test(lower)) {
    return {
      kind: 'credits_exhausted',
      title: `${provider} credits exhausted`,
      userMessage: `${provider} has no API credits available right now. Please use /tell (Gemini) or add credits to the ${provider} account.`
    };
  }
  if (status === 429 || /rate.?limit|too many requests|limit exceeded|tokens?.*limit/i.test(lower)) {
    return {
      kind: 'rate_limit',
      title: `${provider} rate limit reached`,
      userMessage: `${provider} is temporarily rate-limited. Please use /tell (Gemini) for now.`
    };
  }
  if (/api.?key|unauthorized|authentication|invalid.*key|forbidden/i.test(lower) || status === 401 || status === 403) {
    return {
      kind: 'authentication',
      title: `${provider} authentication problem`,
      userMessage: `${provider} is temporarily unavailable due to an API configuration problem. Please use /tell (Gemini) for now.`
    };
  }
  if ([408, 500, 502, 503, 504].includes(Number(status))) {
    return {
      kind: 'temporary_provider_error',
      title: `${provider} temporary API error`,
      userMessage: `${provider} is temporarily unavailable. Please use /tell (Gemini) for now.`
    };
  }
  return {
    kind: 'unknown',
    title: `${provider} request failed`,
    userMessage: `I could not get a ${provider} response right now. Please try /tell (Gemini) instead.`
  };
}

async function sendPonyoAlert({ interaction, provider, question, error, classification, elapsed }) {
  if (!ponyoAlertChannelId) return;
  try {
    const channel = await client.channels.fetch(ponyoAlertChannelId);
    if (!channel?.isTextBased()) throw new Error('PONYO_ALERT_CHANNEL_ID is not a text channel');

    const rawDetails = String(error?.providerBody || error?.message || 'Unknown error');
    const details = rawDetails.length > 3500 ? `${rawDetails.slice(0, 3500)}\n...[truncated]` : rawDetails;
    const user = interaction.user;
    const guild = interaction.guild;
    const lines = [
      '🚨 **Ponyo AI Provider Alert**',
      `**Provider:** ${provider}`,
      `**Problem:** ${classification.title}`,
      `**Category:** ${classification.kind}`,
      `**HTTP status:** ${error?.status ?? 'unknown'}`,
      `**Command:** /${interaction.commandName}`,
      `**User:** ${user?.tag || user?.username || user?.id} (${user?.id || 'unknown'})`,
      `**Guild:** ${guild?.name || 'DM'} (${guild?.id || 'unknown'})`,
      `**Channel:** ${interaction.channel?.name || interaction.channelId || 'unknown'} (${interaction.channelId || 'unknown'})`,
      `**Elapsed before failure:** ${elapsed}s`,
      `**Question:** ${question}`,
      `**Time:** ${formatISTTimestamp()}`,
      '',
      '**Provider error details (private alert channel):**',
      '```text',
      details,
      '```'
    ];
    await channel.send(lines.join('\n').slice(0, 1950));
  } catch (alertError) {
    console.error('[discord] Ponyo alert failed', alertError);
  }
}

client.once('clientReady', readyClient => console.log(`Discord bot online as ${readyClient.user.tag}`));

async function handleAiCommand(interaction, provider, generator) {
  // Ephemeral (private) reply: only the asking user sees the answer.
  // Note: Discord does not allow pinning or forwarding ephemeral messages.
  await interaction.deferReply({ ephemeral: true });
  const started = Date.now();
  let question = '';
  try {
    question = interaction.options.getString('question', true).trim();
    const key = memoryKey(interaction);

    let turns;
    try {
      turns = await getConversationTurns({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        limit: MAX_MEMORY_TURNS
      });
    } catch (stateError) {
      console.error('[discord] persistent conversation lookup failed; using RAM fallback', stateError);
      turns = fallbackMemoryTurns(key);
    }

    const contextualQuestion = buildContextualQuestion(question, turns);
    // Every answer flows through ai.js: the structured (Supabase + live CoC)
    // result is built from the CURRENT question only (so conversation
    // history mentioning other datasets cannot hijack the scope), while the
    // contextual question with history goes to the provider for follow-up
    // resolution. Provider failures fall back to structured text in ai.js.
    const result = await generator(question, contextualQuestion, turns.map(t => t.question));
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    try {
      await logAiChat({
        messenger: interaction.user.username,
        provider,
        question,
        answer: result
      });
    } catch (chatLogError) {
      console.error('[discord] failed to write ai_chat log', chatLogError);
    }

    try {
      await saveConversationTurn({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        provider,
        question,
        answer: result
      });
    } catch (stateError) {
      console.error('[discord] persistent conversation save failed; using RAM fallback', stateError);
      rememberFallbackConversation(key, question, result);
    }

    const chunks = splitDiscordMessage(result);
    let answerId;
    try {
      const saved = await createAiAnswer({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        provider,
        question,
        result
      });
      answerId = saved.id;
    } catch (stateError) {
      console.error('[discord] persistent AI answer save failed; using RAM fallback', stateError);
      answerId = `${interaction.user.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      rememberFallbackAnswer(answerId, question, result, interaction.user.id, provider, elapsed);
    }

    const components = chunks.length > 1 ? [viewerRow(answerId, 0, chunks.length)] : [];
    const sent = await interaction.editReply({ content: pageContent(provider, elapsed, chunks, 0), components });

    if (!String(answerId).includes(':')) {
      try {
        await attachAiAnswerMessage(answerId, sent.id);
      } catch (stateError) {
        console.error('[discord] failed to attach Discord message id to persistent AI answer', stateError);
      }
    }
  } catch (error) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const classification = classifyProviderError(provider, error);
    console.error(`[discord] ${provider.toLowerCase()} failed`, error);
    await sendPonyoAlert({ interaction, provider, question, error, classification, elapsed });
    await interaction.editReply(classification.userMessage);
  }
}

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'ask') {
      await handleAiCommand(interaction, 'Sarvam', answer);
      return;
    }
    if (interaction.commandName === 'tell') {
      await handleAiCommand(interaction, 'Gemini', tell);
      return;
    }
  }

  if (!interaction.isButton() || !interaction.customId.startsWith('ai-page:')) return;

  const parts = interaction.customId.split(':');
  if (parts.length !== 4) {
    await interaction.reply({ content: 'That AI answer button is invalid. Ask the question again.', ephemeral: true });
    return;
  }

  const [, id, pageText, direction] = parts;
  const currentPage = Number(pageText);
  if (!Number.isInteger(currentPage) || !['more', 'less'].includes(direction)) {
    await interaction.reply({ content: 'That AI answer button is invalid. Ask the question again.', ephemeral: true });
    return;
  }

  let saved;
  try {
    saved = await getAiAnswer(id, interaction.user.id);
  } catch (stateError) {
    console.error('[discord] persistent AI answer lookup failed; checking RAM fallback', stateError);
    saved = null;
  }
  saved ??= getFallbackAnswer(id, interaction.user.id);

  if (!saved) {
    await interaction.reply({ content: 'That AI answer is no longer available. Ask the question again.', ephemeral: true });
    return;
  }

  const chunks = splitDiscordMessage(saved.full_answer);
  const delta = direction === 'more' ? 1 : -1;
  const page = Math.max(0, Math.min(chunks.length - 1, currentPage + delta));

  await interaction.update({
    content: pageContent(saved.provider, '—', chunks, page),
    components: chunks.length > 1 ? [viewerRow(id, page, chunks.length)] : []
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of fallbackConversationMemory) if (value.expiresAt < now) fallbackConversationMemory.delete(key);
  for (const [key, value] of fallbackAnswers) if (value.expiresAt < now) fallbackAnswers.delete(key);
}, 10 * 60 * 1000).unref?.();

setInterval(() => {
  cleanupAiState().catch(error => console.error('[discord] AI state cleanup failed', error));
}, 6 * 60 * 60 * 1000).unref?.();

client.login(token)
  .then(async () => {
    try {
      await registerCommands();
    } catch (error) {
      console.error('[discord] command registration failed', error);
      process.exitCode = 1;
    }
  })
  .catch(error => {
    console.error('[discord] startup failed', error);
    process.exitCode = 1;
  });
