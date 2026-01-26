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

## Message History

### Get channel history
```bash
node {baseDir}/scry.mjs --history <nest> [count]
```
- `nest` = channel path like `chat/~bitbet-bolbel/urbit-community`
- `count` = number of messages (default 50)

Example:
```bash
node {baseDir}/scry.mjs --history chat/~dabben-larbet/devs 20
```

### Output Format

History returns formatted messages:
```json
[
  {
    "id": "170141184507790725820779267587779330048",
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

## Limitations

- Individual post lookup (`/posts/{id}`) not available via scry
- Pagination (`/posts/older/`, `/posts/newer/`) not available via scry
- DM message history not available via scry (use `--dms` for conversation list only)
- Thread replies must be fetched via subscription, not scry
