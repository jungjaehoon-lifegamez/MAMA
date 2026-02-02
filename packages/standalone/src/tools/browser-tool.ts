/**
 * Browser Tool
 *
 * Playwright-based browser automation for MAMA
 * Migrated from Puppeteer for better stability and multi-browser support
 */

import type { Browser, Page, BrowserContext } from 'playwright';

export interface BrowserToolConfig {
  /** Headless mode (default: true) */
  headless?: boolean;
  /** Default viewport width */
  viewportWidth?: number;
  /** Default viewport height */
  viewportHeight?: number;
  /** Screenshot output directory */
  screenshotDir?: string;
  /** Browser type: chromium, firefox, webkit (default: chromium) */
  browserType?: 'chromium' | 'firefox' | 'webkit';
}

const DEFAULT_CONFIG: Required<BrowserToolConfig> = {
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 800,
  screenshotDir: '/tmp/mama-screenshots',
  browserType: 'chromium',
};

export class BrowserTool {
  private config: Required<BrowserToolConfig>;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
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

    console.log(`[Browser] Launching ${this.config.browserType}...`);

    // Dynamic import to avoid bundling issues
    const playwright = await import('playwright');

    // Select browser type
    const browserType = playwright[this.config.browserType];

    this.browser = await browserType.launch({
      headless: this.config.headless,
    });

    this.context = await this.browser.newContext({
      viewport: {
        width: this.config.viewportWidth,
        height: this.config.viewportHeight,
      },
    });

    this.page = await this.context.newPage();

    console.log('[Browser] Ready');
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
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

    // Use 'load' instead of 'networkidle' for faster page capture
    // networkidle waits for ALL network requests to finish (ads, analytics, etc.)
    // which can take 30+ seconds on heavy sites like Naver
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });

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
   * Playwright auto-waits for element to be actionable
   */
  async click(selector: string): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Clicking: ${selector}`);

    await page.click(selector);
    return { success: true };
  }

  /**
   * Type text into element
   * Playwright auto-waits for element to be ready
   */
  async type(selector: string, text: string): Promise<{ success: boolean }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Typing into: ${selector}`);

    await page.fill(selector, text);
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
    const text = await page.innerText('body');
    return { success: true, text };
  }

  /**
   * Evaluate JavaScript in page
   */
  async evaluate(script: string): Promise<{ success: boolean; result: unknown }> {
    const page = await this.ensureBrowser();
    console.log(`[Browser] Evaluating script...`);

    const result = await page.evaluate(script);
    return { success: true, result };
  }

  /**
   * Get element text by selector
   */
  async getElementText(selector: string): Promise<{ success: boolean; text: string | null }> {
    const page = await this.ensureBrowser();
    const text = await page.textContent(selector);
    return { success: true, text };
  }

  /**
   * Get all elements matching selector
   */
  async queryAll(selector: string): Promise<{ success: boolean; count: number; texts: string[] }> {
    const page = await this.ensureBrowser();
    const elements = await page.locator(selector).all();
    const texts = await Promise.all(elements.map((el) => el.textContent() || ''));
    return { success: true, count: elements.length, texts: texts.filter(Boolean) as string[] };
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
    await page.keyboard.press(key);
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

  /**
   * Take a PDF of the page (Chromium only)
   */
  async pdf(filename?: string): Promise<{ success: boolean; path: string }> {
    const page = await this.ensureBrowser();

    const { mkdirSync, existsSync } = await import('fs');
    if (!existsSync(this.config.screenshotDir)) {
      mkdirSync(this.config.screenshotDir, { recursive: true });
    }

    const name = filename || `page-${Date.now()}.pdf`;
    const path = `${this.config.screenshotDir}/${name}`;

    await page.pdf({ path, format: 'A4' });
    console.log(`[Browser] PDF saved: ${path}`);

    return { success: true, path };
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
