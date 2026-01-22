# Implementation Notes: Notebook Integration

## Development Summary

This document contains technical notes for future reference on the notebook integration implementation.

### Critical Urbit Channels App Structure

#### Diary Post Poke Structure

**IMPORTANT**: The diary post structure is different from chat memos. Reference implementation from tlon-apps:
https://github.com/tloncorp/tlon-apps/blob/develop/packages/shared/src/urbit/channel.ts

**Correct structure**:
```javascript
{
  id: number,
  action: "poke",
  ship: "ship-name",
  app: "channels",
  mark: "channel-action-1",  // Note: channel-action-1, not channel-action
  json: {
    channel: {
      nest: "diary/~host/channel-id",  // MUST include ~ before host
      action: {
        post: {
          add: {
            content: [{ inline: [text] }],  // Simple inline, not block.prose.inline
            sent: timestamp,
            kind: "/diary",  // String "/diary", not object { diary: null }
            author: "~ship-name",
            blob: null,
            meta: {
              title: "Title",
              image: "",
              description: "",
              cover: ""
            }
          }
        }
      }
    }
  }
}
```

**What DOESN'T work** (lessons learned from debugging):
```javascript
// ❌ Wrong mark
mark: "channel-action"  // Should be "channel-action-1"

// ❌ Wrong nest format
nest: "diary/malmur-halmex/v2u22f1d"  // Missing ~

// ❌ Wrong content structure
content: [{ block: { prose: { inline: [text] } } }]  // Too nested

// ❌ Wrong kind format
"kind-data": { diary: null }  // Should be kind: "/diary"

// ❌ Wrong action wrapper
post: { essay: { add: { ... } } }  // Should be post: { add: { ... } }
```

### DM Thread Reply Structure

DMs in Urbit have different structures for top-level messages vs thread replies:

**Top-level DM**:
```javascript
{
  id: "~ship/id",
  response: {
    add: {
      memo: { author, sent, content }
    }
  }
}
```

**Thread Reply**:
```javascript
{
  id: "~parent-ship/parent-id",  // Parent message ID
  response: {
    reply: {
      id: "~reply-ship/reply-id",  // Reply message ID
      delta: {
        add: {
          memo: { author, sent, content }
        }
      }
    }
  }
}
```

### DM Message Caching

DMs don't support history scry like channels do (`/channels/v4/dm/...` returns 404). Solution: cache messages as they arrive.

**Implementation**:
- Cache key: `dm/${otherParty}` where otherParty is the non-bot participant
- Cache both incoming user messages AND outgoing bot messages
- Cache before the "don't respond to own messages" check
- Store: `{ id, author, content, timestamp }`
- Limit to 50 most recent messages

**Code location** (monitor.js around line 765):
```javascript
const otherParty = senderShip === botShipName ? update.whom : senderShip;
const dmCacheKey = `dm/${otherParty}`;
// Cache before returning for bot's own messages
```

### Save Command Flow

1. User says "save to my notes" (or replies to message with that text)
2. `parseNotebookCommand()` detects the command pattern
3. If `parentId` exists (thread reply):
   - Look up parent message in DM cache
   - Extract parent message content
4. If no `parentId`:
   - Find last bot message in cache
   - Extract that content
5. Generate title:
   - Use custom title if provided via `extractTitle()`
   - Otherwise use first line of content (max 60 chars)
6. Call `sendDiaryPost()` with correct structure
7. Respond with success message

### Command Pattern Matching

Flexible patterns to catch various phrasings:

```javascript
const savePatterns = [
  /save (?:this|that) to (?:my )?notes?/i,
  /save to (?:my )?notes?/i,  // Added for flexibility
  /save to notebook/i,
  /add to (?:my )?diary/i,
  /save (?:this|that) to (?:my )?diary/i,
  /save to (?:my )?diary/i,
  /save (?:this|that)/i,
];
```

### Title Extraction

Supports custom titles via patterns:
```javascript
/(?:as|with title)\s+["']([^"']+)["']/i  // "save to notes as 'My Title'"
/(?:as|with title)\s+(.+?)(?:\.|$)/i     // "save to notes as My Title"
```

Auto-generation:
```javascript
const firstLine = content.split('\n')[0];
const title = firstLine.length > 60
  ? firstLine.substring(0, 60) + '...'
  : firstLine;
```

### Testing Process

Incremental testing approach was crucial:
1. Add helper functions (parseNotebookCommand, extractTitle) - test bot still responds
2. Add sendDiaryPost - test bot still responds
3. Add fetchDiaryEntries - test bot still responds
4. Wire up command detection - test commands detected
5. Implement save handler - test save works
6. Fix diary poke structure (multiple iterations)
7. Add thread reply support
8. Add DM caching
9. Add auto-title generation

### Debugging Tips

- Check logs for poke structure: `tail -f gateway.output | grep "Sending poke to channels"`
- 204 response doesn't mean success - structure could still be wrong
- Use browser console network tab to see actual working poke structure
- DM cache key must match between caching and retrieval
- Thread replies have different event structure than top-level messages

### Configuration

Add to account config:
```json
"notebookChannel": "diary/~host/channel-id"
```

Resolves via `account.notebookChannel` in plugin.

### Files Modified

1. **monitor.js** (~1400 lines):
   - Lines 217-254: Command parsing functions
   - Lines 281-332: sendDiaryPost function
   - Lines 339-395: fetchDiaryEntries function (not wired up yet)
   - Lines 755-810: DM handler with thread reply + caching
   - Lines 1012-1112: Notebook command handling in processMessage

2. **index.js** (~354 lines):
   - Line 98: Added notebookChannel to resolveAccount return

### Future Work

- Wire up `fetchDiaryEntries()` for "list my notes" command
- Add group channel support (currently DM-only)
- Add historical DM scry if API becomes available
- Consider pagination for large notebooks
- Add delete/edit functionality
- Add search/filter capabilities
