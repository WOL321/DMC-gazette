// Takes whatever's piled up in data/pending-changes.json (new towns, new
// residents, new Discord messages) and drafts Gazette-style articles from it
// using the Anthropic API. Drafts are written to drafts/ as a dated JSON file
// — NOT merged into articles.json automatically. A human reviews and merges
// them in by hand (or asks Claude to do it in a chat, same as every other
// update in this project). This is intentional: an LLM drafting from raw
// server events can get tone, emphasis, or nation politics wrong, especially
// around anything sensitive (wars, rivalries, drama) — a review step catches
// that before anything goes live.
//
// REQUIRES: ANTHROPIC_API_KEY environment variable (a GitHub Actions secret),
// from your own Anthropic Console account — console.anthropic.com — separate
// from any claude.ai chat subscription. This calls the API and is billed
// per Anthropic's API pricing, not covered by a claude.ai plan.
//
// Run manually with:
//   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/draft-articles.js

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5'; // check docs.claude.com if this ever needs updating

const PENDING_PATH = path.join(__dirname, '..', 'data', 'pending-changes.json');
const DRAFTS_DIR = path.join(__dirname, '..', 'drafts');

const SYSTEM_PROMPT = `You are a staff writer for The DMC Gazette, an in-character newspaper covering the nations of the DiplomaticaMC Minecraft server. Your job is to turn raw event data (new towns founded, residents joining/leaving, Discord chatter) into short newspaper-style articles matching the Gazette's established voice.

VOICE AND STYLE:
- Journalistic, slightly formal, in-universe (write as if this is a real world with real politics, not "a Minecraft server")
- Never break character to mention Minecraft, plugins, servers, or game mechanics directly
- Bylines are either a named correspondent role ("By Our Diplomatic Correspondent") or "Staff Report"
- Categories used so far: Diplomacy, Settlement, Economy, Culture, Governance, War, Call for Writers — reuse these where they fit, or propose a new one if genuinely needed
- Keep articles factual and grounded in the input data. Do NOT invent people, events, or details not present in the input.
- For "side" and "grid" placement articles, write exactly ONE paragraph.
- For "lead" placement (only use this if the change is genuinely significant — a new town is NOT lead-worthy, a major political shift might be), write 3-5 paragraphs.
- If the input data is thin (e.g. a single resident joining a town), write a brief, modest article — don't inflate small events into dramatic ones.

OUTPUT FORMAT: Respond with ONLY a JSON array (no markdown fences, no commentary) of article objects, each matching this shape:
{
  "id": "kebab-case-slug",
  "placement": "lead" | "side" | "grid",
  "category": "string",
  "headline": "string",
  "byline": "string",
  "body": ["paragraph 1", "paragraph 2", ...]
}
If there's truly nothing worth a full article (e.g. only bot noise in the Discord data), return an empty array [].`;

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function summarizeChangesForPrompt(pending) {
  const lines = [];
  for (const c of pending.minecraft || []) {
    if (c.type === 'new_town') lines.push(`- New town founded: "${c.town}", mayor ${c.mayor}, ${c.residentCount} resident(s).`);
    else if (c.type === 'new_resident') lines.push(`- ${c.username} joined the town of ${c.town}.`);
    else if (c.type === 'new_mayor') lines.push(`- ${c.username} became mayor of ${c.town}.`);
    else if (c.type === 'resident_left') lines.push(`- ${c.username} left the town of ${c.town}.`);
    else if (c.type === 'town_lost') lines.push(`- The town of ${c.town} no longer appears on the map (disbanded or fell).`);
  }
  for (const m of pending.discord || []) {
    lines.push(`- Discord message from ${m.author}: "${m.content}"`);
  }
  return lines.join('\n');
}

async function draftArticles(changesSummary) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Here are the raw events since the last issue. Draft articles from them:\n\n${changesSummary}` },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }
  const data = await res.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text content in API response.');

  let cleaned = textBlock.text.trim();
  // Defensive: strip markdown fences if the model adds them despite instructions.
  cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned);
}

async function main() {
  if (!API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — skipping article drafting this run.');
    return;
  }

  const pending = loadJson(PENDING_PATH, { minecraft: [], discord: [] });
  const hasChanges = (pending.minecraft || []).length || (pending.discord || []).length;
  if (!hasChanges) {
    console.log('Nothing pending — no drafting needed this run.');
    return;
  }

  const summary = summarizeChangesForPrompt(pending);
  console.log('Drafting from:\n' + summary);

  const articles = await draftArticles(summary);
  if (!articles.length) {
    console.log('Model returned no articles worth publishing from this batch.');
  } else {
    if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    const filename = `draft-${new Date().toISOString().slice(0, 10)}-${Date.now()}.json`;
    const outPath = path.join(DRAFTS_DIR, filename);
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), articles }, null, 2) + '\n');
    console.log(`Wrote ${articles.length} draft article(s) to drafts/${filename} — review before publishing.`);
  }

  // Clear pending changes now that they've been drafted (successfully or not
  // — if drafting failed, main() would have thrown before reaching here).
  fs.writeFileSync(PENDING_PATH, JSON.stringify({ minecraft: [], discord: [] }, null, 2) + '\n');
}

main().catch(err => {
  console.error('draft-articles.js failed:', err.message);
  process.exit(1);
});
