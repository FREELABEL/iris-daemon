/**
 * Leadgen API Client
 *
 * HTTP client for creating leads and triggering enrichment
 * via the HeyIRIS API. Uses native fetch().
 */

// API base URL — defaults to production API proxy.
// Override with LEADGEN_API_URL env var for local dev (e.g., http://localhost:8000/api/v1)
const BASE_URL = process.env.LEADGEN_API_URL || 'https://raichu.heyiris.io/api/v1';

export interface CreateLeadPayload {
  name: string;
  source: string;
  contact_info?: Record<string, string>;
  custom_fields?: Record<string, any>;
  notes?: string;
  status?: string;
  keywords?: string[];
  tags?: number[];
}

export interface ApiResponse {
  success: boolean;
  duplicate?: boolean;
  message?: string;
  data?: any;
}

export interface BatchConfig {
  concurrency: number;            // Simultaneous requests (default: 5)
  delayBetweenBatches: number;    // ms delay between batch groups (default: 500)
  onProgress?: (result: BatchResultEntry, index: number, total: number) => void;
}

export interface BatchResultEntry {
  username: string;
  status: 'created' | 'duplicate' | 'error';
  leadId?: number;
  error?: string;
}

export interface BatchCreateResult {
  total: number;
  created: number;
  duplicates: number;
  errors: number;
  results: BatchResultEntry[];
}

export class LeadgenApiClient {
  private token: string;
  private boardId: number;

  constructor(token: string, boardId: number) {
    this.token = token;
    this.boardId = boardId;
  }

  /**
   * Create a lead via POST /api/v1/leads.
   * The backend has its own duplicate detection (by instagram handle within the same bloq).
   */
  async createLead(payload: CreateLeadPayload): Promise<ApiResponse> {
    const body = {
      ...payload,
      bloqId: String(this.boardId),
      status: payload.status || 'Prospected',
      source: payload.source || 'leadgen:instagram',
    };

    try {
      const resp = await fetch(`${BASE_URL}/leads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();

      // Backend returns 200 with duplicate info if lead already exists
      if (data.duplicate || data.message?.toLowerCase().includes('duplicate')) {
        return { success: true, duplicate: true, data, message: 'Duplicate lead' };
      }

      if (!resp.ok) {
        return { success: false, message: data.message || `HTTP ${resp.status}`, data };
      }

      return { success: true, data };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Fetch all existing lead names for this board.
   * Used to skip leads we already have during scraping (saves compute).
   */
  async fetchExistingLeadNames(): Promise<Set<string>> {
    const names = new Set<string>();
    let page = 1;

    try {
      while (true) {
        const resp = await fetch(`${BASE_URL}/leads?bloq_id=${this.boardId}&per_page=200&page=${page}`, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/json',
          },
        });

        if (!resp.ok) break;

        const data = await resp.json();
        const leads = data.data || data || [];
        if (!Array.isArray(leads) || leads.length === 0) break;

        for (const lead of leads) {
          const name = (lead.name || lead.nickname || '').toLowerCase().trim();
          if (name) names.add(name);
        }

        // Check if there are more pages
        if (leads.length < 200) break;
        page++;
        if (page > 50) break; // safety cap
      }
    } catch {
      // Non-fatal — just means we won't pre-filter
    }

    return names;
  }

  /**
   * Trigger enrichment via POST /api/v1/leads/{id}/enrich.
   * Uses the full LeadEnrichmentService pipeline:
   *   Instagram profile fetch → Tavily web search → FireCrawl → AI synthesis
   */
  async enrichLead(leadId: number): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/enrich`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ bloq_id: this.boardId }),
      });

      const data = await resp.json();
      return { success: resp.ok, data, message: data.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Quick Instagram-only enrichment via POST /api/v1/leads/{id}/quick-enrich-ig.
   * Fetches IG profile API only (<5s). Auto-updates lead contact_info.
   */
  async quickEnrichInstagram(leadId: number): Promise<{
    success: boolean;
    contacts?: { emails: string[]; phones: string[]; website?: string; score?: number; bio?: string };
    error?: string;
  }> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/quick-enrich-ig`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      return resp.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Generate an email draft via POST /api/v1/leads/{id}/outreach/generate-email.
   * Uses OutreachService with AI-powered personalization.
   */
  async generateEmailDraft(leadId: number, prompt: string, options?: {
    tone?: string;
    agent_id?: number;
    strategy_template_id?: number;
  }): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/outreach/generate-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ prompt, bloq_id: this.boardId, ...options }),
      });
      const data = await resp.json();
      return { success: resp.ok, data, message: data.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Send a composed email via POST /api/v1/leads/{id}/outreach/send-email.
   * Uses TransactionalEmailService (Resend API).
   */
  async sendEmail(leadId: number, emailData: {
    to_email: string;
    subject: string;
    body_html: string;
    to_name?: string;
    plain_text_only?: boolean;
    strategy_template_id?: number;
    append_signature?: boolean;
  }): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/outreach/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ ...emailData, plain_text_only: emailData.plain_text_only ?? true }),
      });
      const data = await resp.json();
      return { success: resp.ok, data, message: data.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Resolve tag names to IDs — fetches existing tags for the user,
   * creates any that don't exist yet. Returns array of tag IDs.
   */
  async resolveTags(
    userId: number,
    tagDefs: { name: string; color: string }[]
  ): Promise<number[]> {
    const tagIds: number[] = [];

    try {
      // Fetch existing tags
      const resp = await fetch(`${BASE_URL}/user/${userId}/lead-tags`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      const data = await resp.json();
      const existing: { id: number; name: string }[] = data.data || data || [];

      for (const def of tagDefs) {
        const found = existing.find(
          (t) => t.name.toLowerCase() === def.name.toLowerCase()
        );
        if (found) {
          tagIds.push(found.id);
        } else {
          // Create the tag
          const createResp = await fetch(`${BASE_URL}/user/${userId}/lead-tags`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.token}`,
              'Accept': 'application/json',
            },
            body: JSON.stringify({ name: def.name, color: def.color }),
          });
          const created = await createResp.json();
          if (created.data?.id) {
            tagIds.push(created.data.id);
          }
        }
      }
    } catch (err: any) {
      console.log(`    Warning: Could not resolve tags: ${err.message}`);
    }

    return tagIds;
  }

  /**
   * Fetch all leads on this board and return a map of handle → lead info.
   * Used by DM outreach to look up lead IDs and check enrichment status.
   *
   * @deprecated for SOM batch (`batch-with-login.spec.ts`) — that spec now reads
   *   per-row state from the workspace UI's data-* attributes (id, ig handle,
   *   hasEmail/Phone/DmNote/Reply). The MAX_PAGES=4 cap silently broke
   *   eligibility checks past 200 leads. Other specs (e.g. `inbox-followup.spec.ts`)
   *   may still use this; migrate them and then delete.
   */
  async getLeadMap(): Promise<Map<string, { id: number; hasEmail: boolean; hasPhone: boolean; hasDmNote: boolean; hasReply: boolean; igHandle: string | null }>> {
    const map = new Map<string, { id: number; hasEmail: boolean; hasPhone: boolean; hasDmNote: boolean; hasReply: boolean; igHandle: string | null }>();
    const PAGE_SIZE = 50;
    const MAX_PAGES = 4; // Cap at 200 leads — lead map is nice-to-have, not critical
    let page = 1;
    let hasMore = true;

    try {
      while (hasMore && page <= MAX_PAGES) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout per page — fail fast, lead map is optional

        const resp = await fetch(
          `${BASE_URL}/leads?bloq_id=${this.boardId}&per_page=${PAGE_SIZE}&page=${page}`,
          {
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'Accept': 'application/json',
            },
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);

        if (!resp.ok) {
          console.log(`    Warning: Lead map API returned HTTP ${resp.status} on page ${page}`);
          break;
        }

        const data = await resp.json();
        const leads = data.data?.data || data.data || [];

        if (!Array.isArray(leads) || leads.length === 0) break;

        for (const lead of leads) {
          const ci = lead.contact_info || {};
          const hasEmail = !!(ci.email || lead.email);
          const hasPhone = !!ci.phone;
          const notes = lead.notes || [];
          const hasDmNote = Array.isArray(notes) && notes.some(
            (n: any) => n.type === 'outreach' && (n.message || '').includes('[SOM DM]')
          );
          // Reply detection (#67772): check if lead has replied via inbox scan tags or notes
          const hasReply = Array.isArray(notes) && notes.some(
            (n: any) => {
              const msg = (n.message || '').toLowerCase();
              return msg.includes('[replied]') || msg.includes('[inbox reply]') || msg.includes('replied to dm');
            }
          ) || (Array.isArray(lead.tags) && lead.tags.some(
            (t: any) => (t.name || t || '').toLowerCase().includes('replied')
          ));
          // Resolve IG handle: explicit fields first, then fall back to nickname if it looks like a handle
          let igHandle = (ci.instagram || ci.social_handle || lead.twitter || lead.social_handle || '').replace(/^@/, '').trim() || null;
          if (!igHandle && lead.nickname) {
            const nick = lead.nickname.replace(/^@/, '').trim();
            // If nickname is lowercase, no spaces, and looks like a username → treat as IG handle
            if (nick && !nick.includes(' ') && /^[a-z0-9._]+$/i.test(nick)) {
              igHandle = nick.toLowerCase();
            }
          }
          const info = { id: lead.id, hasEmail, hasPhone, hasDmNote, hasReply, igHandle };

          const ig = ci.instagram;
          if (ig) map.set(ig.toLowerCase().replace(/^@/, ''), info);
          if (lead.nickname) {
            map.set(lead.nickname.toLowerCase().replace(/^@/, ''), info);
          }
          if (lead.name) {
            map.set(lead.name.toLowerCase().replace(/^@/, ''), info);
          }
        }

        hasMore = leads.length === PAGE_SIZE;
        page++;
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`    Warning: Lead map API timed out on page ${page} (${map.size} leads indexed so far)`);
      } else {
        console.log(`    Warning: Could not fetch lead map: ${err.message}`);
      }
    }

    return map;
  }

  /**
   * Pre-flight dedup: fetch all existing leads on this board
   * and return a set of known Instagram handles (lowercase, no @).
   */
  async getExistingHandles(): Promise<Set<string>> {
    const existing = new Set<string>();

    try {
      const resp = await fetch(
        `${BASE_URL}/leads?bloq_id=${this.boardId}&per_page=500`,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/json',
          },
        }
      );

      const data = await resp.json();
      const leads = data.data?.data || data.data || [];

      if (Array.isArray(leads)) {
        for (const lead of leads) {
          // Check contact_info.instagram
          const ig = lead.contact_info?.instagram;
          if (ig) existing.add(ig.toLowerCase().replace(/^@/, ''));

          // Check name for @handles
          if (lead.nickname?.startsWith('@')) {
            existing.add(lead.nickname.toLowerCase().replace(/^@/, ''));
          }
          if (lead.name?.startsWith('@')) {
            existing.add(lead.name.toLowerCase().replace(/^@/, ''));
          }
        }
      }
    } catch (err: any) {
      console.log(`    Warning: Could not fetch existing leads for dedup: ${err.message}`);
    }

    return existing;
  }

  /**
   * Check bounce status for an email address.
   * Returns { bounced: boolean, type: string|null, bounced_at: string|null }
   */
  async checkBounceStatus(email: string): Promise<{
    bounced: boolean;
    type?: string;
    bounced_at?: string;
  }> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/bounce-check?email=${encodeURIComponent(email)}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      if (!resp.ok) return { bounced: false };
      return resp.json();
    } catch {
      return { bounced: false };
    }
  }

  /**
   * Check daily send quota remaining.
   * Returns { sent_today: number, daily_cap: number, remaining: number }
   */
  async checkSendQuota(): Promise<{
    sent_today: number;
    daily_cap: number;
    remaining: number;
  }> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/send-quota`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      if (!resp.ok) return { sent_today: 0, daily_cap: 50, remaining: 50 };
      return resp.json();
    } catch {
      return { sent_today: 0, daily_cap: 50, remaining: 50 };
    }
  }

  /**
   * Create multiple leads with controlled concurrency.
   * Sends `concurrency` requests in parallel, waits for all to complete,
   * then pauses `delayBetweenBatches` ms before the next group.
   */
  async createLeadsBatch(
    payloads: CreateLeadPayload[],
    config: BatchConfig = { concurrency: 5, delayBetweenBatches: 500 }
  ): Promise<BatchCreateResult> {
    const result: BatchCreateResult = {
      total: payloads.length,
      created: 0,
      duplicates: 0,
      errors: 0,
      results: [],
    };

    for (let i = 0; i < payloads.length; i += config.concurrency) {
      const batch = payloads.slice(i, i + config.concurrency);

      const promises = batch.map(async (payload, batchIdx) => {
        const globalIdx = i + batchIdx;
        const resp = await this.createLead(payload);

        const entry: BatchResultEntry = {
          username: payload.contact_info?.instagram || payload.name,
          status: resp.duplicate ? 'duplicate' : resp.success ? 'created' : 'error',
          leadId: resp.data?.id || resp.data?.data?.id,
          error: resp.success || resp.duplicate ? undefined : resp.message,
        };

        if (resp.duplicate) result.duplicates++;
        else if (resp.success) result.created++;
        else result.errors++;

        result.results.push(entry);
        config.onProgress?.(entry, globalIdx, payloads.length);

        return entry;
      });

      await Promise.all(promises);

      // Delay between batch groups to avoid rate limiting
      if (i + config.concurrency < payloads.length) {
        await new Promise(r => setTimeout(r, config.delayBetweenBatches));
      }
    }

    return result;
  }

  /**
   * Add a note to a lead via POST /api/v1/leads/{id}/notes.
   * Backend expects { message: string, type: 'outreach'|'response'|'note' }.
   */
  async addNote(leadId: number, message: string, type: 'note' | 'outreach' | 'response' = 'response'): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ message, type }),
      });
      const data = await resp.json();
      return { success: resp.ok, data, message: data.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Record an outbound DM as an OutreachMessage + legacy note.
   * POST /api/v1/leads/{id}/outreach/record-dm
   */
  async recordDmSent(leadId: number, data: {
    message: string;
    channel_account: string;
    campaign_name?: string;
    bloq_id?: number;
    ig_handle?: string;
    step_index?: number;
  }): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/outreach/record-dm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify(data),
      });
      const json = await resp.json();
      return { success: resp.ok, data: json, message: json.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Get outreach messages for a lead. Use for dedup checks.
   * GET /api/v1/leads/{id}/outreach/messages
   */
  async getOutreachMessages(leadId: number, direction?: string): Promise<ApiResponse> {
    try {
      const qs = direction ? `?direction=${direction}` : '';
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/outreach/messages${qs}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      const data = await resp.json();
      return { success: resp.ok, data };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Get a single lead with full data (notes, tags) via GET /api/v1/leads/{id}.
   */
  async getLead(leadId: number): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      const data = await resp.json();
      return { success: resp.ok, data };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Update a lead's tags via PUT /api/v1/leads/{id}.
   * WARNING: uses sync() on backend — replaces ALL tags. Merge with existing before calling.
   */
  async updateLeadTags(leadId: number, tagIds: number[]): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ tags: tagIds }),
      });
      const data = await resp.json();
      return { success: resp.ok, data, message: data.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Update a lead's fields via PUT /api/v1/leads/{id}.
   * Accepts any fields the backend accepts (custom_fields, name, email, etc.)
   */
  async updateLead(leadId: number, data: Record<string, any>): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify(data),
      });
      const result = await resp.json();
      return { success: resp.ok, data: result, message: result.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Initialize outreach steps for a lead (creates the 5-step strategy).
   * Mirrors the "Apply Strategy" button in the UI.
   * Returns the created steps, or existing steps if already initialized.
   */
  async initializeOutreach(leadId: number, strategyKey?: string): Promise<{ success: boolean; steps: any[]; alreadyExisted: boolean }> {
    try {
      const endpoint = strategyKey
        ? `${BASE_URL}/leads/${leadId}/outreach-steps/initialize-strategy`
        : `${BASE_URL}/leads/${leadId}/outreach-steps/initialize-default`;
      const body = strategyKey ? JSON.stringify({ strategy_key: strategyKey }) : undefined;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body,
      });
      const result = await resp.json() as any;
      if (resp.ok) {
        return { success: true, steps: result.data?.steps || [], alreadyExisted: false };
      }
      // 400 = steps already exist — that's fine, fetch them
      if (resp.status === 400 && result.message?.includes('already has')) {
        const existing = await this.getSteps(leadId);
        return { success: true, steps: existing, alreadyExisted: true };
      }
      return { success: false, steps: [], alreadyExisted: false };
    } catch {
      return { success: false, steps: [], alreadyExisted: false };
    }
  }

  /**
   * Get outreach steps for a lead.
   */
  async getSteps(leadId: number): Promise<any[]> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/outreach-steps`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      const result = await resp.json();
      return result.data?.steps ?? result.steps ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Mark an outreach step as completed via API (not UI clicks).
   * This is the reliable way — UI checkbox detection is fragile.
   */
  async completeStep(leadId: number, stepId: number, strategy?: string): Promise<ApiResponse> {
    try {
      const body: Record<string, any> = { is_completed: true };
      if (strategy) body.strategy = strategy;
      const resp = await fetch(`${BASE_URL}/leads/${leadId}/outreach-steps/${stepId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      return { success: resp.ok, data: result, message: result.message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Delete a lead via DELETE /api/v1/leads/{id}.
   */
  async deleteLead(leadId: number): Promise<ApiResponse> {
    try {
      const resp = await fetch(`${BASE_URL}/leads/${leadId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json',
        },
      });
      const data = await resp.json().catch(() => ({}));
      return { success: resp.ok, data, message: (data as any).message };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Enhanced lead map with full info — used by inbox follow-up to check tags/notes.
   * Returns Map of handle → { id, hasEmail, hasPhone, name, status, tagIds }
   */
  async getLeadMapFull(): Promise<Map<string, {
    id: number; hasEmail: boolean; hasPhone: boolean;
    name: string; status: string; tagIds: number[];
  }>> {
    const map = new Map<string, {
      id: number; hasEmail: boolean; hasPhone: boolean;
      name: string; status: string; tagIds: number[];
    }>();

    // Paginate through ALL leads on the board. Fetching only page 1
    // (the old per_page=500 behaviour) silently dropped most of a large board,
    // so matching/dedup missed the majority of leads.
    const PAGE_SIZE = 200;
    const MAX_PAGES = 200; // safety cap = 40k leads — far above any real board
    const PAGE_TIMEOUT_MS = 15000;
    let page = 1;
    let hasMore = true;
    let leadCount = 0;

    const addKey = (k: string | null | undefined, info: any) => {
      if (!k) return;
      const norm = String(k).toLowerCase().replace(/^@/, '').trim();
      if (norm) map.set(norm, info);
    };

    try {
      while (hasMore && page <= MAX_PAGES) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

        let resp: Response;
        try {
          resp = await fetch(
            `${BASE_URL}/leads?bloq_id=${this.boardId}&per_page=${PAGE_SIZE}&page=${page}`,
            {
              headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/json',
              },
              signal: controller.signal,
            }
          );
        } finally {
          clearTimeout(timeout);
        }

        if (!resp.ok) {
          console.log(`    Warning: Lead map API returned HTTP ${resp.status} on page ${page} (${leadCount} leads indexed so far)`);
          break;
        }

        const data = await resp.json();
        const leads = data.data?.data || data.data || [];

        if (!Array.isArray(leads) || leads.length === 0) break;

        for (const lead of leads) {
          const ci = lead.contact_info || {};
          const hasEmail = !!(ci.email || lead.email);
          const hasPhone = !!ci.phone;
          const tagIds = (lead.tags || []).map((t: any) => t.id || t);
          const info = { id: lead.id, hasEmail, hasPhone, name: lead.name || '', status: lead.status || '', tagIds };

          addKey(ci.instagram, info);
          addKey(ci.social_handle, info);
          addKey(lead.twitter, info);
          addKey(lead.social_handle, info);
          addKey(lead.nickname, info);
          addKey(lead.name, info);
        }

        leadCount += leads.length;
        hasMore = leads.length === PAGE_SIZE;
        page++;
      }

      if (page > MAX_PAGES) {
        console.log(`    Warning: Lead map hit MAX_PAGES cap (${MAX_PAGES}) — board may have more than ${MAX_PAGES * PAGE_SIZE} leads`);
      }
      console.log(`   Lead map: ${leadCount} leads across ${page - 1} page(s), ${map.size} match keys`);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`    Warning: Lead map API timed out on page ${page} (${leadCount} leads indexed so far)`);
      } else {
        console.log(`    Warning: Could not fetch lead map: ${err.message}`);
      }
    }

    return map;
  }
}
