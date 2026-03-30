# 003: Fix OpenCode Model Picker Lag (4,070 models causing UI freeze)

## Goal

Eliminate the UI freeze and SchemaError spam caused by OpenCode's model discovery returning 4,070 models. Fix at three layers: sanitize at the harness, reduce unnecessary React Query invalidation, and virtualize the model picker dropdown.

## Context

OpenCode's model API returns 4,070 models. This creates a cascade of problems:

1. **SchemaError spam**: `"DeepSeek R1 (Turbo)\t"` (model index 1275) has a trailing tab character that fails `TrimmedNonEmptyString` validation on every `server.providersUpdated` push (~every 10-15s).
2. **Massive payload**: `server.providersUpdated` pushes all 4,070 models to every connected browser client on every cycle.
3. **UI freeze on hover**: `ProviderModelPicker` renders 4,070 `MenuRadioItem` components when the user hovers over OpenCode in the Composer.

### Root Cause Chain

```
OpenCode API -> 4,070 models (no filtering)
  -> model_discovery.ex caches all as-is (no trim/dedup)
  -> server.providersUpdated pushes all to browser every ~10-15s
  -> "DeepSeek R1 (Turbo)\t" trailing tab -> SchemaError on every push
  -> wsNativeApi.ts receives push -> invalidates React Query cache
  -> ChatView.tsx:1025 useMemo rebuilds modelOptionsByProvider (4,070 entries)
  -> ChatView.tsx:1048 flatMaps ALL into searchableModelOptions
  -> On hover: ProviderModelPicker.tsx:191 renders 4,070 MenuRadioItems
  -> UI freezes
```

### Schema Path

The validation failure flows through:

- `packages/contracts/src/baseSchemas.ts:4` — `TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty())`
- `packages/contracts/src/server.ts:38-41` — `ServerProviderModel` uses `TrimmedNonEmptyString` for both `slug` and `name`
- `packages/contracts/src/server.ts:55` — `ServerProvider.models: Schema.Array(ServerProviderModel)`
- `packages/contracts/src/ws.ts:234` — `WsPushServerProvidersUpdated` wraps `ServerProviderUpdatedPayload`
- On decode, the trailing `\t` in `"DeepSeek R1 (Turbo)\t"` triggers `TrimmedString` (which trims), then `isNonEmpty()` passes, but any downstream roundtrip that expects exact string match will fail or produce a mismatch.

## Fix Layers (priority order)

### Layer 1 -- Sanitize at harness (highest priority, stops the bleeding)

**File**: `apps/harness/lib/harness/model_discovery.ex`

**Changes**:

1. In `parse_opencode_models/1` (line 188), trim whitespace (including tabs) from slug and derived name after parsing. Currently `String.trim/1` is applied to the full line but not to the final `slug` value placed in the map.
2. Add dedup by slug: `|> Enum.uniq_by(& &1["slug"])`.
3. Optionally cap at a reasonable ceiling (200 models per provider) to prevent payload bloat regardless of upstream API changes. Log when truncating.

**Why this is first**: It immediately stops the SchemaError spam and reduces payload size at the source. Zero frontend changes required.

### Layer 2 -- Granular React Query invalidation

**File**: `apps/web/src/routes/__root.tsx` (line 312-314)

**Current behavior** (line 312-314):

```typescript
const unsubProvidersUpdated = onServerProvidersUpdated(() => {
  void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
});
```

Every `server.providersUpdated` push invalidates the entire `server.config` query, triggering a full refetch of server config, which cascades into re-renders of everything that depends on `serverConfigQuery.data`.

**Fix**: Instead of invalidating `server.config`, update only the providers data directly in the query cache (or use a separate query key for providers). The `onServerProvidersUpdated` callback already receives the full `ServerProviderUpdatedPayload` -- use `queryClient.setQueryData` to surgically update just the providers slice.

### Layer 3 -- Virtualize model picker

**File**: `apps/web/src/components/chat/ProviderModelPicker.tsx` (line 191)

**Current behavior** (line 191):

```tsx
{props.modelOptionsByProvider[option.value].map((modelOption) => (
  <MenuRadioItem ...>{modelOption.name}</MenuRadioItem>
))}
```

All models for a provider are rendered as DOM nodes on hover. With 4,070 models for OpenCode, this creates 4,070 DOM elements.

**Fix options** (choose one):

- **A) Virtualized list**: Use `@tanstack/react-virtual` or similar to only render visible items in the scrollable menu popup. Preserves the existing menu structure.
- **B) Searchable picker with lazy render**: Replace the flat list with a search input + filtered list, only rendering the top N matches. Better UX for large lists anyway.
- **C) Simple cap + "show more"**: Render first 50 models, show "N more..." item that expands. Simplest but least elegant.

Recommendation: Option B -- a searchable model picker is better UX regardless of list size.

### Layer 3b -- Memoize searchableModelOptions

**File**: `apps/web/src/components/ChatView.tsx` (lines 1025-1064)

The `searchableModelOptions` memo (line 1048) flatMaps all providers' models into a single array on every `modelOptionsByProvider` change. With 4,070 OpenCode models, this is expensive. After Layer 3 this becomes less critical, but the memo dependencies should be tightened to avoid unnecessary recomputation.

## Files to Modify

| File                                                   | Layer | Change                                             |
| ------------------------------------------------------ | ----- | -------------------------------------------------- |
| `apps/harness/lib/harness/model_discovery.ex`          | 1     | Trim slug/name, dedup, optional cap                |
| `apps/web/src/routes/__root.tsx`                       | 2     | Granular cache update instead of full invalidation |
| `apps/web/src/components/chat/ProviderModelPicker.tsx` | 3     | Virtualize or search-filter model list             |
| `apps/web/src/components/ChatView.tsx`                 | 3b    | Tighten memo deps for searchableModelOptions       |

## Files to Read (Implementation References)

- `packages/contracts/src/baseSchemas.ts:4` — `TrimmedNonEmptyString` definition
- `packages/contracts/src/server.ts:38-55` — `ServerProviderModel` and `ServerProvider` schemas (model shape + where models array lives)
- `packages/contracts/src/ws.ts:232-234` — `WsPushServerProvidersUpdated` push schema
- `apps/web/src/wsNativeApi.ts:66-87` — `onServerProvidersUpdated` listener registration (payload is available to callback)
- `apps/server/src/provider/Layers/HarnessProvider.ts` — where models are passed into provider snapshot
- `apps/server/src/provider/Layers/HarnessClientManager.ts` — accepts raw model strings from harness

## Dependencies

- None. All three layers are independent and can be shipped incrementally.

## Schema Changes

- None. The `ServerProviderModel` schema already does `TrimmedString` (trims input). The fix is ensuring the source data is clean before it hits the schema, and reducing the volume of data flowing through it.

## Risks

- **Layer 1 cap**: If a user genuinely needs access to model 201+, a hard cap would hide those. Mitigate by making the cap configurable or generous (500). The search-based picker in Layer 3 makes large lists usable anyway.
- **Layer 2 cache surgery**: Directly setting query data bypasses any transform logic in the `server.config` query function. Verify the providers slice shape matches exactly.
- **Layer 3 virtualization**: Menu keyboard navigation (arrow keys) must still work with virtualized items. Test with both mouse and keyboard selection.

## Validation

- `bun typecheck` must pass after all changes.
- Manual test: start dev stack with OpenCode provider, verify no SchemaError in server logs, verify model picker opens without lag.
- Automated: consider adding a test in `apps/web/src/wsNativeApi.test.ts` for the providersUpdated flow with a large model list.

## Discovered By

Provider council audit (GPT-5.4 Codex found the same chain independently). Confirmed via dev stack logs showing repeated SchemaError every ~10s and `Discovered 4070 models for opencode`.
