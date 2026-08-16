import { readUiValue, writeUiValue } from "@/lib/ui-store";

const STORAGE_KEY = "hermes:gateway-session-map";
const ACTIVE_PERSISTENT_STORAGE_KEY = "hermes:active-persistent-session";
const ACTIVE_TURN_STORAGE_KEY = "hermes:active-turn";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The active-turn checkpoint only needs to cover the window in which a remote
// turn can still be in flight while the Android WebView is backgrounded. Six
// hours is generous for a single turn yet short enough to avoid stale catch-up
// notifications from a session that ended long ago but whose runtime was lost.
const ACTIVE_TURN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

interface SessionEntry {
  persistentId: string;
  ts: number;
}

type SessionMap = Record<string, SessionEntry>;

function cleanSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readMap(): SessionMap {
  const parsed = readUiValue<unknown>(STORAGE_KEY, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  if (typeof Object.values(parsed)[0] === "string") {
    const migrated: SessionMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        migrated[key] = { persistentId: value, ts: Date.now() };
      }
    }
    writeMap(migrated);
    return migrated;
  }

  const clean: SessionMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.persistentId !== "string" || !entry.persistentId) continue;
    if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts)) continue;
    clean[key] = { persistentId: entry.persistentId, ts: entry.ts };
  }
  return clean;
}

function writeMap(map: SessionMap) {
  writeUiValue(STORAGE_KEY, map);
}

function pruneExpired(map: SessionMap): SessionMap {
  const now = Date.now();
  const entries = Object.entries(map).filter(
    ([, entry]) => now - entry.ts < MAX_AGE_MS,
  );

  if (entries.length <= MAX_ENTRIES) {
    return Object.fromEntries(entries);
  }

  entries.sort((a, b) => b[1].ts - a[1].ts);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

export function rememberSessionMapping(gatewaySessionId: string, persistentSessionId: string) {
  if (!gatewaySessionId || !persistentSessionId) return;
  if (gatewaySessionId === persistentSessionId) return;
  const map = pruneExpired(readMap());
  map[gatewaySessionId] = { persistentId: persistentSessionId, ts: Date.now() };
  writeMap(map);
}

/** Record the persistent id announced by a gateway `session.info` event. */
export function rememberGatewaySessionInfo(
  gatewaySessionId: string | undefined,
  payload: unknown,
): void {
  const gatewayId = cleanSessionId(gatewaySessionId);
  if (!gatewayId || !payload || typeof payload !== "object" || Array.isArray(payload)) return;

  const storedSessionId = (payload as Record<string, unknown>).stored_session_id;
  if (typeof storedSessionId !== "string") return;
  const persistentId = cleanSessionId(storedSessionId);
  if (!persistentId) return;

  rememberSessionMapping(gatewayId, persistentId);
}

export function rememberActivePersistentSessionId(persistentSessionId: string | undefined) {
  const cleaned = cleanSessionId(persistentSessionId);
  if (!cleaned) return;
  writeUiValue(ACTIVE_PERSISTENT_STORAGE_KEY, {
    persistentId: cleaned,
    ts: Date.now(),
  });
}

export function getActivePersistentSessionId(): string | undefined {
  const entry = readUiValue<unknown>(ACTIVE_PERSISTENT_STORAGE_KEY, null);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.persistentId !== "string" || !record.persistentId.trim()) return undefined;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return undefined;
  if (Date.now() - record.ts > MAX_AGE_MS) return undefined;
  return record.persistentId.trim();
}

export function clearActivePersistentSessionId(persistentSessionId?: string) {
  const current = getActivePersistentSessionId();
  if (!current) return;
  const cleaned = cleanSessionId(persistentSessionId);
  if (cleaned && cleaned !== current) return;
  writeUiValue(ACTIVE_PERSISTENT_STORAGE_KEY, null);
}

export function forgetSessionMapping(gatewaySessionId: string | undefined) {
  if (!gatewaySessionId) return;
  const map = pruneExpired(readMap());
  if (!Object.hasOwn(map, gatewaySessionId)) return;
  delete map[gatewaySessionId];
  writeMap(map);
}

/** Enumerate all live gateway→persistent mappings (reconnect pruning). */
export function listSessionMappings(): Array<{ gatewaySessionId: string; persistentSessionId: string }> {
  const now = Date.now();
  return Object.entries(pruneExpired(readMap()))
    .filter(([, entry]) => now - entry.ts < MAX_AGE_MS)
    .map(([gatewaySessionId, entry]) => ({
      gatewaySessionId,
      persistentSessionId: entry.persistentId,
    }));
}

/**
 * Prune EVERY ephemeral gateway mapping. A reconnect mints a fresh gateway id
 * and the old socket's gateway sessions are no longer pinnable; leaving stale
 * ids in the map makes resolveGatewaySessionId hand callers a dead id and a
 * later prompt.submit fails with `session not found`. Callers should record
 * route redirects from listSessionMappings() BEFORE clearing so the detail
 * route can project onto the persistent id.
 */
export function forgetAllSessionMappings(): void {
  writeMap({});
}

/** Remove every ephemeral gateway id that points at one persistent task. */
export function forgetSessionMappingsForPersistentSession(persistentSessionId: string | undefined) {
  if (!persistentSessionId) return;
  const map = pruneExpired(readMap());
  let changed = false;
  for (const [gatewaySessionId, entry] of Object.entries(map)) {
    if (entry.persistentId !== persistentSessionId) continue;
    delete map[gatewaySessionId];
    changed = true;
  }
  if (changed) writeMap(map);
}

export function resolvePersistentSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const entry = readMap()[sessionId];
  if (!entry) return sessionId;
  if (Date.now() - entry.ts > MAX_AGE_MS) return sessionId;
  return entry.persistentId;
}

/**
 * Persistent session ids minted by the backend look like
 * `20260815_074418_096214` (date_time_stamp). Ephemeral gateway session ids
 * are short hex blobs (e.g. `f915c356`) that the REST layer must NEVER see —
 * /api/sessions/{id} answers 404 for them once the reconnect pruned the
 * gateway→persistent map, which is exactly the `session not found` the detail
 * page surfaces after a background reconnect. This predicate lets callers
 * distinguish "this id is already the persistent form" from "this id needs
 * resolution and resolution just failed".
 */
export function isPersistentSessionShape(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  // Backend persistent ids: 8-digit date, underscore, 6-digit time, underscore,
  // then a non-empty alphanumeric suffix (may contain hyphens from branches).
  return /^\d{8}_\d{6}_[A-Za-z0-9\-]+$/.test(sessionId);
}

export function resolveGatewaySessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const map = readMap();
  const now = Date.now();
  // Several gateway ids can point at one persistent id (a map persisted across
  // an app relaunch, a reconnect / re-resume minting a fresh id). Object
  // iteration order is insertion order, so returning the first match hands back
  // the *oldest* (dead) id — detail then renders an empty runtime bucket while
  // the live one keeps streaming. Pick the newest live mapping instead.
  let bestId: string | undefined;
  let bestTs = -Infinity;
  for (const [gatewayId, entry] of Object.entries(map)) {
    if (entry.persistentId === sessionId && now - entry.ts < MAX_AGE_MS && entry.ts > bestTs) {
      bestId = gatewayId;
      bestTs = entry.ts;
    }
  }
  return bestId;
}

interface ResolveSessionIdAliasOptions {
  includeExpired?: boolean;
}

export function resolveSessionIdAliases(
  sessionId: string | undefined,
  options: ResolveSessionIdAliasOptions = {},
): string[] {
  if (!sessionId) return [];
  const normalized = sessionId.trim();
  if (!normalized) return [];

  const aliases = new Set<string>([normalized]);
  const map = readMap();
  const now = Date.now();
  const isFresh = (entry: SessionEntry) => now - entry.ts <= MAX_AGE_MS;
  const isUsable = (entry: SessionEntry) => options.includeExpired || isFresh(entry);

  const direct = map[normalized];
  if (direct && isUsable(direct)) {
    aliases.add(direct.persistentId);
  }

  for (const [gatewayId, entry] of Object.entries(map)) {
    if (!isUsable(entry)) continue;
    if (gatewayId === normalized || entry.persistentId === normalized) {
      aliases.add(gatewayId);
      aliases.add(entry.persistentId);
    }
  }

  return Array.from(aliases);
}

// ── Active-turn checkpoint ─────────────────────────────────────────────
//
// The chat runtime (activeAssistantId/turnStartedAt) lives in jotai memory.
// Android can destroy and rebuild the WebView while the app is backgrounded,
// wiping that memory even though the persistent session and its REST history
// survive. The reconnect catch-up path therefore keeps a small persisted
// checkpoint of the *latest in-flight turn* so a rebuilt client can still run
// the REST snapshot gate instead of skipping with no_active_assistant.
// It is deliberately keyed by persistent session id only (gateway ids rotate
// across reconnects) and expires quickly to avoid stale catch-up alerts.

export interface ActiveTurnCheckpoint {
  persistentSessionId: string;
  turnStartedAt: number;
  activeAssistantId?: string;
}

interface ActiveTurnEntry extends ActiveTurnCheckpoint {
  ts: number;
}

function readActiveTurn(): ActiveTurnEntry | undefined {
  const entry = readUiValue<unknown>(ACTIVE_TURN_STORAGE_KEY, undefined);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.persistentSessionId !== "string" || !record.persistentSessionId.trim()) return undefined;
  if (typeof record.turnStartedAt !== "number" || !Number.isFinite(record.turnStartedAt)) return undefined;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return undefined;
  if (Date.now() - record.ts > ACTIVE_TURN_MAX_AGE_MS) return undefined;
  const activeAssistantId =
    typeof record.activeAssistantId === "string" && record.activeAssistantId.trim()
      ? record.activeAssistantId.trim()
      : undefined;
  return {
    persistentSessionId: record.persistentSessionId.trim(),
    turnStartedAt: record.turnStartedAt,
    activeAssistantId,
    ts: record.ts,
  };
}

/** Record the latest in-flight turn for a persistent session (WebView-rebuild-safe). */
export function rememberActiveTurn(params: {
  persistentSessionId: string | undefined;
  turnStartedAt: number;
  activeAssistantId?: string;
}): void {
  const persistentId = cleanSessionId(params?.persistentSessionId);
  if (!persistentId) return;
  if (typeof params?.turnStartedAt !== "number" || !Number.isFinite(params.turnStartedAt)) return;
  const entry: ActiveTurnEntry = {
    persistentSessionId: persistentId,
    turnStartedAt: params.turnStartedAt,
    activeAssistantId: cleanSessionId(params.activeAssistantId),
    ts: Date.now(),
  };
  writeUiValue(ACTIVE_TURN_STORAGE_KEY, entry);
}

/** Read the fresh active-turn checkpoint for a persistent session, if any. */
export function getActiveTurn(persistentSessionId: string | undefined): ActiveTurnCheckpoint | undefined {
  const persistentId = cleanSessionId(persistentSessionId);
  const entry = readActiveTurn();
  if (!entry) return undefined;
  if (persistentId && entry.persistentSessionId !== persistentId) return undefined;
  const { ts: _ts, ...checkpoint } = entry;
  return checkpoint;
}

/**
 * Clear the active-turn checkpoint. With a matching persistent session id only
 * that session's checkpoint is removed; without one, every checkpoint is
 * cleared (client-wide resets such as terminate-all-streams).
 */
export function clearActiveTurn(persistentSessionId?: string): void {
  const persistentId = cleanSessionId(persistentSessionId);
  if (persistentId) {
    const entry = readActiveTurn();
    if (!entry || entry.persistentSessionId !== persistentId) return;
    writeUiValue(ACTIVE_TURN_STORAGE_KEY, null);
    return;
  }
  writeUiValue(ACTIVE_TURN_STORAGE_KEY, null);
}
