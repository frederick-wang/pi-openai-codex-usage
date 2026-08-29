/**
 * pi-openai-codex-usage
 *
 * ChatGPT Codex subscription usage in the pi footer, with a /codex-usage
 * report. Single extension file; zero runtime dependencies; all system
 * boundaries (fetch, clock, timers, auth, fs, host UI) are injectable —
 * see tests/helpers.ts.
 *
 * Layers (in file order): constants & types → pure helpers → auth →
 * usage client → lifecycle & footer → overlay & command. Terms follow
 * CONTEXT.md; decision record lives in docs/adr/.
 */
import { createHash, createHmac } from "node:crypto";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & domain types
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_ID = "openai-codex";
export const STATUS_KEY = "pi-openai-codex-usage";
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const RESET_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;
export const SETTINGS_PAGE_URL = "https://chatgpt.com/codex/settings/usage";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;
const BACKOFF_CAP_MS = 60_000;
const RETRY_AFTER_CAP_MS = 15 * 60_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_SUSPEND_MS = 5 * 60_000;
const FINGERPRINT_SALT = "pi-openai-codex-usage\0";
const MAX_DISPLAY_CHARS = 160;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const JWT_ACCOUNT_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";
const MAX_RESET_OPTIONS = 32;
const MILLIS_PER_SECOND = 1_000;

export type UsageSource = "api" | "headers";

export interface UsageWindow {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface Credits {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
}

export interface SpendControlLimit {
	limit?: string;
	used?: string;
	remainingPercent?: number;
	resetsAt?: number;
}

export interface SpendControl {
	reached?: boolean;
	individualLimit?: SpendControlLimit;
}

export interface LimitBucket {
	limitId: string;
	limitName?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
	credits?: Credits;
}

export interface ResetCreditsSummary {
	availableCount?: number;
}

export interface Snapshot {
	schemaVersion: 1;
	capturedAt: number;
	source: UsageSource;
	planType?: string;
	rateLimitReachedType?: string;
	limitReached?: boolean;
	allowed?: boolean;
	buckets: LimitBucket[];
	credits?: Credits;
	resetCredits?: ResetCreditsSummary;
	spendControl?: SpendControl;
	fingerprint?: string;
	warnings: string[];
}

export interface ResetCreditOption {
	creditId?: string;
	title: string;
	description: string;
	expiresAt?: number;
}

export interface ResetCreditInventory {
	availableCount: number;
	options: ResetCreditOption[];
}

/** Classified error carried by the client; never thrown into the pi host. */
export class UsageError extends Error {
	readonly code: "auth" | "parse" | "timeout" | "transient" | "breaker" | "reset-restricted" | "reset-conflict";
	constructor(code: UsageError["code"], message: string) {
		super(message);
		this.name = "UsageError";
		this.code = code;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
	const parsed = asNumber(value);
	if (parsed === undefined || !Number.isSafeInteger(parsed)) return undefined;
	return Math.max(0, parsed);
}

/** Strip ANSI/control characters and cap length for display strings. */
function sanitizeDisplayText(value: string, maxChars = MAX_DISPLAY_CHARS): string | undefined {
	const cleaned = value.replace(/[\u0000-\u001f\u007f\u009b]/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

/** Key used for matching model names against bucket ids/names. */
export function normalizedUsageKey(value: string | undefined): string | undefined {
	const key = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return key || undefined;
}

/** Canonical bucket id: lowercase, dashes→underscores. */
export function normalizeLimitId(value: string): string {
	return value.trim().toLowerCase().replace(/-/g, "_");
}

/** Map server window minutes to a display label; fallback when unknown. */
export function windowLabel(minutes: number | undefined, fallback = "Primary"): string {
	if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return fallback;
	if (minutes % 1_440 === 0) {
		const days = minutes / 1_440;
		return days === 1 ? "24h" : `${Math.round(days)}d`;
	}
	if (minutes % 60 === 0) return `${Math.round(minutes / 60)}h`;
	return `${Math.round(minutes)}m`;
}

/** Unix seconds; accepts seconds or milliseconds defensively, string numerics. */
function asTimestampSeconds(value: unknown): number | undefined {
	const n = asNumber(value);
	if (n === undefined || n <= 0) return undefined;
	return n >= 10_000_000_000 ? Math.round(n / 1_000) : n;
}

function normalizeWindow(
	raw: unknown,
	capturedAt: number,
): UsageWindow | undefined {
	const obj = asObject(raw);
	if (!obj) return undefined;
	const usedPercent = asNumber(obj.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowMinutes = asNumber(obj.limit_window_seconds) !== undefined
		? Math.ceil(asNumber(obj.limit_window_seconds)! / 60)
		: asNumber(obj.window_minutes);
	const resetsAt = asTimestampSeconds(obj.reset_at) ?? relativeResetsAt(obj.reset_after_seconds, capturedAt);
	return {
		usedPercent: clampPercent(usedPercent),
		...(windowMinutes !== undefined && windowMinutes > 0 ? { windowMinutes, }: {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

function relativeResetsAt(resetAfterSeconds: unknown, capturedAt: number): number | undefined {
	const seconds = asNumber(resetAfterSeconds);
	if (seconds === undefined || seconds < 0) return undefined;
	return Math.round(capturedAt / 1_000) + seconds;
}

function normalizeCredits(raw: unknown): Credits | undefined {
	const obj = asObject(raw);
	if (!obj) return undefined;
	const hasCredits = asBoolean(obj.has_credits);
	const unlimited = asBoolean(obj.unlimited);
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	const balanceRaw = obj.balance;
	return {
		hasCredits,
		unlimited,
		...(typeof balanceRaw === "string" && balanceRaw.trim() ? { balance: balanceRaw } : {}),
	};
}

function normalizeSpendControl(raw: unknown): SpendControl | undefined {
	const obj = asObject(raw);
	if (!obj) return undefined;
	const reached = asBoolean(obj.reached);
	const individualObj = asObject(obj.individual_limit);
	const out: SpendControl = {};
	if (reached !== undefined) out.reached = reached;
	if (individualObj) {
		const limit = asString(individualObj.limit) ?? asString(individualObj.remaining);
		const used = asString(individualObj.used);
		const remainingPercent = asNumber(individualObj.remaining_percent);
		const resetsAt = asTimestampSeconds(individualObj.reset_at);
		const next: SpendControlLimit = {};
		if (limit) next.limit = limit;
		if (used) next.used = used;
		if (remainingPercent !== undefined) next.remainingPercent = remainingPercent;
		if (resetsAt !== undefined) next.resetsAt = resetsAt;
		out.individualLimit = next;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeBucket(
	limitId: string,
	limitName: string | undefined,
	rateLimit: unknown,
	credits: unknown,
	capturedAt: number,
): LimitBucket | undefined {
	if (rateLimit === undefined && credits === undefined) return undefined;
	const rl = asObject(rateLimit);
	const primary = rl ? normalizeWindow(rl.primary_window, capturedAt) : undefined;
	const secondary = rl ? normalizeWindow(rl.secondary_window, capturedAt) : undefined;
	const bucketCredits = normalizeCredits(credits);
	if (!primary && !secondary && !bucketCredits) return undefined;
	return {
		limitId,
		...(limitName ? { limitName } : {}),
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
		...(bucketCredits ? { credits: bucketCredits } : {}),
	};
}

/**
 * Normalize a `/wham/usage` payload into a Snapshot.
 * Tolerant: unknown fields dropped, optional buckets skipped with warnings,
 * a payload with no bucket synthesizes an empty `codex` bucket (official
 * client behavior). Non-object payloads throw UsageError("parse").
 */
export function normalizeWhamPayload(payload: unknown, capturedAt: number): Snapshot {
	const root = asObject(payload);
	if (!root) throw new UsageError("parse", "payload was not an object");
	const warnings: string[] = [];

	const planType = sanitizeDisplayText(asString(root.plan_type) ?? "");
	const reachedTypeObj = asObject(root.rate_limit_reached_type);
	const rateLimitReachedType = sanitizeDisplayText(asString(reachedTypeObj?.kind) ?? "");

	const buckets: LimitBucket[] = [];
	const primaryBucket = normalizeBucket(
		"codex",
		undefined,
		root.rate_limit,
		root.credits,
		capturedAt,
	);
	if (primaryBucket) buckets.push(primaryBucket);
	else {
		// Official behavior: always expose a codex bucket, even when empty.
		buckets.push({ limitId: "codex" });
	}

	const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
	const seen = new Map<string, LimitBucket>();
	for (const item of additional) {
		const it = asObject(item);
		if (!it) {
			warnings.push("skipped non-object additional_rate_limits item");
			continue;
		}
		const metered = asString(it.metered_feature);
		const name = sanitizeDisplayText(asString(it.limit_name) ?? "");
		const limitId = normalizeLimitId(metered ?? name ?? "");
		if (!limitId) {
			warnings.push("skipped additional rate limit without id");
			continue;
		}
		try {
			const bucket = normalizeBucket(limitId, name, it.rate_limit, undefined, capturedAt);
			if (!bucket) continue;
			const existing = seen.get(limitId);
			if (existing) {
				warnings.push(`duplicate bucket id "${limitId}": merged`);
				seen.set(limitId, { ...existing, ...bucket });
			} else {
				seen.set(limitId, bucket);
			}
		} catch {
			warnings.push(`skipped malformed bucket "${limitId}"`);
		}
	}
	buckets.push(...seen.values());

	const credits = normalizeCredits(root.credits);
	const resetCreditsObj = asObject(root.rate_limit_reset_credits);
	const availableCount = asNonnegativeInteger(resetCreditsObj?.available_count);
	const spendControl = normalizeSpendControl(root.spend_control);
	const rateLimitObj = asObject(root.rate_limit);

	return {
		schemaVersion: 1,
		capturedAt,
		source: "api",
		...(planType ? { planType } : {}),
		...(rateLimitReachedType ? { rateLimitReachedType } : {}),
		...(asBoolean(rateLimitObj?.limit_reached) !== undefined ? { limitReached: asBoolean(rateLimitObj?.limit_reached) } : {}),
		...(asBoolean(rateLimitObj?.allowed) !== undefined ? { allowed: asBoolean(rateLimitObj?.allowed) } : {}),
		buckets,
		...(credits ? { credits } : {}),
		...(availableCount !== undefined ? { resetCredits: { availableCount } } : {}),
		...(spendControl ? { spendControl } : {}),
		warnings,
	};
}

/** Normalize the `/wham/rate-limit-reset-credits` inventory payload. */
export function normalizeResetCreditsListPayload(payload: unknown): ResetCreditInventory {
	const root = asObject(payload);
	if (!root) throw new UsageError("parse", "reset credits payload was not an object");
	const availableCount = asNonnegativeInteger(root.available_count);
	if (availableCount === undefined) throw new UsageError("parse", "invalid available_count");
	const rawCredits = root.credits === undefined ? [] : Array.isArray(root.credits) ? root.credits : [];
	if (!Array.isArray(rawCredits)) throw new UsageError("parse", "invalid credits");

	const options: ResetCreditOption[] = rawCredits
		.map(asObject)
		.filter((c): c is Record<string, unknown> => Boolean(c))
		.filter((c) => c.status === "available" && c.reset_type === "codex_rate_limits")
		.map((c): ResetCreditOption | undefined => {
			const creditId = asString(c.id);
			if (!creditId || creditId.length > 1_024) return undefined;
			let expiresAt: number | undefined;
			if (c.expires_at !== undefined && c.expires_at !== null) {
				const raw = asString(c.expires_at);
				const parsed = raw === undefined ? NaN : Date.parse(raw);
				if (!Number.isFinite(parsed)) return undefined;
				expiresAt = Math.floor(parsed / MILLIS_PER_SECOND);
			}
			return {
				creditId,
				title: sanitizeDisplayText(asString(c.title) ?? "Full reset") ?? "Full reset",
				description: sanitizeDisplayText(asString(c.description) ?? "Reset your current usage limits.") ?? "Reset your current usage limits.",
				...(expiresAt !== undefined ? { expiresAt } : {}),
			};
		})
		.filter((o): o is ResetCreditOption => o !== undefined)
		.sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER))
		.slice(0, MAX_RESET_OPTIONS);

	if (availableCount > 0 && options.length === 0) {
		options.push({ title: "Full reset", description: "Reset your current usage limits." });
	}
	return { availableCount, options };
}

/** Pick the active bucket for a model: exact token → variant token → codex → first. */
export function selectActiveBucket(
	buckets: readonly Pick<LimitBucket, "limitId" | "limitName">[],
	model: { id?: string; name?: string } | undefined,
): Pick<LimitBucket, "limitId" | "limitName"> | undefined {
	if (buckets.length === 0) return undefined;
	const modelKeys = new Set<string>();
	for (const raw of [model?.id, model?.name]) {
		const key = normalizedUsageKey(raw);
		if (key) modelKeys.add(key);
	}
	for (const key of [...modelKeys]) {
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) modelKeys.add(key.slice(codexIndex));
	}
	const exact = buckets.find((b) => {
		const variants = [
			normalizedUsageKey(b.limitId),
			normalizedUsageKey(b.limitName),
		].filter((k): k is string => k !== undefined);
		return variants.some((k) => modelKeys.has(k));
	});
	if (exact) return exact;
	const variantTokens = new Set<string>();
	for (const key of modelKeys) {
		const match = key.match(/(?:^|-)codex-(.+)$/);
		if (match?.[1]) variantTokens.add(match[1]);
	}
	for (const token of variantTokens) {
		const matches = buckets.filter(
			(b) =>
				normalizedUsageKey(b.limitId) !== "codex" &&
				[normalizedUsageKey(b.limitId), normalizedUsageKey(b.limitName)].some((k) =>
					normalizedKeyHasToken(k, token),
				),
		);
		if (matches.length === 1) return matches[0];
	}
	const codex = buckets.find((b) => normalizedUsageKey(b.limitId) === "codex" || normalizedUsageKey(b.limitName) === "codex");
	return codex ?? buckets[0];
}

function normalizedKeyHasToken(key: string | undefined, token: string): boolean {
	if (!key) return false;
	return key === token || key.startsWith(`${token}-`) || key.endsWith(`-${token}`) || key.includes(`-${token}-`);
}

/** HMAC-SHA256 prefix of the account id; the only account-ish value ever persisted. */
export function accountFingerprint(accountId: string): string {
	return createHmac("sha256", FINGERPRINT_SALT).update(accountId).digest("hex").slice(0, 16);
}

/** Pi-shaped user agent built from node:os — mirrors what `pi` itself sends. */
export function buildPiUserAgent(): string {
	return `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})`;
}

/** Replace secrets (and bearer tokens) in an error string before it surfaces. */
export function redactError(message: string, secrets: readonly string[]): string {
	let out = message;
	for (const s of secrets) {
		if (s && s.length > 3) out = out.split(s).join("<redacted>");
	}
	out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted-Bearer>");
	return out;
}

/** Seconds or HTTP-date Retry-After; defaults 60s, capped at 15 minutes. */
export function parseRetryAfter(value: string | null, now: number): number {
	let ms = 60_000;
	if (value !== null) {
		const seconds = Number(value);
		if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * MILLIS_PER_SECOND;
		else {
			const date = Date.parse(value);
			if (!Number.isNaN(date)) ms = Math.max(0, date - now);
		}
	}
	return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** HMAC fingerprint helper exposed for the live-check script. */
export function piAgentDir(env: Record<string, string | undefined>, homedir: string): string {
	return env["PI_CODING_AGENT_DIR"] ?? nodePath.join(homedir, ".pi", "agent");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export function extractAccountIdFromJwt(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		const obj = asObject(payload);
		if (!obj) return undefined;
		const nested = asObject(obj[JWT_CLAIM_PATH]);
		const nestedId = asString(nested?.chatgpt_account_id);
		if (nestedId) return nestedId;
		const direct = asString(obj[JWT_ACCOUNT_CLAIM]);
		return direct || undefined;
	} catch {
		return undefined;
	}
}

/** Minimal pi registry surface we need (test seam). */
export interface RegistryLike {
	getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string } | undefined>;
}

/** Minimal extension context we depend on (test seam). */
export interface CtxLike {
	modelRegistry?: RegistryLike;
	model?: { id?: string; name?: string; provider?: string } | null;
	mode?: string;
	hasUI?: boolean;
	ui?: { setStatus(key: string, text: string | undefined): void; notify(message: string, level: string): void; theme: { fg(role: string, text: string): string } };
	uiContext?: unknown;
}

export interface StoredCodexCredential {
	accountId?: string;
	type?: string;
}

export type CredentialReader = (providerId: string) => StoredCodexCredential | undefined;

export type AuthResolution =
	| { status: "ok"; token: string; accountId: string; switched: boolean; source?: string }
	| { status: "no-auth" }
	| { status: "auth-error"; message: string };

/** Resolve the runtime token + account id, detecting account switches. */
export async function resolveCodexAuth(
	ctx: CtxLike,
	opts: { credentialReader?: CredentialReader },
): Promise<AuthResolution> {
	const registry = ctx.modelRegistry;
	if (!registry) return { status: "no-auth" };
	let resolved: { auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string } | undefined;
	try {
		resolved = await registry.getProviderAuth(PROVIDER_ID);
	} catch (error) {
		return { status: "auth-error", message: error instanceof Error ? error.message : String(error) };
	}
	const token = resolved?.auth?.apiKey?.trim();
	if (!token) return { status: "no-auth" };
	const accountId = extractAccountIdFromJwt(token);
	if (!accountId) return { status: "auth-error", message: "token carried no account id" };
	let switched = false;
	try {
		const stored = opts.credentialReader?.(PROVIDER_ID);
		if (stored?.accountId && stored.accountId !== accountId) switched = true;
	} catch {
		// Stored credential unreadable: keep going; switch detection is best-effort.
	}
	return { status: "ok", token, accountId, switched, ...(resolved?.source ? { source: resolved.source } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage client
// ─────────────────────────────────────────────────────────────────────────────

export type UsageResult =
	| { status: "ok"; snapshot: Snapshot }
	| { status: "retry"; retryAfterMs: number }
	| { status: "error"; code: UsageError["code"]; message: string };

export interface UsageClientLike {
	fetchSnapshot(token: string, accountId: string, signal?: AbortSignal): Promise<UsageResult>;
	resetBreaker(): void;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			if (signal?.aborted) throw new UsageError("timeout", "request aborted");
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				try { void reader.cancel(); } catch { /* */ }
				throw new UsageError("parse", "response body exceeded limit");
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		try { reader.releaseLock(); } catch { /* */ }
	}
}

export function createUsageClient(deps: {
	fetchImpl: typeof fetch;
	timeoutMs?: number;
	nowFn?: () => number;
	maxBodyBytes?: number;
	breakerThreshold?: number;
	breakerSuspendMs?: number;
	userAgent?: string;
}): UsageClientLike {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;
	const now = () => (deps.nowFn ?? Date.now)();
	const userAgent = deps.userAgent ?? buildPiUserAgent();
	const breakerThreshold = deps.breakerThreshold ?? BREAKER_THRESHOLD;
	const breakerSuspendMs = deps.breakerSuspendMs ?? BREAKER_SUSPEND_MS;
	let consecutiveHardFailures = 0;
	let breakerUntil = 0;
	let lastBackoff = 0;

	async function doFetch(token: string, accountId: string, signal: AbortSignal | undefined): Promise<UsageResult> {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combined = signal
			? AbortSignal.any([signal, timeoutSignal])
			: timeoutSignal;
		combined.addEventListener("abort", () => {
			// no-op: error handling below inspects signal state
		});
		let response: Response;
		try {
			response = await deps.fetchImpl(USAGE_URL, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
					Accept: "application/json",
					"User-Agent": userAgent,
				},
				signal: combined,
				redirect: "manual",
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const wasTimeout = timeoutSignal.aborted || (signal?.aborted ?? false);
			return {
				status: "error",
				code: wasTimeout ? "timeout" : "transient",
				message: redactError(`usage fetch failed: ${reason}`, [token]),
			};
		}
		const body = await readBoundedBody(response, maxBodyBytes, signal).catch((e: unknown) => {
			if (e instanceof UsageError) return null;
			throw e;
		});

		if (response.status === 401 || response.status === 403) {
			return { status: "error", code: "auth", message: `usage endpoint rejected the credential (${response.status})` };
		}
		if (response.status === 429) {
			const retryAfter = response.headers.get("retry-after");
			let wait = retryAfter !== null ? parseRetryAfter(retryAfter, now()) : 60_000;
			if (body !== null && retryAfter === null) {
				const resetsAt = parseBodyResetsAt(body);
				if (resetsAt !== undefined) wait = Math.max(1_000, Math.round(resetsAt - now() / MILLIS_PER_SECOND) * MILLIS_PER_SECOND);
			}
			lastBackoff = Math.min(Math.max(1_000, lastBackoff * 2), BACKOFF_CAP_MS);
			return { status: "retry", retryAfterMs: wait };
		}
		if (response.status >= 500) {
			consecutiveHardFailures += 1;
			lastBackoff = Math.min(Math.max(1_000, lastBackoff * 2), BACKOFF_CAP_MS);
			return { status: "error", code: "transient", message: `usage endpoint failed (${response.status})` };
		}
		if (!response.ok) {
			consecutiveHardFailures += 1;
			return { status: "error", code: "transient", message: `usage endpoint failed (${response.status})` };
		}
		if (body === null) {
			return { status: "error", code: "parse", message: "usage response body unreadable" };
		}
		const text = body;
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			consecutiveHardFailures += 1;
			return { status: "error", code: "parse", message: "usage endpoint returned invalid JSON" };
		}
		let snapshot: Snapshot;
		try {
			snapshot = normalizeWhamPayload(payload, now());
		} catch {
			consecutiveHardFailures += 1;
			return { status: "error", code: "parse", message: "usage endpoint returned an unexpected shape" };
		}
		consecutiveHardFailures = 0;
		lastBackoff = 0;
		return { status: "ok", snapshot };
	}

	return {
		async fetchSnapshot(token, accountId, signal) {
			if (now() < breakerUntil) {
				return { status: "error", code: "breaker", message: "suspended after repeated failures" };
			}
			const result = await doFetch(token, accountId, signal);
			if (result.status === "error" && result.code === "transient" && consecutiveHardFailures >= breakerThreshold) {
				breakerUntil = now() + breakerSuspendMs;
			}
			return result;
		},
		resetBreaker() {
			consecutiveHardFailures = 0;
			breakerUntil = 0;
			lastBackoff = 0;
		},
	};
}

function parseBodyResetsAt(body: string): number | undefined {
	try {
		const parsed = JSON.parse(body) as unknown;
		const obj = asObject(parsed);
		const err = asObject(obj?.error);
		if (!err) return undefined;
		const resetsAt = asTimestampSeconds(err.resets_at);
		return resetsAt;
	} catch {
		return undefined;
	}
}

export default function openaiCodexUsage(_pi: unknown): void {
	// Lifecycle lands in T03.
}
