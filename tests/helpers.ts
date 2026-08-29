/** Test scaffold: fake pi capturing handlers/commands; fake ctx recording UI calls. */

export function fakePi() {
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }> = {};
	return {
		handlers,
		commands,
		on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
			(handlers[event] ??= []).push(fn);
		},
		registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			commands[name] = options;
		},
		async emit(event: string, payload: unknown, ctx: unknown) {
			for (const fn of handlers[event] ?? []) await fn(payload, ctx);
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			await commands[name]?.handler(args, ctx);
		},
	};
}

export const identityTheme = { fg: (_r: string, t: string) => t };

export interface OverlayArtifact {
	component: { render(width: number): string[]; invalidate(): void; handleInput(data: string): void } | null;
	options: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } } | null;
	doneCalls: number;
	rows: number;
}

export function stubKb(): { matches(data: string, id: string): boolean } {
	const confirm = new Set(["\r", "\n", "\x1b[13u", "\x1bOM"]);
	const cancel = new Set(["\x1b", "\x1b[27u", "\x03", "\x1b[99;5u"]);
	const up = new Set(["\x1b[A", "\x1bOA"]);
	const down = new Set(["\x1b[B", "\x1bOB"]);
	const pageUp = new Set(["\x1b[5~"]);
	const pageDown = new Set(["\x1b[6~"]);
	const home = new Set(["\x1b[H", "\x1b[1~", "\x1bOH"]);
	const end = new Set(["\x1b[F", "\x1b[4~", "\x1bOF"]);
	return {
		matches(data: string, id: string) {
			switch (id) {
				case "tui.select.confirm": return confirm.has(data);
				case "tui.select.cancel": return cancel.has(data);
				case "tui.select.up": return up.has(data);
				case "tui.select.down": return down.has(data);
				case "tui.select.pageUp": return pageUp.has(data);
				case "tui.select.pageDown": return pageDown.has(data);
				case "tui.altScreen.pageUp": return pageUp.has(data);
				case "tui.altScreen.pageDown": return pageDown.has(data);
				case "tui.altScreen.top": return home.has(data);
				case "tui.altScreen.bottom": return end.has(data);
				default: return false;
			}
		},
	};
}

export function freshCtx(mode = "tui", model?: { provider: string; id?: string; name?: string; baseUrl?: string }, opts: { authApiKey?: string; authError?: boolean; selectId?: string; confirm?: boolean } = {}) {
	const log = {
		status: [] as Array<{ key: string; text: string | undefined }>,
		notifications: [] as Array<{ message: string; level: string }>,
		customCalls: 0,
		overlay: null as OverlayArtifact | null,
		stdout: [] as string[],
		selectCalls: [] as Array<{ message: string; options: Array<{ id: string; label: string }> }>,
		confirmCalls: [] as Array<{ message: string }>,
	};
	const signal = new AbortController().signal;
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model,
		signal,
		modelRegistry: {
			getProviderAuth: async () => {
				if (opts.authError) throw new Error("registry boom");
				return opts.authApiKey === undefined ? undefined : { auth: { apiKey: opts.authApiKey } };
			},
		},
		ui: {
			setStatus: (key: string, text?: string) => {
				log.status.push({ key, text });
			},
			notify: (message: string, level: string) => {
				log.notifications.push({ message, level });
			},
			theme: identityTheme,
			custom: async (
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => unknown,
				options?: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } },
			) => {
				log.customCalls += 1;
				const artifact: OverlayArtifact = {
					component: null,
					options: options ?? null,
					doneCalls: 0,
					rows: 24,
				};
				log.overlay = artifact;
				const done = (value: unknown) => {
					void value;
					artifact.doneCalls += 1;
				};
				const component = factory({ terminal: { rows: artifact.rows } }, ctx.ui.theme, stubKb(), done) as OverlayArtifact["component"];
				artifact.component = component;
				return undefined;
			},
			select: async (o: { message: string; options: Array<{ id: string; label: string; description?: string }> }) => {
				log.selectCalls.push({ message: o.message, options: o.options.map((x) => ({ id: x.id, label: x.label })) });
				return opts.selectId === undefined ? undefined : { id: opts.selectId };
			},
			confirm: async (o: { message: string }) => {
				log.confirmCalls.push({ message: o.message });
				return opts.confirm ?? false;
			},
		},
	};
	return { ctx, log, signal };
}

export function invokeOverlay(log: ReturnType<typeof freshCtx>["log"], width?: number): string[] {
	const comp = log.overlay?.component;
	if (!comp) throw new Error("no overlay captured");
	return comp.render(width ?? 80);
}

export function press(log: ReturnType<typeof freshCtx>["log"], data: string): void {
	const comp = log.overlay?.component;
	if (!comp) throw new Error("no overlay captured");
	comp.handleInput(data);
}

export function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
	const requests: Array<{ url: string; headers: Record<string, string>; fetchInit?: RequestInit }> = [];
	let cursor = 0;
	const fn = (url: string | URL, init?: RequestInit) => {
		requests.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, fetchInit: init });
		const next = responses[Math.min(cursor, responses.length - 1)];
		cursor += 1;
		return Promise.resolve(
			new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
				status: next.status,
				headers: next.headers ?? { "content-type": "application/json" },
			}),
		);
	};
	return { fetch: fn as typeof fetch, requests };
}
