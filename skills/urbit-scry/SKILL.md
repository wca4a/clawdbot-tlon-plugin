---
name: urbit_scry
description: Query Urbit ship state - groups, channels, message history, DMs, contacts, and apps
user-invocable: true
metadata: {"clawdbot":{"emoji":"🔮","requires":{"config":["channels.tlon.enabled"]}}}
---

# Urbit Scry Skill

Query your Urbit ship's state via scry. Use this to fetch groups, channels, message history, DMs, contacts, and installed apps.

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
node {baseDir}/scry.mjs --history chat/~bitbet-bolbel/urbit-community 20
```

### Get older messages (pagination)
```bash
node {baseDir}/scry.mjs --older <nest> <post-id> [count]
```
Use the `id` from the oldest message in previous results to page backwards.

Example:
```bash
node {baseDir}/scry.mjs --older chat/~host/channel 170.141.184.505.382.289 50
```

### Get a thread (post + replies)
```bash
node {baseDir}/scry.mjs --thread <nest> <post-id>
```
Returns the original post and all its replies.

### Get DM history with a ship
```bash
node {baseDir}/scry.mjs --dm <ship> [count]
```

Example:
```bash
node {baseDir}/scry.mjs --dm "~zod" 50
```

**Note:** DM history may not be available via scry on all ships. Tlon primarily uses subscriptions for DM access. Use `--dms` to list DM conversations instead.

## Output Format

History commands return formatted messages:
```json
[
  {
    "id": "170.141.184.505.382.289.616.716.800.565.297.152",
    "author": "~sampel-palnet",
    "content": "Hello world",
    "sent": "2024-01-26T15:30:00.000Z"
  }
]
```

Thread command returns:
```json
{
  "post": { "id": "...", "author": "...", "content": "...", "sent": "..." },
  "replies": [ ... ]
}
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
- `/chat/dm.json` - DM list
- `/hood/kiln/vats.json` - Installed apps
- `/groups-ui/v6/init.json` - Full init (SLOW, ~100KB)

## Options

| Flag | Description |
|------|-------------|
| `--no-cache` | Bypass cache, fetch fresh data |
| `--account <id>` | Use a specific Tlon account |
| `--verbose` | Include raw response data |

## Caching

- Groups, channels, contacts: cached 1 minute
- DM list: cached 30 seconds
- Apps: cached 10 minutes
- Message history: NEVER cached (always fresh)
- init.json: cached 5 minutes

## Finding Channel Nests

To get a channel's nest for history queries:
1. Run `--channels` to list all subscriptions
2. Look for nests starting with `chat/` like `chat/~host-ship/channel-name`
3. Use that nest with `--history`

## When to Use

- User asks "what groups am I in?" → `--groups`
- User asks "show recent messages in X" → `--history chat/~host/X 20`
- User asks "what did ~ship say to me?" → `--dm ~ship 50`
- User asks "get the full thread on that post" → `--thread <nest> <id>`
- User asks "show older messages" → `--older <nest> <last-id> 50`
