# Plan: Show Local Schedules on Hive Machine Cards

## Goal

When a Hive node has local cron schedules (created via `iris hive schedule add`), display them on the machine card in the Hive UI — right below the existing "Sessions" box. Users should see at a glance what's scheduled on each machine.

## Current State

- **Daemon** already has `this.scheduleRegistry.list()` returning all schedules as an array of objects: `{ id, script, cron, enabled, last_run, last_result, ... }`
- **Heartbeat** already sends `active_sessions` to iris-api — but does NOT send schedules
- **iris-api** stores heartbeat extras in `compute_nodes.metadata` JSON column (already has `active_sessions`, `sessions_updated_at`, `local_ip`)
- **Frontend** renders sessions in a collapsible box on each machine card in `HivePanel.vue` (lines 532–575) — the exact pattern to replicate

## Architecture (3 layers, 4 files)

### Layer 1: Daemon → Send schedules in heartbeat

**File:** `fl-docker-dev/coding-agent-bridge/daemon/index.js`
**Location:** Line 153–165, the `getStateCallback` block

**Change:** Add `local_schedules` to the heartbeat payload. Keep it lightweight — send a summary, not full execution logs.

```javascript
// Line 153 — add to the getStateCallback return object:
this.heartbeat.getStateCallback = () => ({
  // ... existing fields ...
  active_sessions: this._getLocalSessions(),
  local_schedules: this.scheduleRegistry
    ? this.scheduleRegistry.list().map(s => ({
        id: s.id,
        script: s.script,
        cron: s.cron,
        enabled: s.enabled,
        last_run: s.last_run || null,
        last_result: s.last_result || null
      }))
    : [],
  // ... rest of existing fields ...
})
```

**Why map instead of raw list():** The schedule objects may contain large `output` fields from last execution. We only send the fields the UI needs.

---

### Layer 2: iris-api → Store schedules in metadata

**File:** `fl-docker-dev/fl-iris-api/app/Services/NodeTaskDispatcher.php`
**Location:** Line 276–288, the `handleNodeHeartbeat()` metadata merge block

**Change:** Store `local_schedules` in metadata, same pattern as `active_sessions`:

```php
// After line 280 (sessions_updated_at), add:
if (isset($heartbeatData['local_schedules'])) {
    $metaUpdates['local_schedules'] = $heartbeatData['local_schedules'];
    $metaUpdates['schedules_updated_at'] = now()->toIso8601String();
}
```

**File:** `fl-docker-dev/fl-iris-api/app/Http/Controllers/Api/ComputeNodeController.php`
**Location:** Line 185–203, the `formatNodeResponse()` method

**Change:** Expose `local_schedules` in the API response:

```php
// After line 200 (sessions_updated_at), add:
'local_schedules' => ($node->metadata ?? [])['local_schedules'] ?? [],
'schedules_updated_at' => ($node->metadata ?? [])['schedules_updated_at'] ?? null,
```

---

### Layer 3: Frontend → Render schedules on machine cards

**File:** `fl-docker-dev/fl-elon-web-ui/components/Hive/HivePanel.vue`
**Location:** After line 575 (end of Sessions block), before the Drop Zone Footer (line 577)

**Change:** Add a "Schedules" box following the exact Sessions pattern. Use green/emerald theme to distinguish from orange Sessions.

```vue
<!-- Local Schedules on this node -->
<div
  v-if="(node.local_schedules || []).length > 0"
  class="px-4 py-2"
>
  <div class="rounded-lg overflow-hidden border border-emerald-900">
    <div class="px-3 py-1.5 text-xs font-semibold text-emerald-400 bg-emerald-900 bg-opacity-30 border-b border-emerald-900 flex items-center justify-between">
      <span><i class="fas fa-clock mr-1" />Schedules</span>
      <span class="text-emerald-600">{{ (node.local_schedules || []).length }}</span>
    </div>
    <div
      v-for="schedule in (node.local_schedules || []).slice(0, 5)"
      :key="schedule.id"
      class="flex items-center gap-2 px-3 py-2 border-b border-gray-800 last:border-0"
    >
      <i
        :class="schedule.enabled ? 'fas fa-play-circle text-emerald-400' : 'fas fa-pause-circle text-gray-500'"
        style="font-size: 10px"
      />
      <span class="flex-1 text-xs text-gray-300 truncate" :title="schedule.script">
        {{ schedule.script }}
      </span>
      <span class="flex-shrink-0 text-xs text-gray-500 font-mono">
        {{ schedule.cron }}
      </span>
    </div>
    <div
      v-if="(node.local_schedules || []).length > 5"
      class="px-3 py-1 text-xs text-gray-600"
    >
      +{{ (node.local_schedules || []).length - 5 }} more
    </div>
  </div>
</div>
```

**Design notes:**
- Emerald/green theme (vs orange for Sessions) — visually distinct
- `fa-clock` icon — communicates "scheduled"
- Shows script name + cron expression
- Play/pause icon reflects `enabled` state
- Truncates at 5 items (schedules tend to be fewer than sessions)
- No click action needed initially (sessions open a modal; schedules don't need interaction yet)

---

## Testing

1. **Start daemon locally** — it should already have schedules if you've used `iris hive schedule add`
2. **Check heartbeat payload** — add `console.log(JSON.stringify(extra))` at line 66 of `heartbeat.js` temporarily
3. **Verify iris-api stores it** — `php artisan tinker` → `ComputeNode::first()->metadata` should show `local_schedules`
4. **Check frontend** — the machine card should show a green "Schedules" box below Sessions

## Post-edit

- Run `npm run fix-file components/Hive/HivePanel.vue` after editing the frontend
- No migration needed (metadata is a JSON column)
- No Vuex store changes needed (node data already fetched and includes metadata fields)

## Files Modified (summary)

| File | Change | Lines affected |
|------|--------|---------------|
| `coding-agent-bridge/daemon/index.js` | Add `local_schedules` to heartbeat state callback | ~line 153 |
| `fl-iris-api/app/Services/NodeTaskDispatcher.php` | Store schedules in metadata on heartbeat | ~line 280 |
| `fl-iris-api/app/Http/Controllers/Api/ComputeNodeController.php` | Expose schedules in API response | ~line 200 |
| `fl-elon-web-ui/components/Hive/HivePanel.vue` | Render schedules box on machine card | ~line 575 |
