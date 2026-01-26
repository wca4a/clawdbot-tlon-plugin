#!/usr/bin/env node
/**
 * Urbit Scry Script
 * Query your Urbit ship state via scry interface.
 *
 * Usage:
 *   Raw scry:     node scry.mjs "/groups/groups.json"
 *   History:      node scry.mjs --history chat/~host/channel 50
 *   Older posts:  node scry.mjs --older chat/~host/channel POST_ID 50
 *   Thread:       node scry.mjs --thread chat/~host/channel POST_ID
 *   DM history:   node scry.mjs --dm ~sampel-palnet 50
 *   Groups:       node scry.mjs --groups
 *   Channels:     node scry.mjs --channels
 *   Contacts:     node scry.mjs --contacts
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";

const CONFIG_PATH = join(homedir(), ".clawdbot", "clawdbot.json");
const CACHE_DIR = join(homedir(), ".clawdbot", "cache", "tlon-scry");

// TTL in milliseconds by path pattern
const TTL_CONFIG = {
  "init.json": 5 * 60 * 1000,      // 5 min - expensive
  "groups.json": 60 * 1000,        // 1 min
  "channels.json": 60 * 1000,      // 1 min
  "contacts": 60 * 1000,           // 1 min
  "dm.json": 30 * 1000,            // 30 sec
  "vats.json": 10 * 60 * 1000,     // 10 min
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

      if (verbose) {
        return { id, author, content, sent: new Date(sent).toISOString(), raw: item };
      }
      return { id, author, content, sent: new Date(sent).toISOString() };
    })
    .filter(m => m.content);
}

// ============ HELPER FUNCTIONS ============

// Get last N messages from a channel
async function getHistory(url, cookie, nest, count = 50) {
  const path = `/channels/v4/${nest}/posts/newest/${count}/outline.json`;
  const data = await scry(url, cookie, path, false); // no cache for posts
  return formatPosts(data);
}

// Get messages older than a specific post ID
async function getOlderPosts(url, cookie, nest, beforeId, count = 50) {
  const path = `/channels/v4/${nest}/posts/older/${beforeId}/${count}.json`;
  const data = await scry(url, cookie, path, false);
  return formatPosts(data);
}

// Get a single post with its replies (thread)
async function getThread(url, cookie, nest, postId) {
  const postPath = `/channels/v4/${nest}/posts/${postId}.json`;
  const repliesPath = `/channels/v4/${nest}/posts/${postId}/replies.json`;

  const [post, replies] = await Promise.all([
    scry(url, cookie, postPath, false),
    scry(url, cookie, repliesPath, false).catch(() => []),
  ]);

  return {
    post: formatPosts([post])[0],
    replies: formatPosts(replies),
  };
}

// Get DM history with a ship
// NOTE: DM history scry may not be available - Tlon uses subscriptions for DMs
async function getDmHistory(url, cookie, ship, count = 50) {
  const normalizedShip = ship.startsWith("~") ? ship : `~${ship}`;

  // Try various possible paths
  const paths = [
    `/chat/dm/${normalizedShip}/writs/newest/${count}.json`,
    `/chat/${normalizedShip}/writs/newest/${count}.json`,
    `/chat/dm/${normalizedShip}.json`,
  ];

  for (const path of paths) {
    try {
      const data = await scry(url, cookie, path, false);
      if (data && typeof data === "object") {
        if (data.writs) return formatPosts(data.writs);
        return formatPosts(data);
      }
    } catch {
      // Try next path
    }
  }

  throw new Error(`DM history not available via scry for ${normalizedShip}. DMs may require subscription-based access.`);
}

// ============ CLI ============

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Urbit Scry - Query your Urbit ship

SHORTCUTS:
  --groups                         List all groups
  --channels                       List all channel subscriptions
  --contacts                       List all contacts
  --dms                            List DM conversations
  --apps                           List installed apps

HISTORY:
  --history <nest> [count]         Last N messages from channel
                                   nest = chat/~host/channel-name
  --older <nest> <id> [count]      Messages older than post ID
  --thread <nest> <id>             Get post and its replies
  --dm <ship> [count]              DM history with a ship

RAW SCRY:
  <path>                           Any scry path ending in .json

OPTIONS:
  --no-cache                       Bypass cache
  --account <id>                   Use specific Tlon account
  --verbose                        Include raw response data

EXAMPLES:
  node scry.mjs --groups
  node scry.mjs --history chat/~bitbet-bolbel/urbit-community 20
  node scry.mjs --dm ~zod 50
  node scry.mjs --thread chat/~host/channel 170.141.184.505...
  node scry.mjs "/groups/groups.json"
`);
    process.exit(0);
  }

  // Parse flags
  const noCache = args.includes("--no-cache");
  const verbose = args.includes("--verbose");
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
      result = await scry(account.url, cookie, "/hood/kiln/vats.json", !noCache);
    }
    // History helpers
    else if (args.includes("--history")) {
      const idx = args.indexOf("--history");
      const nest = args[idx + 1];
      const count = parseInt(args[idx + 2]) || 50;
      if (!nest) throw new Error("--history requires nest (e.g., chat/~host/channel)");
      result = await getHistory(account.url, cookie, nest, count);
    } else if (args.includes("--older")) {
      const idx = args.indexOf("--older");
      const nest = args[idx + 1];
      const postId = args[idx + 2];
      const count = parseInt(args[idx + 3]) || 50;
      if (!nest || !postId) throw new Error("--older requires nest and post ID");
      result = await getOlderPosts(account.url, cookie, nest, postId, count);
    } else if (args.includes("--thread")) {
      const idx = args.indexOf("--thread");
      const nest = args[idx + 1];
      const postId = args[idx + 2];
      if (!nest || !postId) throw new Error("--thread requires nest and post ID");
      result = await getThread(account.url, cookie, nest, postId);
    } else if (args.includes("--dm")) {
      const idx = args.indexOf("--dm");
      const ship = args[idx + 1];
      const count = parseInt(args[idx + 2]) || 50;
      if (!ship) throw new Error("--dm requires ship name");
      result = await getDmHistory(account.url, cookie, ship, count);
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
