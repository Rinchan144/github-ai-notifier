// src/filters.ts

export interface GitHubRepo {
  full_name: string;
  stargazers_count: number;
  created_at: string;
  updated_at: string;
  topics: string[];
  description: string;
}

export function passesDomainFilter(repo: GitHubRepo): boolean {
  const whitelist = ['mcp', 'model-context-protocol', 'ollama', 'local-ai', 'playwright', 'typescript', 'agent'];
  const blacklist = ['wrapper', 'boilerplate', 'coursenotes', 'homework'];

  const textToCheck = `${repo.full_name} ${repo.description || ''} ${repo.topics.join(' ')}`.toLowerCase();

  const hasValidTopic = whitelist.some(keyword => textToCheck.includes(keyword));
  const hasBlacklist = blacklist.some(keyword => textToCheck.includes(keyword));

  return hasValidTopic && !hasBlacklist;
}

export function isRepoHealthy(repo: GitHubRepo): boolean {
  const lastUpdated = new Date(repo.updated_at).getTime();
  const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);

  const isRecentlyActive = lastUpdated > fourteenDaysAgo;
  const hasDescription = Boolean(repo.description && repo.description.length > 20);

  return isRecentlyActive && hasDescription;
}

// Hàm tổng hợp gộp tất cả các bộ lọc
export function filterQualifyingRepos(repos: GitHubRepo[]): GitHubRepo[] {
  return repos.filter(repo => {
    return passesDomainFilter(repo) && isRepoHealthy(repo);
  });
}