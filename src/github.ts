// src/github.ts
import { fetchWithRetry } from './utils/fetcher.js';

export async function fetchGithubTrendingRepos() {
  const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  
  // Xây dựng query tìm kiếm (ví dụ: tìm các repo MCP hoặc Local AI hot)
  const query = 'mcp OR "model-context-protocol" OR "local-ai" created:>2026-11-01';
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=20`;

  const headers: HeadersInit = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'github-ai-notifier-bot',
  };

  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers,
      timeoutMs: 12000, // Timeout 12 giây cho GitHub API
      retries: 3,       // Thử lại tối đa 3 lần nếu mạng rớt
    });

    const data = await response.json();
    return data.items || [];
  } catch (error) {
    console.error("Critical error fetching GitHub repositories:", error);
    throw error;
  }
}