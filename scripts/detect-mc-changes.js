// Detects what's changed in Colombia's towns since the last check — new towns
// founded, residents joining/leaving, mayors changing — by diffing against a
// saved snapshot. Appends anything new to data/pending-changes.json for the
// article-drafting script to pick up later.
//
// KNOWN LIMITATION: this hits the same map host as the Colombia site's own
// roster sync did, and that host blocks requests from GitHub Actions' IP
// ranges (confirmed via three separate attempts — plain fetch, fetch with
// browser headers, and a full headless-browser fetch, all 403'd). This script
// is built the same way regardless, so it starts working immediately, for
// free, the moment that's unblocked (either the map host allowlists GitHub,
// or the server owner's own API is ready to use instead — see MC_SOURCE_URL
// below to swap it in). Until then, this step will log a warning and produce
// zero changes each run — not a crash, just no data.
//
// Run manually with: node scripts/detect-mc-changes.js

const fs = require('fs');
const path = require('path');

// Swap this to the server owner's own API URL once it exists — everything
// else (the diffing logic) stays the same as long as it returns the same
// {towns: [{name, residents: [{username}]}]} shape, or you adjust parseSource().
const MC_SOURCE_URL = 'https://map.diplomaticamc.com/tiles/minecraft_overworld/markers.json';
const NATION_FILTER = 'Colombia';

const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'last-towny-snapshot.json');
const PENDING_PATH = path.join(__dirname, '..', 'data', 'pending-changes.json');

function parseSource(data) {
  const claimsLayer = (data.layers || []).find(l => l.id === 'towny_claims');
  if (!claimsLayer) throw new Error('No "towny_claims" layer found — map plugin may have changed.');
  return claimsLayer.markers
    .filter(m => m.meta && m.meta['%nation%'] === NATION_FILTER && m.meta['%town%'])
    .map(m => {
      const residents = (m.meta['%residents%'] || m.meta['%mayor%'] || '').split(',').map(s => s.trim()).filter(Boolean);
      return { name: (m.meta['%town%'] || '').replace(/_/g, ' '), residents };
    })
    .filter(t => t.name && t.residents.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function diffTowns(previous, current) {
  const changes = [];
  const prevByName = new Map(previous.map(t => [t.name, t]));
  const currByName = new Map(current.map(t => [t.name, t]));

  for (const town of current) {
    const prevTown = prevByName.get(town.name);
    if (!prevTown) {
      changes.push({
        type: 'new_town',
        town: town.name,
        mayor: town.residents[0],
        residentCount: town.residents.length,
        detectedAt: new Date().toISOString(),
      });
      continue;
    }
    const prevResidents = new Set(prevTown.residents);
    const currResidents = new Set(town.residents);
    for (const username of town.residents) {
      if (!prevResidents.has(username)) {
        changes.push({
          type: username === town.residents[0] && prevTown.residents[0] !== username ? 'new_mayor' : 'new_resident',
          town: town.name,
          username,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    for (const username of prevTown.residents) {
      if (!currResidents.has(username)) {
        changes.push({ type: 'resident_left', town: town.name, username, detectedAt: new Date().toISOString() });
      }
    }
  }
  for (const town of previous) {
    if (!currByName.has(town.name)) {
      changes.push({ type: 'town_lost', town: town.name, detectedAt: new Date().toISOString() });
    }
  }
  return changes;
}

async function main() {
  let current;
  try {
    const res = await fetch(MC_SOURCE_URL);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    current = parseSource(data);
  } catch (err) {
    console.warn(`MC change detection skipped this run — could not reach the source: ${err.message}`);
    return; // Not a failure — just nothing to report this run.
  }

  const previous = loadJson(SNAPSHOT_PATH, []);
  const changes = diffTowns(previous, current);

  if (changes.length) {
    const pending = loadJson(PENDING_PATH, { minecraft: [], discord: [] });
    pending.minecraft = [...(pending.minecraft || []), ...changes];
    fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
    console.log(`Detected ${changes.length} Minecraft change(s):`, changes.map(c => c.type).join(', '));
  } else {
    console.log('No Minecraft changes detected this run.');
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n');
}

main().catch(err => {
  console.error('detect-mc-changes.js failed unexpectedly:', err.message);
  process.exit(1);
});
