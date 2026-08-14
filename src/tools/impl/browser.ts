import { mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ToolConfigSchema, ToolSpec } from '../registry.js';

const INSTALL_HINT = 'Playwright Chromium is unavailable. Run: npx playwright install chromium';
const CONFIG: ToolConfigSchema = {
  headless: { type: 'string', default: 'true', label: '无头模式 / Headless', description: 'true 默认后台运行；false 显示浏览器。' },
  userDataDir: { type: 'string', default: '', label: '用户数据目录 / Profile', description: '持久化 cookies 和登录状态；留空使用临时会话。' },
  idleMinutes: { type: 'number', default: 10, label: '空闲关闭（分钟）', min: 1, max: 120 },
};

type PlaywrightLoader = () => Promise<{ chromium: typeof import('playwright')['chromium'] }>;

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = typeof args[name] === 'string' ? args[name].trim() : '';
  if (!value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export class BrowserToolRuntime {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private idleTimer?: NodeJS.Timeout;
  constructor(private readonly load: PlaywrightLoader = () => import('playwright')) {}

  tools(): ToolSpec[] {
    return [
      this.spec('browser_navigate', '打开网页并返回标题、URL 与正文摘要 / Navigate and summarize a page.',
        { type: 'object', properties: { url: { type: 'string' }, timeout: { type: 'number' } }, required: ['url'], additionalProperties: false },
        async (args, context) => {
          const url = requiredString(args, 'url');
          let parsed: URL; try { parsed = new URL(url); } catch { throw new Error('url must be a valid http(s) URL'); }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must use http or https');
          const page = await this.getPage(context.toolConfig);
          const timeout = Math.max(1, Number(args.timeout ?? 30_000));
          await page.goto(parsed.toString(), { timeout, waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5_000) }).catch(() => {});
          return { title: await page.title(), url: page.url(), text: (await page.locator('body').innerText()).trim().slice(0, 2_000) };
        }),
      this.spec('browser_click', '等待并点击元素 / Wait for and click an element by CSS selector.',
        { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'], additionalProperties: false },
        async (args, context) => { const selector = requiredString(args, 'selector'); const page = await this.getPage(context.toolConfig); await page.locator(selector).first().click({ timeout: 30_000 }); return { ok: true, url: page.url() }; }),
      this.spec('browser_type', '填写输入框 / Fill an input selected by CSS.',
        { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'], additionalProperties: false },
        async (args, context) => { const selector = requiredString(args, 'selector'); if (typeof args.text !== 'string') throw new Error('text must be a string'); const page = await this.getPage(context.toolConfig); await page.locator(selector).first().fill(args.text, { timeout: 30_000 }); return { ok: true }; }),
      this.spec('browser_extract', '提取页面正文和链接 / Extract text and links from the page or selector.',
        { type: 'object', properties: { selector: { type: 'string' } }, additionalProperties: false },
        async (args, context) => {
          const page = await this.getPage(context.toolConfig); const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : 'body';
          const locator = page.locator(selector).first(); await locator.waitFor({ state: 'attached', timeout: 30_000 });
          const text = (await locator.innerText()).trim().slice(0, 20_000);
          const links = await locator.locator('a[href]').evaluateAll((nodes) => nodes.slice(0, 100).map((node) => ({ text: (node.textContent ?? '').trim(), href: (node as HTMLAnchorElement).href })));
          return { text, links };
        }),
      this.spec('browser_screenshot', '保存网页 PNG 截图 / Save a PNG screenshot in the workspace.',
        { type: 'object', properties: { path: { type: 'string' }, fullPage: { type: 'boolean' } }, additionalProperties: false },
        async (args, context) => {
          const page = await this.getPage(context.toolConfig); const path = resolve(context.cwd, typeof args.path === 'string' && args.path.trim() ? args.path.trim() : `browser-screenshot-${Date.now()}.png`);
          if (relative(context.cwd, path).startsWith('..')) throw new Error('screenshot path must stay inside the workspace');
          if (!path.toLowerCase().endsWith('.png')) throw new Error('screenshot path must end with .png');
          await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: args.fullPage === true }); return { path };
        }),
    ];
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined; this.page = undefined;
    await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {});
    this.context = undefined; this.browser = undefined;
  }

  private spec(name: string, description: string, parameters: ToolSpec['parameters'], execute: ToolSpec['execute']): ToolSpec {
    return { name, description, parameters, configSchema: CONFIG, execute };
  }

  private async getPage(config: Readonly<Record<string, unknown>> | undefined): Promise<Page> {
    this.touch(Number(config?.idleMinutes ?? 10));
    if (this.page && !this.page.isClosed()) return this.page;
    try {
      const { chromium } = await this.load();
      const headless = String(config?.headless ?? 'true') !== 'false';
      const userDataDir = String(config?.userDataDir ?? '').trim();
      let context: BrowserContext;
      if (userDataDir) context = await chromium.launchPersistentContext(userDataDir, { headless });
      else { const browser = await chromium.launch({ headless }); this.browser = browser; context = await browser.newContext(); }
      this.context = context;
      this.page = context.pages()[0] ?? await context.newPage();
      return this.page;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${INSTALL_HINT}. Details: ${message}`);
    }
  }

  private touch(minutes: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const delay = Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
    this.idleTimer = setTimeout(() => void this.close(), delay); this.idleTimer.unref();
  }
}
