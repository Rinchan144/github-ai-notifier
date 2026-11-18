
interface FetchWithRetryOptions extends RequestInit {
  timeoutMs?: number;    // Thời gian timeout cho mỗi lần gọi (mặc định 15 giây)
  retries?: number;      // Số lần thử lại tối đa (mặc định 3 lần)
  backoffMs?: number;    // Thời gian chờ cơ sở cho retry (mặc định 2 giây)
}

/**
 * Gọi fetch an toàn có tích hợp timeout bằng AbortController và cơ chế Retry.
 */
export async function fetchWithRetry(url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const {
    timeoutMs = 15000, 
    retries = 3,
    backoffMs = 2000,
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[Attempt ${attempt}/${retries}] Requesting: ${url}`);
      
      const response = await globalThis.fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Nếu gặp lỗi HTTP (ví dụ: 500, 404, 429 Rate Limit)
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastError = error;

      const isTimeout = error.name === 'AbortError' || error.code === 'ETIMEDOUT';
      console.warn(`[Attempt ${attempt} Failed] ${isTimeout ? 'Request timed out (ETIMEDOUT)' : error.message}`);

      // Nếu đã hết số lần retry thì thoát vòng lặp
      if (attempt === retries) {
        break;
      }

      // Tính thời gian chờ theo hàm mũ (Exponential Backoff): 2s -> 4s -> 8s...
      const delay = backoffMs * Math.pow(2, attempt - 1);
      console.log(`Waiting ${delay}ms before next retry...\n`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} attempts. Last error: ${lastError?.message}`);
}