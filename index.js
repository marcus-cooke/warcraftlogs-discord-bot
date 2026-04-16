import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { fetchFights, fetchFightDetails, formatDuration, buildFightUrl } from './wcl-parser.js';

// ─────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 30_000;       // 30 seconds
const AUTO_STOP_MINUTES = 30;          // 30 minutes of no activity
const DEFAULT_CHANNEL_ID = null;       // Set to a specific channel ID to restrict

// ─────────────────────────────────────────────────────────
// Slash Commands
// ─────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start tracking raid pulls from a WarcraftLogs report')
    .addStringOption(opt =>
      opt.setName('report')
        .setDescription('WarcraftLogs URL (e.g. https://www.warcraftlogs.com/reports/xxxxx)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop tracking current raid and get a summary'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current tracking status'),
].map(c => c.toJSON());

// ─────────────────────────────────────────────────────────
// Raid Tracker State
// ─────────────────────────────────────────────────────────
class RaidTracker {
  constructor() {
    this.active = false;
    this.reportCode = null;
    this.channel = null;
    this.startedBy = null;
    this.startedAt = null;
    this.fights = [];                   // All fights from the report
    this.trackedFightId = null;         // boss name/ID we're watching
    this.trackedFightName = null;
    this.previousPulls = new Set();     // fight IDs already announced
    this.autoStopTimer = null;
    this.pollTimer = null;
    this.pullTimeline = [];             // [{ data, comparison }]
    this.bestKill = null;               // fastest kill
    this.pullCount = 0;
  }

  reset() {
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.active = false;
    this.reportCode = null;
    this.channel = null;
    this.startedBy = null;
    this.startedAt = null;
    this.fights = [];
    this.trackedFightId = null;
    this.trackedFightName = null;
    this.previousPulls = new Set();
    this.autoStopTimer = null;
    this.pollTimer = null;
    this.pullTimeline = [];
    this.bestKill = null;
    this.pullCount = 0;
  }
}

const tracker = new RaidTracker();

// ─────────────────────────────────────────────────────────
// Discord Client
// ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register slash commands
  if (process.env.DISCORD_CLIENT_ID) {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    ).then(
      () => console.log('✅ Slash commands registered'),
      err => console.error('Failed to register commands:', err.message)
    );
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'start':    await cmdStart(interaction); break;
      case 'stop':     await cmdStop(interaction); break;
      case 'status':   await cmdStatus(interaction); break;
    }
  } catch (err) {
    console.error('Command error:', err);
    const reply = { content: `❌ ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// ─────────────────────────────────────────────────────────
// /start — Parse URL, load fights, begin polling
// ─────────────────────────────────────────────────────────
async function cmdStart(interaction) {
  const url = interaction.options.getString('report');
  const reportCode = extractReportCode(url);

  if (!reportCode) {
    return interaction.reply({
      content: '❌ Invalid WarcraftLogs URL. Use: `https://www.warcraftlogs.com/reports/xxxxx`',
      ephemeral: true
    });
  }

  // Already tracking same report
  if (tracker.active && tracker.reportCode === reportCode) {
    return interaction.reply({ content: '⚠️ Already tracking this report!', ephemeral: true });
  }

  // If tracking a different report, stop it first
  if (tracker.active) {
    sendSummary('New /start received');
    tracker.reset();
  }

  await interaction.deferReply();

  console.log(`Loading report ${reportCode}...`);
  const fights = await fetchFights(reportCode);

  if (!fights || fights.length === 0) {
    return interaction.editReply(
      '❌ No fights found. Check that the report is public and the URL is correct.'
    );
  }

  // Initialize tracker
  tracker.active = true;
  tracker.reportCode = reportCode;
  tracker.channel = interaction.channel;
  tracker.startedBy = interaction.user;
  tracker.startedAt = Date.now();
  tracker.fights = fights;

  // Identify the encounter types
  const bossFights = fights.filter(f => f.type !== 'event' && f.name);
  const lastFight = bossFights[bossFights.length - 1];
  tracker.trackedFightName = lastFight.name;
  tracker.trackedFightId = lastFight.id;

  // Seed known pulls
  seedKnownPulls(fights, lastFight.name);

  // Show fight list
  const fightList = fights.map(f => {
    if (f.type === 'event' || !f.name) return null;
    const icon = f.kill ? '✅' : '❌';
    return `${icon} \`${f.name}\` (#${f.id}) — ${formatDuration(f.duration)}`;
  }).filter(Boolean).join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📋 Fights Discovered')
    .setDescription(fightList || 'No pull fights found.')
    .setFooter({ text: `Tracking: ${tracker.trackedFightName} (#${tracker.trackedFightId})` })
    .setColor(0x5865F2);

  await interaction.editReply({ embeds: [embed] });

  // Announce in channel and start polling
  await interaction.channel.send(
    `✅ Now tracking **${tracker.trackedFightName}**. Polling every 30s. I'll report after each new pull and summarize after 30 min of inactivity.`
  );

  resetAutoStopTimer();
  tracker.pollTimer = setInterval(pollForNewPulls, POLL_INTERVAL_MS);
}

function seedKnownPulls(fights, fightName) {
  for (const f of fights) {
    if (f.name === fightName) {
      tracker.previousPulls.add(f.id);
    }
  }
}

// ─────────────────────────────────────────────────────────
// /stop — Halt polling and send summary
// ─────────────────────────────────────────────────────────
async function cmdStop(interaction) {
  if (!tracker.active) {
    return interaction.reply({ content: '⚠️ Not tracking any raid.', ephemeral: true });
  }

  await interaction.reply('🛑 Stopping tracker…');
  sendSummary('Manual stop via /stop');
  tracker.reset();
}

// ─────────────────────────────────────────────────────────
// /status — Show current state
// ─────────────────────────────────────────────────────────
async function cmdStatus(interaction) {
  if (!tracker.active) {
    return interaction.reply({ content: '⚠️ Idle. Use `/start <url>` to begin tracking.', ephemeral: true });
  }

  const elapsed = ((Date.now() - tracker.startedAt) / 60000).toFixed(1);
  const kills = tracker.pullTimeline.filter(p => p.data && p.data.kill).length;
  const wipes = tracker.pullTimeline.length - kills;

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ Tracking Active`)
    .addFields(
      { name: 'Report', value: `\`${tracker.reportCode}\``, inline: true },
      { name: 'Boss', value: tracker.trackedFightName || 'Unknown', inline: true },
      { name: 'Status', value: '🟢 Polling', inline: true },
      { name: 'Elapsed', value: `${elapsed} min`, inline: true },
      { name: 'Pulls', value: `${tracker.pullTimeline.length} (${kills}K / ${wipes}W)`, inline: true },
      { name: 'Best Kill', value: tracker.bestKill ? formatDuration(tracker.bestKill.duration) : '—', inline: true }
    )
    .setColor(0x23A559);

  return interaction.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────
// Polling — check for new pulls every 30s
// ─────────────────────────────────────────────────────────
async function pollForNewPulls() {
  if (!tracker.active || !tracker.reportCode) return;

  try {
    const fights = await fetchFights(tracker.reportCode);
    if (!fights) return;

    // Find pulls matching our tracked fight name
    const currentPulls = fights.filter(f =>
      f.name === tracker.trackedFightName
    );

    // Discover new pull IDs
    for (const pull of currentPulls) {
      if (tracker.previousPulls.has(pull.id)) continue;

      // New pull found!
      tracker.previousPulls.add(pull.id);
      tracker.pullCount++;
      tracker.trackedFightId = pull.id;

      processNewPull(pull, fights);
      resetAutoStopTimer();
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

async function processNewPull(pull, allFights) {
  console.log(`New pull: #${pull.id} — ${pull.name} — ${pull.kill ? 'KILL' : 'WIPE'}`);

  const idx = tracker.pullTimeline.length;
  const prevPull = tracker.pullTimeline[idx - 1]?.data ?? null;
  const comparison = buildComparison(prevPull, pull);

  // Track best kill
  if (pull.kill) {
    if (!tracker.bestKill || pull.duration < tracker.bestKill.duration) {
      tracker.bestKill = pull;
    }
  }

  tracker.pullTimeline.push({ data: pull, comparison });

  // — Fetch detailed data from Wipefest —
  const details = await fetchFightDetails(tracker.reportCode, pull.id);

  // — Build embed —
  const color = pull.kill ? 0x23A559 : 0xED4245;
  const icon = pull.kill ? '✅' : '❌';

  const embed = new EmbedBuilder()
    .setTitle(`${icon} Pull #${idx + 1}: ${pull.name}`)
    .setColor(color)
    .addFields(
      { name: 'Result', value: pull.kill ? 'Kill' : 'Wipe', inline: true },
      { name: 'Duration', value: formatDuration(pull.duration), inline: true },
      { name: 'Difficulty', value: difficultyName(pull.difficulty), inline: true },
      { name: 'Pull #', value: `${idx + 1} of this boss`, inline: true },
    );

  // Comparison to previous
  if (comparison) {
    let text = '';
    if (comparison.durDiff !== 0) {
      const sign = comparison.durDiff > 0 ? '+' : '';
      const arrow = comparison.durDiff > 0 ? '📈' : '⬇️';
      text += `${arrow} Duration: ${sign}${formatDuration(Math.abs(comparison.durDiff))}\n`;
    }
    for (const [role, val] of Object.entries(comparison.details || {})) {
      text += `${role}: ${val}\n`;
    }
    if (text) embed.addFields({ name: '🔄 vs Previous', value: text });
  }

  // Wipefest details
  if (details && details.mechanics && details.mechanics.length > 0) {
    const mechText = details.mechanics
      .filter(m => m.score !== null && m.score < 50)  // below avg = highlight
      .slice(0, 3)
      .map(m => `• ${m.name}: **${m.score}/100** (needs work)`)
      .join('\n');

    if (mechText) {
      embed.addFields({ name: '⚠️ Weak Mechanics', value: mechText });
    }
  }

  // Coaching feedback
  const feedback = generateFeedback(pull, comparison, details);
  if (feedback) {
    embed.addFields({ name: '💡 Notes', value: feedback.slice(0, 1024) });
  }

  // Link to fight
  embed.setURL(buildFightUrl(tracker.reportCode, pull.id));

  await tracker.channel.send({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────
// Comparison between pulls
// ─────────────────────────────────────────────────────────
function buildComparison(prev, curr) {
  if (!prev) return null;

  const comp = { durDiff: curr.duration - prev.duration, details: {} };

  // Check if the fight got shorter (good for kills, ambiguous for wipes)
  if (curr.kill && prev.kill && curr.duration < prev.duration) {
    comp.details['Optimization'] = `⚡ ${Math.abs(comp.durDiff / 1000).toFixed(0)}s faster`;
  }

  return comp;
}

// ─────────────────────────────────────────────────────────
// Coaching Feedback
// ─────────────────────────────────────────────────────────
function generateFeedback(pull, comparison, details) {
  const notes = [];

  if (pull.kill) {
    if (pull.duration > 600000) {  // > 10 min
      notes.push('⏱️ Long kill — check DPS/healer efficiency and whether subphases are being skipped.');
    } else {
      notes.push('✅ Clean kill. Check if cooldowns can be compressed for speed.');
    }
  } else {
    // Wipe analysis
    const mins = pull.duration / 60000;
    if (mins < 1) {
      notes.push('💥 Early wipe — review the pull strategy, tank positioning, and opener timing.');
    } else if (mins < 3) {
      notes.push('🔍 Mid-fight wipe — likely a phase transition or mechanic execution issue.');
    } else if (mins > 10) {
      notes.push('🐢 Long wipe — check healer mana, enrage timers, and whether DPS is sufficient.');
    }
    notes.push(`Review the full fight analysis: [Wipefest](https://www.wipefest.gg/report/${tracker.reportCode}/fight/${pull.id})`);
  }

  // Mechanic-specific
  if (details?.mechanics) {
    const lowMech = details.mechanics
      .filter(m => m.score !== null && m.score < 30)
      .slice(0, 2)
      .map(m => m.name)
      .join(', ');
    if (lowMech) {
      notes.push(`📉 Focus areas: ${lowMech}`);
    }
  }

  // Progression encouragement
  if (!pull.kill && tracker.pullCount >= 5) {
    notes.push('You\'ve had 5+ attempts — consider reviewing the kill comp, cooldown assignments, or assigning specific mechanic responsibilities.');
  }

  if (notes.length === 0) return null;
  return notes.join('\n');
}

// ─────────────────────────────────────────────────────────
// Auto-stop Timer — stops after 30 min of no new pulls
// ─────────────────────────────────────────────────────────
function resetAutoStopTimer() {
  if (tracker.autoStopTimer) clearTimeout(tracker.autoStopTimer);

  tracker.autoStopTimer = setTimeout(async () => {
    if (!tracker.active) return;
    console.log('Auto-stop triggered — 30 min of no new pulls');
    sendSummary(`No new pull in ${AUTO_STOP_MINUTES} minutes`);
    tracker.reset();
  }, AUTO_STOP_MINUTES * 60 * 1000);
}

// ─────────────────────────────────────────────────────────
// Raid Summary Report
// ─────────────────────────────────────────────────────────
async function sendSummary(reason) {
  const pulls = tracker.pullTimeline;
  if (pulls.length === 0) {
    if (tracker.channel) {
      await tracker.channel.send(`🛑 Tracker stopped. ${reason ? `Reason: ${reason}` : ''}`);
    }
    return;
  }

  const kills = pulls.filter(p => p.data?.kill);
  const wipes = pulls.filter(p => !p.data?.kill);

  const summary = [];
  summary.push(`**Raid Summary: ${tracker.trackedFightName || 'Unknown'}**`);
  summary.push(`Report: \`https://www.warcraftlogs.com/reports/${tracker.reportCode}\``);
  summary.push(`Duration: ${((Date.now() - tracker.startedAt) / 60000).toFixed(0)} min`);
  summary.push(`**Result: ${kills.length} ✅ / ${wipes.length} ❌**`);
  summary.push('');

  // Pull timeline
  summary.push('**Pull History:**');
  for (let i = 0; i < pulls.length; i++) {
    const p = pulls[i].data;
    const icon = p.kill ? '✅' : '❌';
    summary.push(`${i + 1}. ${icon} ${formatDuration(p.duration)}`);
  }

  // Best kill
  if (tracker.bestKill) {
    summary.push('');
    summary.push(`🏆 **Best Kill:** ${formatDuration(tracker.bestKill.duration)}`);
  }

  // Recommendations
  if (wipes.length > 0 && kills.length === 0) {
    summary.push('');
    if (wipes.length >= 5) {
      summary.push('❌ Consider reviewing fundamentals — cooldown usage, positioning, and mechanic assignments. The raid needs to find what works before pushing more pulls.');
    } else {
      summary.push('🔄 Making progress — keep adjusting strategy.');
    }
  }

  if (tracker.channel) {
    const embed = new EmbedBuilder()
      .setTitle('📊 Raid Summary')
      .setDescription(summary.join('\n'))
      .setColor(kills.length > 0 ? 0x23A559 : 0x5865F2)
      .setFooter({ text: `WarcraftLogs Tracker • ${new Date().toLocaleDateString()}` });

    await tracker.channel.send({ embeds: [embed] });
  }
}

// ─────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────
function extractReportCode(url) {
  const match = url?.match(/warcraftlogs\.com\/reports\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function difficultyName(id) {
  const map = { 1: 'LFR', 2: 'Normal', 3: 'Heroic', 4: 'Mythic' };
  return map[id] || 'Unknown';
}

// ─────────────────────────────────────────────────────────
// Login & Start
// ─────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
