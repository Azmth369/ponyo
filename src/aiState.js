import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';

const ANSWER_TTL_DAYS = 30;
const CONVERSATION_TTL_MS = 60 * 60 * 1000;

export async function createAiAnswer({ guildId, channelId, userId, provider, question, result }) {
  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ANSWER_TTL_DAYS * 24 * 60 * 60 * 1000);
  const { error } = await db.from('ai_answers').insert({
    id,
    guild_id: guildId || null,
    channel_id: channelId || null,
    user_id: userId,
    provider,
    question,
    full_answer: String(result || ''),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString()
  });
  if (error) throw error;
  return { id, expiresAt };
}

export async function attachAiAnswerMessage(id, messageId) {
  const { error } = await db
    .from('ai_answers')
    .update({ message_id: messageId })
    .eq('id', id);
  if (error) throw error;
}

export async function getAiAnswer(id, userId) {
  const { data, error } = await db
    .from('ai_answers')
    .select('id,user_id,provider,question,full_answer,created_at,expires_at')
    .eq('id', id)
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function saveConversationTurn({ guildId, channelId, userId, provider, question, answer }) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + CONVERSATION_TTL_MS);
  const { error } = await db.from('ai_conversations').insert({
    guild_id: guildId || null,
    channel_id: channelId || null,
    user_id: userId,
    provider,
    question,
    answer: String(answer || '').slice(0, 4000),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString()
  });
  if (error) throw error;
}

export async function getConversationTurns({ guildId, channelId, userId, limit = 5 }) {
  let query = db
    .from('ai_conversations')
    .select('question,answer,provider,created_at')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit || 5), 1), 10));

  query = guildId ? query.eq('guild_id', guildId) : query.is('guild_id', null);
  query = channelId ? query.eq('channel_id', channelId) : query.is('channel_id', null);

  const { data, error } = await query;
  if (error) throw error;
  return [...(data ?? [])].reverse();
}

// AI Q&A log, matching the ai_chat table design in database/AI_CHAT.xlsx.
export async function logAiChat({ messenger, provider, question, answer }) {
  const { error } = await db.from('ai_chat').insert({
    messenger: String(messenger || 'unknown').slice(0, 100),
    context: {
      provider,
      question: String(question || '').slice(0, 1000),
      answer: String(answer || '').slice(0, 4000)
    }
  });
  if (error) throw error;
}

export async function cleanupAiState() {
  const now = new Date().toISOString();
  const [answers, conversations] = await Promise.all([
    db.from('ai_answers').delete().lt('expires_at', now),
    db.from('ai_conversations').delete().lt('expires_at', now)
  ]);
  if (answers.error) throw answers.error;
  if (conversations.error) throw conversations.error;
}
