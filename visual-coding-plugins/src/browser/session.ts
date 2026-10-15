import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ToolError } from '../core/contract.js';

interface Session { context: BrowserContext; page: Page; revision: string; errors: string[] }

export class BrowserManager {
  private browser?: Browser;
  private sessions = new Map<string, Session>();
  constructor(private readonly channel: 'chrome' | 'chromium' = 'chromium') {}

  async get(workspace: string, runId: string, revision: string, url: string): Promise<Session> {
    const key = JSON.stringify([workspace, runId]);
    const existing = this.sessions.get(key);
    if (existing?.revision === revision) return existing;
    if (existing) { await existing.context.close(); this.sessions.delete(key); }
    this.browser ??= await chromium.launch({ headless: true, timeout: 20_000, channel: this.channel });
    const context = await this.browser.newContext({
      viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1,
      locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce',
      serviceWorkers: 'block', acceptDownloads: false,
    });
    const origin = new URL(url).origin;
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      return target.origin === origin || ['data:', 'blob:'].includes(target.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(10_000);
    const errors: string[] = [];
    const record = (message: string) => { if (errors.length < 50) errors.push(message.slice(0, 2_000)); };
    page.on('pageerror', error => record(error.message));
    page.on('console', message => { if (message.type() === 'error') record(message.text()); });
    try {
      const response = await page.goto(url, { waitUntil: 'load' });
      if (!response?.ok()) throw new ToolError('PREVIEW_FAILED', `Preview returned HTTP ${response?.status()}`);
      await page.waitForFunction(() => document.fonts.status === 'loaded');
    } catch (error) { await context.close(); throw error; }
    const session = { context, page, revision, errors };
    this.sessions.set(key, session);
    return session;
  }

  async inspect(session: Session, selectors: string[]): Promise<Record<string, unknown>> {
    const elements = [];
    for (const selector of selectors) {
      const locator = session.page.locator(selector);
      const count = await locator.count();
      const first = locator.first();
      elements.push({ selector, count, ...(count ? {
        visible: await first.isVisible(),
        text: (await first.innerText()).slice(0, 10_000),
        bounds: await first.boundingBox(),
        styles: await first.evaluate(element => {
          const style = getComputedStyle(element);
          return { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize };
        }),
      } : {}) });
    }
    return { title: await session.page.title(), url: session.page.url(), viewport: session.page.viewportSize(), elements, console_errors: [...session.errors] };
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.sessions.clear();
  }
}
