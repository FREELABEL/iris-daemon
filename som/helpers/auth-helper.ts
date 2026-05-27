import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Authentication helper for HeyIRIS
 * Injects auth token into localStorage to skip the login form.
 *
 * User identity is read from ~/.iris/config.json (written by installer).
 * NO hardcoded credentials — works on any client machine.
 */

interface IrisConfig {
  user_id: number;
  api_url?: string;
  node_api_key?: string;
  frontend_url?: string;
}

function loadIrisConfig(): IrisConfig {
  const configPath = path.join(os.homedir(), '.iris', 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('~/.iris/config.json not found. Run the IRIS installer first.');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config.user_id) {
    throw new Error('user_id missing from ~/.iris/config.json. Run: iris auth login');
  }
  return config;
}

function getFrontendUrl(config: IrisConfig): string {
  return config.frontend_url
    || process.env.IRIS_FRONTEND_URL
    || 'https://web.freelabel.net';
}

export class AuthHelper {

  /**
   * Login by injecting auth token into localStorage.
   * User identity is loaded from ~/.iris/config.json — no hardcoded admin data.
   */
  static async loginWithToken(page: Page, token: string): Promise<void> {
    console.log('🔐 Injecting auth session...');

    const config = loadIrisConfig();
    const frontendUrl = getFrontendUrl(config);
    const userId = config.user_id;

    // Navigate to the domain first (localStorage is domain-scoped)
    await page.goto(`${frontendUrl}/login`);
    await page.waitForTimeout(2000);

    // Inject auth data into localStorage — only token and user_id needed
    // The frontend fetches the full profile from the API on load
    await page.evaluate(({ tkn, uid }) => {
      localStorage.setItem('user_token', tkn);
      localStorage.setItem('user_id', String(uid));
      localStorage.setItem('user', JSON.stringify({
        id: uid,
        user_token: tkn,
      }));
    }, { tkn: token, uid: userId });

    console.log(`✓ Session injected for user ${userId}`);

    // Navigate to the app — retry once on browser crash
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(`${frontendUrl}/iris`, { timeout: 30000 });
        await page.waitForTimeout(5000);
        break;
      } catch (err: any) {
        if (attempt === 2 || !err.message?.includes('closed')) throw err;
        console.log(`⚠️  Browser hiccup on auth (attempt ${attempt}/2) — retrying...`);
        await page.goto(`${frontendUrl}/login`, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await page.evaluate(({ tkn, uid }) => {
          localStorage.setItem('user_token', tkn);
          localStorage.setItem('user', JSON.stringify({ id: uid, user_token: tkn }));
        }, { tkn: token, uid: userId });
      }
    }

    // Verify we're logged in (not redirected to login)
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      throw new Error('Token injection failed - got redirected to login. Token may be expired.');
    }

    console.log('✅ Successfully authenticated!');
  }
}
