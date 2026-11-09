// Run with: node --test support/relay/worker.test.mjs (or npm test there).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { _test } from "./worker.js";

function kv() {
	const m = new Map();
	return {
		m,
		async get(k) { return m.has(k) ? m.get(k) : null; },
		async put(k, v) { m.set(k, v); },
	};
}

function env(extra = {}) {
	return { APPS: JSON.stringify({ sonora: "xmhrnx/sonora" }), GITHUB_TOKEN: "t", ADMIN_TOKEN: "admin", SUPPORT: kv(), ...extra };
}

function post(body, headers = {}) {
	return new Request("https://relay.example/report", {
		method: "POST",
		headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4", ...headers },
		body: JSON.stringify(body),
	});
}

function mockGitHub(handler) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, body, headers: init.headers });
		return handler(url, body, calls.length);
	};
	return calls;
}

const created = () => new Response(JSON.stringify({ number: 7, html_url: "https://github.com/xmhrnx/sonora/issues/7" }), { status: 201 });

test("a report becomes an issue, without the email", async () => {
	const calls = mockGitHub(created);
	const e = env();
	const resp = await worker.fetch(post({
		app: "sonora", title: "Crash when exporting", description: "It crashed, cc @someone see #12",
		email: "me@example.com", version: "1.1.0", build: "12", os: "darwin", os_version: "14.5", arch: "arm64",
		crash: "panic: boom\n```\ngoroutine 1",
	}), e);
	assert.equal(resp.status, 201);
	assert.deepEqual(await resp.json(), { url: "https://github.com/xmhrnx/sonora/issues/7", number: 7 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.github.com/repos/xmhrnx/sonora/issues");
	assert.equal(calls[0].body.title, "[Report] Crash when exporting");
	assert.deepEqual(calls[0].body.labels, ["user report", "crash"]);
	const body = calls[0].body.body;
	assert.ok(!body.includes("me@example.com"), "the email is in the issue");
	assert.ok(body.includes("@​someone") && body.includes("#​12"), "mentions aren't neutralised");
	assert.ok(body.includes("| App version | 1.1.0 (12) |"));
	assert.ok(body.includes("| System | macOS 14.5 |"));
	assert.ok(body.includes("````\npanic: boom"), "the crash isn't fenced past its own backticks");
	assert.equal(await e.SUPPORT.get("email:xmhrnx/sonora#7"), "me@example.com");

	const who = await worker.fetch(new Request("https://relay.example/contact?repo=xmhrnx/sonora&issue=7", { headers: { Authorization: "Bearer admin" } }), e);
	assert.deepEqual(await who.json(), { email: "me@example.com" });
	const nobody = await worker.fetch(new Request("https://relay.example/contact?repo=xmhrnx/sonora&issue=7"), e);
	assert.equal(nobody.status, 401);
});

test("bad reports are turned away", async () => {
	const calls = mockGitHub(created);
	const e = env({ KEY: "k" });
	assert.equal((await worker.fetch(post({ app: "sonora", title: "x" }), e)).status, 403);
	assert.equal((await worker.fetch(post({ app: "other", title: "x" }, { "X-Support-Key": "k" }), e)).status, 400);
	assert.equal((await worker.fetch(post({ app: "sonora", title: "" }, { "X-Support-Key": "k" }), e)).status, 400);
	assert.equal((await worker.fetch(post({ app: "sonora", title: "x".repeat(121) }, { "X-Support-Key": "k" }), e)).status, 400);
	assert.equal((await worker.fetch(post({ app: "sonora", title: "x", email: "nope" }, { "X-Support-Key": "k" }), e)).status, 400);
	assert.equal(calls.length, 0);
});

test("one network sends at most PER_HOUR reports an hour", async () => {
	mockGitHub(created);
	const e = env({ PER_HOUR: "2" });
	const statuses = [];
	for (let i = 0; i < 3; i++) {
		statuses.push((await worker.fetch(post({ app: "sonora", title: "x" }), e)).status);
	}
	assert.deepEqual(statuses, [201, 201, 429]);
});

test("labels the token can't apply are dropped", async () => {
	const calls = mockGitHub((url, body) => body.labels ? new Response("{}", { status: 422 }) : created());
	const resp = await worker.fetch(post({ app: "sonora", title: "x" }), env());
	assert.equal(resp.status, 201);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].body.labels, undefined);
});
