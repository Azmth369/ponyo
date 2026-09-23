import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_CONTEXT_CHARS = Number(process.env.PONYO_AI_CONTEXT_MAX_CHARS || 45000);
const MAX_FILES = Number(process.env.PONYO_AI_MAX_FILES || 8);
const MAX_FILE_CHARS = Number(process.env.PONYO_AI_MAX_FILE_CHARS || 14000);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache'
]);

const SKIP_FILES = new Set([
  '.env', '.env.local', '.env.production'
]);

let cachedIndex = null;
let cachedAt = 0;
const INDEX_TTL_MS = 5 * 60 * 1000;

async function walk(dir, relative = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(relative, entry.name);
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await walk(full, rel));
      continue;
    }

    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.sql', '.yml', '.yaml'].includes(ext)) continue;
    files.push(rel.replaceAll(path.sep, '/'));
  }

  return files;
}

async function getIndex() {
  if (cachedIndex && Date.now() - cachedAt < INDEX_TTL_MS) return cachedIndex;
  cachedIndex = (await walk(ROOT)).sort();
  cachedAt = Date.now();
  return cachedIndex;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 2);
}

function scoreFile(file, questionTokens) {
  const lower = file.toLowerCase();
  let score = 0;

  for (const token of questionTokens) {
    if (lower.includes(token)) score += 8;
  }

  if (['readme.md', 'project_info.txt', 'package.json'].includes(lower)) score += 6;

  const basename = path.basename(lower);
  if (basename === 'ai.js') score += 5;
  if (basename.includes('query')) score += 3;
  if (basename.includes('discord')) score += 3;
  if (basename.includes('retrieval')) score += 3;

  return score;
}

async function readCandidate(file) {
  try {
    const raw = await fs.readFile(path.join(ROOT, file), 'utf8');
    if (!raw.trim()) return null;
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n... [file truncated for context] ...'
      : raw;
  } catch {
    return null;
  }
}

async function buildRepositoryContext(question) {
  const files = await getIndex();
  const tokens = normalize(question);

  const ranked = files
    .map(file => ({ file, score: scoreFile(file, tokens) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const selected = [];
  let used = 0;

  for (const item of ranked) {
    if (selected.length >= MAX_FILES) break;
    const content = await readCandidate(item.file);
    if (!content) continue;

    const block = `===== ${item.file} =====\n${content}\n`;
    if (used + block.length > MAX_CONTEXT_CHARS && selected.length > 0) continue;

    selected.push({ file: item.file, content });
    used += block.length;
  }

  const map = files.map(file => `- ${file}`).join('\n');

  return {
    selected,
    repositoryMap: map,
    selectedPaths: selected.map(item => item.file),
  };
}

const SYSTEM_PROMPT = `You are Ponyo's private software-engineering assistant.

You are answering questions about the CURRENT Ponyo repository, whose source code is provided in REPOSITORY CONTEXT.

Rules:
1. Treat the repository files as the primary source of truth for Ponyo-specific behavior.
2. Never invent a file, function, table, environment variable, dependency, or feature. If it is not present in the supplied context, say that you cannot verify it from the current repository context.
3. When explaining code, mention the relevant file path and function/module name when useful.
4. For architecture questions, trace the actual flow through the code instead of giving a generic AI/bot architecture answer.
5. For bugs, identify the likely file/function and explain the concrete reason before proposing a fix.
6. For changes, give implementation-ready guidance and keep existing architecture intact unless the user explicitly asks for a redesign.
7. Do not expose secrets. Never repeat API keys, tokens, passwords, or .env contents.
8. The user may ask in English, Hindi, or Hinglish; reply in the same language.
9. Keep answers practical and concise unless the user asks for a deep explanation.
10. If the question is about Clash of Clans data behavior, distinguish the code's actual implementation from general game knowledge.

You have a repository file map plus selected source files. The map is useful for locating files; selected files are the evidence you can inspect in detail.`;

async function generateGemini(question, contextText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is required');

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [{
        text: `${question}\n\nREPOSITORY MAP:\n${contextText.repositoryMap}\n\nREPOSITORY CONTEXT:\n${contextText.selected.map(item => `FILE: ${item.file}\n${item.content}`).join('\n\n')}`
      }]
    }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'low' },
      maxOutputTokens: 1800
    }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const message = await res.text();
    const error = new Error(`Gemini ${res.status}: ${message.slice(0, 500)}`);
    error.status = res.status;
    throw error;
  }

  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('')
    || 'I could not generate an answer from the current Ponyo repository context.';
}

export async function ponyoAnswer(question, contextualQuestion = question) {
  if (!question?.trim()) throw new Error('Question cannot be empty');

  const context = await buildRepositoryContext(question);
  const prompt = contextualQuestion.trim();

  return generateGemini(prompt, context);
}
