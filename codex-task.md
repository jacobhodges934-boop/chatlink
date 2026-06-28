# Task: Fix ChatLink delegate_coding_task generation detection

## Current State

All source files in D:\文档\chatlink\ have been modified. The MCP server builds successfully (npm run build passes). The Chrome extension files (extractor.js, background.js) have been updated but Chrome may be caching old content scripts.

## The Core Problem

`delegate_coding_task` calls `send_chat_message` then polls `get_chat_context` every 1-2 seconds waiting for the AI response to complete. It needs to detect when generation is done.

The detection uses two signals:
1. `confirmationSignal` from send confirmation (set to "generation_started" if a stop button appeared)
2. `isGenerating` from each poll (checks if a stop button is visible in the DOM)

Both are unreliable because ChatGPT's DOM structure is unknown from our side.

## What We Need

A reliable way to detect that ChatGPT has finished generating. The approach should work even if:
- The stop button selectors don't match
- The confirmationSignal is undefined
- The content script is a slightly stale version

## Design Freedom

You have full freedom to design the approach. Some options:
- Pure server-side: track message count/content changes in the polling loop
- Fix the content script injection issue
- Use a completely different signal (network requests, DOM mutations, etc.)
- Any combination

## Success Criteria

After your changes:
1. `cd mcp-server && npm run build` passes
2. delegate_coding_task returns within 15 seconds for a short ChatGPT reply
3. observedGenerating is true in the response metadata (or the response completes quickly regardless)

## Files

Key files you may need to modify:
- mcp-server/src/index.ts (polling loop in delegate_coding_task)
- mcp-server/src/bridge.ts
- mcp-server/src/types.ts
- chrome-extension/content-scripts/extractor.js
- chrome-extension/background.js

## Output

After implementing, tell me:
1. What you changed and why
2. What the user needs to do (restart Claude Code? reload extension? refresh page?)
