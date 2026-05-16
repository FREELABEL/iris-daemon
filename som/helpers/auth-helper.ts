import { Page } from '@playwright/test';

/**
 * Authentication helper for HeyIRIS
 * Injects auth token into localStorage to skip the login form
 */
export class AuthHelper {

  /**
   * Login by injecting full user session into localStorage
   */
  static async loginWithToken(page: Page, token: string): Promise<void> {
    console.log('🔐 Injecting auth session...');

    // Navigate to the domain first (localStorage is domain-scoped)
    await page.goto('https://web.freelabel.net/login');
    await page.waitForTimeout(2000);

    // Inject full auth data into localStorage (matches real session)
    await page.evaluate((tkn) => {
      const userData = {
        id: 193,
        email: 'admin@freelabel.net',
        name: null,
        user_name: 'admin',
        phone: '(817) 703-7623',
        account_type: '2',
        is_admin: 1,
        is_paid: 0,
        user_token: tkn,
        xp_points: 1007660,
        dashboard_type: 'artist',
        default_profile: null,
        platform_fee_percentage: 20
      };

      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('user_token', tkn);
      localStorage.setItem('user_id', '193');
      localStorage.setItem('email', 'admin@freelabel.net');
      localStorage.setItem('user_name', 'admin');
      localStorage.setItem('user_account_type', '2');
      localStorage.setItem('user_account_package', '2');
      localStorage.setItem('user_is_paid', '1');
      localStorage.setItem('user_session_key', 'e7ea9e64-ea8b-4c14-a6e3-687bf1888c40');
      localStorage.setItem('user_xp_points', '1007660');
    }, token);

    console.log('✓ Full session injected into localStorage');

    // Navigate to the app - should be authenticated now
    // Retry once if the browser crashes (common under memory pressure with 4 parallel campaigns)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto('https://web.freelabel.net/iris', { timeout: 30000 });
        await page.waitForTimeout(5000);
        break;
      } catch (err: any) {
        if (attempt === 2 || !err.message?.includes('closed')) throw err;
        console.log(`⚠️  Browser hiccup on auth (attempt ${attempt}/2) — retrying...`);
        await page.goto('https://web.freelabel.net/login', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        // Re-inject token (page may have reloaded)
        await page.evaluate((tkn) => {
          localStorage.setItem('user_token', tkn);
          localStorage.setItem('user', JSON.stringify({
            id: 193, email: 'admin@freelabel.net', user_name: 'admin',
            user_token: tkn, account_type: '2', is_admin: 1
          }));
        }, token);
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
