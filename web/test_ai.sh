#!/usr/bin/env bash

set -euo pipefail

echo "Testing Anthropic API endpoints..."

ASSISTANT_RESPONSE=$(curl -s -X POST http://localhost:3000/api/ai/assistant \
  -H "Content-Type: application/json" \
  -d '{"name":"Transit Planner Test","systemPrompt":"You are a helpful transit planning assistant."}')

echo "Assistant response:"
echo "$ASSISTANT_RESPONSE"

MESSAGE_RESPONSE=$(curl -s -X POST http://localhost:3000/api/ai/message \
  -H "Content-Type: application/json" \
  -d '{"message":"Suggest a subway line for Toronto","systemPrompt":"You are a helpful transit planning assistant."}')

echo
echo "Message response:"
echo "$MESSAGE_RESPONSE"

echo
echo "Streaming chat response:"
curl -X POST http://localhost:3000/api/ai/chat \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Hello from the streaming test","systemPrompt":"You are a helpful transit planning assistant."}'
echo
