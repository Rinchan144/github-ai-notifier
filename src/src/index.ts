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

async function fetchHotLocalAIRepos(): Promise<GitHubRepo[]> {
  // Bộ lọc kết hợp: Local AI / MCP / Ollama + các từ khóa về Agent, Skill, Markdown management
  const queryKeywords = '(topic:local-ai OR topic:ollama OR topic:llm OR topic:mcp) (markdown OR agent OR skill OR prompt)';
  const query = encodeURIComponent(`${queryKeywords} pushed:>2026-11-01`);
  const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=5`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'vnd.github+json',
      'User-Agent': 'GitHub-AI-Notifier'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.statusText}`);
  }

  const data = await response.json() as { items: GitHubRepo[] };
  return data.items;
}

async function sendTelegramMessage(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram API error: ${err}`);
  }
}

async function main() {
  try {
    console.log('Fetching hot Local AI & Agent Markdown repos from GitHub...');
    const repos = await fetchHotLocalAIRepos();

    if (!repos || repos.length === 0) {
      console.log('No matching repositories found.');
      return;
    }

    let message = `🔥 *Top Local AI & Agent Markdown Repos* 🔥\n\n`;
    repos.forEach((repo, index) => {
      const topicsStr = repo.topics && repo.topics.length > 0 
        ? repo.topics.slice(0, 3).map(t => `#${t}`).join(' ') 
        : '';

      message += `${index + 1}. *[${repo.full_name}](${repo.html_url})*\n`;
      message += `⭐ ${repo.stargazers_count} | 💻 ${repo.language || 'N/A'}\n`;
      if (topicsStr) message += `🏷️ ${topicsStr}\n`;
      message += `📝 ${repo.description ? repo.description.slice(0, 100) + '...' : 'No description'}\n\n`;
    });

    await sendTelegramMessage(message);
    console.log('Telegram notification sent successfully!');
  } catch (error) {
    console.error('Error running notifier:', error);
    process.exit(1);
  }
}

main();