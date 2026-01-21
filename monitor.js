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
 */
async function sendGroupMessage(api, fromShip, hostShip, channelName, text) {
  const story = [{ inline: [text] }];
  const sentAt = Date.now();

  const action = {
    channel: {
      nest: `chat/${hostShip}/${channelName}`,
      action: {
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
              // Skip other objects
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
 * Fetches all channels the ship has access to
 * Returns an array of channel nest identifiers (e.g., "chat/~host-ship/channel-name")
 */
async function fetchAllChannels(api, runtime) {
  try {
    runtime.log?.(`[tlon] Attempting auto-discovery of group channels...`);

    // Use the groups-ui init endpoint which contains all groups and channels
    const initData = await api.scry("/groups-ui/v6/init.json");

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

      // Handle new group event format: response.post.r-post.set.essay
      const essay = update?.response?.post?.["r-post"]?.set?.essay;
      if (!essay) {
        runtime.log?.(`[tlon] Group update has no essay in response.post.r-post.set`);
        return;
      }

      const messageId = update.response.post.id;
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      const senderShip = essay.author?.startsWith("~")
        ? essay.author
        : `~${essay.author}`;

      // Don't respond to our own messages
      if (senderShip === botShipName) return;

      const messageText = extractMessageText(essay.content);
      if (!messageText) return;

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

      await processMessage({
        messageId,
        senderShip,
        messageText,
        isGroup: true,
        groupChannel: channelNest,
        groupName: `${hostShip}/${channelName}`,
        timestamp: essay.sent || Date.now(),
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
    const {
      messageId,
      senderShip,
      messageText,
      isGroup,
      groupChannel,
      groupName,
      timestamp,
    } = params;

    runtime.log?.(`[tlon] processMessage called for ${senderShip}, isGroup: ${isGroup}, message: "${messageText.substring(0, 50)}"`);

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

            // Send reply back to Tlon
            if (isGroup) {
              const parsed = parseChannelNest(groupChannel);
              if (parsed) {
                await sendGroupMessage(
                  api,
                  botShipName,
                  parsed.hostShip,
                  parsed.channelName,
                  replyText
                );
                runtime.log?.(`[tlon] Delivered AI reply to group ${groupName}`);
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
        for (const channelNest of discoveredChannels) {
          await subscribeToChannel(channelNest);
        }

        // Log if we found new channels
        const newChannelsCount = discoveredChannels.filter(
          c => !subscribedChannels.has(c)
        ).length;
        if (newChannelsCount > 0) {
          runtime.log?.(`[tlon] Discovered ${newChannelsCount} new channel(s)`);
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
