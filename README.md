# Clawdbot Tlon/Urbit Plugin

A channel adapter that enables Clawdbot to send and receive messages on Tlon/Urbit.

## Installation

From your tlon-mcp-server directory:

```bash
cd clawdbot-tlon-plugin
npm install
clawdbot plugins install ./
```

## Configuration

You need to configure your Urbit ship credentials. You can do this via the clawdbot config file or through the CLI.

### Required Configuration

- `ship`: Your Urbit ship name (without ~)
- `code`: Your Urbit +code (authentication code)
- `url`: Your Urbit ship URL (e.g., http://localhost:8080)
- `groupChannels`: (Optional) Array of group channels to monitor manually (format: `chat/~host-ship/channel-name`)
- `autoDiscoverChannels`: (Optional) Set to `false` to disable automatic channel discovery (default: `true`)

### Example Configuration

**Basic Configuration:**
Edit `~/.clawdbot/clawdbot.json`:

```json
{
  "channels": {
    "tlon": {
      "enabled": true,
      "ship": "sitrul-nacwyl",
      "code": "dolsug-ticsen-ripmus-bonmud",
      "url": "https://sitrul-nacwyl.tlon.network"
    }
  }
}
```

The bot will attempt to auto-discover group channels. If auto-discovery doesn't work on your ship, you'll need to manually add channels (see below).

**Manual Group Channels (Optional):**
If you want to manually specify which channels to monitor instead of auto-discovery:

```json
{
  "channels": {
    "tlon": {
      "enabled": true,
      "ship": "zod",
      "code": "lidlut-tabwed-pillex-ridrup",
      "url": "http://localhost:8080",
      "autoDiscoverChannels": false,
      "groupChannels": [
        "chat/~sampel-palnet/my-group-123",
        "chat/~other-ship/another-channel"
      ]
    }
  }
}
```

Or via CLI:

```bash
clawdbot config set channels.tlon.enabled true
clawdbot config set channels.tlon.ship "zod"
clawdbot config set channels.tlon.code "lidlut-tabwed-pillex-ridrup"
clawdbot config set channels.tlon.url "http://localhost:8080"
```

For group channels, edit the config file directly to add the `groupChannels` array.

## Usage

Once configured, you can send messages to Urbit ships:

```bash
clawdbot message send --channel tlon --target ~sampel-palnet --message "Hello from Clawdbot!"
```

## Features

- **Send direct messages** to Urbit ships
- **Receive and respond to DMs** automatically when the bot is mentioned
- **Automatic group discovery** - Automatically finds and monitors all group channels your ship has access to
- **Dynamic channel monitoring** - Checks for new channels every 2 minutes and subscribes automatically (no restart needed!)
- **Group chat support** - Monitor multiple group channels simultaneously
- **Respond in groups** when mentioned
- **Automatic ship name normalization** (handles with or without ~)
- **Connection authentication** and management
- **Real-time monitoring** via Urbit subscriptions
- **AI-powered responses** through clawdbot's agent system
- **Manual channel override** - Optionally specify exact channels to monitor

## How It Works

The plugin monitors incoming messages on your Urbit ship (both DMs and group channels). When someone mentions your ship's name in a message, the bot will:

1. **Detect the mention** - Uses regex pattern matching to identify when your ship is mentioned
2. **Route to AI** - Forwards the message through clawdbot's internal `dispatchReplyWithBufferedBlockDispatcher` API
3. **Process through AI agent** - The message is processed by Claude with full conversation context
4. **Generate response** - AI generates an appropriate contextual response
5. **Send reply** - Delivers the response back via Tlon's SSE API (to the DM or group channel)

### Dynamic Channel Discovery

The bot automatically discovers and subscribes to new channels without requiring a restart:

- **Initial Discovery**: On startup, queries `/~/scry/groups-ui/v6/init.json` to find all accessible channels
- **Periodic Refresh**: Every 2 minutes, re-checks for new channels and DM conversations
- **Auto-Subscribe**: Automatically subscribes to any newly discovered channels
- **No Restart Needed**: Join a new group or start a new DM, and the bot will pick it up within 2 minutes

**What happens when you join a new group:**
1. You join a new Tlon group or channel
2. Within 2 minutes, the bot polls the scry endpoint
3. Discovers the new channel(s)
4. Automatically subscribes to them
5. Starts responding to mentions immediately

**Technical Flow:**
- Messages arrive via Urbit's SSE (Server-Sent Events) subscription system
- Direct messages use the `chat-dm-action` mark with `memo` structure
- Group messages use the `channel-action-1` mark with `essay` structure
- AI responses maintain conversation continuity via session keys
- Channel discovery uses `setInterval()` with 2-minute polling

**Examples:**

Direct Message:
```
User (via DM): "Hey ~zod, what's the weather like today?"
Bot: *processes through AI agent and responds with weather info*
```

Group Channel:
```
User (in group): "Hey ~zod, can you summarize this discussion?"
Bot: *analyzes context and responds in the group with summary*
```

## Architecture

The plugin consists of three main components:

### 1. **index.js** - Plugin Registration
- Defines the Tlon channel plugin interface
- Implements configuration schema and account management
- Registers with clawdbot's plugin system
- Handles outbound message sending

### 2. **monitor.js** - Message Processing
- Authenticates with Urbit ship
- Auto-discovers group channels via `/~/scry/groups-ui/v6/init.json`
- Subscribes to DMs and group channels
- Detects mentions using regex
- Routes messages to AI via `core-bridge.js`
- Delivers AI responses back to Tlon

### 3. **core-bridge.js** - Clawdbot Integration
- Dynamically imports clawdbot's internal APIs
- Provides `resolveAgentRoute()` for session management
- Provides `formatAgentEnvelope()` for message formatting
- Provides `dispatchReplyWithBufferedBlockDispatcher()` for AI routing
- Ensures proper isolation from clawdbot's internal structure

### 4. **urbit-sse-client.js** - SSE Communication
- Custom SSE client for Urbit's event stream
- Handles subscriptions, pokes, and authentication
- Manages connection lifecycle and reconnection

## Limitations

- Bot only responds when explicitly mentioned by ship name
- No media support yet
- No message history in context (single-message processing)

## Finding Group Channel Names

To add group channels manually:

1. **In Tlon:** Open the group and look at the URL or channel details
2. **Format:** Channels are identified as `chat/~[host-ship]/[channel-name]`
3. **Example:** `chat/~lomder-librun/genchat`

**How to find the exact channel identifier:**
- The **host ship** is the ship that hosts the group (starts with ~)
- The **channel name** is the specific channel within that group

**Add to your config:**
```json
{
  "channels": {
    "tlon": {
      "enabled": true,
      "ship": "sitrul-nacwyl",
      "code": "your-code-here",
      "url": "https://sitrul-nacwyl.tlon.network",
      "groupChannels": [
        "chat/~lomder-librun/genchat",
        "chat/~other-host/another-channel"
      ]
    }
  }
}
```

The bot will respond when mentioned in these channels!

## Future Enhancements

- Respond to all messages (not just mentions)
- Contact nickname resolution
- Message history in conversation context
- Media support
- Thread support
- Configurable polling interval (currently fixed at 2 minutes)

## License

MIT
