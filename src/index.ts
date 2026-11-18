import 'dotenv/config'; // Hỗ trợ đọc file .env khi chạy test cục bộ
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Hỗ trợ __dirname trong môi trường ES Module ("type": "module")
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RepoItem {
  category: string;
  fullName: string;
  stars: number;
  description: string;
  url: string;
  createdAt: string;
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

const HISTORY_FILE = path.join(__dirname, '../data/sent-history.json');
const COOLDOWN_DAYS = 5; // Rút ngắn còn 5 ngày để thích ứng với mảng AI chạy nhanh
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const MIN_STAR_GAIN = 100; // Ngưỡng tăng trưởng tối thiểu để tái xuất hiện sau cooldown
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // Giữ lịch sử 30 ngày

// 1. Đọc state từ file JSON (có hỗ trợ tương thích ngược với định dạng cũ)
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
      console.error('Lỗi khi đọc state, khởi tạo mới:', error);
      return { repos: {} };
    }
  }
  return { repos: {} };
}

// 2. Lưu state theo chuẩn V2 có kèm dọn dẹp bản ghi cũ > 30 ngày
function saveState(state: StateFileStructure) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const now = Date.now();
  const cleanedRepos: Record<string, RepoHistoryRecord> = {};

  for (const [fullName, record] of Object.entries(state.repos)) {
    if (now - record.lastSentTimestamp <= MAX_RETENTION_MS) {
      cleanedRepos[fullName] = record;
    }
  }

  const output: StateFileStructure = {
    $schema: "Version 2.0 State Tracking",
    repos: cleanedRepos
  };

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(output, null, 2), 'utf-8');
}

// 3. Gửi tin nhắn qua Telegram Bot API
async function sendTelegramMessage(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('Thiếu biến môi trường TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID.');
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gửi tin nhắn Telegram thất bại: ${errorText}`);
  }

  console.log('Đã gửi thông báo Telegram thành công!');
}

// 4. Fetch dữ liệu từ GitHub Search API có chống timeout và phân loại
async function fetchTrendingRepos(): Promise<RepoItem[]> {
  const dateObj = new Date();
  dateObj.setDate(dateObj.getDate() - 30);
  const isoDate = dateObj.toISOString().split('T')[0];

  const query = `topic:local-ai OR topic:ai-agents OR topic:mcp created:>${isoDate} sort:stars-desc`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=15`;

  try {
    console.log(`Đang gọi GitHub API với query: ${query}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'github-ai-notifier-bot',
        ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API Error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    
    const repos: RepoItem[] = (data.items || []).map((item: any) => {
      let category = '💻 Coding & IDE Assistants';
      if (item.topics?.includes('mcp') || item.name.toLowerCase().includes('mcp')) {
        category = '🔌 Model Context Protocol (MCP)';
      } else if (item.topics?.includes('agent') || item.description?.toLowerCase().includes('agent')) {
        category = '🤖 Autonomous Agents';
      }

      return {
        category,
        fullName: item.full_name,
        stars: item.stargazers_count,
        description: item.description ? item.description.slice(0, 120) + '...' : 'Không có mô tả.',
        url: item.html_url,
        createdAt: item.created_at
      };
    });

    return repos;

  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error('Lỗi: Kết nối tới GitHub API bị quá thời gian (Timeout).');
    } else {
      console.error('Lỗi khi fetch dữ liệu từ GitHub:', error.message);
    }
    return [];
  }
}

// 5. Hàm chính kết hợp State V2 & Star Velocity
async function main() {
  try {
    console.log('Bắt đầu quy trình quét và lọc repo theo State V2 & Star Velocity...');
    const state = loadState();
    const now = Date.now();
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    const fetchedRepos = await fetchTrendingRepos();

    // Lọc repo theo tiêu chí Star Velocity & Cooldown 5 ngày
    const noteworthyRepos = fetchedRepos.filter(repo => {
      const record = state.repos[repo.fullName];
      const createdDate = new Date(repo.createdAt).getTime();
      const isBrandNew = (now - createdDate) <= ONE_WEEK_MS;

      if (!record) {
        return true; // Chưa từng lưu -> Gửi luôn
      }

      // Kiểm tra đang trong thời gian cooldown
      const isInCooldown = (now - record.lastSentTimestamp) <= COOLDOWN_MS;
      if (isInCooldown) {
        return false;
      }

      // Qua cooldown, kiểm tra tốc độ tăng trưởng star
      const starGain = repo.stars - record.lastSentStars;
      return starGain >= MIN_STAR_GAIN;
    });

    let messageToTelegram = '';

    if (noteworthyRepos.length === 0) {
      messageToTelegram = `🤖 *GitHub AI Notifier*\n\n✨ Hôm nay không có repo nào mới hoặc đạt ngưỡng tăng trưởng bứt phá (tăng < ${MIN_STAR_GAIN} stars) trong chu kỳ qua. Hệ thống vẫn đang giám sát chặt chẽ! 🚀`;
      console.log('Không có repo đáng chú ý nào thỏa mãn điều kiện.');
    } else {
      messageToTelegram = `🔥 *Top Local AI & Agent Highlights (Star Velocity V2)* 🔥\n\n`;

      noteworthyRepos.forEach(repo => {
        const record = state.repos[repo.fullName];
        const prevStars = record ? record.lastSentStars : repo.stars;
        const gain = repo.stars - prevStars;
        const gainText = gain > 0 ? ` _(📈 +${gain} stars)_` : '';

        messageToTelegram += `💻 *${repo.category}*\n- [${repo.fullName}](${repo.url}) (⭐ ${repo.stars})${gainText}\n  └ ${repo.description}\n\n`;
        
        // Cập nhật hoặc khởi tạo state V2
        if (!record) {
          state.repos[repo.fullName] = {
            lastSentTimestamp: now,
            lastSentStars: repo.stars,
            initialRecordedStars: repo.stars,
            totalGainSinceTracked: 0
          };
        } else {
          state.repos[repo.fullName] = {
            lastSentTimestamp: now,
            lastSentStars: repo.stars,
            initialRecordedStars: record.initialRecordedStars,
            totalGainSinceTracked: repo.stars - record.initialRecordedStars
          };
        }
      });

      saveState(state);
      console.log(`Đã tìm thấy và xử lý ${noteworthyRepos.length} repo đạt chuẩn.`);
    }

    await sendTelegramMessage(messageToTelegram);

  } catch (error) {
    console.error('Lỗi trong quá trình chạy bot:', error);
    process.exit(1);
  }
}

main();
