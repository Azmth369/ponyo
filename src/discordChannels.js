import 'dotenv/config';

function channelMap() {
  try { return JSON.parse(process.env.DISCORD_CHANNEL_MAP || '{}'); }
  catch { return {}; }
}

export function configuredChannelId(name) {
  return channelMap()[name] || null;
}

export async function sendToConfiguredChannel(client, name, content) {
  const id = configuredChannelId(name);
  if (!id) throw new Error(`No Discord channel configured for '${name}'`);
  const channel = await client.channels.fetch(id);
  if (!channel?.isTextBased()) throw new Error(`Configured channel '${name}' is not text-based`);
  return channel.send({ content: String(content).slice(0, 1900) });
}
