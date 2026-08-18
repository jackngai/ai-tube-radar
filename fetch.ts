// Pulls each channel's real upload feed (YouTube RSS, no API key) and computes cadence.
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

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

  const dates = entries.map(e => +new Date(e.published));
  const gaps = dates.slice(0, -1).map((d, i) => (d - dates[i + 1]) / day);
  const now = Date.now();
  out.push({
    name: c.name,
    channelId: id,
    watched: c.watched,
    latest: { ...entries[0], topic: topicOf(entries[0].title) ?? beatOf(entries.map(e => e.title)), topicIsBeat: !topicOf(entries[0].title) },
    prev: entries[1] ?? null,
    daysSince: Math.floor((now - dates[0]) / day),
    lastGap: gaps[0] != null ? Math.round(gaps[0] * 10) / 10 : null,
    medianGap: Math.round(median(gaps) * 10) / 10,
    last30: dates.filter(d => now - d < 30 * day).length,
    // The RSS feed only carries 15 uploads, so a full window means "at least this many".
    capped: dates.filter(d => now - d < 30 * day).length === entries.length,
    cadence: cadenceOf(median(gaps)),
    span: entries.length,
  });
  console.error(`ok ${c.name} (${entries.length} uploads)`);
}

out.sort((a, b) => a.daysSince - b.daysSince);
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify({ generated: new Date().toISOString(), channels: out }, null, 2));
console.error(`\nwrote ${out.length} channels`);
