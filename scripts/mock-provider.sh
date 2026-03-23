#!/usr/bin/env bash
# mock-provider.sh — Deterministic JSON-RPC stdio mock provider
#
# Simulates a Codex-like app-server that responds to JSON-RPC over stdio.
# Used for the GC cross-contamination stress test (Test B).
#
# Usage: mock-provider.sh [deltas=10] [delay_ms=100] [memory_kb=0]
#
# Behavior:
#   - Responds to "initialize" with {ok: true}
#   - Responds to "thread/start" with a thread ID
#   - On "turn/start": emits turn/started, N item/agentMessage/delta events
#     at fixed intervals, then turn/completed
#   - If memory_kb > 0, allocates garbage string per delta (for GC testing)

set -euo pipefail

DELTAS="${1:-10}"
DELAY_MS="${2:-100}"
MEMORY_KB="${3:-0}"

DELAY_S=$(echo "scale=3; $DELAY_MS / 1000" | bc)

# Generate garbage string of ~N KB
generate_garbage() {
  local kb="$1"
  if [ "$kb" -le 0 ]; then
    echo ""
    return
  fi
  # Each char ~1 byte, so kb*1024 chars
  head -c "$((kb * 1024))" /dev/urandom | base64 | head -c "$((kb * 1024))"
}

send_notification() {
  local method="$1"
  local params="$2"
  echo "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params}"
}

send_response() {
  local id="$1"
  local result="$2"
  echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":$result}"
}

THREAD_COUNTER=0
TURN_COUNTER=0

while IFS= read -r line; do
  # Parse JSON-RPC request
  id=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','null'))" 2>/dev/null || echo "null")
  method=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('method',''))" 2>/dev/null || echo "")
  params=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('params',{})))" 2>/dev/null || echo "{}")

  case "$method" in
    initialize)
      send_response "$id" '{"ok":true,"serverInfo":{"name":"mock-provider","version":"1.0.0"}}'
      ;;

    "thread/start")
      THREAD_COUNTER=$((THREAD_COUNTER + 1))
      thread_id="mock-thread-${THREAD_COUNTER}"
      send_response "$id" "{\"threadId\":\"$thread_id\"}"
      ;;

    "turn/start")
      TURN_COUNTER=$((TURN_COUNTER + 1))
      turn_id="mock-turn-${TURN_COUNTER}"

      # Acknowledge the request
      send_response "$id" "{\"turnId\":\"$turn_id\"}"

      # Emit turn/started
      send_notification "turn/started" "{\"turn\":{\"id\":\"$turn_id\",\"status\":\"running\"}}"

      # Emit deltas
      for i in $(seq 1 "$DELTAS"); do
        sleep "$DELAY_S"
        garbage=""
        if [ "$MEMORY_KB" -gt 0 ]; then
          garbage=$(generate_garbage "$MEMORY_KB")
        fi
        delta_text="Delta $i of $DELTAS"
        if [ -n "$garbage" ]; then
          # Include garbage in metadata (forces allocation in consumer)
          send_notification "item/agentMessage/delta" "{\"delta\":\"$delta_text\",\"_garbage\":\"${garbage:0:1024}\"}"
        else
          send_notification "item/agentMessage/delta" "{\"delta\":\"$delta_text\"}"
        fi
      done

      # Emit turn/completed
      send_notification "turn/completed" "{\"turn\":{\"id\":\"$turn_id\",\"status\":\"completed\"}}"
      ;;

    "turn/cancel"|"session/stop")
      send_response "$id" '{"ok":true}'
      ;;

    *)
      # Unknown method — reply with error
      if [ "$id" != "null" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"error\":{\"code\":-32601,\"message\":\"Method not found: $method\"}}"
      fi
      ;;
  esac
done
