import * as dotenv from 'dotenv';
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string;
  stargazers_count: number;
  language: string;
  topics?: string[];
}

interface CategoryConfig {
  name: string;
  emoji: string;
  query: string;
}

const CATEGORIES: CategoryConfig[] = [
  {
    name: "Coding & IDE Assistants",
    emoji: "💻",
    query: "topic:local-ai (cursor OR copilot OR IDE OR coding) pushed:>2026-11-01"
  },
  {
    name: "Indie Game & 3D Dev",
    emoji: "🎮",
    query: "(topic:local-ai OR topic:ollama) (game OR unity OR unreal OR 3d OR asset) pushed:>2026-11-01"
  },
  {
    name: "Video, Audio & Media",
    emoji: "🎬",
    query: "(topic:local-ai OR topic:llm) (video OR audio OR whisper OR voice OR generation) pushed:>2026-11-01"
  },
  {
    name: "MCP & Agent Frameworks",
    emoji: "🤖",
    query: "(topic:mcp OR topic:agent) (markdown OR skill OR prompt OR workflow) pushed:>2026-11-01"
  }
];

async function fetchReposForQuery(query: string): Promise<GitHubRepo[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=3`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'vnd.github+json',
      'User-Agent': 'GitHub-AI-Notifier'
    }
  });

  if (!response.ok) return [];
  const data = await response.json() as { items?: GitHubRepo[] };
  return data.items || [];
}

async function sendTelegramMessage(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    })
  });
}

async function main() {
  try {
    console.log('Fetching and deduplicating local AI repos...');
    let message = `🔥 *Top Local AI & Agent Highlights* 🔥\n`;
    
    // Set dùng để theo dõi các repo đã được in ra trước đó
    const seenRepos = new Set<string>();
    let totalFound = 0;

    for (const cat of CATEGORIES) {
      const repos = await fetchReposForQuery(cat.query);
      
      // Lọc bỏ những repo đã tồn tại trong set seenRepos
      const uniqueRepos = repos.filter(repo => {
        if (seenRepos.has(repo.full_name)) {
          return false; // Trùng -> Loại bỏ
        }
        seenRepos.add(repo.full_name); // Chưa có -> Thêm vào danh sách đã thấy
        return true;
      });

      if (uniqueRepos.length === 0) continue;

      message += `\n${cat.emoji} *${cat.name}*\n`;
      uniqueRepos.forEach((repo) => {
        totalFound++;
        const shortDesc = repo.description ? repo.description.slice(0, 80) + '...' : 'No description';
        message += `• [${repo.full_name}](${repo.html_url}) (⭐ ${repo.stargazers_count})\n`;
        message += `  └ _${shortDesc}_\n`;
      });
    }

    if (totalFound === 0) {
      console.log('No new unique repositories found.');
      return;
    }

    await sendTelegramMessage(message);
    console.log('Deduplicated notification sent successfully!');
  } catch (error) {
    console.error('Error running notifier:', error);
    process.exit(1);
  }
}

main();