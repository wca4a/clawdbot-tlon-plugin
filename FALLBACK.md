# AI Model Fallback System for Tlon Bot

## Overview

The Tlon bot (~sitrul-nacwyl) now has automatic fallback when Anthropic gets rate limited or overloaded. It will seamlessly switch to OpenAI's GPT-4 to ensure continuous responses.

## How It Works

### 1. **Primary Model: Anthropic Claude Sonnet 4.5**
- Fastest, most capable model
- Used for all requests by default

### 2. **Fallback Chain**
When Anthropic fails (rate limit, overload, billing), the system automatically tries:
1. **OpenAI GPT-4o** (first fallback)
2. **OpenAI GPT-4 Turbo** (second fallback)

### 3. **Error Detection**
The system automatically detects and handles:
- **Rate Limiting (429)** - Too many requests
- **Overload (529)** - Service temporarily unavailable
- **Billing (402)** - Account payment issue
- **Auth (401/403)** - Credential problems
- **Timeout (408)** - Request took too long

### 4. **Cooldown Management**
When a provider fails, it goes into cooldown:
- **Rate limit errors**: Exponential backoff (5s → 25s → 125s → 625s → up to 1 hour)
- **Billing errors**: Longer backoff (2→4→8 hours, up to 12 hours max)
- **Provider-specific**: Anthropic gets 2hr cooldown, OpenAI gets 1hr

After cooldown expires, the primary model is tried again first.

## Configuration

### Model Fallback Chain
**File:** `~/.clawdbot/clawdbot.json`

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5",
        "fallbacks": [
          "openai/gpt-4o",
          "openai/gpt-4-turbo"
        ]
      }
    }
  }
}
```

### Auth Profiles
**File:** `~/.clawdbot/agents/main/agent/auth-profiles.json`

```json
{
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-..."
    },
    "openai:backup": {
      "type": "api_key",
      "provider": "openai",
      "key": "sk-proj-..."
    }
  }
}
```

### Cooldown Settings
**File:** `~/.clawdbot/clawdbot.json`

```json
{
  "auth": {
    "cooldowns": {
      "billingBackoffHours": 3,
      "billingMaxHours": 12,
      "failureWindowHours": 24,
      "billingBackoffHoursByProvider": {
        "anthropic": 2,
        "openai": 1
      }
    }
  }
}
```

## What Users Experience

### Before Fallback (Old Behavior)
```
User: ~sitrul-nacwyl tell me about Blockwall Capital
Bot: The AI service is temporarily overloaded. Please try again in a moment.
```

### With Fallback (New Behavior)
```
User: ~sitrul-nacwyl tell me about Blockwall Capital
Bot: [Seamless response from GPT-4, user doesn't notice the switch]
```

**Users never see error messages** - the bot automatically switches providers behind the scenes.

## Monitoring

### Check Current Status
```bash
tail -f /tmp/tlon-fallback.log | grep -E "fallback|rate_limit|FailoverError|429|overload"
```

### Check Auth Profile Status
```bash
cat ~/.clawdbot/agents/main/agent/auth-profiles.json
```

Look for `usageStats` to see error counts and last failure times.

### Watch Live Activity
```bash
tail -f /tmp/tlon-fallback.log | grep --line-buffered -E "mentioned: true|Dispatching|Delivered|Error|model"
```

## Example Fallback Flow

1. **User sends message**: "~sitrul-nacwyl explain quantum computing"
2. **Bot tries Anthropic**: Request to `claude-sonnet-4-5`
3. **Anthropic returns 429**: Rate limit exceeded
4. **System detects error**: Creates `FailoverError` with `reason: "rate_limit"`
5. **Tries first fallback**: Request to `openai/gpt-4o`
6. **OpenAI succeeds**: Response generated
7. **Bot replies**: User gets answer (never knew about the fallback)
8. **Anthropic cooldown**: Won't try Anthropic again for 5 seconds (then 25s, 125s, etc.)

## Adding More Providers

To add Google Gemini as a third fallback:

1. **Add auth profile**:
```json
{
  "profiles": {
    "google:backup": {
      "type": "api_key",
      "provider": "google",
      "key": "AIza..."
    }
  }
}
```

2. **Add to fallback chain**:
```json
{
  "model": {
    "primary": "anthropic/claude-sonnet-4-5",
    "fallbacks": [
      "openai/gpt-4o",
      "openai/gpt-4-turbo",
      "google/gemini-2.0-flash"
    ]
  }
}
```

3. **Restart gateway**:
```bash
lsof -ti:18789 | xargs kill -9
clawdbot gateway > /tmp/tlon-fallback.log 2>&1 &
```

## Troubleshooting

### Issue: Bot still showing overload errors
**Cause**: Gateway needs restart to load new config

**Fix**:
```bash
lsof -ti:18789 | xargs kill -9
clawdbot gateway > /tmp/tlon-fallback.log 2>&1 &
```

### Issue: OpenAI fallback not working
**Cause**: Invalid or expired API key

**Fix**: Check OpenAI key validity at https://platform.openai.com/api-keys

### Issue: All providers failing
**Symptoms**: Bot not responding at all

**Debug**:
```bash
# Check error logs
tail -100 /tmp/tlon-fallback.log | grep -i error

# Check auth profile status
cat ~/.clawdbot/agents/main/agent/auth-profiles.json
```

### Issue: Cooldowns too aggressive
**Symptom**: Bot taking too long to retry primary model

**Fix**: Reduce cooldown times in config:
```json
{
  "auth": {
    "cooldowns": {
      "billingBackoffHoursByProvider": {
        "anthropic": 0.5,  // 30 minutes instead of 2 hours
        "openai": 0.25     // 15 minutes instead of 1 hour
      }
    }
  }
}
```

## Testing the Fallback

To test that fallback works:

1. **Monitor logs**:
```bash
tail -f /tmp/tlon-fallback.log
```

2. **Send test message** in Tlon:
```
~sitrul-nacwyl tell me a joke
```

3. **Watch for fallback** (if Anthropic is rate limited):
```
[tlon] Dispatching to AI...
[FailoverError] anthropic/claude-sonnet-4-5 failed: rate_limit
[tlon] Trying fallback: openai/gpt-4o
[tlon] AI response received, sending to Tlon...
[tlon] Delivered AI reply
```

## Benefits

✅ **Zero downtime** - Bot always responds even during rate limits
✅ **Transparent** - Users never see error messages
✅ **Cost-effective** - Only uses fallback when primary fails
✅ **Self-healing** - Automatically returns to primary after cooldown
✅ **Multi-provider** - Not dependent on single AI provider
✅ **Configurable** - Easy to adjust cooldowns and fallback order

## Credits

- **Fallback System**: Built into Clawdbot core
- **Configuration**: Added 2026-01-20
- **Models**: Anthropic Claude Sonnet 4.5, OpenAI GPT-4o, OpenAI GPT-4 Turbo
