import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface CursorProviderShape extends ServerProviderShape {}

export class CursorProvider extends ServiceMap.Service<CursorProvider, CursorProviderShape>()(
  "t3/provider/Services/HarnessProvider/CursorProvider",
) {}

export interface OpenCodeProviderShape extends ServerProviderShape {}

export class OpenCodeProvider extends ServiceMap.Service<OpenCodeProvider, OpenCodeProviderShape>()(
  "t3/provider/Services/HarnessProvider/OpenCodeProvider",
) {}
