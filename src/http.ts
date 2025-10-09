import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { config } from './config';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(baseMs: number): number {
  const jitter = Math.random() * baseMs * 0.2; // ±20%
  return baseMs + (Math.random() < 0.5 ? -jitter : jitter);
}

export class HttpClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: config.REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'roblox-monitor/1.0 (+https://example.local)'
      }
    });
  }

  async get<T = unknown>(url: string, options?: AxiosRequestConfig): Promise<T> {
    let attempt = 0;
    // First try + RETRY_ATTEMPTS retries
    const totalAttempts = 1 + config.RETRY_ATTEMPTS;
    for (;;) {
      try {
        const response = await this.client.get<T>(url, options);
        return response.data;
      } catch (error) {
        attempt += 1;
        if (attempt >= totalAttempts) throw error;
        const backoff = withJitter(config.RETRY_BACKOFF_MS * Math.pow(2, attempt - 1));
        await sleep(backoff);
      }
    }
  }
}

export const httpClient = new HttpClient();


