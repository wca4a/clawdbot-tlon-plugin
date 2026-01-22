# Release Notes: Notebook Integration Feature

## Feature #10: Integration with Urbit Notebook

This release implements the ability to save AI responses to an Urbit diary channel (notebook).

### New Features

#### Save to Notebook Command
- **Usage**: Reply to any bot message in a thread with "save to my notes"
- **Alternative commands**: "save this to my notes", "save to notebook", "save to diary", etc.
- **Custom titles**: Use "save to my notes as Custom Title" to specify a custom title
- **Auto-title generation**: If no custom title is provided, the first line (up to 60 chars) of the content is used as the title

#### Supported Save Patterns
- `save to my notes`
- `save this to my notes`
- `save that to my notes`
- `save to notebook`
- `save to diary`
- `add to my diary`
- With custom title: `save to my notes as "My Custom Title"`

### Configuration

Add to your `clawdbot.json` under `channels.tlon`:

```json
{
  "channels": {
    "tlon": {
      "notebookChannel": "diary/~your-ship/channel-id"
    }
  }
}
```

Example:
```json
"notebookChannel": "diary/~malmur-halmex/v2u22f1d"
```

### Technical Implementation

#### Files Modified
- **monitor.js**:
  - Added `parseNotebookCommand()` function to detect save commands
  - Added `extractTitle()` function to extract custom titles
  - Added `sendDiaryPost()` function to post to Urbit diary channels
  - Added `fetchDiaryEntries()` function (placeholder for future list command)
  - Enhanced DM handler to support thread replies
  - Implemented DM message caching for history retrieval
  - Integrated notebook command handling in `processMessage()`

- **index.js**:
  - Added `notebookChannel` field to account resolver

#### Key Technical Details

**Urbit Diary Post Structure** (Critical for future reference):
```javascript
{
  channel: {
    nest: "diary/~host/channel-id",  // Must include ~ prefix
    action: {
      post: {
        add: {
          content: [{ inline: [text] }],  // Simple inline array, not block wrapper
          sent: timestamp,
          kind: "/diary",  // Not kind-data: { diary: null }
          author: "~ship-name",
          blob: null,
          meta: {
            title: "Title Here",
            image: "",
            description: "",
            cover: ""
          }
        }
      }
    }
  }
}
```

**Important**:
- Use mark `"channel-action-1"` not `"channel-action"`
- Nest format must be `diary/~host/id` with tilde
- Content structure is simpler than chat memos (no `block.prose` wrapper)

**DM Thread Replies**:
- Thread replies come as `response.reply.delta.add.memo` not `response.add.memo`
- Parent message ID is in `update.id`
- Reply message ID is in `update.response.reply.id`
- DM messages are cached in `messageCache` using key `dm/${senderShip}`

### Behavior

1. **Thread Reply Save**: When you reply to a bot message with "save to my notes", it saves the **parent message** (the message you're replying to)

2. **Direct Save**: When you say "save to my notes" without replying to anything, it finds and saves the **last bot message** in the conversation

3. **Title Generation**:
   - Custom titles can be specified: "save to my notes as My Title"
   - Auto-generated from first line of content if no custom title
   - Truncated to 60 chars with "..." if too long

4. **DM Message Caching**: All DM messages (both user and bot) are now cached for history retrieval, enabling the save functionality to work

### Testing

Tested successfully in DMs:
- ✅ Save command detection
- ✅ Thread reply parent message retrieval
- ✅ Diary post creation with correct structure
- ✅ Auto-title generation from content
- ✅ DM message caching
- ✅ Bot messages properly saved to diary channel

### Future Enhancements

The `fetchDiaryEntries()` function is implemented but not yet wired up. Future release can add:
- "list my notes" command to display saved notebook entries
- Search/filter functionality
- Delete/edit saved notes

### Known Limitations

- Only works in DMs (group chat support could be added)
- DM history only available from messages after bot restart (no historical scry)
- List command not yet implemented
