#!/usr/bin/env node
/**
 * Urbit Scry Script
 * Query your Urbit ship state via scry interface.
 *
 * Paths derived from tloncorp/tlon-apps postsApi.ts
 *
 * Usage:
 *   Raw scry:     node scry.mjs "/groups/groups.json"
 *   History:      node scry.mjs --history chat/~host/channel 50
 *   Older posts:  node scry.mjs --older chat/~host/channel CURSOR 50
 *   Single post:  node scry.mjs --post chat/~host/channel POST_ID
 *   DM history:   node scry.mjs --dm ~sampel-palnet 50
 *   Groups:       node scry.mjs --groups
 *   Channels:     node scry.mjs --channels
 *   Contacts:     node scry.mjs --contacts
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";

// Format @ud number to dotted notation (required for scry paths)
// e.g., "170141184506312077223314290444316180480" → "170.141.184.506.312.077..."
function formatUd(num) {
  const str = String(num).replace(/\./g, ""); // Remove existing dots
  const chunks = [];
  for (let i = str.length; i > 0; i -= 3) {
    chunks.unshift(str.slice(Math.max(0, i - 3), i));
  }
  return chunks.join(".");
}

// Build scry path, filtering out null/undefined segments
function formatScryPath(...segments) {
  return "/" + segments.filter(s => s != null && s !== "").join("/");
}

const CONFIG_PATH = join(homedir(), ".clawdbot", "clawdbot.json");
const CACHE_DIR = join(homedir(), ".clawdbot", "cache", "tlon-scry");

// TTL in milliseconds by path pattern
const TTL_CONFIG = {
  "init.json": 5 * 60 * 1000,      // 5 min - expensive
  "groups.json": 60 * 1000,        // 1 min
  "channels.json": 60 * 1000,      // 1 min
  "contacts": 60 * 1000,           // 1 min
  "dm.json": 30 * 1000,            // 30 sec
  "charges.json": 10 * 60 * 1000,  // 10 min - app tiles
  "posts": 0,                       // no cache - always fresh
  "writs": 0,                       // no cache - always fresh
  "default": 30 * 1000,            // 30 sec
};

function getTTL(path) {
  for (const [pattern, ttl] of Object.entries(TTL_CONFIG)) {
    if (path.includes(pattern)) return ttl;
  }
  return TTL_CONFIG.default;
}

function getCacheKey(path) {
  return createHash("md5").update(path).digest("hex") + ".json";
}

function readCache(path) {
  const ttl = getTTL(path);
  if (ttl === 0) return null; // no caching for this path

  const cacheFile = join(CACHE_DIR, getCacheKey(path));
  if (!existsSync(cacheFile)) return null;

  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (Date.now() - cached.fetchedAt < ttl) {
      return cached.data;
    }
  } catch {
    // cache corrupted, ignore
  }
  return null;
}

function writeCache(path, data) {
  const ttl = getTTL(path);
  if (ttl === 0) return; // no caching for this path

  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, getCacheKey(path));
  writeFileSync(cacheFile, JSON.stringify({
    path,
    data,
    fetchedAt: Date.now(),
  }));
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    console.error(`Failed to read config: ${err.message}`);
    process.exit(1);
  }
}

function getTlonAccount(config, accountId = "default") {
  const tlon = config.channels?.tlon;
  if (!tlon) {
    console.error("Tlon not configured in clawdbot.json");
    process.exit(1);
  }

  if (accountId !== "default" && tlon.accounts?.[accountId]) {
    const account = tlon.accounts[accountId];
    return {
      ship: account.ship || tlon.ship,
      url: account.url || tlon.url,
      code: account.code || tlon.code,
    };
  }

  return { ship: tlon.ship, url: tlon.url, code: tlon.code };
}

async function authenticate(url, code) {
  const response = await fetch(`${url}/~/login`, {
    method: "POST",
    body: `password=${encodeURIComponent(code)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });

  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error(`Auth failed: ${response.status}`);
  return cookie.split(";")[0];
}

async function scry(url, cookie, path, useCache = true) {
  // Check cache first
  if (useCache) {
    const cached = readCache(path);
    if (cached) {
      console.error(`[cache hit] ${path}`);
      return cached;
    }
  }

  const scryPath = path.startsWith("/") ? path : `/${path}`;
  const response = await fetch(`${url}/~/scry${scryPath}`, {
    headers: { Cookie: cookie },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Scry failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  writeCache(path, data);
  return data;
}

// Extract plain text from Tlon content structure
function extractText(content) {
  if (!content) return "";
  return content.flatMap(block => {
    if (block.inline) {
      return block.inline.map(item => {
        if (typeof item === "string") return item;
        if (item.bold) return item.bold.join("");
        if (item.italic) return item.italic.join("");
        if (item.strike) return item.strike.join("");
        if (item.code) return item.code;
        if (item.link) return item.link.content || item.link.href;
        return "";
      });
    }
    if (block.block?.code) return block.block.code;
    return [];
  }).join("");
}

// Format a single reply
function formatReply(reply) {
  const memo = reply.memo;
  const seal = reply.seal;

  return {
    id: seal?.id,
    author: memo?.author || "unknown",
    content: extractText(memo?.content || []),
    sent: new Date(memo?.sent || Date.now()).toISOString()
  };
}

// Format posts for readable output
function formatPosts(data, verbose = false) {
  // Handle nested { posts: {...} } structure from channel history
  let posts = data;
  if (data && data.posts && typeof data.posts === "object") {
    posts = data.posts;
  }

  const items = Array.isArray(posts) ? posts : Object.values(posts);
  return items
    .filter(item => item !== null && item !== undefined)
    .map(item => {
      const essay = item.essay || item["r-post"]?.set?.essay;
      const seal = item.seal || item["r-post"]?.set?.seal;
      const memo = item.memo; // for DMs

      const author = essay?.author || memo?.author || "unknown";
      const content = extractText(essay?.content || memo?.content || []);
      const sent = essay?.sent || memo?.sent || Date.now();
      const id = seal?.id || item.id;

      // Extract replies if present
      const replies = seal?.replies && typeof seal.replies === "object"
        ? Object.values(seal.replies)
            .filter(r => r !== null && r !== undefined)
            .map(formatReply)
        : [];

      const post = {
        id,
        author,
        content,
        sent: new Date(sent).toISOString()
      };

      if (replies.length > 0) {
        post.replies = replies;
      }

      if (verbose) {
        post.raw = item;
      }

      return post;
    })
    .filter(m => m.content);
}

// ============ HELPER FUNCTIONS ============
// Based on tloncorp/tlon-apps postsApi.ts

// Get last N messages from a channel
// Path: /v4/{channelId}/posts/newest/{count}/{format}
async function getHistory(url, cookie, nest, count = 50, includeReplies = false) {
  const format = includeReplies ? "post" : "outline";
  const path = formatScryPath("channels", "v4", nest, "posts", "newest", count, format + ".json");
  const data = await scry(url, cookie, path, false); // no cache for posts
  return formatPosts(data);
}

// Get posts older than a cursor (pagination)
// Path: /v4/{channelId}/posts/older/{cursor}/{count}/{format}
async function getOlderPosts(url, cookie, nest, cursor, count = 50, includeReplies = false) {
  const format = includeReplies ? "post" : "outline";
  const formattedCursor = formatUd(cursor);
  const path = formatScryPath("channels", "v4", nest, "posts", "older", formattedCursor, count, format + ".json");
  const data = await scry(url, cookie, path, false);
  return formatPosts(data);
}

// Get posts newer than a cursor (pagination)
// Path: /v4/{channelId}/posts/newer/{cursor}/{count}/{format}
async function getNewerPosts(url, cookie, nest, cursor, count = 50, includeReplies = false) {
  const format = includeReplies ? "post" : "outline";
  const formattedCursor = formatUd(cursor);
  const path = formatScryPath("channels", "v4", nest, "posts", "newer", formattedCursor, count, format + ".json");
  const data = await scry(url, cookie, path, false);
  return formatPosts(data);
}

// Get a single post by ID (with replies)
// Path: /v4/{channelId}/posts/post/{postId}
async function getPost(url, cookie, nest, postId) {
  const formattedId = formatUd(postId);
  const path = formatScryPath("channels", "v4", nest, "posts", "post", formattedId + ".json");
  const data = await scry(url, cookie, path, false);
  return data;
}

// Get DM history
// Path: /v3/dm/{dm-id}/writs/newest/{count}/{format}
async function getDmHistory(url, cookie, dmId, count = 50, includeReplies = false) {
  const format = includeReplies ? "heavy" : "light";
  const path = formatScryPath("chat", "v3", "dm", dmId, "writs", "newest", count, format + ".json");
  const data = await scry(url, cookie, path, false);
  return formatWrits(data);
}

// Get club (group DM) history
// Path: /v3/club/{club-id}/writs/newest/{count}/{format}
async function getClubHistory(url, cookie, clubId, count = 50, includeReplies = false) {
  const format = includeReplies ? "heavy" : "light";
  const path = formatScryPath("chat", "v3", "club", clubId, "writs", "newest", count, format + ".json");
  const data = await scry(url, cookie, path, false);
  return formatWrits(data);
}

// Format DM writs for readable output
// Note: DMs can have 'essay' (newer API) or 'memo' (older API)
function formatWrits(data, verbose = false) {
  let writs = data;
  if (data && data.writs && typeof data.writs === "object") {
    writs = data.writs;
  }

  const items = Array.isArray(writs) ? writs : Object.values(writs);
  return items
    .filter(item => item !== null && item !== undefined)
    .map(item => {
      // Try essay first (newer API), then memo (older API)
      const essay = item.essay || item.memo;
      const seal = item.seal;

      const author = essay?.author || "unknown";
      const content = extractText(essay?.content || []);
      const sent = essay?.sent || Date.now();
      const id = seal?.id || item.id;

      // Extract replies if present (same structure as channel posts)
      const replies = seal?.replies && typeof seal.replies === "object"
        ? Object.values(seal.replies)
            .filter(r => r !== null && r !== undefined)
            .map(formatReply)
        : [];

      const writ = {
        id,
        author,
        content,
        sent: new Date(sent).toISOString()
      };

      if (replies.length > 0) {
        writ.replies = replies;
      }

      if (verbose) {
        writ.raw = item;
      }

      return writ;
    })
    .filter(m => m.content);
}


// ============ CLI ============

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Urbit Scry - Query your Urbit ship
(Paths from tloncorp/tlon-apps postsApi.ts)

SHORTCUTS:
  --groups                         List all groups
  --channels                       List all channel subscriptions
  --contacts                       List all contacts
  --dms                            List DM conversations
  --apps                           List installed apps

CHANNEL HISTORY:
  --history <nest> [count]         Last N messages from channel
  --older <nest> <cursor> [count]  Posts older than cursor
  --newer <nest> <cursor> [count]  Posts newer than cursor
  --post <nest> <postId>           Single post with replies

DM HISTORY:
  --dm <ship> [count]              DM history with ship
  --club <club-id> [count]         Group DM history

RAW SCRY:
  <path>                           Any scry path ending in .json

OPTIONS:
  --no-cache                       Bypass cache
  --account <id>                   Use specific Tlon account
  --verbose                        Include raw response data
  --replies                        Include replies (use with --history)

EXAMPLES:
  node scry.mjs --groups
  node scry.mjs --history chat/~bitbet-bolbel/urbit-community 20
  node scry.mjs --older chat/~host/channel 170.141.184... 50
  node scry.mjs --post chat/~host/channel 170.141.184...
  node scry.mjs --dm ~sampel-palnet 50
  node scry.mjs "/groups/groups.json"
`);
    process.exit(0);
  }

  // Parse flags
  const noCache = args.includes("--no-cache");
  const verbose = args.includes("--verbose");
  const includeReplies = args.includes("--replies");
  let accountId = "default";
  const accountIdx = args.indexOf("--account");
  if (accountIdx !== -1) accountId = args[accountIdx + 1];

  // Load config and auth
  const config = loadConfig();
  const account = getTlonAccount(config, accountId);

  if (!account.ship || !account.url || !account.code) {
    console.error("Tlon not fully configured (need ship, url, code)");
    process.exit(1);
  }

  const cookie = await authenticate(account.url, account.code);

  try {
    let result;

    // Shortcuts
    if (args.includes("--groups")) {
      result = await scry(account.url, cookie, "/groups/groups.json", !noCache);
    } else if (args.includes("--channels")) {
      result = await scry(account.url, cookie, "/channels/v4/channels.json", !noCache);
    } else if (args.includes("--contacts")) {
      result = await scry(account.url, cookie, "/contacts/all.json", !noCache);
    } else if (args.includes("--dms")) {
      result = await scry(account.url, cookie, "/chat/dm.json", !noCache);
    } else if (args.includes("--apps")) {
      result = await scry(account.url, cookie, "/docket/charges.json", !noCache);
    }
    // History helpers
    else if (args.includes("--history")) {
      const idx = args.indexOf("--history");
      const nest = args[idx + 1];
      const count = parseInt(args[idx + 2]) || 50;
      if (!nest) throw new Error("--history requires nest (e.g., chat/~host/channel)");
      result = await getHistory(account.url, cookie, nest, count, includeReplies);
    }
    // Pagination: older
    else if (args.includes("--older")) {
      const idx = args.indexOf("--older");
      const nest = args[idx + 1];
      const cursor = args[idx + 2];
      const count = parseInt(args[idx + 3]) || 50;
      if (!nest || !cursor) throw new Error("--older requires nest and cursor");
      result = await getOlderPosts(account.url, cookie, nest, cursor, count, includeReplies);
    }
    // Pagination: newer
    else if (args.includes("--newer")) {
      const idx = args.indexOf("--newer");
      const nest = args[idx + 1];
      const cursor = args[idx + 2];
      const count = parseInt(args[idx + 3]) || 50;
      if (!nest || !cursor) throw new Error("--newer requires nest and cursor");
      result = await getNewerPosts(account.url, cookie, nest, cursor, count, includeReplies);
    }
    // Single post
    else if (args.includes("--post")) {
      const idx = args.indexOf("--post");
      const nest = args[idx + 1];
      const postId = args[idx + 2];
      if (!nest || !postId) throw new Error("--post requires nest and postId");
      result = await getPost(account.url, cookie, nest, postId);
    }
    // DM history
    else if (args.includes("--dm")) {
      const idx = args.indexOf("--dm");
      const dmId = args[idx + 1];
      const count = parseInt(args[idx + 2]) || 50;
      if (!dmId) throw new Error("--dm requires ship (e.g., ~sampel-palnet)");
      result = await getDmHistory(account.url, cookie, dmId, count, includeReplies);
    }
    // Club (group DM) history
    else if (args.includes("--club")) {
      const idx = args.indexOf("--club");
      const clubId = args[idx + 1];
      const count = parseInt(args[idx + 2]) || 50;
      if (!clubId) throw new Error("--club requires club-id");
      result = await getClubHistory(account.url, cookie, clubId, count, includeReplies);
    }
    // Raw scry path
    else {
      const path = args.find(a => !a.startsWith("--"));
      if (!path) throw new Error("No scry path provided");
      result = await scry(account.url, cookie, path, !noCache);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
