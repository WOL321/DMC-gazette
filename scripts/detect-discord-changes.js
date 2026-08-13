// Polls specified Discord channels for messages posted since the last check,
// using a bot token — no persistent connection needed, just a REST API call
// on a schedule. Appends new messages to data/pending-changes.json for the
// article-drafting script to consider.
//
// REQUIRES two things you set up yourself (see the setup guide):
//   DISCORD_BOT_TOKEN   — a bot token from the Discord Developer Portal
//   DISCORD_CHANNEL_IDS — comma-separated channel IDs to watch, e.g.
//                         "123456789012345678,234567890123456789"
// Both are read from environment variables (set as GitHub Actions secrets).
//
// Run manually with:
//   DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_IDS=xxx,yyy node scripts/detect-discord-changes.js

const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const STATE_PATH = path.join(__dirname, '..', 'data', 'discord-state.json');
const PENDING_PATH = path.join(__dirname, '..', 'data', 'pending-changes.json');

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

async function fetchNewMessages(channelId, afterId) {
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set('limit', '50');
  if (afterId) url.searchParams.set('after', afterId);

  const res = await fetch(url, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Discord API ${res.status} ${res.statusText} for channel ${channelId} — check the bot's permissions and that it's actually in that channel.`);
  }
  const messages = await res.json();
  // Discord returns newest-first; reverse so we process oldest-to-newest.
  return messages.reverse();
}

async function main() {
  if (!BOT_TOKEN) {
    console.warn('DISCORD_BOT_TOKEN not set — skipping Discord change detection this run.');
    return;
  }
  if (!CHANNEL_IDS.length) {
    console.warn('DISCORD_CHANNEL_IDS not set — skipping Discord change detection this run.');
    return;
  }

  const state = loadJson(STATE_PATH, {});
  const pending = loadJson(PENDING_PATH, { minecraft: [], discord: [] });
  let totalNew = 0;

  for (const channelId of CHANNEL_IDS) {
    try {
      const isFirstRunForChannel = !state[channelId];
      const afterId = state[channelId] || null;
      const messages = await fetchNewMessages(channelId, afterId);
      if (!messages.length) continue;

      if (isFirstRunForChannel) {
        // First time watching this channel — record where we are now as the
        // baseline instead of treating existing history as "new" changes.
        state[channelId] = messages[messages.length - 1].id;
        console.log(`First run for channel ${channelId} — baseline set, no history treated as new.`);
        continue;
      }

      for (const msg of messages) {
        // Skip empty/system messages and anything from bots (including this one).
        if (!msg.content || msg.author?.bot) continue;
        pending.discord.push({
          channelId,
          messageId: msg.id,
          author: msg.author?.username || 'unknown',
          content: msg.content,
          timestamp: msg.timestamp,
          detectedAt: new Date().toISOString(),
        });
        totalNew++;
      }
      state[channelId] = messages[messages.length - 1].id;
    } catch (err) {
      console.warn(`Skipping channel ${channelId} this run: ${err.message}`);
    }
  }

  if (totalNew) {
    fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
    console.log(`Detected ${totalNew} new Discord message(s) across ${CHANNEL_IDS.length} channel(s).`);
  } else {
    console.log('No new Discord messages detected this run.');
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

main().catch(err => {
  console.error('detect-discord-changes.js failed unexpectedly:', err.message);
  process.exit(1);
});
