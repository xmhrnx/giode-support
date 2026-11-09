// The Giode support relay: a Cloudflare Worker that turns the problem
// reports apps send with giode/support into GitHub issues, so users need
// no GitHub account and the GitHub token stays here, never in an app.
// See README.md to deploy it.
//
// Settings (wrangler.toml [vars] and secrets):
//   APPS          JSON: app name (support.Options.App) to "owner/repo".
//   GITHUB_TOKEN  secret: a fine-grained token with Issues read and write
//                 on those repositories.
//   ADMIN_TOKEN   secret: what reading a reporter's email takes.
//   KEY           optional secret: the key apps must send
//                 (support.Options.Key).
//   LABELS        optional, comma-separated: labels for every report;
//                 default "user report".
//   PER_HOUR, PER_DAY  optional: reports one address may send; 5 and 20.
// Binding: SUPPORT, a KV namespace for the rate limits and the emails.

const LIMITS = { title: 120, description: 20000, attachment: 30000, email: 254 };
const EMAIL_DAYS = 365;
const OS_NAMES = { darwin: "macOS", ios: "iOS", windows: "Windows", linux: "Linux", android: "Android", freebsd: "FreeBSD", openbsd: "OpenBSD" };

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/report" && request.method === "POST") {
				return await report(request, env);
			}
			if (url.pathname === "/contact" && request.method === "GET") {
				return await contact(request, url, env);
			}
			if (url.pathname === "/" && request.method === "GET") {
				return json({ ok: true });
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			console.error(e && e.stack ? e.stack : e);
			return json({ error: "the relay failed; try again later" }, 500);
		}
	},
};

async function report(request, env) {
	if (env.KEY && request.headers.get("X-Support-Key") !== env.KEY) {
		return json({ error: "this app isn't allowed to send reports" }, 403);
	}
	const length = Number(request.headers.get("Content-Length") || 0);
	if (length > 200000) {
		return json({ error: "the report is too large" }, 413);
	}
	let r;
	try {
		r = await request.json();
	} catch {
		return json({ error: "the report isn't valid JSON" }, 400);
	}
	const apps = parseApps(env.APPS);
	const repo = typeof r.app === "string" ? apps[r.app] : undefined;
	if (!repo) {
		return json({ error: "unknown app" }, 400);
	}
	const title = clean(r.title).trim();
	if (!title || title.length > LIMITS.title) {
		return json({ error: "the summary must be 1 to 120 characters" }, 400);
	}
	if (clean(r.description).length > LIMITS.description) {
		return json({ error: "the description is too long" }, 400);
	}
	const email = clean(r.email).trim();
	if (email && (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
		return json({ error: "the email address isn't valid" }, 400);
	}

	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	const limited = await rateLimit(env, ip);
	if (limited) {
		return json({ error: limited }, 429);
	}

	const labels = (env.LABELS || "user report").split(",").map((l) => l.trim()).filter(Boolean);
	if (r.crash) {
		labels.push("crash");
	}
	const fields = { title: `[Report] ${title}`, body: issueBody(r, Boolean(email)) };
	let issue;
	try {
		issue = await github(env, `repos/${repo}/issues`, { ...fields, labels });
	} catch (e) {
		// Labels the token can't apply: send the report without them.
		if (e.status !== 422 && e.status !== 403) {
			throw e;
		}
		issue = await github(env, `repos/${repo}/issues`, fields);
	}
	if (email) {
		await env.SUPPORT.put(`email:${repo}#${issue.number}`, email, { expirationTtl: EMAIL_DAYS * 86400 });
	}
	return json({ url: issue.html_url, number: issue.number }, 201);
}

// contact returns the email a report's sender left:
// GET /contact?repo=owner/repo&issue=12 with Authorization: Bearer ADMIN_TOKEN.
async function contact(request, url, env) {
	if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
		return json({ error: "unauthorized" }, 401);
	}
	const repo = url.searchParams.get("repo");
	const issue = url.searchParams.get("issue");
	const email = repo && issue ? await env.SUPPORT.get(`email:${repo}#${issue}`) : null;
	return email ? json({ email }) : json({ error: "no email for that report" }, 404);
}

// rateLimit counts a report from ip and returns why it's turned away, or
// "" when it's within the limits.
async function rateLimit(env, ip) {
	const now = Date.now();
	const hour = `rate:h:${ip}:${Math.floor(now / 3600000)}`;
	const day = `rate:d:${ip}:${Math.floor(now / 86400000)}`;
	const [h, d] = await Promise.all([env.SUPPORT.get(hour), env.SUPPORT.get(day)]);
	if (Number(h || 0) >= Number(env.PER_HOUR || 5) || Number(d || 0) >= Number(env.PER_DAY || 20)) {
		return "too many reports from this network; try again later";
	}
	await Promise.all([
		env.SUPPORT.put(hour, String(Number(h || 0) + 1), { expirationTtl: 3700 }),
		env.SUPPORT.put(day, String(Number(d || 0) + 1), { expirationTtl: 90000 }),
	]);
	return "";
}

function issueBody(r, hasEmail) {
	const parts = [];
	const description = quiet(clean(r.description).trim());
	parts.push(description || "_No details given._");

	const rows = [
		["App version", [r.version, r.build && `(${r.build})`].filter(Boolean).join(" ")],
		["System", [OS_NAMES[r.os] || r.os, r.os_version].filter(Boolean).join(" ")],
		["CPU", r.arch],
		["Device", r.model],
		["Locale", r.locale],
	].filter(([, v]) => v);
	if (rows.length) {
		parts.push("| | |\n| --- | --- |\n" + rows.map(([k, v]) => `| ${k} | ${cell(v)} |`).join("\n"));
	}
	if (r.crash) {
		parts.push(details("Crash", clean(r.crash).slice(-LIMITS.attachment)));
	}
	if (r.logs) {
		parts.push(details("Logs", clean(r.logs).slice(-LIMITS.attachment)));
	}
	parts.push(
		"<sub>Sent from the app" +
			(hasEmail ? "; the reporter left an email for replies (see the relay's /contact)." : ".") +
			"</sub>",
	);
	return parts.join("\n\n");
}

// details folds long text into a collapsed code block, fenced with more
// backticks than the text has in a row.
function details(summary, text) {
	const runs = text.match(/`+/g) || [];
	const fence = "`".repeat(Math.max(3, ...runs.map((s) => s.length + 1)));
	return `<details><summary>${summary}</summary>\n\n${fence}\n${text}\n${fence}\n\n</details>`;
}

// quiet keeps text from mentioning people or linking issues: a report
// is written by anyone.
function quiet(s) {
	return s.replace(/@(?=[A-Za-z0-9-])/g, "@​").replace(/#(?=\d)/g, "#​");
}

function cell(v) {
	return quiet(clean(String(v))).replace(/[|\n\r]/g, " ").slice(0, 200);
}

function clean(v) {
	// No NULs or other control characters but tabs and newlines.
	return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "") : "";
}

function parseApps(s) {
	try {
		const apps = JSON.parse(s || "{}");
		return apps && typeof apps === "object" ? apps : {};
	} catch {
		return {};
	}
}

async function github(env, path, body) {
	const resp = await fetch(`https://api.github.com/${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "giode-support-relay",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		const e = new Error(`GitHub ${path}: ${resp.status} ${await resp.text()}`);
		e.status = resp.status;
		throw e;
	}
	return resp.json();
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export const _test = { issueBody, quiet, details };
