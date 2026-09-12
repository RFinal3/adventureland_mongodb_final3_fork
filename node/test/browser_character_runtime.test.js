"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.resolve(__dirname, "../../mcp_api.js"), "utf8");

function fixture(options = {}) {
	const listeners = {};
	const emitted = [];
	const timers = new Map();
	let disconnected = false;
	let connections = 0;
	let timerId = 0;
	const owner = {};
	const character = {
		online: true,
		server: "USV",
		info: { name: "Laminakor", secret: "test_secret_1234567890", x: -999 },
	};
	const socket = {
		on(event, handler) {
			listeners[event] = handler;
		},
		emit(event, data) {
			emitted.push([event, data]);
		},
		removeAllListeners() {
			Object.keys(listeners).forEach((key) => delete listeners[key]);
		},
		disconnect() {
			disconnected = true;
		},
	};
	const api = new Function(
		"app",
		"admin_bots_owned_character",
		"mainframe_get_assignment",
		"mainframe_resolve_server",
		"setTimeout",
		"clearTimeout",
		source +
			"\nreturn { runtime: mcp_api_browser_get_character_runtime, status: mcp_api_browser_code_status, relay: mcp_api_comm_relay, sanitize: mcp_api_browser_runtime_observation, tools: mcp_tools, validate: validate_mcp_api_args, ref: MCP_API_REF, setIO: function(io) { MCP_COMM_RELAY_IO = io; } };",
	)(
		{ get() {}, post() {} },
		async (user, name) => {
			assert.equal(user, owner);
			assert.equal(name, "Laminakor");
			return options.missing ? null : Object.assign(character, options.character);
		},
		async () => options.assignment || null,
		async () => (options.server === false ? null : { label: "US V", url: "https://adventure.land", path: "/test/" }),
		(fn) => {
			const id = ++timerId;
			timers.set(id, fn);
			return id;
		},
		(id) => timers.delete(id),
	);
	api.setIO(() => {
		connections++;
		return socket;
	});
	return {
		api,
		listeners,
		emitted,
		timers,
		args: { user: owner, character: "Laminakor" },
		connections: () => connections,
		disconnected: () => disconnected,
		async ready() {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		},
	};
}

test("runtime tool is registered as read-only with a strict character schema", () => {
	const f = fixture();
	const tool = f.api.tools().find((entry) => entry.name === "browser_get_character_runtime");
	assert.equal(tool.annotations.readOnlyHint, true);
	assert.equal(tool.annotations.destructiveHint, false);
	assert.deepEqual(tool.inputSchema.required, ["character"]);
	assert.equal(tool.inputSchema.additionalProperties, false);
	assert.ok(f.api.validate(f.api.ref.browser_get_character_runtime, {}));
	assert.ok(f.api.validate(f.api.ref.browser_get_character_runtime, { character: "Laminakor", code: "attack()" }));
});

test("fresh welcome state is sanitized and reads emit no application events", async () => {
	const f = fixture();
	const pending = f.api.runtime(f.args);
	await f.ready();
	const packet = {
		name: "Laminakor",
		ctype: "warrior",
		level: 42,
		map: "main",
		x: 0,
		y: 120,
		hp: 0,
		max_hp: 100,
		mp: 20,
		max_mp: 30,
		rip: "gravestone",
		target: "snake42",
		party: "Laminakor",
		code: true,
		secret: "DO_NOT_EXPOSE",
		user: { gold: 123 },
		items: [{ name: "private" }],
		slots: {
			mainhand: { name: "blade", level: 3, stat_type: "str", p: "shiny", private_note: "DO_NOT_EXPOSE" },
			trade1: { name: "shopitem" },
		},
	};
	f.listeners.welcome({ character: packet, x: 999, y: 999 });
	const result = await pending;
	assert.equal(result.server, "US V");
	assert.equal(result.code_running, true);
	assert.equal(result.observation.x, 0);
	assert.equal(result.observation.y, 120);
	assert.equal(result.observation.hp, 0);
	assert.equal(result.observation.rip, true);
	assert.equal(result.observation.class, "warrior");
	assert.equal(result.observation.party_roster, null);
	assert.equal(result.observation.source, "authenticated_game_server_welcome");
	assert.ok(Number.isFinite(Date.parse(result.observation.observed_at)));
	assert.deepEqual(result.observation.equipment, {
		mainhand: { name: "blade", level: 3, stat_type: "str", p: "shiny" },
	});
	assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|private_note|shopitem|test_secret|items|user/);
	assert.deepEqual(f.emitted, []);
	assert.equal(f.disconnected(), true);
	assert.equal(f.timers.size, 0);
	assert.equal(Object.keys(f.listeners).length, 0);
	assert.equal(packet.secret, "DO_NOT_EXPOSE");
});

test("malformed or absent fields do not leak nested objects or fabricated values", () => {
	const f = fixture();
	const result = f.api.sanitize({ hp: "100", x: Infinity, y: NaN, target: { secret: "hidden" }, slots: [], rip: {} });
	for (const key of ["hp", "x", "y", "target", "equipment", "rip", "map", "class"]) assert.equal(result[key], null);
	assert.equal(f.api.sanitize({ rip: false, target: 0 }).rip, false);
	assert.equal(f.api.sanitize({ target: 0 }).target, 0);
});

test("ownership, Mainframe assignment, offline and server failures open no socket", async () => {
	for (const [options, reason] of [
		[{ missing: true }, "character_not_found"],
		[{ assignment: { desired_state: "running" } }, "runtime_mismatch"],
		[{ character: { online: false } }, "character_offline"],
		[{ server: false }, "server_unavailable"],
	]) {
		const f = fixture(options);
		assert.equal((await f.api.runtime(f.args)).reason, reason);
		assert.equal(f.connections(), 0);
	}
});

test("mismatched and missing welcome identities are refused", async () => {
	for (const data of [{}, { character: { name: "SomeoneElse" } }]) {
		const f = fixture();
		const pending = f.api.runtime(f.args);
		await f.ready();
		f.listeners.welcome(data);
		assert.equal((await pending).reason, "browser_session_unavailable");
		assert.equal(f.disconnected(), true);
		assert.deepEqual(f.emitted, []);
	}
});

test("relay failure paths clean up without returning an observation", async () => {
	for (const [event, reason] of [
		["connect_error", "comm_unavailable"],
		["disconnect", "comm_disconnected"],
		["timeout", "comm_timeout"],
	]) {
		const f = fixture();
		const pending = f.api.runtime(f.args);
		await f.ready();
		if (event === "timeout") Array.from(f.timers.values())[0]();
		else f.listeners[event]();
		const result = await pending;
		assert.equal(result.reason, reason);
		assert.equal(result.observation, undefined);
		assert.equal(f.timers.size, 0);
		assert.equal(f.disconnected(), true);
		assert.deepEqual(f.emitted, []);
	}
});

test("existing status response and offline behavior remain unchanged", async () => {
	const f = fixture();
	const pending = f.api.status(f.args);
	await f.ready();
	f.listeners.welcome({ character: { name: "Laminakor", code: true, x: 123 } });
	assert.deepEqual(await pending, {
		success: true,
		character: "Laminakor",
		runtime: "browser",
		server: "US V",
		online: true,
		code_running: true,
	});
	const offline = fixture({ character: { online: false } });
	assert.deepEqual(await offline.api.status(offline.args), {
		success: true,
		character: "Laminakor",
		runtime: "browser",
		online: false,
		code_running: false,
	});
});

test("existing command relay still waits for entities and queues its command", async () => {
	const f = fixture();
	const pending = f.api.relay(
		{ character: "Laminakor", runtime: "browser", server: "US V", secret: "fake" },
		"example_command",
	);
	f.listeners.welcome({ character: { name: "Laminakor", code: true } });
	f.listeners.entities();
	f.listeners.entities();
	assert.deepEqual(
		f.emitted.map((entry) => entry[0]),
		["loaded", "o:command"],
	);
	Array.from(f.timers.values()).at(-1)();
	const result = await pending;
	assert.equal(result.queued, true);
	assert.equal(result.code_running_before, true);
	assert.equal(result.observation, undefined);
});
