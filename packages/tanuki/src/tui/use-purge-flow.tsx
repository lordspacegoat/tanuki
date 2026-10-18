/**
 * Wires a screen's "purge this scope" action to the confirm → run flow.
 *
 * The zone explorer and the groups screen both need exactly this and nothing
 * more: resolve a scope against the current zones and groups, refuse it plainly
 * if there is nothing to do, otherwise take over the content area until the run
 * finishes. Keeping it here means the two screens cannot drift apart on what a
 * purge asks, and neither has to know how `PurgeFlow` is staged.
 */
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { CloudflareClient } from "../cloudflare/client.ts";
import type { Group, PurgeRate, ZoneRecord } from "../config/schema.ts";
import { purgeZones } from "../services/purge-service.ts";
import type { PurgeSummary } from "../services/purge-service.ts";
import { blockedReason, resolveScope } from "../services/purge-scope.ts";
import type { PurgeScope, ResolvedScope } from "../services/purge-scope.ts";
import { PurgeFlow } from "./screens/purge-flow.tsx";
import type { PurgeRunFn } from "./screens/purge-flow.tsx";
import type { Palette } from "./theme.ts";

export interface PurgeFlowControls {
  /**
   * Opens the confirm step. Returns a sentence instead when the scope cannot be
   * purged, so the caller decides how to show it — a screen-owned notice line,
   * not a second one appearing out of nowhere.
   */
  open: (scope: PurgeScope) => string | null;
  /** True while a purge is open. The owning screen must yield its keys. */
  active: boolean;
  /** The flow to render in place of the list, or null. */
  node: ReactNode;
}

export interface PurgeFlowOptions {
  zones: readonly ZoneRecord[];
  groups: readonly Group[];
  purgeRate: PurgeRate;
  getClient: () => Promise<CloudflareClient>;
  colours: Palette;
  /** Called when a run actually starts, not when the question is asked. */
  onStart?: () => void;
  onResult: (summary: PurgeSummary) => void;
}

export function usePurgeFlow(options: PurgeFlowOptions): PurgeFlowControls {
  const { zones, groups, purgeRate, getClient, colours, onStart, onResult } = options;
  const [resolved, setResolved] = useState<ResolvedScope | null>(null);

  // Built on demand so a purge always uses the credential as it stands now.
  const run = useCallback<PurgeRunFn>(
    async (targets, signal, onProgress) => {
      onStart?.();
      return purgeZones(await getClient(), targets, { signal, onProgress });
    },
    [getClient, onStart],
  );

  const open = useCallback(
    (scope: PurgeScope): string | null => {
      const next = resolveScope(scope, zones, groups, purgeRate);
      const blocked = blockedReason(next);
      if (blocked !== null) return blocked;
      setResolved(next);
      return null;
    },
    [zones, groups, purgeRate],
  );

  const node =
    resolved === null ? null : (
      <PurgeFlow
        resolved={resolved}
        run={run}
        colours={colours}
        onDone={(summary) => {
          setResolved(null);
          if (summary) onResult(summary);
        }}
      />
    );

  return { open, active: resolved !== null, node };
}
