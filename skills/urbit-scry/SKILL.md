---
name: urbit_scry
description: Query Urbit ship state - groups, channels, message history, contacts, and apps
user-invocable: true
metadata: {"clawdbot":{"emoji":"🔮","requires":{"config":["channels.tlon.enabled"]}}}
---

# Urbit Scry Skill

Query your Urbit ship's state via scry. Use this to fetch groups, channels, message history, contacts, and installed apps.

## Quick Reference

| Task | Command |
|------|---------|
| List groups | `node {baseDir}/scry.mjs --groups` |
| List channels | `node {baseDir}/scry.mjs --channels` |
| List contacts | `node {baseDir}/scry.mjs --contacts` |
| List DM conversations | `node {baseDir}/scry.mjs --dms` |
| List installed apps | `node {baseDir}/scry.mjs --apps` |

## Parsing Groups Response

Groups are keyed by ID (`~host/group-name`). Count groups with `Object.keys(groups).length`.

```javascript
// Get group count
const groups = await scry("/groups/groups.json");
const count = Object.keys(groups).length;

// Get group list with titles
const groupList = Object.entries(groups).map(([id, g]) => ({
  id,
  title: g.meta?.title || id,
  description: g.meta?.description || ""
}));
```

## Message History

### Get channel history
```bash
node {baseDir}/scry.mjs --history <nest> [count]
node {baseDir}/scry.mjs --history <nest> [count] --replies  # include replies
```
- `nest` = channel path like `chat/~bitbet-bolbel/urbit-community`
- `count` = number of messages (default 50)

### Pagination (older/newer)
```bash
node {baseDir}/scry.mjs --older <nest> <cursor> [count]
node {baseDir}/scry.mjs --newer <nest> <cursor> [count]
```
Use the cursor from previous response's `older` or `newer` field.

### Get single post with replies
```bash
node {baseDir}/scry.mjs --post <nest> <postId>
```

### DM history
```bash
node {baseDir}/scry.mjs --dm <ship> [count]
node {baseDir}/scry.mjs --club <club-id> [count]  # group DMs
```

### Examples
```bash
node {baseDir}/scry.mjs --history chat/~dabben-larbet/devs 20
node {baseDir}/scry.mjs --older chat/~host/channel 170.141.184... 50
node {baseDir}/scry.mjs --post chat/~host/channel 170.141.184...
node {baseDir}/scry.mjs --dm ~sampel-palnet 50
```

### Output Format

History returns formatted messages:
```json
[
  {
    "id": "170.141.184.507.790.725.820.779.267.587.779.330.048",
    "author": "~sampel-palnet",
    "content": "Hello world",
    "sent": "2026-01-26T15:30:00.000Z"
  }
]
```

## Raw Scry (Advanced)

For any other query, use a raw scry path:
```bash
node {baseDir}/scry.mjs "<path>"
```

Common paths:
- `/groups/groups.json` - All groups
- `/channels/v4/channels.json` - All channels
- `/contacts/all.json` - All contacts
- `/chat/dm.json` - DM conversation list
- `/hood/kiln/vats.json` - Installed apps
- `/docket/charges.json` - App tiles
- `/groups-ui/v6/init.json` - Full init (SLOW, ~100KB+)

## Options

| Flag | Description |
|------|-------------|
| `--no-cache` | Bypass cache, fetch fresh data |
| `--account <id>` | Use a specific Tlon account |
| `--verbose` | Include raw response data |

## Caching

Results are cached in `~/.clawdbot/cache/tlon-scry/`:

- Groups, channels, contacts: 1 minute
- DM list: 30 seconds
- Apps: 10 minutes
- init.json: 5 minutes
- **Message history: NEVER cached** (always fresh)

## Finding Channel Nests

To get a channel's nest for history queries:
1. Run `--channels` to list all subscriptions
2. Look for nests starting with `chat/` like `chat/~host-ship/channel-name`
3. Use that nest with `--history`

## When to Use

- User asks "what groups am I in?" → `--groups`
- User asks "show recent messages in X" → `--history chat/~host/X 20`
- User asks "who can I DM?" → `--dms`
- User asks "what apps are installed?" → `--apps`
- User asks about contacts → `--contacts`

## Scry Paths (from tlon-apps)

Channel posts use `/v4/{channelId}/posts/{mode}/{cursor?}/{count}/{format}`:
- Modes: `newest`, `older`, `newer`, `post`
- Formats: `outline` (lightweight) or `post` (with replies)

DMs use `/v3/dm/{id}/writs/{mode}/{cursor?}/{count}/{format}`:
- Formats: `light` or `heavy` (with replies)

## Limitations

- Thread replies require `--replies` flag or raw scry with `post`/`heavy` format
- Club (group DM) IDs are UUIDs, not ship names
