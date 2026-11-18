import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RepoItem {
  category: string;
  fullName: string;
  stars: number;
  description: string;
  url: string;
  createdAt: string;
  latestRelease?: string;
  healthScore: number;
}

interface RepoHistoryRecord {
  lastSentTimestamp: number;
  lastSentStars: number;
  initialRecordedStars: number;
  totalGainSinceTracked: number;
}

interface StateFileStructure {
  $schema?: string;
  repos: Record<string, RepoHistoryRecord>;
}

interface TopicConfig {
  category: string;
  query: string;
}

const HISTORY_FILE = path.join(__dirname, '../data/sent-history.json');
const CONFIG_FILE = path.join(__dirname, '../config/topics.json');
const ARCHIVE_DIR = path.join(__dirname, '../archives');

const COOLDOWN_DAYS = 5;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const MIN_STAR_GAIN = 100;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*`[\]])/g, '\\$1');
}

// 1. Đọc và lưu State V2
function loadState(): StateFileStructure {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (!parsed.repos) {
        const migratedRepos: Record<string, RepoHistoryRecord> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const val: any = v;
          const stars = typeof val === 'object' && val.stars ? val.stars : 0;
          migratedRepos[k] = {
            lastSentTimestamp: typeof val === 'number' ? val : (val.timestamp || Date.now()),
            lastSentStars: stars,
            initialRecordedStars: stars,
            totalGainSinceTracked: 0
          };
        }
        return { repos: migratedRepos };
      }
      return parsed;
    } catch (error) {
      console.error('⚠️ Lỗi đọc state file:', error);
      return { repos: {} };
    }
  }
  return { repos: {} };
}

function saveState(state: StateFileStructure) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const cleanedRepos: Record<string, RepoHistoryRecord> = {};
  for (const [fullName, record] of Object.entries(state.repos)) {
    if (now - record.lastSentTimestamp <= MAX_RETENTION_MS) {
      cleanedRepos[fullName] = record;
    }
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ $schema: "Version 2.0 State Tracking", repos: cleanedRepos }, null, 2), 'utf-8');
}

// 2. Gửi tin nhắn Telegram (Có chunking và xử lý lỗi)
async function sendTelegramMessage(message: string, replyToMessageId?: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Thiếu Telegram Token hoặc Chat ID.');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const MAX_LENGTH = 4000;

  for (let i = 0; i < message.length; i += MAX_LENGTH) {
    const chunk = message.slice(i, i + MAX_LENGTH);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(replyToMessageId && i === 0 ? { reply_to_message_id: replyToMessageId } : {})
      }),
    });

    const data: any = await res.json();
    if (!data.ok) {
      console.error(`❌ Telegram từ chối gửi tin nhắn: ${data.description}`);
    }
  }
  console.log('✅ Đã gửi bản tin qua Telegram thành công.');
}

// 3. Lấy Release Notes & Health Score
async function fetchLatestRelease(fullName: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/releases/latest`, {
      headers: {
        'User-Agent': 'github-ai-notifier-bot',
        ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
    });
    if (!res.ok) return 'Chính thức (Stable)';
    const data: any = await res.json();
    return data.tag_name ? `Release ${data.tag_name}` : 'Chính thức (Stable)';
  } catch {
    return 'Chính thức (Stable)';
  }
}

function calculateHealthScore(item: any): number {
  let score = 50;
  if (item.license && item.license.spdx_id !== 'NOASSERTION') score += 20;
  if (item.has_issues) score += 10;
  if (item.forks_count > 10) score += 10;
  if (item.description && item.description.length > 20) score += 10;
  return Math.min(score, 100);
}

// 4. Đọc file config topics
function loadTopics(): TopicConfig[] {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed.topics) return parsed.topics;
    } catch (e) {
      console.error('⚠️ Lỗi đọc config topics:', e);
    }
  }
  return [
    { category: '💻 Coding & AI Assistants', query: 'AI agent OR MCP OR local-ai' },
    { category: '🧪 QA & Test Automation', query: 'playwright OR test-automation OR software-testing' }
  ];
}

// 5. Fetch dữ liệu đa chủ đề từ config
async function fetchTrendingRepos(): Promise<RepoItem[]> {
  const topics = loadTopics();
  const dateObj = new Date();
  dateObj.setDate(dateObj.getDate() - 30);
  const isoDate = dateObj.toISOString().split('T')[0];
  const allRepos: RepoItem[] = [];

  for (const topic of topics) {
    const query = `${topic.query} created:>${isoDate} sort:stars-desc`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'github-ai-notifier-bot',
          ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      if (!res.ok) {
        console.error(`⚠️ GitHub API trả về lỗi (${res.status}) cho chủ đề [${topic.category}]`);
        continue;
      }

      const data: any = await res.json();
      for (const item of (data.items || [])) {
        const healthScore = calculateHealthScore(item);
        if (healthScore >= 60) {
          const latestRelease = await fetchLatestRelease(item.full_name);
          allRepos.push({
            category: topic.category,
            fullName: item.full_name,
            stars: item.stargazers_count,
            description: item.description ? item.description.slice(0, 120) + '...' : 'Không có mô tả.',
            url: item.html_url,
            createdAt: item.created_at,
            latestRelease,
            healthScore
          });
        }
      }
    } catch (e) {
      console.error(`⚠️ Lỗi kết nối khi fetch chủ đề [${topic.category}]:`, e);
    }
  }

  return allRepos;
}

// 6. Lưu file Markdown Archive và INDEX.md
function saveMarkdownArchive(repos: RepoItem[]) {
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const archivePath = path.join(ARCHIVE_DIR, `${today}.md`);

  let content = `# 🚀 GitHub AI & QA Highlights - ${today}\n\n`;
  content += `Tổng hợp các dự án nổi bật được bot tự động quét và kiểm duyệt chất lượng.\n\n`;

  repos.forEach((repo, idx) => {
    content += `### ${idx + 1}. [${repo.fullName}](${repo.url})\n`;
    content += `- **Danh mục:** ${repo.category}\n`;
    content += `- **Stars:** ⭐ ${repo.stars} | **Health Score:** 🛡️ ${repo.healthScore}% | **Version:** 🏷️ ${repo.latestRelease}\n`;
    content += `- **Mô tả:** ${repo.description}\n\n`;
  });

  fs.writeFileSync(archivePath, content, 'utf-8');
  console.log(`📁 Đã lưu file archive: archives/${today}.md`);
}

function updateArchiveIndex() {
  if (!fs.existsSync(ARCHIVE_DIR)) return;

  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter(file => file.endsWith('.md') && file !== 'INDEX.md')
    .sort()
    .reverse();

  let indexContent = `# 📚 Knowledge Base - Archive Index\n\n`;
  indexContent += `Trang mục lục tổng hợp toàn bộ các bản tin AI & QA Automation Highlights.\n\n`;
  indexContent += `| Ngày (Date) | File Bản Tin | Trạng thái |\n` +
                  `| :--- | :--- | :--- |\n`;

  files.forEach(file => {
    const dateStr = file.replace('.md', '');
    indexContent += `| **${dateStr}** | [Xem chi tiết](./${file}) | 🟢 Active |\n`;
  });

  const indexPath = path.join(ARCHIVE_DIR, 'INDEX.md');
  fs.writeFileSync(indexPath, indexContent, 'utf-8');
  console.log(`📚 Đã cập nhật file mục lục: archives/INDEX.md`);
}

// 7. Xử lý lệnh Telegram tương tác
async function handleTelegramCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=1`);
    const data: any = await res.json();
    if (!data.ok || !data.result || data.result.length === 0) return;

    const update = data.result[data.result.length - 1];
    const message = update.message;
    if (!message || !message.text) return;

    const text = message.text.trim();

    if (text === '/top') {
      const state = loadState();
      const sortedRepos = Object.entries(state.repos)
        .sort((a, b) => b[1].lastSentStars - a[1].lastSentStars)
        .slice(0, 5);

      let reply = `🏆 *Top 5 Repos có nhiều star nhất trong lịch sử:*\n\n`;
      sortedRepos.forEach(([name, rec], idx) => {
        reply += `${idx + 1}. \`${name}\` (⭐ ${rec.lastSentStars} stars)\n`;
      });
      await sendTelegramMessage(reply, message.message_id);
    } 
    else if (text.startsWith('/search')) {
      const keyword = text.replace('/search', '').trim().toLowerCase();
      if (!keyword) {
        await sendTelegramMessage(`⚠️ Vui lòng nhập từ khóa. Ví dụ: \`/search playwright\``, message.message_id);
        return;
      }
      const state = loadState();
      const matchedRepos = Object.entries(state.repos)
        .filter(([fullName]) => fullName.toLowerCase().includes(keyword))
        .slice(0, 10);

      if (matchedRepos.length === 0) {
        await sendTelegramMessage(`🔍 Không tìm thấy repo nào chứa từ khóa *"${keyword}"*.`, message.message_id);
      } else {
        let reply = `🔍 *Kết quả tìm kiếm cho "${keyword}" (${matchedRepos.length}):*\n\n`;
        matchedRepos.forEach(([name, rec], idx) => {
          reply += `${idx + 1}. [${name}](https://github.com/${name}) (⭐ ${rec.lastSentStars} stars)\n`;
        });
        await sendTelegramMessage(reply, message.message_id);
      }
    }
    else if (text === '/stats') {
      const state = loadState();
      const repos = Object.entries(state.repos);
      let totalStars = repos.reduce((acc, [, rec]) => acc + rec.lastSentStars, 0);

      const statsMessage = 
        `📊 *System Statistics*\n\n` +
        `• 📦 *Tổng số repo theo dõi:* \`${repos.length}\`\n` +
        `• ⭐ *Tổng lượng stars:* \`${totalStars.toLocaleString()}\`\n` +
        `💡 *Hệ thống đang hoạt động ổn định.*`;
      await sendTelegramMessage(statsMessage, message.message_id);
    }
    else if (text === '/help') {
      const helpMessage = 
        `🤖 *GitHub AI & QA Notifier - Lệnh hệ thống*\n\n` +
        `• \`/top\` - Xem top 5 repo star cao nhất.\n` +
        `• \`/search <keyword>\` - Tra cứu lịch sử theo từ khóa.\n` +
        `• \`/stats\` - Xem thống kê tổng quan.\n` +
        `• \`/help\` - Xem hướng dẫn này.`;
      await sendTelegramMessage(helpMessage, message.message_id);
    }
  } catch (e) {}
}

// 8. Hàm chính
async function main() {
  try {
    console.log('🚀 [GitHub AI Notifier] Bắt đầu quét dữ liệu...');
    await handleTelegramCommands();

    const state = loadState();
    const now = Date.now();
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    const fetchedRepos = await fetchTrendingRepos();

    const noteworthyRepos = fetchedRepos.filter(repo => {
      const record = state.repos[repo.fullName];
      const createdDate = new Date(repo.createdAt).getTime();
      const isBrandNew = (now - createdDate) <= ONE_WEEK_MS;

      if (!record) return true;
      if ((now - record.lastSentTimestamp) <= COOLDOWN_MS) return false;
      return (repo.stars - record.lastSentStars) >= MIN_STAR_GAIN;
    });

    if (noteworthyRepos.length === 0) {
      console.log('ℹ️ Không có repo mới đạt chuẩn trong chu kỳ này.');
      return;
    }

    saveMarkdownArchive(noteworthyRepos);
    updateArchiveIndex();

    // Gom nhóm các repo theo từng category để định dạng bản tin Telegram gọn gàng
    const groupedRepos: Record<string, typeof noteworthyRepos> = {};
    noteworthyRepos.forEach(repo => {
      if (!groupedRepos[repo.category]) {
        groupedRepos[repo.category] = [];
      }
      groupedRepos[repo.category].push(repo);
    });

    let messageToTelegram = `🔥 *Top AI & QA Automation Highlights* 🔥\n\n`;

    for (const [category, repos] of Object.entries(groupedRepos)) {
      messageToTelegram += `📂 *${category}*\n`;
      
      repos.forEach(repo => {
        const record = state.repos[repo.fullName];
        const prevStars = record ? record.lastSentStars : repo.stars;
        const gain = repo.stars - prevStars;
        const gainText = gain > 0 ? ` _(📈 +${gain} stars)_` : '';

        messageToTelegram += `  • [${repo.fullName}](${repo.url}) (⭐ ${repo.stars})${gainText}\n`;
        messageToTelegram += `    🏷️ *Ver:* ${repo.latestRelease} | 🛡️ *Health:* ${repo.healthScore}%\n`;
        messageToTelegram += `    └ ${escapeMarkdown(repo.description)}\n`;

        state.repos[repo.fullName] = {
          lastSentTimestamp: now,
          lastSentStars: repo.stars,
          initialRecordedStars: record ? record.initialRecordedStars : repo.stars,
          totalGainSinceTracked: repo.stars - (record ? record.initialRecordedStars : repo.stars)
        };
      });

      messageToTelegram += `\n`;
    }

    saveState(state);
    await sendTelegramMessage(messageToTelegram);
    console.log(`🎉 Hoàn tất! Đã xử lý và gửi ${noteworthyRepos.length} dự án.`);

  } catch (error) {
    console.error('❌ Lỗi thực thi hệ thống:', error);
    process.exit(1);
  }
}

main();