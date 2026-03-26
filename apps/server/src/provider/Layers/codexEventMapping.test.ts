/**
 * Unit tests for codexEventMapping — calls mapToRuntimeEvents directly
 * without the full adapter/stream infrastructure.
 */
import { describe, it, expect } from "vitest";
import { mapToRuntimeEvents } from "./codexEventMapping.ts";
import { EventId, type ProviderEvent, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";

const threadId = ThreadId.makeUnsafe("thread-1");

function makeEvent(overrides: Partial<ProviderEvent>): ProviderEvent {
  return {
    id: EventId.makeUnsafe("evt-1"),
    kind: "notification",
    provider: "codex",
    createdAt: new Date().toISOString(),
    threadId,
    ...overrides,
  } as ProviderEvent;
}

describe("codexEventMapping — codex/event/plan_delta", () => {
  it("maps plan_delta with msg.delta to turn.proposed.delta", () => {
    const events = mapToRuntimeEvents(
      makeEvent({
        method: "codex/event/plan_delta",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: {
          msg: {
            turn_id: "turn-1",
            delta: "- Step 1: read the file",
          },
        },
      }),
      threadId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("turn.proposed.delta");
    if (events[0]!.type === "turn.proposed.delta") {
      expect(events[0]!.payload.delta).toBe("- Step 1: read the file");
    }
  });

  it("maps plan_delta with msg.text fallback", () => {
    const events = mapToRuntimeEvents(
      makeEvent({
        method: "codex/event/plan_delta",
        payload: {
          msg: {
            text: "plan text via text field",
          },
        },
      }),
      threadId,
    );

    expect(events).toHaveLength(1);
    if (events[0]!.type === "turn.proposed.delta") {
      expect(events[0]!.payload.delta).toBe("plan text via text field");
    }
  });

  it("maps plan_delta with msg.content.text fallback", () => {
    const events = mapToRuntimeEvents(
      makeEvent({
        method: "codex/event/plan_delta",
        payload: {
          msg: {
            content: { text: "nested content text" },
          },
        },
      }),
      threadId,
    );

    expect(events).toHaveLength(1);
    if (events[0]!.type === "turn.proposed.delta") {
      expect(events[0]!.payload.delta).toBe("nested content text");
    }
  });

  it("returns empty for plan_delta with no extractable delta", () => {
    const events = mapToRuntimeEvents(
      makeEvent({
        method: "codex/event/plan_delta",
        payload: {
          msg: {},
        },
      }),
      threadId,
    );

    expect(events).toHaveLength(0);
  });

  it("returns empty for plan_delta with empty delta string", () => {
    const events = mapToRuntimeEvents(
      makeEvent({
        method: "codex/event/plan_delta",
        payload: {
          msg: { delta: "" },
        },
      }),
      threadId,
    );

    expect(events).toHaveLength(0);
  });
});
