# Thread Reply Implementation - Success Log
**Date:** 2026-01-22
**Status:** ✅ Working

## Summary
Successfully implemented and tested thread reply functionality for the Clawdbot Tlon plugin. The bot now correctly replies within Tlon threads instead of posting to the main channel.

## What Was Fixed

### 1. Correct Poke Structure
The key was matching the official Tlon client's structure exactly:

```javascript
action: {
  post: {              // ← "post" wrapper required
    reply: {
      id: parentId,    // ← parent post ID (formatted with dots)
      action: {        // ← "action", NOT "delta"
        add: {         // ← NO "memo" wrapper
          content: story,
          author: fromShip,
          sent: sentAt,
        }
      }
    }
  }
}
```

**Reference:** https://github.com/tloncorp/tlon-apps/blob/develop/packages/shared/src/urbit/channel.ts

### 2. Parent ID Extraction
Thread replies share the same `parent-id` in their seal:
```javascript
const parentId = seal?.["parent-id"] || seal?.parent || null;
```

When replying, we send the `parentId` back to keep the message in the same thread.

### 3. Session Context Separation
Each thread gets its own conversation context:
```javascript
const sessionKeySuffix = parentId ? `:thread:${parentId}` : '';
const finalSessionKey = `${route.sessionKey}${sessionKeySuffix}`;
```

This prevents threads from bleeding context into each other.

### 4. ID Formatting
Urbit @ud format requires dots every 3 digits:
```javascript
function formatUdId(id) {
  return String(id).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
```

## Branch Information
- **Working Branch:** `thread-reply-implementation`
- **Latest Commit:** 3e7f6f1
- **Key Commits:**
  - `bb5e210` - Initial fix matching official client structure
  - `7cb1bc7` - Added post wrapper around reply
  - `c100532` - Added @ud format for IDs
  - `1d436bc` - Updated logging
  - `3e7f6f1` - Added plugin manifest

## Configuration Changes

### clawdbot.json Updates

1. **Context Pruning** (required for clawdbot v2026+):
```json
"contextPruning": {
  "mode": "off"  // Changed from "adaptive" (no longer valid)
}
```

2. **Channel Permissions** (open channels):
```json
"authorization": {
  "channelRules": {
    "chat/~nocsyx-lassul/bongtable": {
      "mode": "open"
    },
    "chat/~malmur-halmex/vkvinb1": {
      "mode": "open"
    }
  }
}
```

3. **Outbound Channels** (for cron jobs to send DMs):
```json
"groupChannels": [
  "chat/~malmur-halmex/v3aedb3s",
  "dm/~malmur-halmex"
]
```

### Plugin Manifest
Created `clawdbot.plugin.json` (required for clawdbot v2026+):
```json
{
  "id": "tlon",
  "channels": ["tlon"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

## Clawdbot Upgrade Issues Resolved

### Issue 1: Invalid contextPruning.mode
**Error:** `Config validation failed: agents.defaults.contextPruning.mode: Invalid input`
**Solution:** Changed `"mode": "adaptive"` to `"mode": "off"` (valid values: "off", "cache-ttl")

### Issue 2: Missing Plugin Manifest
**Error:** `plugin manifest not found: /Users/williamarzt/.clawdbot/extensions/tlon/clawdbot.plugin.json`
**Solution:** Created the required manifest file

### Issue 3: CLAWDBOT_ROOT Error
**Error:** `Unable to resolve Clawdbot root. Set CLAWDBOT_ROOT to the package root.`
**Solution:** Set environment variable when starting gateway:
```bash
CLAWDBOT_ROOT=/opt/homebrew/lib/node_modules/clawdbot clawdbot gateway
```

## Testing
Gateway successfully started and thread replies confirmed working in:
- ✅ `chat/~nocsyx-lassul/bongtable`
- ✅ All 24 monitored channels subscribed
- ✅ Bot responds in threads when mentioned
- ✅ Separate conversation context per thread

## File Locations
- Plugin code: `/Users/williamarzt/.clawdbot/extensions/tlon/`
- Config: `/Users/williamarzt/.clawdbot/clawdbot.json`
- Logs: `/tmp/clawdbot/clawdbot-2026-01-22.log`
- Source repo: `/Users/williamarzt/tlon-mcp-server/clawdbot-tlon-plugin`

## Key Learnings

1. **Always match official client exactly** - The poke structure must be identical
2. **The `post` wrapper is critical** - Both `reply` and `add` need wrapping
3. **Use `action`, not `delta`** - Inside the reply structure
4. **No `memo` wrapper** - Content goes directly in `add`
5. **Format IDs properly** - Urbit @ud format uses dots
6. **Log everything** - Extensive logging was crucial for debugging

## Previous Attempts (What Didn't Work)

1. ❌ `delta: { add: { memo: {...} } }` structure
2. ❌ Missing `post` wrapper around `reply`
3. ❌ Using `delta` instead of `action`
4. ❌ Not formatting IDs with dots
5. ❌ Messages appeared to send (204 response) but didn't show in UI

## Cron Job Setup
For scheduled messages to work, ensure:
1. Target channel/DM is in `groupChannels` array
2. Plugin has `outbound` section properly defined (already in code)
3. Gateway restarted after config changes

Example cron job payload:
```json
{
  "deliver": true,
  "channel": "tlon",
  "to": "~malmur-halmex"
}
```

## Next Steps / Future Improvements
- Consider adding attachment support in threads
- Handle edge cases (deleted threads, archived channels)
- Add thread title/summary for long threads
- Implement thread auto-archiving after inactivity

## References
- Tlon Channel API: https://github.com/tloncorp/tlon-apps/blob/develop/packages/shared/src/urbit/channel.ts
- Tlon DM API: https://github.com/tloncorp/tlon-apps/blob/develop/packages/shared/src/urbit/dms.ts
- Clawdbot docs: https://clawdbot.com (when available)
