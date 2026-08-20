// Pulls each channel's real upload feed (YouTube RSS, no API key), computes cadence,
// and summarizes each channel's latest video into bullets.
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { GoogleGenAI } from '@google/genai';
// ClaudeClaw's transcript fetcher: handles yt-dlp's auto-caption fallbacks and the
// --no-simulate gotcha. Not worth re-implementing here.
import { fetchVideoBundle } from '/Users/jack/ClaudeClaw/src/youtube.ts';

config({ path: '/Users/jack/ClaudeClaw/.env' });

const db = new Database('/Users/jack/ClaudeClaw/store/claudeclaw.db', { readonly: true });
const channels = db.prepare(`
  SELECT channel AS name,
         MAX(CASE WHEN channel_url LIKE '%/channel/UC%' THEN channel_url END) AS url,
         COUNT(*) AS watched, SUM(worth_implementing) AS ai
  FROM youtube_videos WHERE agent_id='personal'
  GROUP BY channel
  HAVING ai >= 2 AND url IS NOT NULL AND (ai*1.0/COUNT(*)) >= 0.5
  ORDER BY ai DESC`).all() as any[];

const day = 86400000;
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

// Coarse topic tag from the latest video's title. Keyword map beats an LLM call for one word.
const TOPICS: [RegExp, string][] = [
  [/claude code|claude|anthropic|opus|sonnet/i, 'Claude'],
  [/n8n|make\.com|zapier|automation|workflow/i, 'Automation'],
  [/agent|mcp|swarm|subagent/i, 'Agents'],
  [/cursor|windsurf|copilot|codex|vibe cod|coding|developer|dev environment|ide/i, 'AI Coding'],
  [/gpt|openai|gemini|grok|llama|deepseek|qwen|kimi|mistral|model|benchmark|open-?source/i, 'Models'],
  [/veo|sora|midjourney|image|video gen|nano banana|flux|design/i, 'Gen Media'],
  [/rag|vector|embedding|fine-?tun|context engineer|prompt/i, 'RAG & Prompting'],
  [/business|money|client|freelanc|saas|marketing|course|sell/i, 'AI Business'],
  [/news|weekly|this week|roundup|podcast|interview/i, 'News & Talk'],
];
const topicOf = (t: string) => TOPICS.find(([re]) => re.test(t))?.[1] ?? null;
// Vague latest title ("You can just keep the work moving") -> fall back to the channel's usual beat.
const beatOf = (titles: string[]) => {
  const tally = new Map<string, number>();
  for (const t of titles) { const k = topicOf(t); if (k) tally.set(k, (tally.get(k) ?? 0) + 1); }
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'General AI';
};

// Median gap between uploads -> a human cadence label.
const cadenceOf = (d: number) =>
  d < 1.5 ? 'Daily' : d < 3 ? 'Every 2-3 days' : d < 5.5 ? '~2x per week' : d < 10 ? 'Weekly' : d < 18 ? 'Biweekly' : 'Monthly';

const gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// The only summaries worth keeping are the ones for the current latest video of each
// channel, and those already live in the last data.json. So it doubles as the cache:
// unchanged latest video -> no transcript pull, no model call.
const cached: Record<string, string[]> = {};
try {
  for (const c of JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8')).channels ?? []) {
    if (c.latest?.id && c.latest?.bullets?.length) cached[c.latest.id] = c.latest.bullets;
  }
} catch { /* first run, or a hand-broken data.json: summarize everything */ }

async function bulletsFor(videoId: string, title: string): Promise<string[] | null> {
  if (cached[videoId]) return cached[videoId];
  let transcript: string;
  try {
    transcript = (await fetchVideoBundle(videoId)).transcript.fullText;
  } catch (err) {
    console.error(`   no transcript for ${videoId}: ${(err as Error).message}`);
    return null;
  }
  const prompt = [
    'Summarize this YouTube video for someone deciding whether to watch it.',
    '',
    `Title: ${title}`,
    '',
    'Transcript:',
    transcript.slice(0, 14000),
    '',
    'Return strict JSON: {"bullets": ["...", "...", "..."]}',
    '- Exactly 2 or 3 bullets.',
    '- Each under 110 characters, a full clause, no trailing period.',
    '- State what the video actually shows or claims. Concrete tools, numbers, and findings.',
    '- Never write "this video covers", "the creator explains", or any marketing language.',
  ].join('\n');
  try {
    const res = await gemini.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const b = JSON.parse(res.text ?? '{}').bullets;
    return Array.isArray(b) && b.length ? b.slice(0, 3).map(String) : null;
  } catch (err) {
    console.error(`   summary failed for ${videoId}: ${(err as Error).message}`);
    return null;
  }
}

const out: any[] = [];
for (const c of channels) {
  const id = c.url.split('/channel/')[1];
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  if (!res.ok) { console.error(`SKIP ${c.name}: HTTP ${res.status}`); continue; }
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]).map(e => ({
    id: e.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] ?? '',
    title: (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
    published: e.match(/<published>(.*?)<\/published>/)?.[1] ?? '',
    views: Number(e.match(/views="(\d+)"/)?.[1] ?? 0),
  })).filter(e => e.published).sort((a, b) => +new Date(b.published) - +new Date(a.published));
  if (!entries.length) { console.error(`SKIP ${c.name}: empty feed`); continue; }

  // The channel page's og:image is the avatar. No API key, and re-read every run so a
  // creator changing their picture self-heals instead of leaving a dead URL.
  let avatar: string | null = null;
  try {
    const page = await fetch('https://www.youtube.com/channel/' + id, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const m = (await page.text()).match(/<meta property="og:image" content="([^"]+)"/);
    // Default is =s900; 88px is plenty for a 34px slot on a 2x screen.
    if (m) avatar = m[1].replace(/=s\d+-/, '=s88-');
  } catch { /* fall back to the initials badge */ }

  const dates = entries.map(e => +new Date(e.published));
  const gaps = dates.slice(0, -1).map((d, i) => (d - dates[i + 1]) / day);
  const now = Date.now();
  out.push({
    name: c.name,
    channelId: id,
    avatar,
    watched: c.watched,
    latest: { ...entries[0], topic: topicOf(entries[0].title) ?? beatOf(entries.map(e => e.title)), topicIsBeat: !topicOf(entries[0].title) },
    prev: entries[1] ?? null,
    daysSince: Math.floor((now - dates[0]) / day),
    medianGap: Math.round(median(gaps) * 10) / 10,
    cadence: cadenceOf(median(gaps)),
    span: entries.length,
  });
  console.error(`ok ${c.name} (${entries.length} uploads)`);
}

console.error('');
for (const c of out) {
  c.latest.bullets = await bulletsFor(c.latest.id, c.latest.title);
  console.error(`${c.latest.bullets ? 'sum ' : 'NO  '}${c.name}`);
}

out.sort((a, b) => a.daysSince - b.daysSince);
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify({ generated: new Date().toISOString(), channels: out }, null, 2));
console.error(`\nwrote ${out.length} channels`);
