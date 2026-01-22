// Polyfill window.location for Node.js environment
// Required because some clawdbot dependencies (axios, Slack SDK) expect browser globals
if (typeof global.window === "undefined") {
  global.window = {};
}
if (!global.window.location) {
  global.window.location = {
    href: "http://localhost",
    origin: "http://localhost",
    protocol: "http:",
    host: "localhost",
    hostname: "localhost",
    port: "",
    pathname: "/",
    search: "",
    hash: "",
  };
}

import { unixToDa, formatUd } from "@urbit/aura";
import { UrbitSSEClient } from "./urbit-sse-client.js";
import { loadCoreChannelDeps } from "./core-bridge.js";

console.log("[tlon] ====== monitor.js loaded with thread reply fix + dedup fix (commit fad6ef0) ======");

/**
 * Formats model name for display in signature
 * Converts "anthropic/claude-sonnet-4-5" to "Claude Sonnet 4.5"
 */
function formatModelName(modelString) {
  if (!modelString) return "AI";

  // Remove provider prefix (e.g., "anthropic/", "openai/")
  const modelName = modelString.includes("/")
    ? modelString.split("/")[1]
    : modelString;

  // Convert common model names to friendly format
  const modelMappings = {
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-3-5": "Claude Sonnet 3.5",
    "gpt-4o": "GPT-4o",
    "gpt-4-turbo": "GPT-4 Turbo",
    "gpt-4": "GPT-4",
    "gemini-2.0-flash": "Gemini 2.0 Flash",
    "gemini-pro": "Gemini Pro",
  };

  return modelMappings[modelName] || modelName
    .replace(/-/g, " ")
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Authenticate and get cookie
 */
async function authenticate(url, code) {
  const resp = await fetch(`${url}/~/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${code}`,
  });

  if (!resp.ok) {
    throw new Error(`Login failed with status ${resp.status}`);
  }

  // Read and discard the token body
  await resp.text();

  // Extract cookie
  const cookie = resp.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("No authentication cookie received");
  }

  return cookie;
}

/**
 * Sends a direct message via Urbit
 */
async function sendDm(api, fromShip, toShip, text) {
  const story = [{ inline: [text] }];
  const sentAt = Date.now();
  const idUd = formatUd(unixToDa(sentAt).toString());
  const id = `${fromShip}/${idUd}`;

  const delta = {
    add: {
      memo: {
        content: story,
        author: fromShip,
        sent: sentAt,
      },
      kind: null,
      time: null,
    },
  };

  const action = {
    ship: toShip,
    diff: { id, delta },
  };

  await api.poke({
    app: "chat",
    mark: "chat-dm-action",
    json: action,
  });

  return { channel: "tlon", success: true, messageId: id };
}

/**
 * Sends a message to a group channel
 * @param {string} replyTo - Optional parent post ID for threading
 */
async function sendGroupMessage(api, fromShip, hostShip, channelName, text, replyTo = null) {
  const story = [{ inline: [text] }];
  const sentAt = Date.now();

  const action = {
    channel: {
      nest: `chat/${hostShip}/${channelName}`,
      action: replyTo ? {
        // Reply action for threading
        reply: {
          id: replyTo,
          delta: {
            add: {
              memo: {
                content: story,
                author: fromShip,
                sent: sentAt,
              }
            }
          }
        }
      } : {
        // Regular post action
        post: {
          add: {
            content: story,
            author: fromShip,
            sent: sentAt,
            kind: "/chat",
            blob: null,
            meta: null,
          },
        },
      },
    },
  };

  await api.poke({
    app: "channels",
    mark: "channel-action-1",
    json: action,
  });

  return { channel: "tlon", success: true, messageId: `${fromShip}/${sentAt}` };
}

/**
 * Checks if the bot's ship is mentioned in a message
 */
function isBotMentioned(messageText, botShipName) {
  if (!messageText || !botShipName) return false;

  // Normalize bot ship name (ensure it has ~)
  const normalizedBotShip = botShipName.startsWith("~")
    ? botShipName
    : `~${botShipName}`;

  // Escape special regex characters
  const escapedShip = normalizedBotShip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check for mention - ship name should be at start, after whitespace, or standalone
  const mentionPattern = new RegExp(`(^|\\s)${escapedShip}(?=\\s|$)`, "i");
  return mentionPattern.test(messageText);
}

/**
 * Checks if a ship is allowed to send DMs to the bot
 */
function isDmAllowed(senderShip, account) {
  // If dmAllowlist is not configured or empty, allow all
  if (!account.dmAllowlist || !Array.isArray(account.dmAllowlist) || account.dmAllowlist.length === 0) {
    return true;
  }

  // Normalize ship names for comparison (ensure ~ prefix)
  const normalizedSender = senderShip.startsWith("~")
    ? senderShip
    : `~${senderShip}`;

  const normalizedAllowlist = account.dmAllowlist
    .map((ship) => ship.startsWith("~") ? ship : `~${ship}`);

  // Check if sender is in allowlist
  return normalizedAllowlist.includes(normalizedSender);
}

/**
 * Extracts text content from Tlon message structure
 */
function extractMessageText(content) {
  if (!content || !Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.inline && Array.isArray(block.inline)) {
        return block.inline
          .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
              if (item.ship) return item.ship; // Ship mention
              if (item.break !== undefined) return "\n"; // Line break
              if (item.link && item.link.href) return item.link.href; // URL link
              // Skip other objects (images, etc.)
            }
            return "";
          })
          .join("");
      }
      return "";
    })
    .join("\n")
    .trim();
}

/**
 * Parses a channel nest identifier
 * Format: chat/~host-ship/channel-name
 */
function parseChannelNest(nest) {
  if (!nest) return null;
  const parts = nest.split("/");
  if (parts.length !== 3 || parts[0] !== "chat") return null;

  return {
    hostShip: parts[1],
    channelName: parts[2],
  };
}

/**
 * Message cache for channel history (for faster access)
 * Structure: Map<channelNest, Array<{author, content, timestamp, id}>>
 */
const messageCache = new Map();
const MAX_CACHED_MESSAGES = 100;

/**
 * Adds a message to the cache
 */
function cacheMessage(channelNest, message) {
  if (!messageCache.has(channelNest)) {
    messageCache.set(channelNest, []);
  }

  const cache = messageCache.get(channelNest);
  cache.unshift(message); // Add to front (most recent)

  // Keep only last MAX_CACHED_MESSAGES
  if (cache.length > MAX_CACHED_MESSAGES) {
    cache.pop();
  }
}

/**
 * Fetches channel history from Urbit via scry
 * Format: /channels/v4/<channel-nest>/posts/newest/<count>/outline.json
 * Returns pagination object: { newest, posts: {...}, total, newer, older }
 */
async function fetchChannelHistory(api, channelNest, count = 50, runtime) {
  try {
    const scryPath = `/channels/v4/${channelNest}/posts/newest/${count}/outline.json`;
    runtime?.log?.(`[tlon] Fetching history: ${scryPath}`);

    const data = await api.scry(scryPath);
    runtime?.log?.(`[tlon] Scry returned data type: ${Array.isArray(data) ? 'array' : typeof data}, keys: ${typeof data === 'object' ? Object.keys(data).slice(0, 5).join(', ') : 'N/A'}`);

    if (!data) {
      runtime?.log?.(`[tlon] Data is null`);
      return [];
    }

    // Extract posts from pagination object
    let posts = [];
    if (Array.isArray(data)) {
      // Direct array of posts
      posts = data;
    } else if (data.posts && typeof data.posts === 'object') {
      // Pagination object with posts property (keyed by ID)
      posts = Object.values(data.posts);
      runtime?.log?.(`[tlon] Extracted ${posts.length} posts from pagination object`);
    } else if (typeof data === 'object') {
      // Fallback: treat as keyed object
      posts = Object.values(data);
    }

    runtime?.log?.(`[tlon] Processing ${posts.length} posts`);

    // Extract posts from outline format
    const messages = posts.map(item => {
      // Handle both post and r-post structures
      const essay = item.essay || item['r-post']?.set?.essay;
      const seal = item.seal || item['r-post']?.set?.seal;

      return {
        author: essay?.author || 'unknown',
        content: extractMessageText(essay?.content || []),
        timestamp: essay?.sent || Date.now(),
        id: seal?.id,
      };
    }).filter(msg => msg.content); // Filter out empty messages

    runtime?.log?.(`[tlon] Extracted ${messages.length} messages from history`);
    return messages;
  } catch (error) {
    runtime?.log?.(`[tlon] Error fetching channel history: ${error.message}`);
    console.error(`[tlon] Error fetching channel history: ${error.message}`, error.stack);
    return [];
  }
}

/**
 * Gets recent channel history (tries cache first, then scry)
 */
async function getChannelHistory(api, channelNest, count = 50, runtime) {
  // Try cache first for speed
  const cache = messageCache.get(channelNest) || [];
  if (cache.length >= count) {
    runtime?.log?.(`[tlon] Using cached messages (${cache.length} available)`);
    return cache.slice(0, count);
  }

  runtime?.log?.(`[tlon] Cache has ${cache.length} messages, need ${count}, fetching from scry...`);
  // Fall back to scry for full history
  return await fetchChannelHistory(api, channelNest, count, runtime);
}

/**
 * Detects if a message is a summarization request
 */
function isSummarizationRequest(messageText) {
  const patterns = [
    /summarize\s+(this\s+)?(channel|chat|conversation)/i,
    /what\s+did\s+i\s+miss/i,
    /catch\s+me\s+up/i,
    /channel\s+summary/i,
    /tldr/i,
  ];
  return patterns.some(pattern => pattern.test(messageText));
}

/**
 * Formats a date for the groups-ui changes endpoint
 * Format: ~YYYY.M.D..HH.MM.SS..XXXX (only date changes, time/hex stay constant)
 */
function formatChangesDate(daysAgo = 5) {
  const now = new Date();
  const targetDate = new Date(now - (daysAgo * 24 * 60 * 60 * 1000));
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const day = targetDate.getDate();
  // Keep time and hex constant as per Urbit convention
  return `~${year}.${month}.${day}..20.19.51..9b9d`;
}

/**
 * Fetches changes from groups-ui since a specific date
 * Returns delta data that can be used to efficiently discover new channels
 */
async function fetchGroupChanges(api, runtime, daysAgo = 5) {
  try {
    const changeDate = formatChangesDate(daysAgo);
    runtime.log?.(`[tlon] Fetching group changes since ${daysAgo} days ago (${changeDate})...`);

    const changes = await api.scry(`/groups-ui/v5/changes/${changeDate}.json`);

    if (changes) {
      runtime.log?.(`[tlon] Successfully fetched changes data`);
      return changes;
    }

    return null;
  } catch (error) {
    runtime.log?.(`[tlon] Failed to fetch changes (falling back to full init): ${error.message}`);
    return null;
  }
}

/**
 * Fetches all channels the ship has access to
 * Returns an array of channel nest identifiers (e.g., "chat/~host-ship/channel-name")
 * Tries changes endpoint first for efficiency, falls back to full init
 */
async function fetchAllChannels(api, runtime) {
  try {
    runtime.log?.(`[tlon] Attempting auto-discovery of group channels...`);

    // Try delta-based changes first (more efficient)
    const changes = await fetchGroupChanges(api, runtime, 5);

    let initData;
    if (changes) {
      // We got changes, but still need to extract channel info
      // For now, fall back to full init since changes format varies
      runtime.log?.(`[tlon] Changes data received, using full init for channel extraction`);
      initData = await api.scry("/groups-ui/v6/init.json");
    } else {
      // No changes data, use full init
      initData = await api.scry("/groups-ui/v6/init.json");
    }

    const channels = [];

    // Extract chat channels from the groups data structure
    if (initData && initData.groups) {
      for (const [groupKey, groupData] of Object.entries(initData.groups)) {
        if (groupData.channels) {
          for (const channelNest of Object.keys(groupData.channels)) {
            // Only include chat channels (not diary, heap, etc.)
            if (channelNest.startsWith("chat/")) {
              channels.push(channelNest);
            }
          }
        }
      }
    }

    if (channels.length > 0) {
      runtime.log?.(`[tlon] Auto-discovered ${channels.length} chat channel(s)`);
      runtime.log?.(`[tlon] Channels: ${channels.slice(0, 5).join(", ")}${channels.length > 5 ? "..." : ""}`);
    } else {
      runtime.log?.(`[tlon] No chat channels found via auto-discovery`);
      runtime.log?.(`[tlon] Add channels manually to config: channels.tlon.groupChannels`);
    }

    return channels;
  } catch (error) {
    runtime.log?.(`[tlon] Auto-discovery failed: ${error.message}`);
    runtime.log?.(`[tlon] To monitor group channels, add them to config: channels.tlon.groupChannels`);
    runtime.log?.(`[tlon] Example: ["chat/~host-ship/channel-name"]`);
    return [];
  }
}

/**
 * Monitors Tlon/Urbit for incoming DMs and group messages
 */
export async function monitorTlonProvider(opts = {}) {
  const runtime = opts.runtime ?? {
    log: console.log,
    error: console.error,
  };

  const account = opts.account;
  if (!account) {
    throw new Error("Tlon account configuration required");
  }

  runtime.log?.(`[tlon] Account config: ${JSON.stringify({
    showModelSignature: account.showModelSignature,
    ship: account.ship,
    hasCode: !!account.code,
    hasUrl: !!account.url
  })}`);

  const botShipName = account.ship.startsWith("~")
    ? account.ship
    : `~${account.ship}`;

  runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);

  // Authenticate with Urbit
  let api;
  let cookie;
  try {
    runtime.log?.(`[tlon] Attempting authentication to ${account.url}...`);
    runtime.log?.(`[tlon] Ship: ${account.ship.replace(/^~/, "")}`);

    cookie = await authenticate(account.url, account.code);
    runtime.log?.(`[tlon] Successfully authenticated to ${account.url}`);

    // Create custom SSE client
    api = new UrbitSSEClient(account.url, cookie);
  } catch (error) {
    runtime.error?.(`[tlon] Failed to authenticate: ${error.message}`);
    throw error;
  }

  // Get list of group channels to monitor
  let groupChannels = [];

  // Try auto-discovery first (unless explicitly disabled)
  if (account.autoDiscoverChannels !== false) {
    try {
      const discoveredChannels = await fetchAllChannels(api, runtime);
      if (discoveredChannels.length > 0) {
        groupChannels = discoveredChannels;
        runtime.log?.(`[tlon] Auto-discovered ${groupChannels.length} channel(s)`);
      }
    } catch (error) {
      runtime.error?.(`[tlon] Auto-discovery failed: ${error.message}`);
    }
  }

  // Fall back to manual config if auto-discovery didn't find anything
  if (groupChannels.length === 0 && account.groupChannels && account.groupChannels.length > 0) {
    groupChannels = account.groupChannels;
    runtime.log?.(`[tlon] Using manual groupChannels config: ${groupChannels.join(", ")}`);
  }

  if (groupChannels.length > 0) {
    runtime.log?.(
      `[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`
    );
  } else {
    runtime.log?.(`[tlon] No group channels to monitor (DMs only)`);
  }

  // Keep track of processed message IDs to avoid duplicates
  const processedMessages = new Set();

  /**
   * Handler for incoming DM messages
   */
  const handleIncomingDM = async (update) => {
    try {
      runtime.log?.(`[tlon] DM handler called with update: ${JSON.stringify(update).substring(0, 200)}`);

      // Handle new DM event format: response.add.memo
      const memo = update?.response?.add?.memo;
      if (!memo) {
        runtime.log?.(`[tlon] DM update has no memo in response.add`);
        return;
      }

      const messageId = update.id;
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      const senderShip = memo.author?.startsWith("~")
        ? memo.author
        : `~${memo.author}`;

      // Don't respond to our own messages
      if (senderShip === botShipName) return;

      const messageText = extractMessageText(memo.content);
      if (!messageText) return;

      // Check DM access control
      if (!isDmAllowed(senderShip, account)) {
        runtime.log?.(
          `[tlon] Blocked DM from ${senderShip}: not in allowed list`
        );
        return;
      }

      runtime.log?.(
        `[tlon] Received DM from ${senderShip}: "${messageText.slice(0, 50)}..."`
      );

      // All DMs are processed (no mention check needed)

      await processMessage({
        messageId,
        senderShip,
        messageText,
        isGroup: false,
        timestamp: memo.sent || Date.now(),
      });
    } catch (error) {
      runtime.error?.(`[tlon] Error handling DM: ${error.message}`);
    }
  };

  /**
   * Handler for incoming group channel messages
   */
  const handleIncomingGroupMessage = (channelNest) => async (update) => {
    try {
      runtime.log?.(`[tlon] Group handler called for ${channelNest} with update: ${JSON.stringify(update).substring(0, 200)}`);
      const parsed = parseChannelNest(channelNest);
      if (!parsed) return;

      const { hostShip, channelName } = parsed;

      // Handle both top-level posts and thread replies
      // Top-level: response.post.r-post.set.essay
      // Thread reply: response.post.r-post.reply.r-reply.set.memo
      const essay = update?.response?.post?.["r-post"]?.set?.essay;
      const memo = update?.response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.memo;

      if (!essay && !memo) {
        runtime.log?.(`[tlon] Group update has neither essay nor memo`);
        return;
      }

      // Use memo for thread replies, essay for top-level posts
      const content = memo || essay;
      const isThreadReply = !!memo;

      // For thread replies, use the reply ID, not the parent post ID
      const messageId = isThreadReply
        ? update.response.post["r-post"]?.reply?.id
        : update.response.post.id;

      if (processedMessages.has(messageId)) {
        runtime.log?.(`[tlon] Skipping duplicate message ${messageId}`);
        return;
      }
      processedMessages.add(messageId);

      const senderShip = content.author?.startsWith("~")
        ? content.author
        : `~${content.author}`;

      // Don't respond to our own messages
      if (senderShip === botShipName) return;

      const messageText = extractMessageText(content.content);
      if (!messageText) return;

      // Cache this message for history/summarization
      cacheMessage(channelNest, {
        author: senderShip,
        content: messageText,
        timestamp: content.sent || Date.now(),
        id: messageId,
      });

      // Check if bot is mentioned
      const mentioned = isBotMentioned(messageText, botShipName);

      runtime.log?.(
        `[tlon] Received group message in ${channelNest} from ${senderShip}: "${messageText.slice(0, 50)}..." (mentioned: ${mentioned})`
      );

      // Only process if bot is mentioned
      if (!mentioned) return;

      // Check channel authorization
      const tlonConfig = opts.cfg?.channels?.tlon;
      const authorization = tlonConfig?.authorization || {};
      const channelRules = authorization.channelRules || {};
      const defaultAuthorizedShips = tlonConfig?.defaultAuthorizedShips || ["~malmur-halmex"];

      // Get channel rule or use default (restricted)
      const channelRule = channelRules[channelNest];
      const mode = channelRule?.mode || "restricted"; // Default to restricted
      const allowedShips = channelRule?.allowedShips || defaultAuthorizedShips;

      // Normalize sender ship (ensure it has ~)
      const normalizedSender = senderShip.startsWith("~") ? senderShip : `~${senderShip}`;

      // Check authorization for restricted channels
      if (mode === "restricted") {
        const isAuthorized = allowedShips.some(ship => {
          const normalizedAllowed = ship.startsWith("~") ? ship : `~${ship}`;
          return normalizedAllowed === normalizedSender;
        });

        if (!isAuthorized) {
          runtime.log?.(
            `[tlon] ⛔ Access denied: ${normalizedSender} in ${channelNest} (restricted, allowed: ${allowedShips.join(", ")})`
          );
          return;
        }

        runtime.log?.(
          `[tlon] ✅ Access granted: ${normalizedSender} in ${channelNest} (authorized user)`
        );
      } else {
        runtime.log?.(
          `[tlon] ✅ Access granted: ${normalizedSender} in ${channelNest} (open channel)`
        );
      }

      // Extract seal data for thread support
      // For thread replies, seal is in a different location
      const seal = isThreadReply
        ? update?.response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.seal
        : update?.response?.post?.["r-post"]?.set?.seal;

      // For thread replies, reply to the specific message, not the parent post
      // This makes our reply appear as a direct response to the user's message
      const replyToId = isThreadReply
        ? seal?.id  // Reply to this specific message in the thread
        : null;     // Top-level posts don't have a reply target

      const parentId = seal?.["parent-id"] || seal?.parent || null; // Parent post ID (for logging/context)
      const postType = update?.response?.post?.["r-post"]?.set?.type;

      runtime.log?.(
        `[tlon] Message type: ${isThreadReply ? "thread reply" : "top-level post"}, replyToId: ${replyToId}, parentId: ${parentId}`
      );

      await processMessage({
        messageId,
        senderShip,
        messageText,
        isGroup: true,
        groupChannel: channelNest,
        groupName: `${hostShip}/${channelName}`,
        timestamp: content.sent || Date.now(),
        replyToId,  // Use replyToId for threading (the specific message to reply to)
        parentId,   // Keep parentId for context/logging
        postType,
        seal,
      });
    } catch (error) {
      runtime.error?.(
        `[tlon] Error handling group message in ${channelNest}: ${error.message}`
      );
    }
  };

  // Load core channel deps
  const deps = await loadCoreChannelDeps();

  /**
   * Process a message and generate AI response
   */
  const processMessage = async (params) => {
    let {
      messageId,
      senderShip,
      messageText,
      isGroup,
      groupChannel,
      groupName,
      timestamp,
      replyToId,  // The specific message ID to reply to (for threading)
      parentId,   // Parent post ID (for context)
      postType,
      seal,
    } = params;

    runtime.log?.(`[tlon] processMessage called for ${senderShip}, isGroup: ${isGroup}, message: "${messageText.substring(0, 50)}"`);

    // Check if this is a summarization request
    if (isGroup && isSummarizationRequest(messageText)) {
      runtime.log?.(`[tlon] Detected summarization request in ${groupChannel}`);
      try {
        const history = await getChannelHistory(api, groupChannel, 50, runtime);
        if (history.length === 0) {
          const noHistoryMsg = "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
          if (isGroup) {
            const parsed = parseChannelNest(groupChannel);
            if (parsed) {
              await sendGroupMessage(
                api,
                botShipName,
                parsed.hostShip,
                parsed.channelName,
                noHistoryMsg
              );
            }
          } else {
            await sendDm(api, botShipName, senderShip, noHistoryMsg);
          }
          return;
        }

        // Format history for AI
        const historyText = history
          .map(msg => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author}: ${msg.content}`)
          .join("\n");

        const summaryPrompt = `Please summarize this channel conversation (${history.length} recent messages):\n\n${historyText}\n\nProvide a concise summary highlighting:\n1. Main topics discussed\n2. Key decisions or conclusions\n3. Action items if any\n4. Notable participants`;

        // Override message text with summary prompt
        messageText = summaryPrompt;
        runtime.log?.(`[tlon] Generating summary for ${history.length} messages`);
      } catch (error) {
        runtime.error?.(`[tlon] Error generating summary: ${error.message}`);
        const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${error.message}`;
        if (isGroup) {
          const parsed = parseChannelNest(groupChannel);
          if (parsed) {
            await sendGroupMessage(
              api,
              botShipName,
              parsed.hostShip,
              parsed.channelName,
              errorMsg
            );
          }
        } else {
          await sendDm(api, botShipName, senderShip, errorMsg);
        }
        return;
      }
    }

    try {
      // Resolve agent route
      const route = deps.resolveAgentRoute({
        cfg: opts.cfg,
        channel: "tlon",
        accountId: opts.accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: isGroup ? groupChannel : senderShip,
        },
      });

      // Format message for AI
      const fromLabel = isGroup
        ? `${senderShip} in ${groupName}`
        : senderShip;
      const body = deps.formatAgentEnvelope({
        channel: "Tlon",
        from: fromLabel,
        timestamp,
        body: messageText,
      });

      // Create inbound context
      const ctxPayload = deps.finalizeInboundContext({
        Body: body,
        RawBody: messageText,
        CommandBody: messageText,
        From: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
        To: `tlon:${botShipName}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: fromLabel,
        SenderName: senderShip,
        SenderId: senderShip,
        Provider: "tlon",
        Surface: "tlon",
        MessageSid: messageId,
        OriginatingChannel: "tlon",
        OriginatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
      });

      // Dispatch to AI and get response
      const dispatchStartTime = Date.now();
      runtime.log?.(
        `[tlon] Dispatching to AI for ${senderShip} (${isGroup ? `group: ${groupName}` : 'DM'})`
      );

      await deps.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: opts.cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            const dispatchDuration = Date.now() - dispatchStartTime;
            let replyText = payload.text;

            if (!replyText) {
              runtime.log?.(`[tlon] No reply text in AI response (took ${dispatchDuration}ms)`);
              return;
            }

            // Add model signature if enabled
            const tlonConfig = opts.cfg?.channels?.tlon;
            const showSignature = tlonConfig?.showModelSignature ?? false;
            runtime.log?.(`[tlon] showModelSignature config: ${showSignature} (from cfg.channels.tlon)`);
            runtime.log?.(`[tlon] Full payload keys: ${Object.keys(payload).join(', ')}`);
            runtime.log?.(`[tlon] Full route keys: ${Object.keys(route).join(', ')}`);
            runtime.log?.(`[tlon] opts.cfg.agents: ${JSON.stringify(opts.cfg?.agents?.defaults?.model)}`);
            if (showSignature) {
              const modelInfo = payload.metadata?.model || payload.model || route.model || opts.cfg?.agents?.defaults?.model?.primary;
              runtime.log?.(`[tlon] Model info: ${JSON.stringify({
                payloadMetadataModel: payload.metadata?.model,
                payloadModel: payload.model,
                routeModel: route.model,
                cfgModel: opts.cfg?.agents?.defaults?.model?.primary,
                resolved: modelInfo
              })}`);
              if (modelInfo) {
                const modelName = formatModelName(modelInfo);
                runtime.log?.(`[tlon] Adding signature: ${modelName}`);
                replyText = `${replyText}\n\n_[Generated by ${modelName}]_`;
              } else {
                runtime.log?.(`[tlon] No model info found, using fallback`);
                replyText = `${replyText}\n\n_[Generated by AI]_`;
              }
            }

            runtime.log?.(
              `[tlon] AI response received (took ${dispatchDuration}ms), sending to Tlon...`
            );

            // Debug delivery path
            runtime.log?.(`[tlon] 🔍 Delivery debug: isGroup=${isGroup}, groupChannel=${groupChannel}, senderShip=${senderShip}, replyToId=${replyToId}, parentId=${parentId}`);

            // Send reply back to Tlon
            if (isGroup) {
              const parsed = parseChannelNest(groupChannel);
              runtime.log?.(`[tlon] 🔍 Parsed channel nest: ${JSON.stringify(parsed)}`);
              if (parsed) {
                // Reply in thread if this message is part of a thread
                if (replyToId) {
                  runtime.log?.(`[tlon] Replying in thread (replyTo: ${replyToId})`);
                }
                await sendGroupMessage(
                  api,
                  botShipName,
                  parsed.hostShip,
                  parsed.channelName,
                  replyText,
                  replyToId // Pass replyToId to reply to the specific message in the thread
                );
                const threadInfo = replyToId ? ` (in thread)` : '';
                runtime.log?.(`[tlon] Delivered AI reply to group ${groupName}${threadInfo}`);
              } else {
                runtime.log?.(`[tlon] ⚠️ Failed to parse channel nest: ${groupChannel}`);
              }
            } else {
              await sendDm(api, botShipName, senderShip, replyText);
              runtime.log?.(`[tlon] Delivered AI reply to ${senderShip}`);
            }
          },
          onError: (err, info) => {
            const dispatchDuration = Date.now() - dispatchStartTime;
            runtime.error?.(
              `[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`
            );
            runtime.error?.(`[tlon] Error type: ${err?.constructor?.name || 'Unknown'}`);
            runtime.error?.(`[tlon] Error details: ${JSON.stringify(info, null, 2)}`);
            if (err?.stack) {
              runtime.error?.(`[tlon] Stack trace: ${err.stack}`);
            }
          },
        },
      });

      const totalDuration = Date.now() - dispatchStartTime;
      runtime.log?.(
        `[tlon] AI dispatch completed for ${senderShip} (total: ${totalDuration}ms)`
      );
    } catch (error) {
      runtime.error?.(`[tlon] Error processing message: ${error.message}`);
      runtime.error?.(`[tlon] Stack trace: ${error.stack}`);
    }
  };

  // Track currently subscribed channels for dynamic updates
  const subscribedChannels = new Set(); // Start empty, add after successful subscription
  const subscribedDMs = new Set();

  /**
   * Subscribe to a group channel
   */
  async function subscribeToChannel(channelNest) {
    if (subscribedChannels.has(channelNest)) {
      return; // Already subscribed
    }

    const parsed = parseChannelNest(channelNest);
    if (!parsed) {
      runtime.error?.(
        `[tlon] Invalid channel format: ${channelNest} (expected: chat/~host-ship/channel-name)`
      );
      return;
    }

    try {
      await api.subscribe({
        app: "channels",
        path: `/${channelNest}`,
        event: handleIncomingGroupMessage(channelNest),
        err: (error) => {
          runtime.error?.(
            `[tlon] Group subscription error for ${channelNest}: ${error}`
          );
        },
        quit: () => {
          runtime.log?.(`[tlon] Group subscription ended for ${channelNest}`);
          subscribedChannels.delete(channelNest);
        },
      });
      subscribedChannels.add(channelNest);
      runtime.log?.(`[tlon] Subscribed to group channel: ${channelNest}`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to subscribe to ${channelNest}: ${error.message}`);
    }
  }

  /**
   * Subscribe to a DM conversation
   */
  async function subscribeToDM(dmShip) {
    if (subscribedDMs.has(dmShip)) {
      return; // Already subscribed
    }

    try {
      await api.subscribe({
        app: "chat",
        path: `/dm/${dmShip}`,
        event: handleIncomingDM,
        err: (error) => {
          runtime.error?.(`[tlon] DM subscription error for ${dmShip}: ${error}`);
        },
        quit: () => {
          runtime.log?.(`[tlon] DM subscription ended for ${dmShip}`);
          subscribedDMs.delete(dmShip);
        },
      });
      subscribedDMs.add(dmShip);
      runtime.log?.(`[tlon] Subscribed to DM with ${dmShip}`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to subscribe to DM with ${dmShip}: ${error.message}`);
    }
  }

  /**
   * Discover and subscribe to new channels
   */
  async function refreshChannelSubscriptions() {
    try {
      // Check for new DMs
      const dmShips = await api.scry("/chat/dm.json");
      for (const dmShip of dmShips) {
        await subscribeToDM(dmShip);
      }

      // Check for new group channels (if auto-discovery is enabled)
      if (account.autoDiscoverChannels !== false) {
        const discoveredChannels = await fetchAllChannels(api, runtime);

        // Find truly new channels (not already subscribed)
        const newChannels = discoveredChannels.filter(c => !subscribedChannels.has(c));

        if (newChannels.length > 0) {
          runtime.log?.(`[tlon] 🆕 Discovered ${newChannels.length} new channel(s):`);
          newChannels.forEach(c => runtime.log?.(`[tlon]   - ${c}`));
        }

        // Subscribe to all discovered channels (including new ones)
        for (const channelNest of discoveredChannels) {
          await subscribeToChannel(channelNest);
        }
      }
    } catch (error) {
      runtime.error?.(`[tlon] Channel refresh failed: ${error.message}`);
    }
  }

  // Subscribe to incoming messages
  try {
    runtime.log?.(`[tlon] Subscribing to updates...`);

    // Get list of DM ships and subscribe to each one
    let dmShips = [];
    try {
      dmShips = await api.scry("/chat/dm.json");
      runtime.log?.(`[tlon] Found ${dmShips.length} DM conversation(s)`);
    } catch (error) {
      runtime.error?.(`[tlon] Failed to fetch DM list: ${error.message}`);
    }

    // Subscribe to each DM individually
    for (const dmShip of dmShips) {
      await subscribeToDM(dmShip);
    }

    // Subscribe to each group channel
    for (const channelNest of groupChannels) {
      await subscribeToChannel(channelNest);
    }

    runtime.log?.(`[tlon] All subscriptions registered, connecting to SSE stream...`);

    // Connect to Urbit and start the SSE stream
    await api.connect();

    runtime.log?.(`[tlon] Connected! All subscriptions active`);

    // Start dynamic channel discovery (poll every 2 minutes)
    const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
    const pollInterval = setInterval(() => {
      if (!opts.abortSignal?.aborted) {
        runtime.log?.(`[tlon] Checking for new channels...`);
        refreshChannelSubscriptions().catch((error) => {
          runtime.error?.(`[tlon] Channel refresh error: ${error.message}`);
        });
      }
    }, POLL_INTERVAL_MS);

    runtime.log?.(`[tlon] Dynamic channel discovery enabled (checking every 2 minutes)`);

    // Keep the monitor running until aborted
    if (opts.abortSignal) {
      await new Promise((resolve) => {
        opts.abortSignal.addEventListener("abort", () => {
          clearInterval(pollInterval);
          resolve();
        }, {
          once: true,
        });
      });
    } else {
      // If no abort signal, wait indefinitely
      await new Promise(() => {});
    }
  } catch (error) {
    if (opts.abortSignal?.aborted) {
      runtime.log?.(`[tlon] Monitor stopped`);
      return;
    }
    throw error;
  } finally {
    // Cleanup
    try {
      await api.close();
    } catch (e) {
      runtime.error?.(`[tlon] Cleanup error: ${e.message}`);
    }
  }
}
