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
import * as nodeFs from "node:fs";
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
		if (Object.keys(next).length > 0) out.individualLimit = next;
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

export type UsageClient = UsageClientLike & ResetCreditClientLike;

export function createUsageClient(deps: {
	fetchImpl: typeof fetch;
	timeoutMs?: number;
	nowFn?: () => number;
	maxBodyBytes?: number;
	breakerThreshold?: number;
	breakerSuspendMs?: number;
	userAgent?: string;
}): UsageClient {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;
	const now = () => (deps.nowFn ?? Date.now)();
	const userAgent = deps.userAgent ?? buildPiUserAgent();
	const breakerThreshold = deps.breakerThreshold ?? BREAKER_THRESHOLD;
	const breakerSuspendMs = deps.breakerSuspendMs ?? BREAKER_SUSPEND_MS;
	let consecutiveHardFailures = 0;
	let breakerUntil = 0;

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
			return { status: "retry", retryAfterMs: wait };
		}
		if (response.status >= 500) {
			consecutiveHardFailures += 1;
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
		async listResetCredits(token, accountId, signal) {
			if (now() < breakerUntil) {
				return { status: "error", code: "breaker", message: "suspended after repeated failures" };
			}
			const { status, text } = await resetRequest(deps.fetchImpl, RESET_CREDITS_URL, undefined, token, accountId, userAgent, timeoutMs, maxBodyBytes, signal);
			if (status === 401 || status === 403) return { status: "error", code: "auth", message: "reset endpoint rejected the credential" };
			if (status === 429) {
				return { status: "retry", retryAfterMs: 60_000 };
			}
			if (!text || status >= 500) return { status: "error", code: "transient", message: `reset endpoint failed (${status})` };
			try {
				return { status: "ok", inventory: normalizeResetCreditsListPayload(JSON.parse(text)) };
			} catch {
				return { status: "error", code: "parse", message: "reset endpoint returned an unexpected shape" };
			}
		},
		async consumeResetCredit(token, accountId, body, signal) {
			if (now() < breakerUntil) {
				return { status: "error", code: "breaker", message: "suspended after repeated failures" };
			}
			const { status, text } = await resetRequest(deps.fetchImpl, RESET_CONSUME_URL, JSON.stringify(body), token, accountId, userAgent, timeoutMs, maxBodyBytes, signal);
			if (status === 401 || status === 403) return { status: "error", code: "auth", message: "reset endpoint rejected the credential" };
			if (status === 429) return { status: "retry", retryAfterMs: 60_000 };
			if (!text || status >= 500) return { status: "error", code: "transient", message: `reset endpoint failed (${status})` };
			try {
				const parsed = JSON.parse(text) as unknown;
				const obj = asObject(parsed);
				const code = asString(obj?.code);
				if (code !== "reset" && code !== "nothing_to_reset" && code !== "no_credit" && code !== "already_redeemed") {
					return { status: "error", code: "parse", message: "reset endpoint returned an unknown outcome" };
				}
				const windowsReset = asNonnegativeInteger(obj?.windows_reset) ?? 0;
				return { status: "ok", code, windowsReset };
			} catch {
				return { status: "error", code: "parse", message: "reset endpoint returned invalid JSON" };
			}
		},
		resetBreaker() {
			consecutiveHardFailures = 0;
			breakerUntil = 0;
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

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────

export type Lang = "en" | "zh";

export function resolveLang(env: Record<string, string | undefined>): Lang {
	const explicit = env["PI_OPENAI_CODEX_USAGE_LANG"];
	if (explicit === "zh" || explicit === "en") return explicit;
	const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
	return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

type MsgVars = Record<string, string | number>;

const MESSAGES: Record<Lang, Record<string, (v: MsgVars) => string>> = {
	en: {
		reportTitle: () => "OpenAI Codex Usage",
		visitPage: () => `Visit ${SETTINGS_PAGE_URL} for up-to-date information`,
		pressClose: () => "Press Enter, Esc, or Ctrl+C to close · ↑↓ scroll",
		pressCloseShort: () => "Esc to close",
		scrollStatus: (v) => `${v.pos}/${v.total} lines · ↑↓ scroll · Enter closes`,
		plan: (v) => `plan: ${v.plan}`,
		updatedAgo: (v) => `updated ${v.age}`,
		source: (v) => `source: ${v.source}`,
		left: () => "left",
		limitWindow: () => "limit",
		credits: () => "Credits",
		creditsUnlimited: () => "unlimited",
		creditsAvailable: () => "available",
		creditsNone: () => "none",
		resetCredits: () => "Usage limit resets",
		resetCountOne: (v) => `${v.n} available`,
		resetCountMany: (v) => `${v.n} available`,
		resetCountNone: () => "none available",
		resetCountMissing: () => "—",
		resetOptionHint: () => "Use /codex-usage consume to redeem one.",
		resetOption: (v) => `${v.title} — ${v.desc}`,
		resetOptionExpires: (v) => `expires ${v.at}`,
		fullReset: () => "Full reset",
		fullResetDesc: () => "Reset your current usage limits.",
		spendControl: () => "Spend control",
		spendReached: () => "reached",
		spendLimitLimit: (v) => `limit ${v.limit}`,
		spendLimitUsed: (v) => `used ${v.used}`,
		spendLimitRemaining: (v) => `${v.pct}% remaining`,
		warnings: () => "Warnings",
		windowPrimary: () => "Primary",
		windowSecondary: () => "Secondary",
		resetsIn: (v) => `↻${v.t}`,
		nA: () => "n/a",
		error: () => "error",
		rateLimited: () => "rate limited",
		authError: () => "auth error",
		authNeeded: () => "pi-openai-codex-usage: no OpenAI Codex credential. Run /login and select OpenAI Codex.",
		authFailed: () => "pi-openai-codex-usage: usage fetch failed (credential rejected).",
		fetchFailed: () => "pi-openai-codex-usage: usage fetch failed.",
		rateLimitedNotify: () => "pi-openai-codex-usage: the usage endpoint is rate-limiting; retry shortly.",
		retryLater: () => "pi-openai-codex-usage: usage endpoint suspended after repeated failures; retrying later.",
		jsonModeRestricted: () => "pi-openai-codex-usage: --json requires TUI or print mode.",
		consumeModeRestricted: () => "pi-openai-codex-usage: consume requires the interactive TUI.",
		unknownArgs: (v) => `Unknown option: ${v.arg}. Usage: /codex-usage [--json|--refresh|consume]`,
		consumeTitle: () => "Consume a usage reset",
		consumeEmpty: () => "No usage limit resets available.",
		consumeConfirm: (v) => `Consume “${v.title}”${v.expiry ? ` (expires ${v.expiry})` : ""}? This cannot be undone.`,
		consumeCancelled: () => "Reset cancelled.",
		consumeReset: (v) => `Usage reset. ${v.windows} window(s) reset.`,
		consumeNothing: () => "Your usage does not need a reset right now.",
		consumeNoCredit: () => "No usage limit resets are available.",
		consumeAlready: () => "Usage reset was already completed.",
		consumeUnknown: () => "Reset outcome unknown; check the usage page.",
		consumeRestricted: () => "pi-openai-codex-usage: reset not allowed — the runtime account does not match the stored credential.",
		consumeUnavailable: () => "pi-openai-codex-usage: reset detail is unavailable for this account.",
		alertAuthInvalid: () => "pi-openai-codex-usage: OpenAI Codex credential rejected; usage updates paused.",
		alertReachedUnknown: (v) => `Codex usage limit reached (${v.kind}).`,
		alertReachedLimit: () => "Codex usage limit reached.",
		alertReachedOwnerCredits: () => "Workspace owner credits depleted; usage blocked.",
		alertReachedMemberCredits: () => "Workspace member credits depleted; usage blocked.",
		alertReachedOwnerUsage: () => "Workspace owner usage limit reached.",
		alertReachedMemberUsage: () => "Workspace member usage limit reached.",
		reportSummary: (v) => `Codex usage: ${v.pct}% left`,
		ageJustNow: () => "just now",
		ageSec: (v) => `${v.n}s ago`,
		ageMin: (v) => `${v.n}m ago`,
		ageHour: (v) => `${v.n}h ago`,
	},
	zh: {
		reportTitle: () => "OpenAI Codex 用量",
		visitPage: () => `更多信息见 ${SETTINGS_PAGE_URL}`,
		pressClose: () => "按 Enter、Esc 或 Ctrl+C 关闭 · ↑↓ 滚动",
		pressCloseShort: () => "Esc 关闭",
		scrollStatus: (v) => `第 ${v.pos}/${v.total} 行 · ↑↓ 滚动 · Enter 关闭`,
		plan: (v) => `套餐：${v.plan}`,
		updatedAgo: (v) => `更新于 ${v.age}`,
		source: (v) => `来源：${v.source}`,
		left: () => "剩余",
		limitWindow: () => "限额",
		credits: () => "额度",
		creditsUnlimited: () => "不限量",
		creditsAvailable: () => "可用",
		creditsNone: () => "无",
		resetCredits: () => "用量重置次数",
		resetCountOne: (v) => `${v.n} 次可用`,
		resetCountMany: (v) => `${v.n} 次可用`,
		resetCountNone: () => "暂无可用",
		resetCountMissing: () => "—",
		resetOptionHint: () => `需要的话，运行 /codex-usage consume 用掉一次。`,
		resetOption: (v) => `${v.title} — ${v.desc}`,
		resetOptionExpires: (v) => `过期时间 ${v.at}`,
		fullReset: () => "完整重置",
		fullResetDesc: () => "重置当前用量限制。",
		spendControl: () => "支出上限",
		spendReached: () => "已到上限",
		spendLimitLimit: (v) => `上限 ${v.limit}`,
		spendLimitUsed: (v) => `已用 ${v.used}`,
		spendLimitRemaining: (v) => `剩余 ${v.pct}%`,
		warnings: () => "提示",
		windowPrimary: () => "主时段",
		windowSecondary: () => "副时段",
		resetsIn: (v) => `↻${v.t}`,
		nA: () => "n/a",
		error: () => "错误",
		rateLimited: () => "限流中",
		authError: () => "认证错误",
		authNeeded: () => "pi-openai-codex-usage：没有找到 OpenAI Codex 登录信息，请运行 /login 选择 OpenAI Codex。",
		authFailed: () => "pi-openai-codex-usage：用量获取失败（凭据被拒绝）。",
		fetchFailed: () => "pi-openai-codex-usage：用量获取失败。",
		rateLimitedNotify: () => "pi-openai-codex-usage：用量接口限流了，稍后再试。",
		retryLater: () => "pi-openai-codex-usage：用量接口连续失败已暂停，稍后会自动重试。",
		jsonModeRestricted: () => "pi-openai-codex-usage：--json 只支持 TUI 或 print 模式。",
		consumeModeRestricted: () => "pi-openai-codex-usage：consume 只能在交互式 TUI 里用。",
		unknownArgs: (v) => `未知选项：${v.arg}。用法：/codex-usage [--json|--refresh|consume]`,
		consumeTitle: () => "使用一次用量重置",
		consumeEmpty: () => "现在没有可用的用量重置。",
		consumeConfirm: (v) => `确认用掉“${v.title}”${v.expiry ? `（${v.expiry} 过期）` : ""}？用掉就没了。`,
		consumeCancelled: () => "已取消。",
		consumeReset: (v) => `重置成功，${v.windows} 个时段已重置。`,
		consumeNothing: () => "现在的用量不需要重置。",
		consumeNoCredit: () => "没有可用的用量重置。",
		consumeAlready: () => "这次重置之前已经用掉了。",
		consumeUnknown: () => "重置结果未知，去用量页面看看吧。",
		consumeRestricted: () => "pi-openai-codex-usage：不允许重置——当前账户与 pi 保存的账户不是同一个。",
		consumeUnavailable: () => "pi-openai-codex-usage：当前账户拿不到重置详情。",
		alertAuthInvalid: () => "pi-openai-codex-usage：OpenAI Codex 凭据被拒绝，用量更新已暂停。",
		alertReachedUnknown: (v) => `Codex 用量已达上限（${v.kind}）。`,
		alertReachedLimit: () => "Codex 用量已达上限。",
		alertReachedOwnerCredits: () => "工作区管理员的额度已用完，用量被限制。",
		alertReachedMemberCredits: () => "团队成员的额度已用完，用量被限制。",
		alertReachedOwnerUsage: () => "已用满工作区管理员的用量上限。",
		alertReachedMemberUsage: () => "已用满团队成员的用量上限。",
		reportSummary: (v) => `Codex 用量：剩余 ${v.pct}%`,
		ageJustNow: () => "刚刚",
		ageSec: (v) => `${v.n} 秒前`,
		ageMin: (v) => `${v.n} 分钟前`,
		ageHour: (v) => `${v.n} 小时前`,
	},
};

export type MsgKey = keyof typeof MESSAGES.en;

/** Test hook: en/zh catalog key parity (silent en fallback must never hide drift). */
export function catalogKeyDiff(): { zhMissing: string[]; enMissing: string[]; orphanKeys: string[] } {
	const enKeys = Object.keys(MESSAGES.en);
	const zhKeys = Object.keys(MESSAGES.zh);
	return {
		zhMissing: enKeys.filter((k) => !(k in MESSAGES.zh)),
		enMissing: zhKeys.filter((k) => !(k in MESSAGES.en)),
		orphanKeys: Object.keys(MESSAGES.zh).filter((k) => !enKeys.includes(k)),
	};
}

export function msg(lang: Lang, key: MsgKey, vars: MsgVars = {}): string {
	const fn = MESSAGES[lang][key] ?? MESSAGES.en[key];
	return fn ? fn(vars) : key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal text helpers (ported from the pi-xai-usage overlay contract)
// ─────────────────────────────────────────────────────────────────────────────

export function visualWidth(s: string): number {
	let w = 0;
	for (let i = 0; i < s.length; ) {
		const cp = s.codePointAt(i) ?? 0;
		if (cp === 0x1b) {
			i = skipEscape(s, i);
			continue;
		}
		w += isWideChar(cp) ? 2 : 1;
		i += cp > 0xffff ? 2 : 1;
	}
	return w;
}

function skipEscape(s: string, i: number): number {
	if (s[i + 1] === "]") {
		let j = i + 2;
		while (j < s.length) {
			const b = s.charCodeAt(j);
			if (b === 0x07) {
				j += 1;
				break;
			}
			if (b === 0x1b && s[j + 1] === "\\") {
				j += 2;
				break;
			}
			j += 1;
		}
		return j;
	}
	let j = i + 1;
	while (j < s.length) {
		const b = s.charCodeAt(j);
		if (b >= 0x40 && b <= 0x7e && b !== 0x5b && b !== 0x5d) {
			j += 1;
			break;
		}
		j += 1;
	}
	return j;
}

function isWideChar(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

export function wrapLines(lines: string[], width: number): string[] {
	if (width <= 0) return [...lines];
	const out: string[] = [];
	for (const line of lines) {
		if (visualWidth(line) <= width) {
			out.push(line);
			continue;
		}
		const tokens = ansiTokens(line);
		const wrapped: string[] = [];
		let cur = "";
		let curW = 0;
		for (const tok of tokens) {
			if (tok.ansi) {
				cur += tok.s;
				continue;
			}
			const cw = isWideChar(tok.cp) ? 2 : 1;
			if (curW + cw > width && visibleCharCount(cur) > 0) {
				wrapped.push(cur);
				cur = cw <= width ? tok.s : "";
				curW = cw <= width ? cw : 0;
			} else if (cw > width) {
				cur = "";
				curW = 0;
			} else {
				cur += tok.s;
				curW += cw;
			}
		}
		if (cur.length > 0) wrapped.push(cur);
		const { ansiPrefix } = splitAnsi(line);
		const styleOnly = ansiPrefix.replace(/\s/g, "");
		for (let k = 0; k < wrapped.length; k++) {
			out.push(k === 0 ? wrapped[k] : `${styleOnly}${wrapped[k]}`);
		}
	}
	return out;
}

function visibleCharCount(s: string): number {
	let n = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			i = skipEscape(s, i);
		} else {
			const cp = s.codePointAt(i) ?? 0;
			n += 1;
			i += cp > 0xffff ? 2 : 1;
		}
	}
	return n;
}

function padToWidth(line: string, width: number): string {
	const cur = visualWidth(line);
	return cur >= width ? line : `${line}${String.fromCharCode(32).repeat(width - cur)}`;
}

function clampChrome(line: string, width: number): string {
	if (visualWidth(line) <= width) return line;
	const tokens = ansiTokens(line);
	let out = "";
	let w = 0;
	let sawVisible = false;
	for (const tok of tokens) {
		if (tok.ansi) {
			out += tok.s;
			continue;
		}
		const cw = isWideChar(tok.cp) ? 2 : 1;
		if (!sawVisible && tok.s.trim() === "") {
			if (w + cw > width) break;
			out += tok.s;
			w += cw;
			continue;
		}
		if (w + cw > width && w > 0) break;
		out += tok.s;
		w += cw;
		sawVisible = true;
	}
	return out;
}

interface AnsiToken {
	ansi: boolean;
	s: string;
	cp: number;
}

function ansiTokens(line: string): AnsiToken[] {
	const tokens: AnsiToken[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const j = skipEscape(line, i);
			tokens.push({ ansi: true, s: line.slice(i, j), cp: 0 });
			i = j;
		} else {
			const cp = line.codePointAt(i) ?? 0;
			const ch = String.fromCodePoint(cp);
			tokens.push({ ansi: false, s: ch, cp });
			i += cp > 0xffff ? 2 : 1;
		}
	}
	return tokens;
}

function splitAnsi(line: string): { text: string; ansiPrefix: string; ansiSuffix: string } {
	const tokens = ansiTokens(line);
	let prefix = "";
	let start = 0;
	while (start < tokens.length && (tokens[start].ansi || tokens[start].s.trim() === "")) {
		prefix += tokens[start].s;
		start += 1;
	}
	let suffix = "";
	let end = tokens.length;
	while (end > start && tokens[end - 1].ansi) {
		suffix = tokens[end - 1].s + suffix;
		end -= 1;
	}
	return { text: tokens.slice(start, end).map((t) => t.s).join(""), ansiPrefix: prefix, ansiSuffix: suffix };
}

export function clampScrollTop(scrollTop: number, bodyLength: number, avail: number): number {
	const max = Math.max(0, bodyLength - avail);
	return Math.min(Math.max(0, scrollTop), max);
}

export interface WindowResult {
	top: number;
	lines: string[];
	atEnd: boolean;
}

export function windowSlice(body: string[], scrollTop: number, avail: number): WindowResult {
	const top = clampScrollTop(scrollTop, body.length, avail);
	return {
		top,
		lines: body.slice(top, top + avail),
		atEnd: top >= Math.max(0, body.length - avail),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay component (bordered, scrollable, render(width) contract)
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyLike {
	matches(data: string, id: string): boolean;
}

export interface OverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface OverlayComponentOpts {
	header: string;
	body: string[];
	footer: string;
	theme: FooterTheme;
	kb: KeyLike;
	done: (value: unknown) => void;
	rowGen: () => number;
	lang: Lang;
}

export function createOverlayComponent(opts: OverlayComponentOpts): OverlayComponent {
	const { header, body, footer, theme, kb, done, rowGen, lang } = opts;
	let scrollTop = 0;
	let closed = false;
	let lastWidth = 80;
	const body0 = body[0] === "" ? body.slice(1) : body;

	const close = () => {
		if (closed) return;
		closed = true;
		done(undefined);
	};

	function maxRowsAt(): number {
		return Math.max(1, Math.floor(rowGen() * 0.8));
	}

	function layout(width: number): { avail: number; canStatus: boolean; boxed: boolean } {
		const maxRows = maxRowsAt();
		const boxed = maxRows >= 6 && width >= 8;
		const chrome = boxed ? 5 : 3;
		const avail = Math.max(0, maxRows - chrome);
		const canStatus = boxed && maxRows >= chrome + 3;
		return { avail, canStatus, boxed };
	}

	function scrollWindowAt(w: number): { bodyLines: string[]; avail: number; needsStatus: boolean } {
		const innerW = Math.max(1, w - 2);
		const bodyLines = wrapLines(body0, innerW);
		const { avail, canStatus } = layout(w);
		const needsStatus = canStatus && bodyLines.length > avail;
		const bodyAvail = needsStatus ? Math.max(0, avail - 2) : avail;
		return { bodyLines, avail: bodyAvail, needsStatus };
	}

	function renderLines(width: number): string[] {
		const w = Math.max(1, width);
		const innerW = Math.max(1, w - 2);
		const { bodyLines, avail: bodyAvail, needsStatus } = scrollWindowAt(w);
		const { boxed } = layout(w);
		const win = windowSlice(bodyLines, scrollTop, bodyAvail);
		scrollTop = win.top;
		const statusRow = needsStatus
			? clampChrome(`  ${theme.fg("muted", msg(lang, "scrollStatus", { pos: win.atEnd ? bodyLines.length : win.top + win.lines.length, total: bodyLines.length }))}`, innerW)
			: null;
		const footerText = innerW < 20 ? msg(lang, "pressCloseShort") : footer;
		const footerRow = clampChrome(`  ${theme.fg("dim", footerText)}`, innerW);
		const titleRow = clampChrome(`  ${theme.fg("accent", header)}`, innerW);
		const blocks: string[] = [""];
		blocks.push(...win.lines);
		if (statusRow) {
			blocks.push("");
			blocks.push(statusRow);
		}
		blocks.push("");
		blocks.push(footerRow);
		if (!boxed) {
			const out: string[] = [titleRow];
			if (win.lines.length > 0) out.push("", ...win.lines);
			if (statusRow) out.push("", statusRow);
			out.push(footerRow);
			return out;
		}
		const titleStr = clampChrome(` ${theme.fg("accent", header)} `, innerW);
		const titleW = visualWidth(titleStr);
		const pad = Math.max(0, innerW - titleW);
		const topPad = Math.floor(pad / 2);
		const topPad2 = pad - topPad;
		const top = theme.fg("border", "╭") + theme.fg("border", "─".repeat(topPad)) + titleStr + theme.fg("border", "─".repeat(topPad2)) + theme.fg("border", "╮");
		const bottom = theme.fg("border", `╰${"─".repeat(Math.max(0, innerW))}╯`);
		const out: string[] = [top];
		for (const line of blocks) {
			const inner = line === "" ? " ".repeat(innerW) : padToWidth(line, innerW);
			out.push(`${theme.fg("border", "│")}${inner}${theme.fg("border", "│")}`);
		}
		out.push(bottom);
		return out;
	}

	return {
		render(width: number) {
			lastWidth = Math.max(1, width);
			return renderLines(lastWidth);
		},
		invalidate() {
			// render() recomputes everything; kept as the pi contract entry.
		},
		handleInput(data: string) {
			if (closed) return;
			if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
				close();
				return;
			}
			const w = Math.max(1, lastWidth);
			const { bodyLines, avail: bodyAvail } = scrollWindowAt(w);
			const max = Math.max(0, bodyLines.length - bodyAvail);
			if (kb.matches(data, "tui.select.up")) {
				scrollTop = clampScrollTop(scrollTop - 1, bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.down")) {
				scrollTop = clampScrollTop(scrollTop + 1, bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.altScreen.pageUp")) {
				scrollTop = clampScrollTop(scrollTop - Math.max(1, bodyAvail - 1), bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.altScreen.pageDown")) {
				scrollTop = clampScrollTop(scrollTop + Math.max(1, bodyAvail - 1), bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.altScreen.top")) {
				scrollTop = 0;
			} else if (kb.matches(data, "tui.altScreen.bottom")) {
				scrollTop = max;
			} else if (data.toLowerCase() === "r") {
				// Refresh handled by the owning component via a callback; base
				// overlay keeps scrolling and closing only (see factory).
			}
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface FooterTheme {
	fg(role: string, text: string): string;
}

export const identityTheme: FooterTheme = { fg: (_role, text) => text };

function colorRoleForRemaining(remaining: number): string {
	if (remaining >= 50) return "success";
	if (remaining >= 20) return "warning";
	return "error";
}

export function renderBar(remainingPercent: number, theme: FooterTheme): string {
	const width = 8;
	const filled = Math.round((clampPercent(remainingPercent) / 100) * width);
	return theme.fg(colorRoleForRemaining(remainingPercent), "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

export function formatReset(resetsAt: number | undefined, now: number, lang: Lang = "en"): string {
	if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
	const ms = resetsAt * 1_000;
	const diff = ms - now;
	if (diff <= 0) return "";
	if (diff < 24 * 3_600_000) {
		const h = Math.floor(diff / 3_600_000);
		const m = Math.floor((diff % 3_600_000) / 60_000);
		return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
	}
	const at = new Date(ms);
	if (diff < 7 * 24 * 3_600_000) {
		const hh = String(at.getHours()).padStart(2, "0");
		const mm = String(at.getMinutes()).padStart(2, "0");
		const day = lang === "zh" ? WEEKDAYS_ZH[at.getDay()] : WEEKDAYS[at.getDay()];
		return `${day} ${hh}:${mm}`;
	}
	if (lang === "zh") return `${at.getMonth() + 1}月${at.getDate()}日`;
	return `${MONTHS[at.getMonth()]}${String(at.getDate()).padStart(2, "0")}`;
}

function bucketsLookup(snapshot: Snapshot, limitId: string): LimitBucket | undefined {
	return snapshot.buckets.find((b) => b.limitId === limitId);
}

/** Compact footer label for a bucket: `codex`, `spark`, or the variant name. */
export function compactBucketLabel(bucket: Pick<LimitBucket, "limitId" | "limitName">): string {
	if (normalizedUsageKey(bucket.limitId) === "codex") return "codex";
	const raw = bucket.limitName ?? bucket.limitId;
	const variant = raw.match(/codex[\s-_]+(.+)$/i)?.[1];
	if (variant) return variant.trim().toLowerCase();
	const parts = raw.replace(/[_\s-]+/g, " ").trim().split(/\s+/);
	return (parts.at(-1) ?? raw).toLowerCase();
}

export interface FooterOpts {
	now: number;
	stale?: boolean;
	theme?: FooterTheme;
	lang?: Lang;
	activeBucket?: Pick<LimitBucket, "limitId" | "limitName">;
}

/** GLM-style multi-bar footer for the active bucket: `codex 5h ████░ 43% · 7d ██████ 12% ↻5h 12m`. */
export function renderFooter(snapshot: Snapshot, opts: FooterOpts): string {
	const theme = opts.theme ?? identityTheme;
	const lang = opts.lang ?? "en";
	const bucket = opts.activeBucket ?? snapshot.buckets[0] ?? { limitId: "codex" };
	const label = compactBucketLabel(bucket);
	const segs: string[] = [];
	const shownBucket: LimitBucket = (bucketsLookup(snapshot, bucket.limitId)) ?? { limitId: bucket.limitId };
	const windows: Array<{ w: UsageWindow | undefined; fallback: string }> = [
		{ w: shownBucket.primary, fallback: msg(lang, "windowPrimary") },
		{ w: shownBucket.secondary, fallback: msg(lang, "windowSecondary") },
	];
	const resetUs = windows
		.map((x) => x.w?.resetsAt)
		.filter((v): v is number => v !== undefined)
		.sort((a, b) => a - b)[0];
		const resetText = resetUs !== undefined ? formatReset(resetUs, opts.now, lang) : "";
	for (const win of windows) {
		if (!win.w) continue;
		const remaining = Math.round(100 - clampPercent(win.w.usedPercent));
		const labelText = win.w.windowMinutes !== undefined ? windowLabel(win.w.windowMinutes) : win.fallback;
		const chunk = `${labelText} ${renderBar(remaining, theme)} ${remaining}%`;
		segs.push(theme.fg("dim", chunk));
	}
	if (segs.length === 0) return `${label} ${theme.fg("dim", msg(lang, "nA"))}`;
	let footer = segs.join(" · ");
	if (resetText) footer += ` ${theme.fg("dim", msg(lang, "resetsIn", { t: resetText }))}`;
	if (opts.stale) footer = `${theme.fg("dim", "~")}${footer}`;
	return `${label} ${footer}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report text & JSON payload
// ─────────────────────────────────────────────────────────────────────────────

function formatAge(ms: number, lang: Lang): string {
	if (ms < 5_000) return msg(lang, "ageJustNow");
	if (ms < 60_000) return msg(lang, "ageSec", { n: Math.round(ms / 1_000) });
	if (ms < 3_600_000) return msg(lang, "ageMin", { n: Math.round(ms / 60_000) });
	return msg(lang, "ageHour", { n: Math.round(ms / 3_600_000) });
}

export function remainingPercent(w: UsageWindow | undefined): number | null {
	return w === undefined ? null : Math.round(100 - clampPercent(w.usedPercent));
}

export function buildReportLines(snapshot: Snapshot, opts: { now: number; lang: Lang; stale?: boolean; resetInventory?: ResetCreditInventory }): string[] {
	const lines: string[] = [];
	const age = formatAge(Math.max(0, opts.now - snapshot.capturedAt), opts.lang);
	lines.push(msg(opts.lang, "plan", { plan: snapshot.planType ?? "?" }));
	lines.push(`${msg(opts.lang, "updatedAgo", { age })}${opts.stale ? " (~)" : ""} · ${msg(opts.lang, "source", { source: snapshot.source === "api" ? "API" : "headers" })}`);
	for (const bucket of snapshot.buckets) {
		const label = bucket.limitName ?? bucket.limitId;
		const wins: Array<{ w: UsageWindow | undefined; fallback: string }> = [
			{ w: bucket.primary, fallback: msg(opts.lang, "windowPrimary") },
			{ w: bucket.secondary, fallback: msg(opts.lang, "windowSecondary") },
		];
		for (const { w, fallback } of wins) {
			if (!w) continue;
			const rem = remainingPercent(w);
			const labelText = w.windowMinutes !== undefined ? windowLabel(w.windowMinutes) : fallback;
			const reset = formatReset(w.resetsAt, opts.now, opts.lang);
			lines.push(`  ${label} ${labelText} ${msg(opts.lang, "limitWindow")}: ${renderBar(rem ?? 0, identityTheme)} ${rem ?? "?"}% ${msg(opts.lang, "left")}${reset ? ` · ${msg(opts.lang, "resetsIn", { t: reset })}` : ""}`);
		}
	}
	const credits = snapshot.credits ?? snapshot.buckets[0]?.credits;
	if (credits) {
		const value = credits.hasCredits === false ? msg(opts.lang, "creditsNone")
			: credits.unlimited ? msg(opts.lang, "creditsUnlimited")
			: credits.balance?.trim() ? credits.balance
			: msg(opts.lang, "creditsAvailable");
		lines.push(`  ${msg(opts.lang, "credits")}: ${value}`);
	}
	const rc = snapshot.resetCredits?.availableCount;
	lines.push(`  ${msg(opts.lang, "resetCredits")}: ${rc === undefined ? msg(opts.lang, "resetCountMissing") : rc === 0 ? msg(opts.lang, "resetCountNone") : rc === 1 ? msg(opts.lang, "resetCountOne", { n: rc }) : msg(opts.lang, "resetCountMany", { n: rc })}`);
	if (opts.resetInventory && opts.resetInventory.options.length > 0) {
		for (const option of opts.resetInventory.options) {
			const expiry = option.expiresAt !== undefined ? msg(opts.lang, "resetOptionExpires", { at: formatReset(option.expiresAt, opts.now, opts.lang) || "?" }) : "";
			lines.push(`    ${msg(opts.lang, "resetOption", { title: option.title, desc: option.description })}${expiry ? ` (${expiry})` : ""}`);
		}
		lines.push(`    ${msg(opts.lang, "resetOptionHint")}`);
	}
	const sc = snapshot.spendControl;
	if (sc && (sc.reached === true || sc.individualLimit)) {
		const bits: string[] = [];
		if (sc.reached === true) bits.push(msg(opts.lang, "spendReached"));
		if (sc.individualLimit) {
			const limitBits: string[] = [];
			if (sc.individualLimit.limit !== undefined) limitBits.push(msg(opts.lang, "spendLimitLimit", { limit: sc.individualLimit.limit }));
			if (sc.individualLimit.used !== undefined) limitBits.push(msg(opts.lang, "spendLimitUsed", { used: sc.individualLimit.used }));
			if (sc.individualLimit.remainingPercent !== undefined) limitBits.push(msg(opts.lang, "spendLimitRemaining", { pct: sc.individualLimit.remainingPercent }));
			if (limitBits.length > 0) bits.push(limitBits.join(" · "));
		}
		if (bits.length > 0) lines.push(`  ${msg(opts.lang, "spendControl")}: ${bits.join(" · ")}`);
	}
	if (snapshot.warnings.length > 0) {
		lines.push(`  ${msg(opts.lang, "warnings")}:`);
		for (const w of snapshot.warnings) lines.push(`    ${w}`);
	}
	lines.push("");
	lines.push(msg(opts.lang, "visitPage"));
	return lines;
}

/** Stable English-key JSON payload; never contains account id or fingerprint. */
export function toJsonPayload(snapshot: Snapshot, opts: { stale?: boolean; resetInventory?: ResetCreditInventory }): unknown {
	return {
		schemaVersion: snapshot.schemaVersion,
		capturedAt: snapshot.capturedAt,
		freshness: opts.stale ? "stale" : "fresh",
		source: snapshot.source,
		...(snapshot.planType ? { planType: snapshot.planType } : {}),
		...(snapshot.rateLimitReachedType ? { rateLimitReachedType: snapshot.rateLimitReachedType } : {}),
		...(snapshot.limitReached !== undefined ? { limitReached: snapshot.limitReached } : {}),
		...(snapshot.allowed !== undefined ? { allowed: snapshot.allowed } : {}),
		buckets: snapshot.buckets.map((b) => ({
			limitId: b.limitId,
			...(b.limitName ? { limitName: b.limitName } : {}),
			...(b.primary ? { primary: { ...b.primary } } : {}),
			...(b.secondary ? { secondary: { ...b.secondary } } : {}),
			...(b.credits ? { credits: { ...b.credits } } : {}),
		})),
		...(snapshot.credits ? { credits: { ...snapshot.credits } } : {}),
		...(snapshot.resetCredits ? { resetCredits: { ...snapshot.resetCredits } } : {}),
		...(opts.resetInventory ? { resetCreditOptions: opts.resetInventory.options } : {}),
		...(snapshot.spendControl ? { spendControl: snapshot.spendControl } : {}),
		warnings: snapshot.warnings,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Passive header parse & merge (ADR-0004)
// ─────────────────────────────────────────────────────────────────────────────

export interface HeaderWindowUpdate {
	usedPercent?: number;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface HeaderBucketUpdate {
	limitId: string;
	limitName?: string;
	primary?: HeaderWindowUpdate;
	secondary?: HeaderWindowUpdate;
	credits?: Credits;
}

export interface HeaderUpdate {
	buckets: HeaderBucketUpdate[];
	promoMessage?: string;
	planType?: string;
	rateLimitReachedType?: string;
}

function headerMap(headers: Record<string, string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const [k, v] of Object.entries(headers)) {
		if (v !== undefined && v !== null) out.set(k.toLowerCase(), String(v));
	}
	return out;
}

function hNum(map: Map<string, string>, name: string): number | undefined {
	const raw = map.get(name);
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function hBool(map: Map<string, string>, name: string): boolean | undefined {
	const raw = map.get(name)?.trim().toLowerCase();
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return undefined;
}

function parseHeaderWindow(map: Map<string, string>, prefix: string, now: number): HeaderWindowUpdate | undefined {
	const usedPercent = hNum(map, `${prefix}-used-percent`);
	const windowMinutes = hNum(map, `${prefix}-window-minutes`);
	const resetAtRaw = hNum(map, `${prefix}-reset-at`);
	const resetAfterRaw = hNum(map, `${prefix}-reset-after-seconds`);
	const resetsAt = resetAtRaw !== undefined ? (resetAtRaw >= 10_000_000_000 ? Math.round(resetAtRaw / 1_000) : resetAtRaw) : resetAfterRaw !== undefined ? Math.round(now / 1_000) + resetAfterRaw : undefined;
	if (usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined) return undefined;
	return {
		...(usedPercent !== undefined ? { usedPercent: clampPercent(usedPercent) } : {}),
		...(windowMinutes !== undefined ? { windowMinutes } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

function parseHeaderBucket(map: Map<string, string>, limitId: string, now: number): HeaderBucketUpdate | undefined {
	const dashed = normalizeLimitId(limitId).replace(/_/g, "-");
	const prefixes = [`x-${dashed}`];
	const under = limitId.includes("_") ? `x-${limitId}` : undefined;
	if (under) prefixes.push(under);
	let primary: HeaderWindowUpdate | undefined;
	let secondary: HeaderWindowUpdate | undefined;
	let limitName: string | undefined;
	for (const prefix of prefixes) {
		primary ??= parseHeaderWindow(map, `${prefix}-primary`, now);
		secondary ??= parseHeaderWindow(map, `${prefix}-secondary`, now);
		limitName ??= map.get(`${prefix}-limit-name`)?.trim();
	}
	if (!primary && !secondary && !limitName) return undefined;
	return {
		limitId: normalizeLimitId(limitId),
		...(limitName ? { limitName: sanitizeDisplayText(limitName) ?? undefined } : {}),
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

/** Parse the official `x-{limit}-*` header families (plus reset-after compat). */
export function parseRateLimitHeaders(headers: Record<string, string>, now = Date.now()): HeaderUpdate | undefined {
	const map = headerMap(headers);
	const ids = new Set<string>(["codex"]);
	for (const key of map.keys()) {
		const match = /^x-([a-z0-9_-]+)-primary-used-percent$/.exec(key);
		if (match?.[1]) ids.add(normalizeLimitId(match[1]));
	}
	const buckets: HeaderBucketUpdate[] = [];
	for (const id of ids) {
		const bucket = parseHeaderBucket(map, id, now);
		if (bucket) buckets.push(bucket);
	}
	const credits = parseHeaderCredits(map);
	if (buckets.length === 0 && !credits) return undefined;
	if (credits) {
		const codex = buckets.find((b) => b.limitId === "codex");
		if (codex) codex.credits = credits;
		else buckets.push({ limitId: "codex", credits });
	}
	const promo = sanitizeDisplayText(map.get("x-codex-promo-message") ?? "");
	const planType = sanitizeDisplayText(map.get("x-codex-plan-type") ?? "");
	const reached = sanitizeDisplayText(map.get("x-codex-rate-limit-reached-type") ?? "");
	const out: HeaderUpdate = { buckets };
	if (promo) out.promoMessage = promo;
	if (planType) out.planType = planType;
	if (reached) out.rateLimitReachedType = reached;
	return out;
}

function parseHeaderCredits(map: Map<string, string>): Credits | undefined {
	const hasCredits = hBool(map, "x-codex-credits-has-credits");
	const unlimited = hBool(map, "x-codex-credits-unlimited");
	const balanceRaw = map.get("x-codex-credits-balance");
	if (hasCredits === undefined && unlimited === undefined && balanceRaw === undefined) return undefined;
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(balanceRaw && balanceRaw.trim() ? { balance: balanceRaw } : {}),
	} as Credits;
}

/** Field-wise merge over an existing snapshot; never introduces new buckets. */
export function mergeHeaderUpdate(snapshot: Snapshot, update: HeaderUpdate): Snapshot {
	const buckets = snapshot.buckets.map((bucket) => {
		const up = update.buckets.find((b) => b.limitId === bucket.limitId);
		if (!up) return bucket;
		const next: LimitBucket = { ...bucket };
		if (up.primary) {
			const merged: UsageWindow = {
				usedPercent: up.primary.usedPercent ?? bucket.primary?.usedPercent ?? 0,
			};
			if (up.primary.windowMinutes !== undefined) merged.windowMinutes = up.primary.windowMinutes;
			else if (bucket.primary?.windowMinutes !== undefined) merged.windowMinutes = bucket.primary.windowMinutes;
			if (up.primary.resetsAt !== undefined) merged.resetsAt = up.primary.resetsAt;
			else if (bucket.primary?.resetsAt !== undefined) merged.resetsAt = bucket.primary.resetsAt;
			next.primary = merged;
		}
		if (up.secondary) {
			const merged: UsageWindow = {
				usedPercent: up.secondary.usedPercent ?? bucket.secondary?.usedPercent ?? 0,
			};
			if (up.secondary.windowMinutes !== undefined) merged.windowMinutes = up.secondary.windowMinutes;
			else if (bucket.secondary?.windowMinutes !== undefined) merged.windowMinutes = bucket.secondary.windowMinutes;
			if (up.secondary.resetsAt !== undefined) merged.resetsAt = up.secondary.resetsAt;
			else if (bucket.secondary?.resetsAt !== undefined) merged.resetsAt = bucket.secondary.resetsAt;
			next.secondary = merged;
		}
		if (up.credits) next.credits = { ...(bucket.credits ?? {}), ...up.credits } as Credits;
		if (up.limitName) next.limitName = up.limitName;
		return next;
	});
	const next: Snapshot = { ...snapshot, buckets };
	if (update.planType) next.planType = update.planType;
	if (update.rateLimitReachedType) next.rateLimitReachedType = update.rateLimitReachedType;
	// capturedAt/source/freshness intentionally untouched (ADR-0004).
	return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot persistence store (ADR-0007)
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotStoreRow {
	t: number;
	fingerprint: string;
	snapshot: Snapshot;
}

export interface SnapshotStoreLike {
	append(row: SnapshotStoreRow): void;
	load(fingerprint: string): SnapshotStoreRow | undefined;
}

export interface StoreIo {
	readFile(p: string): string | null;
	appendFile(p: string, s: string): void;
	writeFile(p: string, s: string): void;
	rename(from: string, to: string): void;
	mkdir(p: string): void;
}

export const SNAPSHOT_KEEP = 500;
export const SNAPSHOT_COMPACT_AT = 1_000;
export const SNAPSHOT_FILE_NAME = "pi-openai-codex-usage-snapshots.jsonl";

function rowHygienic(raw: unknown): boolean {
	const text = JSON.stringify(raw);
	if (!text) return false;
	const lower = text.toLowerCase();
	return !lower.includes("access_token") && !lower.includes("authorization") && !lower.includes("bearer") && !lower.includes("accountid");
}

export function createSnapshotStore(dir: string, io: StoreIo): SnapshotStoreLike {
	const file = nodePath.join(dir, SNAPSHOT_FILE_NAME);
	const parseAll = (): SnapshotStoreRow[] => {
		const raw = io.readFile(file);
		if (raw === null) return [];
		const out: SnapshotStoreRow[] = [];
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const r = JSON.parse(t) as unknown;
				if (!isRecord(r)) continue;
				if (typeof r["t"] !== "number" || typeof r["fingerprint"] !== "string" || !isRecord(r["snapshot"])) continue;
				if (!rowHygienic(r)) continue;
				out.push({ t: r["t"], fingerprint: r["fingerprint"], snapshot: r["snapshot"] as unknown as Snapshot });
			} catch {
				// skip corrupt lines
			}
		}
		return out;
	};
	return {
		append(row) {
			try {
				io.mkdir(dir);
				const all = parseAll();
				all.push(row);
				if (all.length > SNAPSHOT_COMPACT_AT) {
					const kept = all.slice(-SNAPSHOT_KEEP);
					const tmp = `${file}.tmp`;
					io.writeFile(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
					io.rename(tmp, file);
				} else {
					io.appendFile(file, JSON.stringify(row) + "\n");
				}
			} catch {
				// best effort
			}
		},
		load(fingerprint) {
			const all = parseAll();
			for (let i = all.length - 1; i >= 0; i -= 1) {
				if (all[i].fingerprint === fingerprint) return all[i];
			}
			return undefined;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts (two transitions only)
// ─────────────────────────────────────────────────────────────────────────────

export interface AlertStateV1 {
	reachedType?: string;
	authInvalidReported?: boolean;
}

export interface AlertEmission {
	kind: "auth-invalid" | "reached";
	messageKey: MsgKey;
	vars?: MsgVars;
}

function reachedMessageKey(kind: string | undefined): { key: MsgKey; vars?: MsgVars } {
	switch (kind) {
		case "rate_limit_reached":
			return { key: "alertReachedLimit" };
		case "workspace_owner_credits_depleted":
			return { key: "alertReachedOwnerCredits" };
		case "workspace_member_credits_depleted":
			return { key: "alertReachedMemberCredits" };
		case "workspace_owner_usage_limit_reached":
			return { key: "alertReachedOwnerUsage" };
		case "workspace_member_usage_limit_reached":
			return { key: "alertReachedMemberUsage" };
		default:
			return { key: "alertReachedUnknown", vars: { kind: kind ?? "unknown" } };
	}
}

export function evaluateAlerts(prev: AlertStateV1 | null, next: { snapshot: Snapshot; authInvalid: boolean }): { emitted: AlertEmission[]; state: AlertStateV1 } {
	const emitted: AlertEmission[] = [];
	const nextReached = next.snapshot.rateLimitReachedType;
	const state: AlertStateV1 = {};
	if (next.authInvalid && prev?.authInvalidReported !== true) {
		emitted.push({ kind: "auth-invalid", messageKey: "alertAuthInvalid" });
		state.authInvalidReported = true;
	} else if (!next.authInvalid) {
		state.authInvalidReported = false;
	} else {
		state.authInvalidReported = true;
	}
	if (nextReached !== undefined && nextReached !== prev?.reachedType) {
		const mapped = reachedMessageKey(nextReached);
		emitted.push({ kind: "reached", messageKey: mapped.key, ...(mapped.vars ? { vars: mapped.vars } : {}) });
		state.reachedType = nextReached;
	} else if (nextReached === undefined) {
		state.reachedType = undefined;
	} else {
		state.reachedType = prev?.reachedType;
	}
	return { emitted, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset credits client additions
// ─────────────────────────────────────────────────────────────────────────────

export type ResetInventoryResult =
	| { status: "ok"; inventory: ResetCreditInventory }
	| { status: "retry"; retryAfterMs: number }
	| { status: "error"; code: UsageError["code"]; message: string };

export type ConsumeResetResult =
	| { status: "ok"; code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"; windowsReset: number }
	| { status: "retry"; retryAfterMs: number }
	| { status: "error"; code: UsageError["code"]; message: string };

export interface ResetCreditClientLike {
	listResetCredits(token: string, accountId: string, signal?: AbortSignal): Promise<ResetInventoryResult>;
	consumeResetCredit(token: string, accountId: string, body: { redeem_request_id: string; credit_id?: string }, signal?: AbortSignal): Promise<ConsumeResetResult>;
}

async function resetRequest(
	fetchImpl: typeof fetch,
	url: string,
	body: string | undefined,
	token: string,
	accountId: string,
	userAgent: string,
	timeoutMs: number,
	maxBodyBytes: number,
	signal: AbortSignal | undefined,
): Promise<{ status: number; text: string }> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetchImpl(url, {
		method: body === undefined ? "GET" : "POST",
		...(body !== undefined ? { body } : {}),
		headers: {
			Authorization: `Bearer ${token}`,
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
			Accept: "application/json",
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			"User-Agent": userAgent,
		},
		signal: combined,
		redirect: "manual",
	});
	const text = await readBoundedBody(response, maxBodyBytes, signal).catch(() => "");
	return { status: response.status, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension factory and default wiring
// ─────────────────────────────────────────────────────────────────────────────

export type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

export interface UiLike {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	theme: FooterTheme;
	custom?(
		factory: (tui: unknown, theme: FooterTheme, kb: KeyLike, done: (value: unknown) => void) => OverlayComponent,
		options?: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } },
	): Promise<unknown>;
	select?(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
	confirm?(title: string, message: string, opts?: unknown): Promise<boolean>;
}

export interface ExtensionDeps {
	env?: Record<string, string | undefined>;
	nowFn?: () => number;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	interactive?: (ctx: CtxLike) => boolean;
	clientFor(): UsageClientLike & ResetCreditClientLike;
	authFor(ctx: CtxLike, opts: { requireActiveModel: boolean; wantToken?: boolean }): Promise<AuthResolution>;
	credentialReader?: CredentialReader;
	ensureReader?: () => Promise<void>;
	snapshotStore?: SnapshotStoreLike;
	resetIdFactory?: () => string;
}

const REFRESH_DEBOUNCE_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const COUNTDOWN_TICK_MS = 30_000;
const STALE_HARD_MS = 10 * 60_000;
const RESET_ONESHOT_SKEW_MS = 5_000;
const ZERO_LATCH_MS = 15_000;
const ZERO_LATCH_RETRY_MS = 1_000;

interface ExtensionState {
	active: boolean;
	snapshot: Snapshot | null;
	stale: boolean;
	fingerprint: string | null;
	authInvalid: boolean;
	retryDeadline: number;
	nextAllowedAt: number;
	inFlight: boolean;
	generation: number;
	consecutiveFailures: number;
	lastOkFetchAt: number;
	zeroLatch: Map<string, number> | null;
	resetOneShot: TimerHandle | null;
	lastError: string | null;
	lastResetKey: string | null;
	alertState: AlertStateV1 | null;
	lastCtx: CtxLike | null;
	resetInventory: ResetCreditInventory | null;
}

export function createExtension(deps: ExtensionDeps) {
	const now = () => (deps.nowFn ?? Date.now)();
	const setTimeoutImpl = deps.setTimeout ?? setTimeout;
	const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout;
	const setIntervalImpl = deps.setInterval ?? setInterval;
	const clearIntervalImpl = deps.clearInterval ?? clearInterval;
	const isInteractive = (ctx: CtxLike) => deps.interactive?.(ctx) ?? (ctx.mode === "tui" || ctx.hasUI === true);
	const lang = resolveLang(deps.env ?? {});
	const store = deps.snapshotStore ?? { append() { /* */ }, load: () => undefined };

	return function install(pi: unknown): void {
		const s: ExtensionState = {
			active: false,
			snapshot: null,
			stale: false,
			fingerprint: null,
			authInvalid: false,
			retryDeadline: 0,
			nextAllowedAt: 0,
			inFlight: false,
			generation: 0,
			consecutiveFailures: 0,
			lastOkFetchAt: 0,
			zeroLatch: null,
			resetOneShot: null,
			lastError: null,
			lastResetKey: null,
			alertState: null,
			lastCtx: null,
			resetInventory: null,
		};

		const api = pi as {
			on(event: string, handler: (event: unknown, ctx: CtxLike) => Promise<void> | void): void;
			registerCommand(name: string, opts: { description: string; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string; description?: string }> | null; handler: (args: string, ctx: CtxLike) => Promise<void> | void }): void;
		};

		let heartbeatTimer: TimerHandle | null = null;
		let countdownTimer: TimerHandle | null = null;
		let debounceTimer: TimerHandle | null = null;
		let retryOneShot: TimerHandle | null = null;

		const clearTimers = () => {
			if (heartbeatTimer) { clearIntervalImpl(heartbeatTimer as never); heartbeatTimer = null; }
			if (countdownTimer) { clearIntervalImpl(countdownTimer as never); countdownTimer = null; }
			if (debounceTimer) { clearTimeoutImpl(debounceTimer as never); debounceTimer = null; }
			if (retryOneShot) { clearTimeoutImpl(retryOneShot as never); retryOneShot = null; }
			if (retryOneShot) { clearTimeoutImpl(retryOneShot as never); retryOneShot = null; }
			if (s.resetOneShot) { clearTimeoutImpl(s.resetOneShot); s.resetOneShot = null; }
		};

		function activeBucket(): Pick<LimitBucket, "limitId" | "limitName"> | undefined {
			const ctx = s.lastCtx;
			if (!s.snapshot || !ctx?.model) return { limitId: s.snapshot?.buckets[0]?.limitId ?? "codex" };
			return selectActiveBucket(s.snapshot.buckets, ctx.model);
		}

		function footerText(): string {
			if (!s.active) return "";
			const uiLabel = "codex";
			if (s.authInvalid) return `${uiLabel} ${uiThemed("authError")}`;
			if (!s.snapshot) {
				if (now() < s.retryDeadline) return `${uiLabel} ${uiThemed("rateLimited")}`;
				if (s.lastError) return `${uiLabel} ${uiThemed("error")}`;
				return uiThemed("loadingState");
			}
			if (s.stale && now() - s.lastOkFetchAt > STALE_HARD_MS) return `${uiLabel} ${uiThemed("error")}`;
			return renderFooter(s.snapshot, { now: now(), stale: s.stale, lang, activeBucket: selectActiveBucket(s.snapshot.buckets, s.lastCtx?.model ?? undefined) });
		}

		function uiThemed(kind: "authError" | "rateLimited" | "error" | "loadingState"): string {
			const ui = s.lastCtx?.ui;
			const theme = ui?.theme ?? identityTheme;
			const text = kind === "authError" ? msg(lang, "authError") : kind === "rateLimited" ? msg(lang, "rateLimited") : kind === "error" ? msg(lang, "error") : msg(lang, "nA");
			const role = kind === "authError" || kind === "error" ? "error" : "dim";
			return theme.fg(role, text);
		}

		function render(): void {
			const ui = s.lastCtx?.ui as UiLike | undefined;
			if (!ui) return;
			if (!s.active) {
				ui.setStatus("pi-openai-codex-usage", undefined);
				return;
			}
			ui.setStatus("pi-openai-codex-usage", footerText());
		}

		const startHeartbeat = () => {
			if (heartbeatTimer || !s.active) return;
			heartbeatTimer = setIntervalImpl(() => {
				if (s.active && s.lastCtx) void refresh(s.lastCtx, false);
			}, HEARTBEAT_MS) as TimerHandle;
			heartbeatTimer.unref?.();
		};

		const startCountdown = () => {
			if (countdownTimer || !s.active) return;
			countdownTimer = setIntervalImpl(() => {
				if (s.active && s.snapshot) render();
			}, COUNTDOWN_TICK_MS) as TimerHandle;
			countdownTimer.unref?.();
		};

		const scheduleRetryOneShot = (ctx: CtxLike) => {
			if (retryOneShot) return;
			const delay = Math.max(1_000, s.retryDeadline - now());
			retryOneShot = setTimeoutImpl(() => {
				retryOneShot = null;
				if (s.active && isInteractive(ctx)) void refresh(ctx, false);
			}, delay) as TimerHandle;
			retryOneShot.unref?.();
		};

		const scheduleDebouncedRefresh = (ctx: CtxLike) => {
			if (debounceTimer) return;
			debounceTimer = setTimeoutImpl(() => {
				debounceTimer = null;
				if (s.active && isInteractive(ctx)) void refresh(ctx, false);
			}, REFRESH_DEBOUNCE_MS) as TimerHandle;
			debounceTimer.unref?.();
		};

		const scheduleResetOneShot = (snapshot: Snapshot) => {
			if (s.resetOneShot) return;
			const reached = snapshot.rateLimitReachedType !== undefined;
			const bucket = s.lastCtx?.model ? selectActiveBucket(snapshot.buckets, s.lastCtx.model) : snapshot.buckets[0];
			const windows = [snapshot.buckets.find((b) => b.limitId === bucket?.limitId)?.primary, snapshot.buckets.find((b) => b.limitId === bucket?.limitId)?.secondary];
			const exhausted = windows.some((w) => w !== undefined && w.usedPercent >= 100) || snapshot.limitReached === true;
			if (!reached && !exhausted) return;
			const resetsAt = windows.map((w) => w?.resetsAt).filter((v): v is number => v !== undefined).sort((a, b) => a - b)[0];
			if (resetsAt === undefined) return;
			const key = `${bucket?.limitId ?? "codex"}:${resetsAt}`;
			if (s.lastResetKey === key) return; // already fired for this reset instant
			const delay = Math.max(1_000, resetsAt * 1_000 - now() + RESET_ONESHOT_SKEW_MS);
			s.resetOneShot = setTimeoutImpl(() => {
				s.resetOneShot = null;
				s.lastResetKey = key;
				if (s.active && s.lastCtx) void refresh(s.lastCtx, true);
			}, delay) as TimerHandle;
			s.resetOneShot.unref?.();
		};

		function applySnapshot(next: Snapshot, ctx: CtxLike): void {
			const prev = s.snapshot;
			// Provisional-zero guard: latch per bucket on a non-zero → zero transition.
			const newlyZeroed: string[] = [];
			for (const pos of ["primary", "secondary"] as const) {
				for (const [before, after] of [[prev?.buckets ?? [], next.buckets]] as const) {
					for (const b of after) {
						const prevB = before.find((x) => x.limitId === b.limitId);
						const beforePct = prevB?.[ pos ]?.usedPercent;
						const afterWin = b[pos];
						if (beforePct !== undefined && beforePct > 0 && afterWin !== undefined && afterWin.usedPercent === 0) {
							newlyZeroed.push(`${b.limitId}:${pos}`);
						}
					}
				}
			}
			if (newlyZeroed.length > 0) {
				const latches = s.zeroLatch ?? new Map<string, number>();
				const fresh = newlyZeroed.filter((k) => (latches.get(k) ?? Number.POSITIVE_INFINITY) === Number.POSITIVE_INFINITY);
				for (const k of fresh) latches.set(k, now());
				s.zeroLatch = latches;
				if (fresh.some((k) => now() - (latches.get(k) ?? 0) < ZERO_LATCH_MS)) {
					const t = setTimeoutImpl(() => {
						if (s.active) void refresh(ctx, true);
					}, ZERO_LATCH_RETRY_MS) as TimerHandle;
					t.unref?.();
					return; // keep the previous snapshot until the latch resolves
				}
			}
			if (newlyZeroed.length === 0) s.zeroLatch = null;
			s.snapshot = next;
			s.stale = false;
			s.lastOkFetchAt = now();
			s.consecutiveFailures = 0;
			if (s.fingerprint) {
				try {
					store.append({ t: now(), fingerprint: s.fingerprint, snapshot: next });
				} catch { /* */ }
			}
			scheduleResetOneShot(next);
		}

		async function refresh(ctx: CtxLike, force: boolean): Promise<void> {
			if (!isInteractive(ctx) || !s.active || s.inFlight) return;
			if (!force && now() < s.retryDeadline) return;
			if (!force && now() < s.nextAllowedAt) return;
			s.inFlight = true;
			const gen = s.generation;
			let authRetried = false;
			try {
				const auth = await deps.authFor(ctx, { requireActiveModel: true, wantToken: true });
				if (gen !== s.generation) return;
				if (auth.status !== "ok") {
					s.authInvalid = auth.status === "auth-error";
					if (s.snapshot) s.stale = true;
					emitAlerts(ctx, s.snapshot, s.authInvalid);
					render();
					return;
				}
				if (auth.switched) {
					const nextFp = accountFingerprint(auth.accountId);
					if (s.fingerprint !== nextFp) {
						// Account switch: drop all state.
						s.snapshot = null;
						s.stale = false;
						s.alertState = null;
						s.zeroLatch = null;
						s.fingerprint = nextFp;
					}
				} else if (s.fingerprint === null) {
					s.fingerprint = accountFingerprint(auth.accountId);
				}
				const client = deps.clientFor();
				const result = await client.fetchSnapshot(auth.token, auth.accountId, undefined);
				if (gen !== s.generation) return;
				if (result.status === "ok") {
					s.retryDeadline = 0;
					s.authInvalid = false;
					s.lastError = null;
					applySnapshot(result.snapshot, ctx);
					emitAlerts(ctx, result.snapshot, false);
				} else if (result.status === "retry") {
					s.retryDeadline = Math.max(s.retryDeadline, now() + result.retryAfterMs);
					s.nextAllowedAt = Math.max(s.nextAllowedAt, s.retryDeadline);
					s.lastError = "rate-limit";
					if (s.snapshot) s.stale = true;
					scheduleRetryOneShot(ctx);
				} else {
					if (result.code === "auth") {
						// One re-resolution before declaring invalid (PRD story 10).
						if (!authRetried) {
							authRetried = true;
							const retryAuth = await deps.authFor(ctx, { requireActiveModel: true, wantToken: true });
							if (gen !== s.generation) return;
							if (retryAuth.status === "ok") {
								if (retryAuth.switched && s.fingerprint !== accountFingerprint(retryAuth.accountId)) {
									s.snapshot = null;
									s.stale = false;
									s.alertState = null;
									s.fingerprint = accountFingerprint(retryAuth.accountId);
								}
								const retry = await client.fetchSnapshot(retryAuth.token, retryAuth.accountId, ctxSignal(ctx));
								if (gen !== s.generation) return;
								if (retry.status === "ok") {
									s.retryDeadline = 0;
									s.authInvalid = false;
									s.lastError = null;
									applySnapshot(retry.snapshot, ctx);
									emitAlerts(ctx, retry.snapshot, false);
									render();
									return;
								}
							}
						}
						s.authInvalid = true;
						s.lastError = "auth";
						if (s.snapshot) s.stale = true;
					} else {
						s.consecutiveFailures += 1;
						s.nextAllowedAt = now() + Math.min(1_000 * 2 ** Math.min(4, s.consecutiveFailures + 1), 60_000);
						s.lastError = result.code;
						if (s.snapshot) s.stale = true;
					}
					emitAlerts(ctx, s.snapshot, s.authInvalid);
					if (result.code === "breaker" && s.lastCtx?.ui && s.snapshot === null) {
						s.lastCtx.ui.notify(msg(lang, "retryLater"), "warning");
					}
				}
				render();
			} catch (error) {
				if (gen !== s.generation) return;
				if (isStaleCtxReason(error)) return;
				if (s.snapshot) s.stale = true;
				render();
			} finally {
				if (gen === s.generation) s.inFlight = false;
			}
		}

		function emitAlerts(ctx: CtxLike, snapshot: Snapshot | null, authInvalid: boolean): void {
			const ui = ctx.ui as UiLike | undefined;
			if (!ui) return;
			const { emitted, state } = evaluateAlerts(s.alertState, { snapshot: snapshot ?? emptySnapshot0(), authInvalid });
			s.alertState = state;
			for (const e of emitted) ui.notify(msg(lang, e.messageKey, e.vars ?? {}), e.kind === "reached" ? "warning" : "error");
		}

		function emptySnapshot0(): Snapshot {
			return { schemaVersion: 1, capturedAt: now(), source: "api", buckets: [], warnings: [] };
		}

		async function activate(ctx: CtxLike, modelFromEvent?: { provider?: string; id?: string; name?: string } | null): Promise<void> {
			s.lastCtx = ctx;
			const model = modelFromEvent ?? ctx.model ?? null;
			if (model?.provider !== PROVIDER_ID) {
				s.active = false;
				s.snapshot = null;
				s.stale = false;
				clearTimers();
				render();
				return;
			}
			if (!isInteractive(ctx)) return;
			const auth = await deps.authFor(ctx, { requireActiveModel: true, wantToken: false });
			if (auth.status === "ok" && s.fingerprint === null) {
				s.fingerprint = accountFingerprint(auth.accountId);
				tryRestoreSnapshot(ctx);
			}
			s.active = true;
			render();
			startHeartbeat();
			startCountdown();
			void refresh(ctx, true);
		}

		function tryRestoreSnapshot(ctx: CtxLike): void {
			const ui = ctx.ui as UiLike | undefined;
			if (!ui || !s.fingerprint) return;
			const row = store.load(s.fingerprint);
			if (row) {
				s.snapshot = row.snapshot;
				s.stale = true;
				s.lastOkFetchAt = now();
			}
		}

		function isStaleCtxReason(error: unknown): boolean {
			return error instanceof Error && (error.message.includes("ctx is stale") || error.message.includes("stale after session"));
		}

		function handleAfterProviderResponse(event: { status: number; headers?: Record<string, string> }, ctx: CtxLike): void {
			if (!isInteractive(ctx) || !s.active || s.snapshot === null) return;
			if (ctx.model?.provider !== PROVIDER_ID) return;
			if (event.status === 429) {
				const ra = event.headers?.["retry-after"] ?? event.headers?.["Retry-After"];
				if (typeof ra === "string") {
					const wait = parseRetryAfter(ra, now());
					s.retryDeadline = Math.max(s.retryDeadline, now() + wait);
					s.nextAllowedAt = Math.max(s.nextAllowedAt, s.retryDeadline);
				}
			}
			const update = event.headers ? parseRateLimitHeaders(event.headers, now()) : undefined;
			if (!update) return;
			const merged = mergeHeaderUpdate(s.snapshot, update);
			if (merged !== s.snapshot) {
				s.snapshot = merged;
				scheduleResetOneShot(merged);
				render();
			}
		}

		// ── events ──
		api.on("session_start", async (_event, ctx) => {
			if (!isInteractive(ctx)) return;
			await activate(ctx);
		});
		api.on("model_select", async (event, ctx) => {
			s.generation += 1;
			s.inFlight = false;
			const model = (event as { model?: { provider?: string; id?: string; name?: string } }).model;
			s.lastCtx = ctx;
			if (!isInteractive(ctx)) return;
			await activate(ctx, model);
		});
		api.on("agent_settled", async (_event, ctx) => {
			if (!isInteractive(ctx) || !s.active) return;
			scheduleDebouncedRefresh(ctx);
		});
		api.on("agent_end", async (_event, ctx) => {
			if (!isInteractive(ctx) || !s.active) return;
			scheduleDebouncedRefresh(ctx);
		});
		api.on("after_provider_response", async (event, ctx) => {
			handleAfterProviderResponse(event as { status: number; headers?: Record<string, string> }, ctx);
		});
		api.on("session_shutdown", async () => {
			s.generation += 1;
			s.active = false;
			clearTimers();
			render();
		});

		// ── command ──
		api.registerCommand("codex-usage", {
			description: "Show ChatGPT Codex subscription usage (add --json for raw output)",
			getArgumentCompletions: (prefix: string) => {
				const items = [
					{ value: "--json", label: "--json", description: "Stable JSON snapshot" },
					{ value: "--refresh", label: "--refresh", description: "Bypass throttling" },
					{ value: "consume", label: "consume", description: "Redeem one usage reset" },
				];
				const filtered = items.filter((i) => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : null;
			},
			handler: async (args, ctx) => {
				const ui = ctx.ui as UiLike | undefined;
				if (!ui) return;
				try {
					const parsed = parseCommandArgs(args);
					if (parsed.error) {
						ui.notify(msg(lang, "unknownArgs", { arg: parsed.error.arg }), "error");
						return;
					}
					if (parsed.mode === "consume") {
						await consumeFlow(ctx, parsed);
						return;
					}
					if (parsed.json && ctx.mode !== "tui" && ctx.mode !== "print") {
						ui.notify(msg(lang, "jsonModeRestricted"), "warning");
						return;
					}
					const auth = await deps.authFor(ctx, { requireActiveModel: false, wantToken: true });
					if (auth.status !== "ok") {
						ui.notify(auth.status === "no-auth" ? msg(lang, "authNeeded") : msg(lang, "authFailed"), "error");
						return;
					}
					if (!parsed.refresh && now() < s.retryDeadline) {
						ui.notify(msg(lang, "rateLimitedNotify"), "error");
						return;
					}
					const client = deps.clientFor();
					const result = await client.fetchSnapshot(auth.token, auth.accountId, ctxSignal(ctx));
					if (result.status !== "ok") {
						ui.notify(result.status === "retry" ? msg(lang, "rateLimitedNotify") : result.message || msg(lang, "fetchFailed"), "error");
						return;
					}
					const snapshot = result.snapshot;
					if (s.active && (ctx.model?.provider === PROVIDER_ID)) {
						s.lastCtx = ctx;
						applySnapshot(snapshot, ctx);
						render();
					}
					let inventory: ResetCreditInventory | null = null;
					try {
						const inv = await client.listResetCredits(auth.token, auth.accountId, ctxSignal(ctx));
						if (inv.status === "ok") inventory = inv.inventory;
					} catch { /* report still useful without inventory */ }
					const stale = s.active ? s.stale : false;
					if (parsed.json) {
						const payload = JSON.stringify(toJsonPayload(snapshot, { stale, resetInventory: inventory ?? undefined }), null, 2);
						if (ctx.mode === "tui") {
							await showOverlay(ctx, payload.split("\n"), msg(lang, "reportTitle"));
						} else if (ctx.mode === "print") {
							console.log(payload);
						} else {
							ui.notify(msg(lang, "jsonModeRestricted"), "warning");
						}
						return;
					}
					const lines = buildReportLines(snapshot, { now: now(), lang, stale, resetInventory: inventory ?? undefined });
					if (ctx.mode === "tui") {
						await showOverlay(ctx, lines, msg(lang, "reportTitle"));
					} else {
						const rem = remainingPercent(snapshot.buckets[0]?.primary);
						ui.notify(msg(lang, "reportSummary", { pct: rem === null ? "?" : String(rem) }), "info");
					}
				} catch (error) {
					if (isStaleCtxReason(error)) return;
					ui.notify(error instanceof Error ? error.message : msg(lang, "fetchFailed"), "error");
				}
			},
		});

		async function showOverlay(ctx: CtxLike, body: string[], header: string): Promise<void> {
			const ui = ctx.ui as UiLike | undefined;
			if (!ui?.custom) return;
			await ui.custom(
				(tui, theme, kb, done) => {
					const rowGen = () => (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
					return createOverlayComponent({
						header,
						body,
						footer: msg(lang, "pressClose"),
						theme,
						kb,
						done,
						rowGen,
						lang,
					});
				},
				{ overlay: true, overlayOptions: { maxHeight: "80%" } },
			);
		}

		async function consumeFlow(ctx: CtxLike, parsed: { refresh: boolean; json: boolean; mode: "report" | "consume" }): Promise<void> {
			const ui = ctx.ui as UiLike | undefined;
			if (!ui) return;
			if (ctx.mode !== "tui") {
				ui.notify(msg(lang, "consumeModeRestricted"), "warning");
				return;
			}
			const auth = await deps.authFor(ctx, { requireActiveModel: false, wantToken: true });
			if (auth.status !== "ok") {
				ui.notify(auth.status === "no-auth" ? msg(lang, "authNeeded") : msg(lang, "authFailed"), "error");
				return;
			}
			// Guard 1+2: stored credential must match the runtime account, exactly once.
			await deps.ensureReader?.();
			const stored = deps.credentialReader?.(PROVIDER_ID);
			if (!stored?.accountId || stored.accountId !== auth.accountId) {
				ui.notify(msg(lang, "consumeRestricted"), "warning");
				return;
			}
			const client = deps.clientFor();
			const inv = await client.listResetCredits(auth.token, auth.accountId, ctxSignal(ctx));
			if (inv.status !== "ok") {
				ui.notify(inv.status === "retry" ? msg(lang, "rateLimitedNotify") : msg(lang, "consumeUnavailable"), "error");
				return;
			}
			if (inv.inventory.availableCount === 0 || inv.inventory.options.length === 0) {
				ui.notify(msg(lang, "consumeEmpty"), "info");
				return;
			}
			const choice = await ui.select?.(
				msg(lang, "consumeTitle"),
				inv.inventory.options.map((o) =>
					`${o.title}${o.expiresAt !== undefined ? ` (${msg(lang, "resetOptionExpires", { at: formatReset(o.expiresAt, now(), lang) || "?" })})` : ""}`,
				),
			);
			if (choice === undefined || choice === null) {
				ui.notify(msg(lang, "consumeCancelled"), "info");
				return;
			}
			// pi's select resolves the chosen OPTION STRING (interactive-mode.js);
			// map the label back to the option.
			const chosen = inv.inventory.options.find(
				(o) =>
					`${o.title}${o.expiresAt !== undefined ? ` (${msg(lang, "resetOptionExpires", { at: formatReset(o.expiresAt, now(), lang) || "?" })})` : ""}` === choice,
			);
			if (!chosen) {
				ui.notify(msg(lang, "consumeCancelled"), "info");
				return;
			}
			// Guard 4: explicit confirmation before POST.
			const ok = await ui.confirm?.(msg(lang, "consumeTitle"), msg(lang, "consumeConfirm", { title: chosen.title, expiry: chosen.expiresAt !== undefined ? formatReset(chosen.expiresAt, now(), lang) || "" : "" }));
			if (!ok) {
				ui.notify(msg(lang, "consumeCancelled"), "info");
				return;
			}
			// Guards 1+2 re-verified after the dialog: re-resolve and re-check identity.
			const reAuth = await deps.authFor(ctx, { requireActiveModel: false, wantToken: true });
			if (reAuth.status !== "ok" || reAuth.accountId !== auth.accountId) {
				ui.notify(msg(lang, "consumeRestricted"), "warning");
				return;
			}
			// Guard 3: fresh redeem request id per attempt.
			const redeemId = deps.resetIdFactory?.() ?? cryptoRandomId();
			const outcome = await client.consumeResetCredit(reAuth.token, reAuth.accountId, { redeem_request_id: redeemId, ...(chosen.creditId ? { credit_id: chosen.creditId } : {}) }, ctxSignal(ctx));
			if (outcome.status !== "ok") {
				ui.notify(outcome.status === "retry" ? msg(lang, "rateLimitedNotify") : outcome.message || msg(lang, "consumeUnavailable"), "error");
				return;
			}
			// Guard 5: outcome explained; snapshot refetched.
			const copy =
				outcome.code === "reset" ? msg(lang, "consumeReset", { windows: outcome.windowsReset })
				: outcome.code === "nothing_to_reset" ? msg(lang, "consumeNothing")
				: outcome.code === "no_credit" ? msg(lang, "consumeNoCredit")
				: outcome.code === "already_redeemed" ? msg(lang, "consumeAlready")
				: msg(lang, "consumeUnknown");
			ui.notify(copy, "info");
			if (reAuth.switched) {
				const nextFp = accountFingerprint(reAuth.accountId);
				if (s.fingerprint !== nextFp) {
					s.snapshot = null;
					s.stale = false;
					s.alertState = null;
					s.fingerprint = nextFp;
				}
			}
			if (s.lastCtx) void refresh(s.lastCtx, true);
		}

		function ctxSignal(ctx: CtxLike): AbortSignal | undefined {
			return (ctx as { signal?: AbortSignal }).signal;
		}

		function cryptoRandomId(): string {
			try {
				return createHash("sha256").update(`${now()}-${Math.random()}`).digest("hex").slice(0, 32);
			} catch {
				return `${now()}-${Math.random()}`;
			}
		}
	};
}

function parseCommandArgs(args: string): { refresh: boolean; json: boolean; mode: "report" | "consume"; error?: { arg: string } } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let refresh = false;
	let json = false;
	let mode: "report" | "consume" = "report";
	for (const token of tokens) {
		if (token === "--refresh") refresh = true;
		else if (token === "--json") json = true;
		else if (token === "consume") mode = "consume";
		else return { refresh: true, json: false, mode: "report", error: { arg: token } };
	}
	return { refresh, json, mode };
}

export function openaiCodexUsageInstall(pi: unknown): void {
	const env = process.env as Record<string, string | undefined>;
	const homedir = nodeOs.homedir();
	let cachedReader: CredentialReader | undefined;
	let readerPromise: Promise<void> | null = null;
	const ensureReader = async (): Promise<void> => {
		if (!readerPromise) {
			readerPromise = (async () => {
				try {
					// Peer-dependency export Pi exposes for credential reads;
					// older Pi versions degrade to best-effort switch detection.
					const mod = await import("@earendil-works/pi-coding-agent") as { readStoredCredential?: (providerId: string) => StoredCodexCredential | undefined };
					if (mod.readStoredCredential) cachedReader = (providerId) => mod.readStoredCredential?.(providerId);
				} catch {
					cachedReader = undefined;
				}
			})();
		}
		await readerPromise;
	};
	const dir = piAgentDir(env, homedir);
	const store = createSnapshotStore(dir, {
		readFile: (p) => {
			try { return nodeFs.readFileSync(p, "utf8"); } catch { return null; }
		},
		appendFile: (p, text) => {
			try { nodeFs.appendFileSync(p, text, { mode: 0o600 }); } catch { /* */ }
		},
		writeFile: (p, text) => {
			try { nodeFs.writeFileSync(p, text, { mode: 0o600 }); } catch { /* */ }
		},
		rename: (from, to) => {
			try { nodeFs.renameSync(from, to); } catch { /* */ }
		},
		mkdir: (p) => {
			try { nodeFs.mkdirSync(p, { recursive: true }); } catch { /* */ }
		},
	});
	const client = createUsageClient({ fetchImpl: fetch });
	createExtension({
		env,
		clientFor: () => client,
		authFor: async (ctx, opts) => {
			await ensureReader();
			return resolveCodexAuth(ctx, { credentialReader: cachedReader });
		},
		credentialReader: (providerId) => cachedReader?.(providerId),
		ensureReader,
		snapshotStore: store,
	})(pi);
}

export default function openaiCodexUsage(pi: unknown): void {
	openaiCodexUsageInstall(pi);
}
