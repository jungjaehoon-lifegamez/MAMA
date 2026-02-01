/**
 * Browser Tool
 *
 * Puppeteer-based browser automation for MAMA
 */

import type { Browser, Page } from 'puppeteer';

export interface BrowserToolConfig {
  /** Headless mode (default: true) */
  headless?: boolean;
  /** Default viewport width */
  viewportWidth?: number;
  /** Default viewport height */
  viewportHeight?: number;
  /** Screenshot output directory */
  screenshotDir?: string;
}

const DEFAULT_CONFIG: Required<BrowserToolConfig> = {
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 800,
  screenshotDir: '/tmp/mama-screenshots',
};

export class BrowserTool {
  private config: Required<BrowserToolConfig>;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(config: BrowserToolConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Launch browser if not already running
   */
  async launch(): Promise<void> {
    if (this.browser) {
      console.log('[Browser] Already running');
      return;
    }

    console.log('[Browser] Launching...');

    // Dynamic import to avoid bundling issues
    const puppeteer = await import('puppeteer');

    this.browser = await puppeteer.default.launch({
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: this.config.viewportWidth,
      height: this.config.viewportHeight,
    });

    console.log('[Browser] Ready');
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      console.log('[Browser] Closed');
    }
  }

  /**
   * Ensure browser is running
   */
  private async ensureBrowser(): Promise<Page> {
    if (!this.browser || !this.page) {
      await this.launch();
    }
    return this.page!;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string): Promise<{ success: boolean; title: string; url: string }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Navigating to: ${url}`);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const title = await page.title();
    const currentUrl = page.url();

    return { success: true, title, url: currentUrl };
  }

  /**
   * Take screenshot
   */
  async screenshot(filename?: string): Promise<{ success: boolean; path: string }> {
    const page = await this.ensureBrowser();

    const { mkdirSync, existsSync } = await import('fs');
    if (!existsSync(this.config.screenshotDir)) {
      mkdirSync(this.config.screenshotDir, { recursive: true });
    }

    const name = filename || `screenshot-${Date.now()}.png`;
    const path = `${this.config.screenshotDir}/${name}`;

    await page.screenshot({ path, fullPage: false });
    console.log(`[Browser] Screenshot saved: ${path}`);

    return { success: true, path };
  }

  /**
   * Take full page screenshot
   */
  async screenshotFullPage(filename?: string): Promise<{ success: boolean; path: string }> {
    const page = await this.ensureBrowser();

    const { mkdirSync, existsSync } = await import('fs');
    if (!existsSync(this.config.screenshotDir)) {
      mkdirSync(this.config.screenshotDir, { recursive: true });
    }

    const name = filename || `fullpage-${Date.now()}.png`;
    const path = `${this.config.screenshotDir}/${name}`;

    await page.screenshot({ path, fullPage: true });
    console.log(`[Browser] Full page screenshot saved: ${path}`);

    return { success: true, path };
  }

  /**
   * Click element by selector
   */
  async click(selector: string): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Clicking: ${selector}`);

    await page.click(selector);
    return { success: true };
  }

  /**
   * Type text into element
   */
  async type(selector: string, text: string): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Typing into: ${selector}`);

    await page.type(selector, text);
    return { success: true };
  }

  /**
   * Wait for selector
   */
  async waitFor(selector: string, timeout = 10000): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Waiting for: ${selector}`);

    await page.waitForSelector(selector, { timeout });
    return { success: true };
  }

  /**
   * Get page content (HTML)
   */
  async getContent(): Promise<{ success: boolean; html: string }> {
    const page = await this.ensureBrowser();
    const html = await page.content();
    return { success: true, html };
  }

  /**
   * Get page text content
   */
  async getText(): Promise<{ success: boolean; text: string }> {
    const page = await this.ensureBrowser();
    const text = await page.evaluate('document.body.innerText');
    return { success: true, text: text as string };
  }

  /**
   * Evaluate JavaScript in page
   */
  async evaluate(script: string): Promise<{ success: boolean; result: unknown }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Evaluating script...`);

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = await page.evaluate(new Function(script) as () => unknown);
    return { success: true, result };
  }

  /**
   * Get element text by selector
   */
  async getElementText(selector: string): Promise<{ success: boolean; text: string | null }> {
    const page = await this.ensureBrowser();
    const text = await page.$eval(selector, (el) => el.textContent);
    return { success: true, text };
  }

  /**
   * Get all elements matching selector
   */
  async queryAll(selector: string): Promise<{ success: boolean; count: number; texts: string[] }> {
    const page = await this.ensureBrowser();
    const elements = await page.$$(selector);
    const texts = await Promise.all(
      elements.map((el) => el.evaluate((node) => node.textContent || ''))
    );
    return { success: true, count: elements.length, texts };
  }

  /**
   * Scroll page
   */
  async scroll(
    direction: 'up' | 'down' | 'top' | 'bottom',
    amount = 500
  ): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();

    switch (direction) {
      case 'up':
        await page.evaluate(`window.scrollBy(0, -${amount})`);
        break;
      case 'down':
        await page.evaluate(`window.scrollBy(0, ${amount})`);
        break;
      case 'top':
        await page.evaluate('window.scrollTo(0, 0)');
        break;
      case 'bottom':
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        break;
    }

    return { success: true };
  }

  /**
   * Press keyboard key
   */
  async press(key: string): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    // Type assertion for keyboard key type
    await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]);
    return { success: true };
  }

  /**
   * Go back
   */
  async goBack(): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    await page.goBack();
    return { success: true };
  }

  /**
   * Go forward
   */
  async goForward(): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    await page.goForward();
    return { success: true };
  }

  /**
   * Reload page
   */
  async reload(): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    await page.reload();
    return { success: true };
  }

  /**
   * Get current URL
   */
  getUrl(): string | null {
    return this.page?.url() || null;
  }

  /**
   * Check if browser is running
   */
  isRunning(): boolean {
    return this.browser !== null;
  }
}

// Singleton instance
let instance: BrowserTool | null = null;

export function getBrowserTool(config?: BrowserToolConfig): BrowserTool {
  if (!instance) {
    instance = new BrowserTool(config);
  }
  return instance;
}
