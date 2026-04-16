import http from 'https';

// ─────────────────────────────────────────────────────────
// WarcraftLogs data parser
// ─────────────────────────────────────────────────────────
// WCL is fully JS-rendered — we use proxy sites for data:
//   WoWAnalyzer → fight list
//   Wipefest    → mechanics & scoring

const WOOWANALYZER_BASE = 'https://wowanalyzer.com';
const WIPEFEST_BASE = 'https://www.wipefest.gg';

// ─────────────────────────────────────────────────────────
// Fetch the fight list from WoWAnalyzer
// ─────────────────────────────────────────────────────────
export async function fetchFights(reportCode) {
  const url = `${WOOWANALYZER_BASE}/report/${reportCode}`;
  let html = await fetchHtml(url);

  if (!html) {
    console.error('Failed to fetch WoWAnalyzer');
    return null;
  }

  // WoWAnalyzer embeds fight data as JSON in the page
  const fights = parseFights(html);

  if (!fights || fights.length === 0) {
    html = await fetchHtml(`${WIPEFEST_BASE}/report/${reportCode}`);
    if (!html) return null;
  }

  return fights;
}

function parseFights(html) {
  const fights = [];

  // Try extracting embedded JSON first (most reliable)
  // WoWAnalyzer stores fights data in the initial page load
  try {
    // Pattern: look for fight array in JSON
    const patterns = [
      /"fights"\s*:\s*(\[[\s\S]*?\])/i,
      /"fights"\s*=\s*(\[[\s\S]*?\])/i,
      /fights["']\s*:\s*(\[.*?\])/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          let raw = match[1];
          // Find balanced brackets
          let depth = 0;
          let endIdx = -1;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '[') depth++;
            if (raw[i] === ']') depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
          if (endIdx > 0) {
            raw = raw.slice(0, endIdx + 1);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              return parsed.map(f => ({
                id: f.id ?? f.fightID ?? null,
                name: f.name ?? 'Unknown Fight',
                type: f.type ?? 'EncounterCombat',
                difficulty: f.difficulty ?? 0,
                kill: f.kill ?? false,
                duration: f.duration ?? f.endTime - f.startTime ?? 0,
              })).filter(f => f.id && f.type === 'EncounterCombat');
            }
          }
        } catch (e) {
          // JSON parse failed, fall through to HTML parsing
        }
      }
    }
  } catch (e) {
    // continue
  }

  // Fallback: HTML parsing from the table
  const trRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
  let match;

  while ((match = trRegex.exec(html)) !== null) {
    const tr = match[0];

    // Extract fight info from table row
    const idMatch = tr.match(/data-fight-id["']\s*=\s*["'](\d+)["']/);
    const nameMatch = tr.match(/>([^<]+)</);
    const killMatch = tr.match(/kill|Kill|kill/);
    const durationMatch = tr.match(/(\d+):(\d+)/);

    if (idMatch && nameMatch) {
      fights.push({
        id: parseInt(idMatch[1]),
        name: nameMatch[1].trim(),
        type: 'EncounterCombat',
        difficulty: 0,
        kill: !!killMatch,
        duration: durationMatch ? (parseInt(durationMatch[1]) * 60 + parseInt(durationMatch[2])) * 1000 : 0,
      });
    }
  }

  return fights.length > 0 ? fights : null;
}

// ─────────────────────────────────────────────────────────
// Fetch detailed fight data from Wipefest
// ─────────────────────────────────────────────────────────
export async function fetchFightDetails(reportCode, fightId) {
  const url = `${WIPEFEST_BASE}/report/${reportCode}/fight/${fightId}`;

  const details = {
    id: fightId,
    mechanics: [],
    score: null,
    deaths: null,
  };

  try {
    const html = await fetchHtml(url);
    if (!html) return details;

    // Extract mechanics — Wipefest shows mechanics as named score bars
    // Pattern: "Mechanics Name: 70%" or similar
    const mechRegex = /class="mechanic[^"]*"[^>]*>\s*([\s\S]*?)<\//g;
    let mechMatch;
    while ((mechMatch = mechRegex.exec(html)) !== null) {
      const text = mechMatch[1];
      const nameMatch = text.match(/>([^<]+)</);
      const scoreMatch = text.match(/(\d+)%/);
      if (nameMatch && scoreMatch) {
        details.mechanics.push({
          name: nameMatch[1].trim(),
          score: parseInt(scoreMatch[1]),
        });
      }
    }

    // Extract overall score
    const scoreMatch = html.match(/Overall[^<]*?\s*(\d+)%/);
    if (scoreMatch) {
      details.score = parseInt(scoreMatch[1]);
    }

    // Extract deaths count
    const deathMatch = html.match(/Deaths["']\s*:\s*(\d+)/);
    if (deathMatch) {
      details.deaths = parseInt(deathMatch[1]);
    }

    // Look for mechanic scores in data attributes
    // Wipefest uses class-based percentile styling like: class="score-70"
    const classScoreRegex = /class="[^"]*score-(\d+)[^"]*"[^>]*>([^<]+)</g;
    let classMatch;
    while ((classMatch = classScoreRegex.exec(html)) !== null) {
      details.mechanics.push({
        name: classMatch[2].trim(),
        score: parseInt(classMatch[1]),
      });
    }

  } catch (e) {
    console.error(`Failed to fetch Wipefest details for fight ${fightId}:`, e.message);
  }

  return details;
}

// ─────────────────────────────────────────────────────────
// HTTP Fetch (pure Node, no dependencies)
// ─────────────────────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve) => {
    const timeout = 10000;

    http.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WCL-Tracker/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      timeout: timeout,
    }, (res) => {
      if (res.statusCode >= 400) {
        resolve(null);
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', () => {
      resolve(null);
    }).setTimeout(timeout, (req) => {
      req.abort();
      resolve(null);
    });
  });
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
export function formatDuration(ms) {
  if (!ms || ms <= 0) return 'Unknown';
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function buildFightUrl(reportCode, fightId) {
  return `https://www.warcraftlogs.com/reports/${reportCode}#fight=${fightId}`;
}
