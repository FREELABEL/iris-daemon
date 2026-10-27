/**
 * The strategy a SOM run names must exist on the board it targets, with a first-step script,
 * BEFORE anything opens a browser or messages anyone (#191275).
 *
 * Strategies are matched by exact name, scoped to the board. A name that does not exist there
 * used to fall through to a generic "Hey {name}! Noticed you're doing some interesting work…"
 * sent to real people. Now the run stops and says which names do exist.
 */

/**
 * Pure: find the strategy and its first-step script in a board's template list.
 * @returns {{ok: true, id: any, script: string} | {ok: false, reason: string, available: string[]}}
 */
function findStrategyScript(templates, name) {
  const list = Array.isArray(templates) ? templates : [];
  const available = list.map(t => t && t.name).filter(Boolean);
  const wanted = String(name || '').trim();
  if (!wanted) {
    return { ok: false, reason: 'no strategy name given', available };
  }
  const strat = list.find(t => t && t.name === wanted);
  if (!strat) {
    const near = available.find(n => n.toLowerCase() === wanted.toLowerCase());
    return {
      ok: false,
      reason: near
        ? `strategy "${wanted}" not found — names match exactly; did you mean "${near}"?`
        : `strategy "${wanted}" does not exist on this board`,
      available,
    };
  }
  const steps = Array.isArray(strat.steps) ? [...strat.steps] : [];
  steps.sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
  const script = String(steps[0]?.instructions || '').trim();
  if (!script) {
    return { ok: false, reason: `strategy "${wanted}" has no first-step script`, available };
  }
  return { ok: true, id: strat.id, script };
}

/** Fetch the board's templates and check the named strategy. Network failure is a failure. */
async function checkStrategy(boardId, name, opts = {}) {
  const apiBase = opts.apiBase || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io';
  const token = opts.token || process.env.HEYIRIS_TOKEN || process.env.IRIS_API_KEY || '';
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const res = await fetchImpl(`${apiBase}/api/v1/bloqs/${boardId}/outreach-strategy-templates`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, reason: `could not read the strategies on board ${boardId} (HTTP ${res.status})`, available: [] };
    }
    const json = await res.json();
    return findStrategyScript(json?.data?.templates || json?.templates || [], name);
  } catch (err) {
    return { ok: false, reason: `could not read the strategies on board ${boardId}: ${err.message}`, available: [] };
  }
}

/** One line a person can act on. */
function describeFailure(boardId, result) {
  const names = (result.available || []).map(n => `"${n}"`).join(', ');
  return `Board ${boardId}: ${result.reason}.` + (names ? ` Strategies on this board: ${names}.` : '');
}

module.exports = { findStrategyScript, checkStrategy, describeFailure };
