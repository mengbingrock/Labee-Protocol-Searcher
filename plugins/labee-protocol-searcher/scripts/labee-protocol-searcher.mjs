#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir, hostname } from "node:os";
import dns, { lookup, reverse } from "node:dns/promises";
import net, { isIP } from "node:net";
import https from "node:https";
import tls from "node:tls";
import { execFile } from "node:child_process";

//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* @__PURE__ */ createRequire(import.meta.url);

//#endregion
//#region src/env.ts
function applyEnvFile(path) {
	let content;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return;
	}
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (!key || key in process.env) continue;
		let val = line.slice(eq + 1).trim();
		if (val.startsWith("\"") && val.endsWith("\"") || val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
		process.env[key] = val;
	}
}
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of [packageRoot, process.cwd()]) for (const name of [".env", ".env.local"]) applyEnvFile(resolve(dir, name));

//#endregion
//#region src/providers/types.ts
const USER_AGENTS = [
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0"
];
function userAgent(seed) {
	return USER_AGENTS[Math.abs(seed) % USER_AGENTS.length];
}
const sleep$1 = (ms) => new Promise((r) => setTimeout(r, ms));
/** fetch with an AbortController timeout. Resolves the Response or throws. */
async function fetchWithTimeout(doFetch, url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await doFetch(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}
/** HTTP statuses worth retrying: rate-limited and transient server errors.
*  (NCBI's eutils flap with 500s, so 500 is included.) */
const RETRYABLE_STATUS = new Set([
	429,
	500,
	502,
	503,
	504
]);
/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to ms, capped. */
function retryAfterMs(header) {
	if (!header) return null;
	const secs = Number(header);
	if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1e3, 3e4);
	const when = Date.parse(header);
	if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 3e4);
	return null;
}
/** Exponential backoff with ±25% full jitter. */
function backoffMs(base, max, attempt) {
	const raw = Math.min(base * 2 ** attempt, max);
	return Math.round(raw * (.75 + .5 * Math.random()));
}
/**
* `fetchWithTimeout` plus retry-with-backoff on transient failures (HTTP 429 /
* 5xx and network/timeout errors), honouring `Retry-After`. Retrying the same
* endpoint on a transient blip avoids needlessly falling through to a
* lower-priority provider. Non-retryable responses (2xx, 4xx≠429) return
* immediately. Throws the last error only if every attempt failed to connect.
*/
async function fetchWithRetry(doFetch, url, init, timeoutMs, retry = {}) {
	const retries = retry.retries ?? 2;
	const base = retry.baseDelayMs ?? 400;
	const max = retry.maxDelayMs ?? 4e3;
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) try {
		const res = await fetchWithTimeout(doFetch, url, init, timeoutMs);
		if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) return res;
		await sleep$1(retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(base, max, attempt));
	} catch (err) {
		lastErr = err;
		if (attempt === retries) throw err;
		await sleep$1(backoffMs(base, max, attempt));
	}
	throw lastErr ?? /* @__PURE__ */ new Error("fetch failed after retries");
}
const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	nbsp: " ",
	deg: "°",
	micro: "µ",
	times: "×",
	plusmn: "±",
	ndash: "–",
	mdash: "—",
	minus: "−",
	hellip: "…",
	rsquo: "'",
	lsquo: "'",
	rdquo: "”",
	ldquo: "“"
};
function decodeEntities(s) {
	return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}
function stripTags(s) {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

//#endregion
//#region src/providers/brave.ts
const DEFAULT_ENDPOINT$2 = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS$6 = 9e3;
function apiKey() {
	return process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || void 0;
}
/** Endpoint override for self-hosted gateways / enterprise proxies / testing. */
function endpoint$1() {
	return process.env.BRAVE_API_ENDPOINT || DEFAULT_ENDPOINT$2;
}
const braveProvider = {
	id: "brave",
	available: () => Boolean(apiKey()),
	async run(query, limit, opts = {}) {
		const key = apiKey();
		if (!key) return {
			results: [],
			status: 0,
			error: "BRAVE_API_KEY not set"
		};
		const doFetch = opts.fetchImpl ?? fetch;
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$6;
		const url = `${endpoint$1()}?q=${encodeURIComponent(query)}&count=${Math.min(20, Math.max(1, limit))}&country=us&search_lang=en`;
		try {
			const res = await fetchWithTimeout(doFetch, url, { headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": key
			} }, timeoutMs);
			const text = await res.text();
			if (res.status !== 200) return {
				results: [],
				status: res.status,
				error: `Brave API HTTP ${res.status}`
			};
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				return {
					results: [],
					status: res.status,
					error: "Brave API returned non-JSON"
				};
			}
			const results = (json.web?.results ?? []).filter((r) => r.url && r.title).slice(0, limit).map((r) => ({
				title: stripTags(r.title),
				url: r.url,
				snippet: stripTags(r.description ?? "")
			}));
			return results.length > 0 ? {
				results,
				status: res.status
			} : {
				results: [],
				status: res.status,
				error: "Brave API returned no results"
			};
		} catch (err) {
			return {
				results: [],
				status: 0,
				error: err instanceof Error && err.name === "AbortError" ? `Brave API timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : "Brave API request failed"
			};
		}
	}
};

//#endregion
//#region src/providers/google.ts
const DEFAULT_ENDPOINT$1 = "https://www.googleapis.com/customsearch/v1";
const DEFAULT_TIMEOUT_MS$5 = 9e3;
function creds() {
	const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_CSE_KEY;
	const cx = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_CSE_ID;
	return key && cx ? {
		key,
		cx
	} : void 0;
}
/** Endpoint override for self-hosted gateways / enterprise proxies / testing. */
function endpoint() {
	return process.env.GOOGLE_API_ENDPOINT || DEFAULT_ENDPOINT$1;
}
const googleProvider = {
	id: "google",
	available: () => Boolean(creds()),
	async run(query, limit, opts = {}) {
		const c = creds();
		if (!c) return {
			results: [],
			status: 0,
			error: "GOOGLE_API_KEY/GOOGLE_CSE_CX not set"
		};
		const doFetch = opts.fetchImpl ?? fetch;
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$5;
		const url = `${endpoint()}?key=${encodeURIComponent(c.key)}&cx=${encodeURIComponent(c.cx)}&q=${encodeURIComponent(query)}&num=${Math.min(10, Math.max(1, limit))}`;
		try {
			const res = await fetchWithTimeout(doFetch, url, { headers: { Accept: "application/json" } }, timeoutMs);
			const text = await res.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				return {
					results: [],
					status: res.status,
					error: "Google API returned non-JSON"
				};
			}
			if (res.status !== 200) return {
				results: [],
				status: res.status,
				error: json.error?.message ?? `Google API HTTP ${res.status}`
			};
			const results = (json.items ?? []).filter((r) => r.link && r.title).slice(0, limit).map((r) => ({
				title: stripTags(r.title),
				url: r.link,
				snippet: stripTags(r.snippet ?? "")
			}));
			return results.length > 0 ? {
				results,
				status: res.status
			} : {
				results: [],
				status: res.status,
				error: "Google API returned no results"
			};
		} catch (err) {
			return {
				results: [],
				status: 0,
				error: err instanceof Error && err.name === "AbortError" ? `Google API timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : "Google API request failed"
			};
		}
	}
};

//#endregion
//#region src/providers/registry.ts
const ALL = [braveProvider, googleProvider];
/** Shown wherever an unkeyed install would otherwise just report "no results". */
const NO_PROVIDER_CONFIGURED = "no web-search provider is configured — set BRAVE_API_KEY, or GOOGLE_API_KEY with GOOGLE_CSE_CX";
/** The active providers, highest priority first. */
function activeProviders() {
	const pin = process.env.PROTOCOLS_SEARCH_PROVIDER?.trim().toLowerCase();
	if (pin) {
		const chosen = ALL.find((p) => p.id === pin);
		if (chosen) return [chosen];
	}
	return ALL.filter((p) => p.available());
}
/** Ids of every known provider and whether each is currently usable. */
function providerStatus() {
	return ALL.map((p) => ({
		id: p.id,
		available: p.available()
	}));
}
function resultKey$1(result) {
	try {
		const url = new URL(result.url);
		return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
	} catch {
		return `${result.title.toLowerCase()}|${result.url.toLowerCase()}`;
	}
}
/**
* Run `query` through every active provider, merging unique results and
* retaining per-backend coverage. Explicit provider pinning still limits the set.
*/
async function webSearch(query, limit, opts) {
	const providers = activeProviders();
	const attempts = [];
	const errors = [];
	const merged = /* @__PURE__ */ new Map();
	if (providers.length === 0) return {
		results: [],
		provider: "none",
		providers: ALL.map((p) => ({
			id: p.id,
			status: "unavailable",
			count: 0,
			elapsedMs: 0
		})),
		error: NO_PROVIDER_CONFIGURED
	};
	if (!process.env.PROTOCOLS_SEARCH_PROVIDER?.trim().toLowerCase()) {
		for (const provider of ALL) if (!provider.available()) attempts.push({
			id: provider.id,
			status: "unavailable",
			count: 0,
			elapsedMs: 0
		});
	}
	for (const provider of providers) {
		const started = Date.now();
		try {
			const res = await provider.run(query, limit, opts);
			const status = res.results.length > 0 ? "ok" : res.error ? "error" : "empty";
			attempts.push({
				id: provider.id,
				status,
				count: res.results.length,
				elapsedMs: Date.now() - started,
				...res.error ? { error: res.error } : {}
			});
			if (res.results.length === 0) errors.push(`${provider.id}: ${res.error ?? "no results"}`);
			for (const result of res.results) {
				const key = resultKey$1(result);
				const current = merged.get(key);
				if (!current) merged.set(key, result);
				else if (!current.snippet && result.snippet) merged.set(key, {
					...current,
					snippet: result.snippet
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "failed";
			errors.push(`${provider.id}: ${message}`);
			attempts.push({
				id: provider.id,
				status: "error",
				count: 0,
				elapsedMs: Date.now() - started,
				error: message
			});
		}
	}
	const successful = attempts.filter((attempt) => attempt.status === "ok").map((attempt) => attempt.id);
	return {
		results: [...merged.values()],
		provider: successful.join("+") || providers.at(-1)?.id || "none",
		providers: attempts,
		...errors.length > 0 ? { error: errors.join("; ") } : {}
	};
}

//#endregion
//#region src/journals.ts
const DEFAULT_TIMEOUT_MS$4 = 9e3;
const CONTACT = process.env.PROTOCOLS_CONTACT_EMAIL || "labee-protocol-searcher@example.com";
/**
* Titles and abstracts arrive as publisher markup, and some sources escape it:
* Crossref returns `&lt;i&gt;Synechocystis&lt;/i&gt;`, not `<i>…</i>`.
*
* `stripTags` strips tags and *then* decodes entities, so one pass over an
* escaped title only turns it into a tag-bearing one. A second pass removes
* those. Two is enough — nothing here is escaped three deep — and the pass is
* safe for a bare `&lt;` (the tag regex needs a closing `>` to match).
*/
function text(raw) {
	return raw ? stripTags(stripTags(raw)) : "";
}
/** `text`, capped for use as a result snippet. */
function clean(raw) {
	const t = text(raw);
	if (t.length <= 300) return t;
	const cut = t.slice(0, 300);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
function doiUrl(doi) {
	if (!doi) return "";
	if (doi.startsWith("http")) return doi;
	return `https://doi.org/${doi.replace(/^doi:/i, "")}`;
}
/** Reconstruct plain text from OpenAlex's abstract_inverted_index. */
function fromInvertedIndex(inv) {
	if (!inv) return "";
	const words = [];
	for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
	return clean(words.join(" "));
}
const crossref = async (journal, query, limit, opts) => {
	const res = await fetchWithRetry(opts.fetchImpl ?? fetch, `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=container-title:${encodeURIComponent(journal.crossrefContainer)}&rows=${limit}&select=title,DOI,URL,abstract&sort=relevance&mailto=${encodeURIComponent(CONTACT)}`, { headers: {
		Accept: "application/json",
		"User-Agent": `labee-protocol-searcher (mailto:${CONTACT})`
	} }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$4);
	if (res.status !== 200) throw new Error(`Crossref HTTP ${res.status}`);
	return ((await res.json()).message?.items ?? []).map((it) => ({
		title: text(it.title?.[0]),
		url: it.URL ?? doiUrl(it.DOI),
		snippet: clean(it.abstract)
	})).filter((r) => r.title && r.url).slice(0, limit);
};
const europepmc = async (journal, query, limit, opts) => {
	const doFetch = opts.fetchImpl ?? fetch;
	const q = `${query} AND JOURNAL:"${journal.europepmcJournal}"`;
	const res = await fetchWithRetry(doFetch, `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=${limit}&resultType=lite`, { headers: { Accept: "application/json" } }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$4);
	if (res.status !== 200) throw new Error(`Europe PMC HTTP ${res.status}`);
	return ((await res.json()).resultList?.result ?? []).map((r) => {
		const evidence = [];
		if (r.pmcid) evidence.push(`europepmc:pmcid:${r.pmcid.toUpperCase()}`);
		if (/^(?:y|yes|true|1)$/i.test(r.isOpenAccess ?? "")) evidence.push("europepmc:open-access");
		if (/^(?:y|yes|true|1)$/i.test(r.inEPMC ?? "")) evidence.push("europepmc:fulltext-indexed");
		return {
			title: text(r.title),
			url: r.doi ? doiUrl(r.doi) : r.id ? `https://europepmc.org/article/MED/${r.id}` : "",
			snippet: clean(r.abstractText),
			...evidence.length > 0 ? { oaEvidence: evidence } : {}
		};
	}).filter((r) => r.title && r.url).slice(0, limit);
};
const openalex = async (journal, query, limit, opts) => {
	const doFetch = opts.fetchImpl ?? fetch;
	const issnFilter = journal.issn.join("|");
	const res = await fetchWithRetry(doFetch, `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=primary_location.source.issn:${encodeURIComponent(issnFilter)}&per_page=${limit}&mailto=${encodeURIComponent(CONTACT)}`, { headers: {
		Accept: "application/json",
		"User-Agent": `labee-protocol-searcher (mailto:${CONTACT})`
	} }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$4);
	if (res.status !== 200) throw new Error(`OpenAlex HTTP ${res.status}`);
	return ((await res.json()).results ?? []).map((w) => {
		const evidence = [];
		if (w.open_access?.is_oa || w.best_oa_location?.is_oa) evidence.push("openalex:open-access");
		const oaUrl = w.best_oa_location?.pdf_url ?? w.best_oa_location?.landing_page_url;
		if (oaUrl) evidence.push(`openalex:oa-url:${oaUrl}`);
		return {
			title: text(w.display_name),
			url: doiUrl(w.doi) || w.id || "",
			snippet: fromInvertedIndex(w.abstract_inverted_index),
			...evidence.length > 0 ? { oaEvidence: evidence } : {}
		};
	}).filter((r) => r.title && r.url).slice(0, limit);
};
const semanticscholar = async (journal, query, limit, opts) => {
	const doFetch = opts.fetchImpl ?? fetch;
	const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&venue=${encodeURIComponent(journal.crossrefContainer)}&fields=title,externalIds,url,abstract,openAccessPdf&limit=${limit}`;
	const headers = { Accept: "application/json" };
	const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
	if (key) headers["x-api-key"] = key;
	const res = await fetchWithRetry(doFetch, url, { headers }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$4, { retries: key ? 2 : 0 });
	if (res.status !== 200) throw new Error(`Semantic Scholar HTTP ${res.status}`);
	return ((await res.json()).data ?? []).map((w) => {
		const evidence = w.openAccessPdf?.url ? [`semanticscholar:open-access-pdf:${w.openAccessPdf.url}`] : [];
		return {
			title: text(w.title),
			url: doiUrl(w.externalIds?.DOI) || w.url || "",
			snippet: clean(w.abstract),
			...evidence.length > 0 ? { oaEvidence: evidence } : {}
		};
	}).filter((r) => r.title && r.url).slice(0, limit);
};
const pubmed = async (journal, query, limit, opts) => {
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$4;
	const keyParam = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : "";
	const common = `&tool=labee-protocol-searcher&email=${encodeURIComponent(CONTACT)}${keyParam}`;
	const term = `${query} AND "${journal.europepmcJournal}"[Journal]`;
	const sres = await fetchWithRetry(doFetch, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&term=${encodeURIComponent(term)}${common}`, { headers: { Accept: "application/json" } }, timeoutMs);
	if (sres.status !== 200) throw new Error(`PubMed esearch HTTP ${sres.status}`);
	const ids = (await sres.json()).esearchresult?.idlist ?? [];
	if (ids.length === 0) return [];
	const ures = await fetchWithRetry(doFetch, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}${common}`, { headers: { Accept: "application/json" } }, timeoutMs);
	if (ures.status !== 200) throw new Error(`PubMed esummary HTTP ${ures.status}`);
	const result = (await ures.json()).result ?? {};
	return ids.map((id) => {
		const it = result[id];
		if (!it) return null;
		const doi = (it.articleids ?? []).find((a) => a.idtype === "doi")?.value;
		const pmcid = (it.articleids ?? []).find((a) => a.idtype === "pmc")?.value;
		return {
			title: text(it.title).replace(/\.$/, ""),
			url: doi ? doiUrl(doi) : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
			snippet: "",
			...pmcid ? { oaEvidence: [`pubmed:pmcid:${pmcid.toUpperCase()}`] } : {}
		};
	}).filter((r) => Boolean(r && r.title && r.url)).slice(0, limit);
};
const PROVIDERS = {
	crossref,
	europepmc,
	openalex,
	semanticscholar,
	pubmed
};
const DEFAULT_ORDER = [
	"crossref",
	"europepmc",
	"openalex",
	"semanticscholar",
	"pubmed"
];
/** Active journal-provider ids, in priority order (PROTOCOLS_JOURNAL_PROVIDERS). */
function journalProviderOrder() {
	const raw = process.env.PROTOCOLS_JOURNAL_PROVIDERS?.trim();
	if (!raw) return DEFAULT_ORDER;
	const ids = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => PROVIDERS[s]);
	return ids.length > 0 ? ids : DEFAULT_ORDER;
}
function resultKey(result) {
	try {
		const url = new URL(result.url);
		if (url.hostname.toLowerCase() === "doi.org") return `doi:${decodeURIComponent(url.pathname).replace(/^\//, "").toLowerCase()}`;
		return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
	} catch {
		return `${result.title.toLowerCase()}|${result.url.toLowerCase()}`;
	}
}
/** Search every active scholarly API, merge unique results, and report coverage. */
async function searchJournal(journal, query, limit, opts = {}) {
	const errors = [];
	const providers = [];
	const merged = /* @__PURE__ */ new Map();
	const order = journalProviderOrder();
	for (const id of order) {
		const fn = PROVIDERS[id];
		const started = Date.now();
		try {
			const results = await fn(journal, query, limit, opts);
			providers.push({
				id,
				status: results.length > 0 ? "ok" : "empty",
				count: results.length,
				elapsedMs: Date.now() - started
			});
			if (results.length === 0) errors.push(`${id}: no results`);
			for (const result of results) {
				const key = resultKey(result);
				const current = merged.get(key);
				const discoveredBy = [...new Set([...current?.discoveredBy ?? [], id])];
				const oaEvidence = [...new Set([...current?.oaEvidence ?? [], ...result.oaEvidence ?? []])];
				if (!current) merged.set(key, {
					...result,
					discoveredBy,
					...oaEvidence.length > 0 ? { oaEvidence } : {}
				});
				else merged.set(key, {
					...current,
					...!current.snippet && result.snippet ? { snippet: result.snippet } : {},
					discoveredBy,
					...oaEvidence.length > 0 ? { oaEvidence } : {}
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "failed";
			errors.push(`${id}: ${message}`);
			providers.push({
				id,
				status: "error",
				count: 0,
				elapsedMs: Date.now() - started,
				error: message
			});
		}
	}
	const successful = providers.filter((provider) => provider.status === "ok").map((provider) => provider.id);
	return {
		results: [...merged.values()],
		source: successful.join("+") || order.at(-1) || "none",
		providers,
		...errors.length > 0 ? { error: errors.join("; ") } : {}
	};
}

//#endregion
//#region src/vendors.ts
const enc = encodeURIComponent;
const VENDORS = [
	{
		id: "star-protocols",
		name: "STAR Protocols (Cell Press)",
		blurb: "Peer-reviewed step-by-step life-science protocols.",
		kind: "journal",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "cell.com/star-protocols",
		journal: {
			crossrefContainer: "STAR Protocols",
			europepmcJournal: "STAR Protocols",
			issn: ["2666-1667"]
		},
		searchUrl: (q) => `https://www.cell.com/action/doSearch?type=quicksearch&text1=${enc(q)}&field1=AllField&journalCode=xpro&SeriesKey=xpro`,
		publisherResult: /^https?:\/\/(?:www\.)?cell\.com\/star-protocols\/fulltext\//i
	},
	{
		id: "nature-protocols",
		name: "Nature Protocols",
		blurb: "Peer-reviewed protocols across the life sciences.",
		kind: "journal",
		fetchability: "partial",
		publisherFetch: "abstract-only",
		searchSite: "nature.com/nprot",
		journal: {
			crossrefContainer: "Nature Protocols",
			europepmcJournal: "Nature Protocols",
			issn: ["1750-2799", "1754-2189"]
		},
		searchUrl: (q) => `https://www.nature.com/search?journal=nprot&q=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?nature\.com\/articles\//i
	},
	{
		id: "jove",
		name: "JoVE (Journal of Visualized Experiments)",
		blurb: "Peer-reviewed video protocols across the life sciences.",
		kind: "journal",
		fetchability: "partial",
		publisherFetch: "blocked",
		searchSite: "jove.com",
		journal: {
			crossrefContainer: "Journal of Visualized Experiments",
			europepmcJournal: "Journal of Visualized Experiments",
			issn: ["1940-087X"]
		},
		searchUrl: (q) => `https://www.jove.com/search?query=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?jove\.com\/(?:t|v)\//i
	},
	{
		id: "bio-protocol",
		name: "Bio-protocol",
		blurb: "Peer-reviewed, community-contributed step-by-step life-science protocols.",
		kind: "journal",
		fetchability: "full",
		publisherFetch: "blocked",
		searchSite: "bio-protocol.org",
		journal: {
			crossrefContainer: "Bio-protocol",
			europepmcJournal: "Bio-protocol",
			issn: ["2331-8325"]
		},
		searchUrl: (q) => `https://bio-protocol.org/en/searchlist?content=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?bio-protocol\.org\/en\/bpdetail\?/i,
		interactiveSearch: { startUrl: "https://bio-protocol.org/en" }
	},
	{
		id: "current-protocols",
		name: "Current Protocols (Wiley)",
		blurb: "Comprehensive, regularly-updated protocols across life-science methods.",
		kind: "journal",
		fetchability: "partial",
		publisherFetch: "abstract-only",
		searchSite: "currentprotocols.onlinelibrary.wiley.com",
		journal: {
			crossrefContainer: "Current Protocols",
			europepmcJournal: "Current Protocols",
			issn: ["2691-1299"]
		},
		searchUrl: (q) => `https://currentprotocols.onlinelibrary.wiley.com/action/doSearch?AllField=${enc(q)}`,
		publisherResult: /^https?:\/\/currentprotocols\.onlinelibrary\.wiley\.com\/doi\//i
	},
	{
		id: "protocols-io",
		name: "protocols.io",
		blurb: "Open-access repository of step-by-step protocols (community + published, with DOIs).",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "protocols.io",
		searchUrl: (q) => `https://www.protocols.io/search?q=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?protocols\.io\/view\//i
	},
	{
		id: "thermofisher",
		name: "Thermo Fisher Scientific",
		blurb: "Reagents, kits, instruments; extensive product protocols and manuals.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "thermofisher.com",
		searchUrl: (q) => `https://www.thermofisher.com/search/results?query=${enc(q)}&focusarea=Search%20All`,
		publisherResult: /^https?:\/\/(?:www\.)?thermofisher\.com\/order\/catalog\/product\//i
	},
	{
		id: "qiagen",
		name: "QIAGEN",
		blurb: "Nucleic-acid extraction/purification kits and their handbooks.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "qiagen.com",
		searchUrl: (q) => `https://www.qiagen.com/us/search?q=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?qiagen\.com\/(?:[a-z]{2}\/)?products\//i
	},
	{
		id: "neb",
		name: "New England Biolabs (NEB)",
		blurb: "Enzymes, cloning/library-prep reagents; detailed molecular-biology protocols. For restriction-enzyme recognition/cut/methylation facts use REBASE rather than this vendor's pages: `search` with `sources: [\"rebase\"]`, then `fetch` the `rebase:<enzyme>` id.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		ungated: /^https?:\/\/(?:www\.)?neb\.com\/.+\.pdf(?:$|\?)/i,
		searchSite: "neb.com",
		searchUrl: (q) => `https://www.neb.com/en-us/search#q=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?neb\.com\/en-us\/(?:products|protocols)\//i,
		publisherResultClass: /\bCoveoResultLink\b/i,
		publisherScrapeSelector: ".CoveoResultLink",
		publisherResidentialFirst: true
	},
	{
		id: "bio-rad",
		name: "Bio-Rad",
		blurb: "Electrophoresis, blotting, qPCR, chromatography reagents and protocols.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "bio-rad.com",
		searchUrl: (q) => `https://www.bio-rad.com/en-us/SearchResults?search_api_fulltext=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?bio-rad\.com\/en-us\/product\//i
	},
	{
		id: "sigma-aldrich",
		name: "Sigma-Aldrich (Merck)",
		blurb: "Broad chemicals/biochemicals catalog; SDS and product protocols.",
		kind: "vendor",
		fetchability: "none",
		publisherFetch: "blocked",
		searchSite: "sigmaaldrich.com",
		searchUrl: (q) => `https://www.sigmaaldrich.com/US/en/search/${enc(q)}?focus=products&type=product`,
		publisherResult: /^https?:\/\/(?:www\.)?sigmaaldrich\.com\/US\/en\/product\//i
	},
	{
		id: "emd-millipore",
		name: "EMD Millipore (MilliporeSigma)",
		blurb: "Life-science reagents, filtration, antibodies; product protocols.",
		kind: "vendor",
		fetchability: "none",
		publisherFetch: "blocked",
		searchSite: "emdmillipore.com",
		searchUrl: (q) => `https://www.emdmillipore.com/US/en/search/-/Search?SearchTerm=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?emdmillipore\.com\/US\/en\/product\//i
	},
	{
		id: "takarabio",
		name: "Takara Bio",
		blurb: "cDNA synthesis, PCR, NGS library-prep kits and user manuals.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "takarabio.com",
		searchUrl: (q) => `https://www.takarabio.com/search-results?term=${enc(q)}&tab=product`,
		publisherResult: /^https?:\/\/(?:www\.)?takarabio\.com\/products\//i
	},
	{
		id: "promega",
		name: "Promega",
		blurb: "Reporter assays, purification, cell-viability reagents and protocols.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "promega.com",
		searchUrl: (q) => `https://www.promega.com/results#q=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?promega\.com\/products\//i,
		interactiveSearch: { startUrl: "https://www.promega.com/" }
	},
	{
		id: "idt",
		name: "Integrated DNA Technologies (IDT)",
		blurb: "Custom oligos/primers/gBlocks; primer-design and oligo-handling protocols.",
		kind: "vendor",
		fetchability: "full",
		publisherFetch: "full",
		searchSite: "idtdna.com",
		searchUrl: (q) => `https://www.idtdna.com/page/search#q=${enc(q)}`,
		publisherResult: /^https?:\/\/(?:www\.)?idtdna\.com\/page\/support-and-education\//i,
		shadowSearch: true
	}
];
const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));
function getVendor(id) {
	return BY_ID.get(id);
}
/** Resolve a catalog publisher from an absolute result/page URL. */
function getVendorForUrl(raw) {
	let host;
	try {
		host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return;
	}
	return VENDORS.find((vendor) => {
		const expected = vendor.searchSite.split("/")[0].toLowerCase().replace(/^www\./, "");
		return host === expected;
	});
}
/**
* Resolve a list of requested vendor ids to Vendor objects. Unknown ids are
* collected separately so the caller can report them instead of silently
* dropping them. With no ids (undefined/empty), every vendor is returned.
*/
function resolveVendors(ids) {
	if (!ids || ids.length === 0) return {
		vendors: VENDORS,
		unknown: []
	};
	const vendors = [];
	const unknown = [];
	for (const raw of ids) {
		const id = raw.trim().toLowerCase();
		const v = BY_ID.get(id);
		if (v) vendors.push(v);
		else unknown.push(raw);
	}
	return {
		vendors,
		unknown
	};
}
const VENDOR_IDS = VENDORS.map((v) => v.id);

//#endregion
//#region src/rebase.ts
const REBASE_URL = "https://rebase.neb.com/rebase/link_withrefm";
const DEFAULT_TIMEOUT_MS$3 = 15e3;
const CACHE_TTL_MS = 1440 * 60 * 1e3;
const NEB_CODE = "N";
let cache$1 = null;
/** Strip cut markers and offset annotations, leaving bare IUPAC bases. */
function normalizeSite(site) {
	return site.replace(/\([^)]*\)/g, "").replace(/[\^\s]/g, "").toUpperCase();
}
/** Parse the supplier legend (letter → company) from the file header. */
function parseSuppliers(text) {
	const out = /* @__PURE__ */ new Map();
	const header = text.split(/\n<1>/, 1)[0] ?? "";
	for (const line of header.split("\n")) {
		const m = /^\s+([A-Z])\s{2,}(\S.*?)\s*(?:\(\d+\/\d+\))?\s*$/.exec(line);
		if (m) out.set(m[1], m[2].trim());
	}
	return out;
}
/**
* Parse the withrefm flat file into an index. Records start at `<1>`; each
* `<n>` tag sets the current field and any following untagged lines append to
* it (so multi-line <8> references are captured whole).
*/
function parseRebase(text) {
	const byName = /* @__PURE__ */ new Map();
	const bySite = /* @__PURE__ */ new Map();
	const suppliers = parseSuppliers(text);
	let fields = [];
	let cur = 0;
	const flush = () => {
		const name = (fields[1] ?? "").trim();
		if (!name) return;
		const rec = {
			name,
			isoschizomers: (fields[2] ?? "").trim(),
			site: (fields[3] ?? "").trim(),
			methylation: (fields[4] ?? "").trim(),
			organism: (fields[5] ?? "").trim(),
			source: (fields[6] ?? "").trim(),
			suppliers: (fields[7] ?? "").replace(/\s+/g, "").trim()
		};
		byName.set(name.toUpperCase(), rec);
		const norm = normalizeSite(rec.site);
		if (norm) {
			const list = bySite.get(norm);
			if (list) list.push(name);
			else bySite.set(norm, [name]);
		}
	};
	for (const line of text.split("\n")) {
		const m = /^<(\d)>(.*)$/.exec(line);
		if (m) {
			const n = Number(m[1]);
			if (n === 1) {
				flush();
				fields = [];
			}
			cur = n;
			fields[n] = m[2];
		} else if (cur > 0 && line.length > 0) fields[cur] = `${fields[cur] ?? ""} ${line.trim()}`;
	}
	flush();
	return {
		byName,
		bySite,
		suppliers
	};
}
/** Fetch + parse REBASE, memoised in module memory behind a TTL. */
async function loadIndex(opts) {
	const now = Date.now();
	if (cache$1 && now - cache$1.fetchedAt < CACHE_TTL_MS) return cache$1.index;
	const res = await fetchWithRetry(opts.fetchImpl ?? fetch, REBASE_URL, { headers: {
		Accept: "text/plain",
		"User-Agent": "labee-protocol-searcher"
	} }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$3);
	if (res.status !== 200) throw new Error(`REBASE HTTP ${res.status}`);
	const index = parseRebase(await res.text());
	cache$1 = {
		index,
		fetchedAt: now
	};
	return index;
}
const IUPAC = /^[ACGTRYSWKMBDHVN]+$/;
/** Decide whether a query looks like a recognition site vs an enzyme name. */
function looksLikeSite(query) {
	const q = query.replace(/\s+/g, "").toUpperCase();
	return q.length >= 3 && IUPAC.test(q);
}
function suppliedBy(rec, suppliers) {
	const codes = rec.suppliers.split("");
	if (codes.length === 0) return "No commercial supplier listed in REBASE.";
	const names = codes.map((c) => suppliers.get(c) ?? `code ${c}`);
	return `${codes.includes(NEB_CODE) ? "**Supplied by NEB.** " : "Not listed as an NEB product. "}Commercial suppliers: ${names.join(", ")}.`;
}
function renderRecord(rec, index) {
	return [
		`# ${rec.name}`,
		"",
		`- **Recognition site / cut:** \`${rec.site || "unknown"}\``,
		`- **Isoschizomers:** ${rec.isoschizomers || "none listed"}`,
		`- **Methylation sensitivity:** ${rec.methylation || "none listed"}`,
		`- **Source organism:** ${rec.organism || "unknown"}`,
		`- ${suppliedBy(rec, index.suppliers)}`,
		"",
		"_Source: REBASE (rebase.neb.com), NEB's open Restriction Enzyme Database._"
	].join("\n");
}
/** Suggest up to `n` enzyme names containing the query (case-insensitive). */
function suggestNames(index, query, n = 8) {
	const q = query.toUpperCase();
	const out = [];
	for (const rec of index.byName.values()) if (rec.name.toUpperCase().includes(q)) {
		out.push(rec.name);
		if (out.length >= n) break;
	}
	return out;
}
/**
* Look up a restriction enzyme by name (e.g. "EcoRI") or recognition site
* (e.g. "GAATTC"), returning model-friendly markdown. Auto-detects the mode
* when `by` is omitted. Never throws for "not found" — returns guidance text.
*/
async function findRestrictionEnzyme(query, opts = {}) {
	const trimmed = query.trim();
	if (!trimmed) return "Error: `query` is required (an enzyme name or recognition site).";
	const index = await loadIndex(opts);
	if ((opts.by ?? (looksLikeSite(trimmed) ? "site" : "name")) === "site") {
		const norm = normalizeSite(trimmed);
		const names = index.bySite.get(norm);
		if (!names || names.length === 0) return `No REBASE enzymes recognise \`${norm}\`. Sites use IUPAC codes (e.g. GAATTC, GGTCTC).`;
		return `${`# Enzymes recognising \`${norm}\`\n\n${names.length} match${names.length === 1 ? "" : "es"}: ${names.join(", ")}\n`}\n${names.map((nm) => index.byName.get(nm.toUpperCase())).filter((r) => Boolean(r)).sort((a, b) => Number(b.suppliers.includes(NEB_CODE)) - Number(a.suppliers.includes(NEB_CODE))).slice(0, 3).map((r) => renderRecord(r, index)).join("\n\n---\n\n")}`;
	}
	const rec = index.byName.get(trimmed.toUpperCase());
	if (rec) return renderRecord(rec, index);
	const suggestions = suggestNames(index, trimmed);
	return `No REBASE enzyme named "${trimmed}".${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " No similar enzyme names found in REBASE."}`;
}
/** A compact one-line summary for a search listing. */
function enzymeSnippet(rec) {
	const parts = [rec.site || "site unknown"];
	if (rec.organism) parts.push(rec.organism);
	parts.push(rec.suppliers.includes(NEB_CODE) ? "NEB-supplied" : "not an NEB product");
	return parts.join(" · ");
}
/**
* Heuristic: does this query name a restriction enzyme or a recognition site?
* Used to auto-include REBASE in a general `search`. Single-token only — enzyme
* names end in a Roman numeral (EcoRI, HindIII, BsaI); sites are pure IUPAC.
*/
function looksLikeEnzymeQuery(query) {
	const q = query.trim();
	if (!q || /\s/.test(q)) return false;
	return looksLikeSite(q) || /^[A-Za-z]{2,}[IVX]+$/.test(q);
}
/**
* Search REBASE for enzymes matching a name or recognition site, returning
* compact hits for a result listing (each `fetch`-able via `rebase:<name>`).
*/
async function searchRebase(query, opts = {}) {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const index = await loadIndex(opts);
	const by = opts.by ?? (looksLikeSite(trimmed) ? "site" : "name");
	const toHit = (rec) => ({
		name: rec.name,
		title: `${rec.name} — ${rec.site || "site unknown"}`,
		snippet: enzymeSnippet(rec)
	});
	if (by === "site") return (index.bySite.get(normalizeSite(trimmed)) ?? []).map((n) => index.byName.get(n.toUpperCase())).filter((r) => Boolean(r)).sort((a, b) => Number(b.suppliers.includes(NEB_CODE)) - Number(a.suppliers.includes(NEB_CODE))).slice(0, 8).map(toHit);
	const hits = [];
	const exact = index.byName.get(trimmed.toUpperCase());
	if (exact) hits.push(toHit(exact));
	for (const nm of suggestNames(index, trimmed, 8)) {
		if (nm.toUpperCase() === trimmed.toUpperCase()) continue;
		const rec = index.byName.get(nm.toUpperCase());
		if (rec) hits.push(toHit(rec));
		if (hits.length >= 8) break;
	}
	return hits;
}

//#endregion
//#region src/availability.ts
/**
* Journal prior first, refined by live provider signals. `oaSignals` are the
* open-access indicators the scholarly backends attached to this result during
* this search — Europe PMC's `isOpenAccess`, OpenAlex's `is_oa`, and so on.
*/
function assessDoiAvailability(journalPrior, oaSignals = []) {
	if (oaSignals.length > 0) return {
		availability: "likely-fetchable",
		confidence: "metadata",
		journalPrior,
		signals: [...new Set(oaSignals)]
	};
	return {
		availability: journalPrior === "full" ? "likely-fetchable" : journalPrior === "none" ? "unlikely-fetchable" : "unknown",
		confidence: "journal-prior",
		journalPrior
	};
}

//#endregion
//#region src/browserless.ts
/**
* Our own deployment, running the fork. Deliberately not a hosted
* browserless.io region: that service is a different codebase without the
* residential exit, and defaulting to it would silently send traffic to a
* third party that this project does not control.
*/
const DEFAULT_ENDPOINT = "https://browserless.truegrit.dev";
const DEFAULT_TIMEOUT_MS$2 = 3e4;
const MAX_TIMEOUT_MS = 12e4;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const RESIDENTIAL_RETRY_DELAY_MS = 1500;
const SEARCH_SELECTOR_TIMEOUT_MS = 5e3;
/**
* Read the configuration, or null when the fallback is unavailable. An absent
* token is "not configured", never an error: the whole feature is opt-in, and
* an install without it must behave exactly as it did before.
*/
function browserlessConfig(env = process.env) {
	if (env.PROTOCOLS_BROWSERLESS?.trim().toLowerCase() === "off") return null;
	const token = env.BROWSERLESS_TOKEN?.trim();
	if (!token) return null;
	const endpoint = (env.BROWSERLESS_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
	const configured = Number(env.BROWSERLESS_TIMEOUT_MS);
	return {
		endpoint,
		token,
		timeoutMs: Number.isFinite(configured) && configured > 0 ? Math.min(configured, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS$2
	};
}
/**
* The control endpoint must be HTTPS, or loopback for a self-hosted container.
* Credentials in the URL are refused: the token belongs in the query string the
* caller builds, not somewhere it can be logged as part of an origin.
*/
function assertBrowserlessEndpoint(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("browserless endpoint is not a valid URL");
	}
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("browserless endpoint must use HTTPS unless it is loopback");
	if (url.username || url.password) throw new Error("browserless endpoint credentials are forbidden");
	return url;
}
/**
* Which codebase answers at this endpoint, and therefore which routes exist.
*
* "hosted" is browserless.io's own service: it serves `/unblock`, whose stealth
* patching is the only thing measured to clear neb.com's Cloudflare challenge.
* Everything else is treated as our fork, which serves `/content` and can route
* through a registered residential exit, but has no `/unblock` — verified
* against github.com/mengbingrock/browserless, whose HTTP routes are exactly
* content, download, function, json-*, pdf, performance, scrape and screenshot.
*
* Host-suffix matching, so a lookalike like `browserless.io.example.com` is
* treated as self-hosted rather than inheriting the hosted contract.
*/
function endpointFlavor(endpoint) {
	const host = endpoint.hostname.toLowerCase().replace(/\.$/, "");
	return host === "browserless.io" || host.endsWith(".browserless.io") ? "hosted" : "self-hosted";
}
/**
* Pages whose rendered body is a "not found" notice rather than content.
*
* `/unblock` returns the rendered HTML and no HTTP status, so the usual
* `res.status !== 200` guard is unavailable — a soft 404 arrives looking
* exactly like a successful retrieval. Observed case: a dead neb.com protocol
* URL renders 4.7k characters of "We're very sorry, but we cannot find the URL
* that you have requested", which without this check is reported as content.
*
* Kept deliberately narrow, and applied only to the first part of the document:
* a protocol that discusses HTTP status codes must not be discarded.
*/
const SOFT_NOT_FOUND = /we (?:cannot|can(?:'|’)t|could not|are unable to) find the (?:url|page|document)|page not found|404 (?:-|—|:)? ?not found|the requested page (?:could not be found|does not exist)/i;
function looksLikeSoftNotFound(text) {
	return SOFT_NOT_FOUND.test(text.slice(0, 1200));
}
/**
* Render `url` in a remote browser and return its HTML, or null on any failure.
* Never throws: this is a fallback, and a fallback that can fail the call it was
* meant to rescue is worse than no fallback at all.
*
* `doFetch` is the caller's injected fetch, so tests drive this without a token
* or a network, exactly like every other network path in this codebase.
*
* `residential` asks the server to route the render back out through a
* registered residential exit — see residential.ts. Pass it only when one is
* actually registered: with no matching agent the server rejects the call, and
* a fallback that fails is worse than one that calls from a datacenter.
*/
async function renderWithBrowserless(url, doFetch, cfg, residential) {
	let endpoint;
	try {
		endpoint = assertBrowserlessEndpoint(cfg.endpoint);
	} catch {
		return null;
	}
	const hosted = endpointFlavor(endpoint) === "hosted";
	const params = new URLSearchParams({ token: cfg.token });
	if (!hosted) params.set("timeout", String(MAX_TIMEOUT_MS));
	if (residential && !hosted) {
		params.set("residentialProxy", "true");
		params.set("residentialProxyCountry", residential.country);
		if (residential.region) params.set("residentialProxyRegion", residential.region);
		if (residential.city) params.set("residentialProxyCity", residential.city);
	}
	const route = `${endpoint.origin}${hosted ? "/unblock" : "/content"}?${params.toString()}`;
	const body = JSON.stringify(hosted ? {
		url,
		content: true,
		browserWSEndpoint: false,
		cookies: false,
		screenshot: false
	} : {
		url,
		gotoOptions: {
			waitUntil: "domcontentloaded",
			timeout: MAX_TIMEOUT_MS
		},
		waitForTimeout: DEFAULT_TIMEOUT_MS$2,
		solveCaptchas: true
	});
	const attempts = residential && !hosted ? 2 : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const requestTimeout = hosted ? cfg.timeoutMs : Math.max(cfg.timeoutMs, 9e4);
		const timer = setTimeout(() => controller.abort(), requestTimeout);
		try {
			const res = await doFetch(route, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				signal: controller.signal
			});
			if (!res.ok) {
				if (attempt < attempts) {
					await new Promise((r) => setTimeout(r, RESIDENTIAL_RETRY_DELAY_MS));
					continue;
				}
				return null;
			}
			const raw = await res.text();
			if (raw.length > MAX_HTML_BYTES) return null;
			if (!hosted) return raw.trim() ? raw : null;
			const content = JSON.parse(raw).content;
			return typeof content === "string" && content.trim() ? content : null;
		} catch {
			if (attempt < attempts) {
				await new Promise((r) => setTimeout(r, RESIDENTIAL_RETRY_DELAY_MS));
				continue;
			}
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}
const SEARCH_FUNCTION = String.raw`
export default async function ({ page, context }) {
  // Commerce/search pages often keep analytics and chat connections alive, so
  // networkidle2 may never fire. DOMContentLoaded plus the explicit 30-second
  // settle below is deterministic and was the successful live-test shape.
  await page.goto(context.entryUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise((resolve) => setTimeout(resolve, 5000));

  if (context.interactive) {
    let input = context.inputSelector ? await page.$(context.inputSelector) : null;
    if (!input) {
      const inputs = await page.$$('input');
      for (const candidate of inputs) {
        const meta = await candidate.evaluate((el) => ({
          placeholder: el.getAttribute('placeholder') || '',
          name: el.getAttribute('name') || '',
          aria: el.getAttribute('aria-label') || '',
          type: el.getAttribute('type') || '',
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        }));
        const label = (meta.placeholder + ' ' + meta.name + ' ' + meta.aria).toLowerCase();
        if (meta.visible && meta.type !== 'hidden' && /search|keyword|query|term/.test(label) && !/cookie|vendor/.test(label)) {
          input = candidate;
          break;
        }
      }
    }
    if (!input) throw new Error('publisher search input not found');
    await input.click({ clickCount: 3 });
    await input.type(context.query, { delay: 25 });
    const submit = context.submitSelector ? await page.$(context.submitSelector) : null;
    if (submit) await submit.click(); else await input.press('Enter');
  }

  await new Promise((resolve) => setTimeout(resolve, context.waitMs));
  const data = await page.evaluate((shadowDom) => {
    const links = [];
    const roots = new Set();
    function visit(root) {
      if (!root || roots.has(root)) return;
      roots.add(root);
      for (const anchor of root.querySelectorAll('a[href]')) {
        if (links.length >= 2500) break;
        const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        const className = typeof anchor.className === 'string' ? anchor.className : '';
        links.push({ href: anchor.href, text, snippet: '', className });
      }
      if (shadowDom) {
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
      }
    }
    visit(document);
    return {
      title: document.title,
      url: location.href,
      bodyText: (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30000),
      links: links.slice(0, 2500),
    };
  }, context.shadowDom);
  return { data, type: 'application/json' };
}`;
function searchPageFromHtml(html, requestedUrl) {
	const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const bodyText = decodeEntities(stripTags(html.replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi, " "))).replace(/\s+/g, " ").trim().slice(0, 3e4);
	const links = [];
	const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	let match;
	while ((match = anchor.exec(html)) && links.length < 2500) {
		const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
		const href = decodeEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
		if (!href) continue;
		let absolute;
		try {
			absolute = new URL(href, requestedUrl).toString();
		} catch {
			continue;
		}
		const text = decodeEntities(stripTags(match[2])).replace(/\s+/g, " ").trim();
		const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
		const className = decodeEntities(classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "");
		links.push({
			href: absolute,
			text,
			snippet: "",
			...className ? { className } : {}
		});
	}
	return {
		title: decodeEntities(stripTags(titleMatch?.[1] ?? "")).trim(),
		url: requestedUrl,
		bodyText,
		links
	};
}
/**
* Extract live result anchors through the self-hosted `/scrape` route.
*
* This is intentionally separate from `/function`: scrape enables the fork's
* configured public-page challenge solver and stealth launch mode, while still
* returning structured DOM attributes. NEB's Coveo cards require exactly this
* combination—the cards are visible in a screenshot but absent from the HTML
* serialized by `/content`.
*/
async function scrapeSearchWithBrowserless(searchUrl, selector, doFetch, cfg, residential) {
	let endpoint;
	try {
		endpoint = assertBrowserlessEndpoint(cfg.endpoint);
	} catch {
		return null;
	}
	if (endpointFlavor(endpoint) !== "self-hosted") return null;
	const params = new URLSearchParams({
		token: cfg.token,
		timeout: String(MAX_TIMEOUT_MS)
	});
	if (residential) {
		params.set("residentialProxy", "true");
		params.set("residentialProxyCountry", residential.country);
		if (residential.region) params.set("residentialProxyRegion", residential.region);
		if (residential.city) params.set("residentialProxyCity", residential.city);
	}
	const body = JSON.stringify({
		url: searchUrl,
		gotoOptions: {
			waitUntil: "domcontentloaded",
			timeout: MAX_TIMEOUT_MS
		},
		waitForTimeout: DEFAULT_TIMEOUT_MS$2,
		solveCaptchas: true,
		elements: [{
			selector,
			timeout: SEARCH_SELECTOR_TIMEOUT_MS
		}]
	});
	const attempts = residential ? 2 : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
		try {
			const response = await doFetch(`${endpoint.origin}/scrape?${params.toString()}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				signal: controller.signal
			});
			if (!response.ok) {
				if (attempt < attempts) {
					await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
					continue;
				}
				return null;
			}
			const raw = await response.text();
			if (!raw.trim() || raw.length > MAX_HTML_BYTES) return null;
			const results = JSON.parse(raw).data?.find((row) => row.selector === selector)?.results;
			if (!Array.isArray(results)) return null;
			const links = [];
			for (const result of results) {
				const attributes = Array.isArray(result.attributes) ? result.attributes : [];
				const href = attributes.find((attribute) => attribute.name.toLowerCase() === "href")?.value;
				if (!href) continue;
				let absolute;
				try {
					absolute = new URL(href, searchUrl).toString();
				} catch {
					continue;
				}
				const className = attributes.find((attribute) => attribute.name.toLowerCase() === "class")?.value;
				links.push({
					href: absolute,
					text: typeof result.text === "string" ? result.text.replace(/\s+/g, " ").trim() : "",
					snippet: "",
					...className ? { className } : {}
				});
			}
			return {
				title: "",
				url: searchUrl,
				bodyText: "",
				links
			};
		} catch {
			if (attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
				continue;
			}
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}
/** Render a publisher search UI and return its populated links. */
async function searchWithBrowserless(searchUrl, query, doFetch, cfg, interaction, shadowDom = false, residential) {
	let endpoint;
	try {
		endpoint = assertBrowserlessEndpoint(cfg.endpoint);
	} catch {
		return null;
	}
	if (endpointFlavor(endpoint) !== "self-hosted") return null;
	if (!interaction && !shadowDom) {
		const html = await renderWithBrowserless(searchUrl, doFetch, cfg, residential);
		return html ? searchPageFromHtml(html, searchUrl) : null;
	}
	const params = new URLSearchParams({
		token: cfg.token,
		timeout: String(MAX_TIMEOUT_MS)
	});
	if (residential) {
		params.set("residentialProxy", "true");
		params.set("residentialProxyCountry", residential.country);
		if (residential.region) params.set("residentialProxyRegion", residential.region);
		if (residential.city) params.set("residentialProxyCity", residential.city);
	}
	const context = {
		entryUrl: interaction?.startUrl ?? searchUrl,
		query,
		waitMs: DEFAULT_TIMEOUT_MS$2,
		interactive: Boolean(interaction),
		shadowDom,
		...interaction?.inputSelector ? { inputSelector: interaction.inputSelector } : {},
		...interaction?.submitSelector ? { submitSelector: interaction.submitSelector } : {}
	};
	const attempts = residential ? 2 : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
		try {
			const response = await doFetch(`${endpoint.origin}/function?${params.toString()}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					code: SEARCH_FUNCTION,
					context
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				if (attempt < attempts) {
					await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
					continue;
				}
				return null;
			}
			const raw = await response.text();
			if (!raw.trim() || raw.length > MAX_HTML_BYTES) return null;
			const data = JSON.parse(raw).data;
			if (!data || !Array.isArray(data.links)) return null;
			return {
				title: typeof data.title === "string" ? data.title : "",
				url: typeof data.url === "string" ? data.url : searchUrl,
				bodyText: typeof data.bodyText === "string" ? data.bodyText : "",
				links: data.links.filter((link) => Boolean(link) && typeof link.href === "string" && typeof link.text === "string" && typeof link.snippet === "string" && (link.className === void 0 || typeof link.className === "string"))
			};
		} catch {
			if (attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
				continue;
			}
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}

//#endregion
//#region node_modules/ws/lib/constants.js
var require_constants = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const BINARY_TYPES = [
		"nodebuffer",
		"arraybuffer",
		"fragments"
	];
	const hasBlob = typeof Blob !== "undefined";
	if (hasBlob) BINARY_TYPES.push("blob");
	module.exports = {
		BINARY_TYPES,
		CLOSE_TIMEOUT: 3e4,
		EMPTY_BUFFER: Buffer.alloc(0),
		GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
		hasBlob,
		kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
		kListener: Symbol("kListener"),
		kStatusCode: Symbol("status-code"),
		kWebSocket: Symbol("websocket"),
		NOOP: () => {}
	};
}));

//#endregion
//#region node_modules/ws/lib/buffer-util.js
var require_buffer_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { EMPTY_BUFFER } = require_constants();
	const FastBuffer = Buffer[Symbol.species];
	/**
	* Merges an array of buffers into a new buffer.
	*
	* @param {Buffer[]} list The array of buffers to concat
	* @param {Number} totalLength The total length of buffers in the list
	* @return {Buffer} The resulting buffer
	* @public
	*/
	function concat(list, totalLength) {
		if (list.length === 0) return EMPTY_BUFFER;
		if (list.length === 1) return list[0];
		const target = Buffer.allocUnsafe(totalLength);
		let offset = 0;
		for (let i = 0; i < list.length; i++) {
			const buf = list[i];
			target.set(buf, offset);
			offset += buf.length;
		}
		if (offset < totalLength) return new FastBuffer(target.buffer, target.byteOffset, offset);
		return target;
	}
	/**
	* Masks a buffer using the given mask.
	*
	* @param {Buffer} source The buffer to mask
	* @param {Buffer} mask The mask to use
	* @param {Buffer} output The buffer where to store the result
	* @param {Number} offset The offset at which to start writing
	* @param {Number} length The number of bytes to mask.
	* @public
	*/
	function _mask(source, mask, output, offset, length) {
		for (let i = 0; i < length; i++) output[offset + i] = source[i] ^ mask[i & 3];
	}
	/**
	* Unmasks a buffer using the given mask.
	*
	* @param {Buffer} buffer The buffer to unmask
	* @param {Buffer} mask The mask to use
	* @public
	*/
	function _unmask(buffer, mask) {
		for (let i = 0; i < buffer.length; i++) buffer[i] ^= mask[i & 3];
	}
	/**
	* Converts a buffer to an `ArrayBuffer`.
	*
	* @param {Buffer} buf The buffer to convert
	* @return {ArrayBuffer} Converted buffer
	* @public
	*/
	function toArrayBuffer(buf) {
		if (buf.length === buf.buffer.byteLength) return buf.buffer;
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
	}
	/**
	* Converts `data` to a `Buffer`.
	*
	* @param {*} data The data to convert
	* @return {Buffer} The buffer
	* @throws {TypeError}
	* @public
	*/
	function toBuffer(data) {
		toBuffer.readOnly = true;
		if (Buffer.isBuffer(data)) return data;
		let buf;
		if (data instanceof ArrayBuffer) buf = new FastBuffer(data);
		else if (ArrayBuffer.isView(data)) buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
		else {
			buf = Buffer.from(data);
			toBuffer.readOnly = false;
		}
		return buf;
	}
	module.exports = {
		concat,
		mask: _mask,
		toArrayBuffer,
		toBuffer,
		unmask: _unmask
	};
	/* istanbul ignore else  */
	if (!process.env.WS_NO_BUFFER_UTIL) try {
		const bufferUtil = __require("bufferutil");
		module.exports.mask = function(source, mask, output, offset, length) {
			if (length < 48) _mask(source, mask, output, offset, length);
			else bufferUtil.mask(source, mask, output, offset, length);
		};
		module.exports.unmask = function(buffer, mask) {
			if (buffer.length < 32) _unmask(buffer, mask);
			else bufferUtil.unmask(buffer, mask);
		};
	} catch (e) {}
}));

//#endregion
//#region node_modules/ws/lib/limiter.js
var require_limiter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const kDone = Symbol("kDone");
	const kRun = Symbol("kRun");
	/**
	* A very simple job queue with adjustable concurrency. Adapted from
	* https://github.com/STRML/async-limiter
	*/
	var Limiter = class {
		/**
		* Creates a new `Limiter`.
		*
		* @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
		*     to run concurrently
		*/
		constructor(concurrency) {
			this[kDone] = () => {
				this.pending--;
				this[kRun]();
			};
			this.concurrency = concurrency || Infinity;
			this.jobs = [];
			this.pending = 0;
		}
		/**
		* Adds a job to the queue.
		*
		* @param {Function} job The job to run
		* @public
		*/
		add(job) {
			this.jobs.push(job);
			this[kRun]();
		}
		/**
		* Removes a job from the queue and runs it if possible.
		*
		* @private
		*/
		[kRun]() {
			if (this.pending === this.concurrency) return;
			if (this.jobs.length) {
				const job = this.jobs.shift();
				this.pending++;
				job(this[kDone]);
			}
		}
	};
	module.exports = Limiter;
}));

//#endregion
//#region node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const zlib = __require("zlib");
	const bufferUtil = require_buffer_util();
	const Limiter = require_limiter();
	const { kStatusCode } = require_constants();
	const FastBuffer = Buffer[Symbol.species];
	const TRAILER = Buffer.from([
		0,
		0,
		255,
		255
	]);
	const kPerMessageDeflate = Symbol("permessage-deflate");
	const kTotalLength = Symbol("total-length");
	const kCallback = Symbol("callback");
	const kBuffers = Symbol("buffers");
	const kError = Symbol("error");
	let zlibLimiter;
	/**
	* permessage-deflate implementation.
	*/
	var PerMessageDeflate = class {
		/**
		* Creates a PerMessageDeflate instance.
		*
		* @param {Object} [options] Configuration options
		* @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
		*     for, or request, a custom client window size
		* @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
		*     acknowledge disabling of client context takeover
		* @param {Number} [options.concurrencyLimit=10] The number of concurrent
		*     calls to zlib
		* @param {Boolean} [options.isServer=false] Create the instance in either
		*     server or client mode
		* @param {Number} [options.maxPayload=0] The maximum allowed message length
		* @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
		*     use of a custom server window size
		* @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
		*     disabling of server context takeover
		* @param {Number} [options.threshold=1024] Size (in bytes) below which
		*     messages should not be compressed if context takeover is disabled
		* @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
		*     deflate
		* @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
		*     inflate
		*/
		constructor(options) {
			this._options = options || {};
			this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
			this._maxPayload = this._options.maxPayload | 0;
			this._isServer = !!this._options.isServer;
			this._deflate = null;
			this._inflate = null;
			this.params = null;
			if (!zlibLimiter) zlibLimiter = new Limiter(this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10);
		}
		/**
		* @type {String}
		*/
		static get extensionName() {
			return "permessage-deflate";
		}
		/**
		* Create an extension negotiation offer.
		*
		* @return {Object} Extension parameters
		* @public
		*/
		offer() {
			const params = {};
			if (this._options.serverNoContextTakeover) params.server_no_context_takeover = true;
			if (this._options.clientNoContextTakeover) params.client_no_context_takeover = true;
			if (this._options.serverMaxWindowBits) params.server_max_window_bits = this._options.serverMaxWindowBits;
			if (this._options.clientMaxWindowBits) params.client_max_window_bits = this._options.clientMaxWindowBits;
			else if (this._options.clientMaxWindowBits == null) params.client_max_window_bits = true;
			return params;
		}
		/**
		* Accept an extension negotiation offer/response.
		*
		* @param {Array} configurations The extension negotiation offers/reponse
		* @return {Object} Accepted configuration
		* @public
		*/
		accept(configurations) {
			configurations = this.normalizeParams(configurations);
			this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
			return this.params;
		}
		/**
		* Releases all resources used by the extension.
		*
		* @public
		*/
		cleanup() {
			if (this._inflate) {
				this._inflate.close();
				this._inflate = null;
			}
			if (this._deflate) {
				const callback = this._deflate[kCallback];
				this._deflate.close();
				this._deflate = null;
				if (callback) callback(/* @__PURE__ */ new Error("The deflate stream was closed while data was being processed"));
			}
		}
		/**
		*  Accept an extension negotiation offer.
		*
		* @param {Array} offers The extension negotiation offers
		* @return {Object} Accepted configuration
		* @private
		*/
		acceptAsServer(offers) {
			const opts = this._options;
			const accepted = offers.find((params) => {
				if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) return false;
				return true;
			});
			if (!accepted) throw new Error("None of the extension offers can be accepted");
			if (opts.serverNoContextTakeover) accepted.server_no_context_takeover = true;
			if (opts.clientNoContextTakeover) accepted.client_no_context_takeover = true;
			if (typeof opts.serverMaxWindowBits === "number") accepted.server_max_window_bits = opts.serverMaxWindowBits;
			if (typeof opts.clientMaxWindowBits === "number") accepted.client_max_window_bits = opts.clientMaxWindowBits;
			else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) delete accepted.client_max_window_bits;
			return accepted;
		}
		/**
		* Accept the extension negotiation response.
		*
		* @param {Array} response The extension negotiation response
		* @return {Object} Accepted configuration
		* @private
		*/
		acceptAsClient(response) {
			const params = response[0];
			if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) throw new Error("Unexpected parameter \"client_no_context_takeover\"");
			if (!params.client_max_window_bits) {
				if (typeof this._options.clientMaxWindowBits === "number") params.client_max_window_bits = this._options.clientMaxWindowBits;
			} else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) throw new Error("Unexpected or invalid parameter \"client_max_window_bits\"");
			return params;
		}
		/**
		* Normalize parameters.
		*
		* @param {Array} configurations The extension negotiation offers/reponse
		* @return {Array} The offers/response with normalized parameters
		* @private
		*/
		normalizeParams(configurations) {
			configurations.forEach((params) => {
				Object.keys(params).forEach((key) => {
					let value = params[key];
					if (value.length > 1) throw new Error(`Parameter "${key}" must have only a single value`);
					value = value[0];
					if (key === "client_max_window_bits") {
						if (value !== true) {
							const num = +value;
							if (!Number.isInteger(num) || num < 8 || num > 15) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
							value = num;
						} else if (!this._isServer) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
					} else if (key === "server_max_window_bits") {
						const num = +value;
						if (!Number.isInteger(num) || num < 8 || num > 15) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
						value = num;
					} else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
						if (value !== true) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
					} else throw new Error(`Unknown parameter "${key}"`);
					params[key] = value;
				});
			});
			return configurations;
		}
		/**
		* Decompress data. Concurrency limited.
		*
		* @param {Buffer} data Compressed data
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @public
		*/
		decompress(data, fin, callback) {
			zlibLimiter.add((done) => {
				this._decompress(data, fin, (err, result) => {
					done();
					callback(err, result);
				});
			});
		}
		/**
		* Compress data. Concurrency limited.
		*
		* @param {(Buffer|String)} data Data to compress
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @public
		*/
		compress(data, fin, callback) {
			zlibLimiter.add((done) => {
				this._compress(data, fin, (err, result) => {
					done();
					callback(err, result);
				});
			});
		}
		/**
		* Decompress data.
		*
		* @param {Buffer} data Compressed data
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @private
		*/
		_decompress(data, fin, callback) {
			const endpoint = this._isServer ? "client" : "server";
			if (!this._inflate) {
				const key = `${endpoint}_max_window_bits`;
				const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
				this._inflate = zlib.createInflateRaw({
					...this._options.zlibInflateOptions,
					windowBits
				});
				this._inflate[kPerMessageDeflate] = this;
				this._inflate[kTotalLength] = 0;
				this._inflate[kBuffers] = [];
				this._inflate.on("error", inflateOnError);
				this._inflate.on("data", inflateOnData);
			}
			this._inflate[kCallback] = callback;
			this._inflate.write(data);
			if (fin) this._inflate.write(TRAILER);
			this._inflate.flush(() => {
				const err = this._inflate[kError];
				if (err) {
					this._inflate.close();
					this._inflate = null;
					callback(err);
					return;
				}
				const data = bufferUtil.concat(this._inflate[kBuffers], this._inflate[kTotalLength]);
				if (this._inflate._readableState.endEmitted) {
					this._inflate.close();
					this._inflate = null;
				} else {
					this._inflate[kTotalLength] = 0;
					this._inflate[kBuffers] = [];
					if (fin && this.params[`${endpoint}_no_context_takeover`]) this._inflate.reset();
				}
				callback(null, data);
			});
		}
		/**
		* Compress data.
		*
		* @param {(Buffer|String)} data Data to compress
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @private
		*/
		_compress(data, fin, callback) {
			const endpoint = this._isServer ? "server" : "client";
			if (!this._deflate) {
				const key = `${endpoint}_max_window_bits`;
				const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
				this._deflate = zlib.createDeflateRaw({
					...this._options.zlibDeflateOptions,
					windowBits
				});
				this._deflate[kTotalLength] = 0;
				this._deflate[kBuffers] = [];
				this._deflate.on("data", deflateOnData);
			}
			this._deflate[kCallback] = callback;
			this._deflate.write(data);
			this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
				if (!this._deflate) return;
				let data = bufferUtil.concat(this._deflate[kBuffers], this._deflate[kTotalLength]);
				if (fin) data = new FastBuffer(data.buffer, data.byteOffset, data.length - 4);
				this._deflate[kCallback] = null;
				this._deflate[kTotalLength] = 0;
				this._deflate[kBuffers] = [];
				if (fin && this.params[`${endpoint}_no_context_takeover`]) this._deflate.reset();
				callback(null, data);
			});
		}
	};
	module.exports = PerMessageDeflate;
	/**
	* The listener of the `zlib.DeflateRaw` stream `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function deflateOnData(chunk) {
		this[kBuffers].push(chunk);
		this[kTotalLength] += chunk.length;
	}
	/**
	* The listener of the `zlib.InflateRaw` stream `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function inflateOnData(chunk) {
		this[kTotalLength] += chunk.length;
		if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
			this[kBuffers].push(chunk);
			return;
		}
		this[kError] = /* @__PURE__ */ new RangeError("Max payload size exceeded");
		this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
		this[kError][kStatusCode] = 1009;
		this.removeListener("data", inflateOnData);
		this.reset();
	}
	/**
	* The listener of the `zlib.InflateRaw` stream `'error'` event.
	*
	* @param {Error} err The emitted error
	* @private
	*/
	function inflateOnError(err) {
		this[kPerMessageDeflate]._inflate = null;
		if (this[kError]) {
			this[kCallback](this[kError]);
			return;
		}
		err[kStatusCode] = 1007;
		this[kCallback](err);
	}
}));

//#endregion
//#region node_modules/ws/lib/validation.js
var require_validation = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { isUtf8 } = __require("buffer");
	const { hasBlob } = require_constants();
	const tokenChars = [
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		0,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		1,
		1,
		0,
		1,
		1,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		1,
		0,
		1,
		0
	];
	/**
	* Checks if a status code is allowed in a close frame.
	*
	* @param {Number} code The status code
	* @return {Boolean} `true` if the status code is valid, else `false`
	* @public
	*/
	function isValidStatusCode(code) {
		return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
	}
	/**
	* Checks if a given buffer contains only correct UTF-8.
	* Ported from https://www.cl.cam.ac.uk/%7Emgk25/ucs/utf8_check.c by
	* Markus Kuhn.
	*
	* @param {Buffer} buf The buffer to check
	* @return {Boolean} `true` if `buf` contains only correct UTF-8, else `false`
	* @public
	*/
	function _isValidUTF8(buf) {
		const len = buf.length;
		let i = 0;
		while (i < len) if ((buf[i] & 128) === 0) i++;
		else if ((buf[i] & 224) === 192) {
			if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) return false;
			i += 2;
		} else if ((buf[i] & 240) === 224) {
			if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || buf[i] === 237 && (buf[i + 1] & 224) === 160) return false;
			i += 3;
		} else if ((buf[i] & 248) === 240) {
			if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) return false;
			i += 4;
		} else return false;
		return true;
	}
	/**
	* Determines whether a value is a `Blob`.
	*
	* @param {*} value The value to be tested
	* @return {Boolean} `true` if `value` is a `Blob`, else `false`
	* @private
	*/
	function isBlob(value) {
		return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
	}
	module.exports = {
		isBlob,
		isValidStatusCode,
		isValidUTF8: _isValidUTF8,
		tokenChars
	};
	if (isUtf8) module.exports.isValidUTF8 = function(buf) {
		return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
	};
	else if (!process.env.WS_NO_UTF_8_VALIDATE) try {
		const isValidUTF8 = __require("utf-8-validate");
		module.exports.isValidUTF8 = function(buf) {
			return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
		};
	} catch (e) {}
}));

//#endregion
//#region node_modules/ws/lib/receiver.js
var require_receiver = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { Writable } = __require("stream");
	const PerMessageDeflate = require_permessage_deflate();
	const { BINARY_TYPES, EMPTY_BUFFER, kStatusCode, kWebSocket } = require_constants();
	const { concat, toArrayBuffer, unmask } = require_buffer_util();
	const { isValidStatusCode, isValidUTF8 } = require_validation();
	const FastBuffer = Buffer[Symbol.species];
	const GET_INFO = 0;
	const GET_PAYLOAD_LENGTH_16 = 1;
	const GET_PAYLOAD_LENGTH_64 = 2;
	const GET_MASK = 3;
	const GET_DATA = 4;
	const INFLATING = 5;
	const DEFER_EVENT = 6;
	/**
	* HyBi Receiver implementation.
	*
	* @extends Writable
	*/
	var Receiver = class extends Writable {
		/**
		* Creates a Receiver instance.
		*
		* @param {Object} [options] Options object
		* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {String} [options.binaryType=nodebuffer] The type for binary data
		* @param {Object} [options.extensions] An object containing the negotiated
		*     extensions
		* @param {Boolean} [options.isServer=false] Specifies whether to operate in
		*     client or server mode
		* @param {Number} [options.maxBufferedChunks=0] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=0] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=0] The maximum allowed message length
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		*/
		constructor(options = {}) {
			super();
			this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
			this._binaryType = options.binaryType || BINARY_TYPES[0];
			this._extensions = options.extensions || {};
			this._isServer = !!options.isServer;
			this._maxBufferedChunks = options.maxBufferedChunks | 0;
			this._maxFragments = options.maxFragments | 0;
			this._maxPayload = options.maxPayload | 0;
			this._skipUTF8Validation = !!options.skipUTF8Validation;
			this[kWebSocket] = void 0;
			this._bufferedBytes = 0;
			this._buffers = [];
			this._compressed = false;
			this._payloadLength = 0;
			this._mask = void 0;
			this._fragmented = 0;
			this._masked = false;
			this._fin = false;
			this._opcode = 0;
			this._totalPayloadLength = 0;
			this._messageLength = 0;
			this._numFragments = 0;
			this._fragments = [];
			this._errored = false;
			this._loop = false;
			this._state = GET_INFO;
		}
		/**
		* Implements `Writable.prototype._write()`.
		*
		* @param {Buffer} chunk The chunk of data to write
		* @param {String} encoding The character encoding of `chunk`
		* @param {Function} cb Callback
		* @private
		*/
		_write(chunk, encoding, cb) {
			if (this._opcode === 8 && this._state == GET_INFO) return cb();
			if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
				cb(this.createError(RangeError, "Too many buffered chunks", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
				return;
			}
			this._bufferedBytes += chunk.length;
			this._buffers.push(chunk);
			this.startLoop(cb);
		}
		/**
		* Consumes `n` bytes from the buffered data.
		*
		* @param {Number} n The number of bytes to consume
		* @return {Buffer} The consumed bytes
		* @private
		*/
		consume(n) {
			this._bufferedBytes -= n;
			if (n === this._buffers[0].length) return this._buffers.shift();
			if (n < this._buffers[0].length) {
				const buf = this._buffers[0];
				this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
				return new FastBuffer(buf.buffer, buf.byteOffset, n);
			}
			const dst = Buffer.allocUnsafe(n);
			do {
				const buf = this._buffers[0];
				const offset = dst.length - n;
				if (n >= buf.length) dst.set(this._buffers.shift(), offset);
				else {
					dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
					this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
				}
				n -= buf.length;
			} while (n > 0);
			return dst;
		}
		/**
		* Starts the parsing loop.
		*
		* @param {Function} cb Callback
		* @private
		*/
		startLoop(cb) {
			this._loop = true;
			do
				switch (this._state) {
					case GET_INFO:
						this.getInfo(cb);
						break;
					case GET_PAYLOAD_LENGTH_16:
						this.getPayloadLength16(cb);
						break;
					case GET_PAYLOAD_LENGTH_64:
						this.getPayloadLength64(cb);
						break;
					case GET_MASK:
						this.getMask();
						break;
					case GET_DATA:
						this.getData(cb);
						break;
					case INFLATING:
					case DEFER_EVENT:
						this._loop = false;
						return;
				}
			while (this._loop);
			if (!this._errored) cb();
		}
		/**
		* Reads the first two bytes of a frame.
		*
		* @param {Function} cb Callback
		* @private
		*/
		getInfo(cb) {
			if (this._bufferedBytes < 2) {
				this._loop = false;
				return;
			}
			const buf = this.consume(2);
			if ((buf[0] & 48) !== 0) {
				cb(this.createError(RangeError, "RSV2 and RSV3 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_2_3"));
				return;
			}
			const compressed = (buf[0] & 64) === 64;
			if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
				cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
				return;
			}
			this._fin = (buf[0] & 128) === 128;
			this._opcode = buf[0] & 15;
			this._payloadLength = buf[1] & 127;
			if (this._opcode === 0) {
				if (compressed) {
					cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
					return;
				}
				if (!this._fragmented) {
					cb(this.createError(RangeError, "invalid opcode 0", true, 1002, "WS_ERR_INVALID_OPCODE"));
					return;
				}
				this._opcode = this._fragmented;
			} else if (this._opcode === 1 || this._opcode === 2) {
				if (this._fragmented) {
					cb(this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE"));
					return;
				}
				this._compressed = compressed;
			} else if (this._opcode > 7 && this._opcode < 11) {
				if (!this._fin) {
					cb(this.createError(RangeError, "FIN must be set", true, 1002, "WS_ERR_EXPECTED_FIN"));
					return;
				}
				if (compressed) {
					cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
					return;
				}
				if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
					cb(this.createError(RangeError, `invalid payload length ${this._payloadLength}`, true, 1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"));
					return;
				}
			} else {
				cb(this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE"));
				return;
			}
			if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
			this._masked = (buf[1] & 128) === 128;
			if (this._isServer) {
				if (!this._masked) {
					cb(this.createError(RangeError, "MASK must be set", true, 1002, "WS_ERR_EXPECTED_MASK"));
					return;
				}
			} else if (this._masked) {
				cb(this.createError(RangeError, "MASK must be clear", true, 1002, "WS_ERR_UNEXPECTED_MASK"));
				return;
			}
			if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
			else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
			else this.haveLength(cb);
		}
		/**
		* Gets extended payload length (7+16).
		*
		* @param {Function} cb Callback
		* @private
		*/
		getPayloadLength16(cb) {
			if (this._bufferedBytes < 2) {
				this._loop = false;
				return;
			}
			this._payloadLength = this.consume(2).readUInt16BE(0);
			this.haveLength(cb);
		}
		/**
		* Gets extended payload length (7+64).
		*
		* @param {Function} cb Callback
		* @private
		*/
		getPayloadLength64(cb) {
			if (this._bufferedBytes < 8) {
				this._loop = false;
				return;
			}
			const buf = this.consume(8);
			const num = buf.readUInt32BE(0);
			if (num > Math.pow(2, 21) - 1) {
				cb(this.createError(RangeError, "Unsupported WebSocket frame: payload length > 2^53 - 1", false, 1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"));
				return;
			}
			this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
			this.haveLength(cb);
		}
		/**
		* Payload length has been read.
		*
		* @param {Function} cb Callback
		* @private
		*/
		haveLength(cb) {
			if (this._payloadLength && this._opcode < 8) {
				this._totalPayloadLength += this._payloadLength;
				if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
					cb(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
					return;
				}
			}
			if (this._masked) this._state = GET_MASK;
			else this._state = GET_DATA;
		}
		/**
		* Reads mask bytes.
		*
		* @private
		*/
		getMask() {
			if (this._bufferedBytes < 4) {
				this._loop = false;
				return;
			}
			this._mask = this.consume(4);
			this._state = GET_DATA;
		}
		/**
		* Reads data bytes.
		*
		* @param {Function} cb Callback
		* @private
		*/
		getData(cb) {
			let data = EMPTY_BUFFER;
			if (this._payloadLength) {
				if (this._bufferedBytes < this._payloadLength) {
					this._loop = false;
					return;
				}
				data = this.consume(this._payloadLength);
				if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) unmask(data, this._mask);
			}
			if (this._opcode > 7) {
				this.controlMessage(data, cb);
				return;
			}
			if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
				cb(this.createError(RangeError, "Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
				return;
			}
			if (this._compressed) {
				this._state = INFLATING;
				this.decompress(data, cb);
				return;
			}
			if (data.length) {
				this._messageLength = this._totalPayloadLength;
				this._fragments.push(data);
			}
			this.dataMessage(cb);
		}
		/**
		* Decompresses data.
		*
		* @param {Buffer} data Compressed data
		* @param {Function} cb Callback
		* @private
		*/
		decompress(data, cb) {
			this._extensions[PerMessageDeflate.extensionName].decompress(data, this._fin, (err, buf) => {
				if (err) return cb(err);
				if (buf.length) {
					this._messageLength += buf.length;
					if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
						cb(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
						return;
					}
					this._fragments.push(buf);
				}
				this.dataMessage(cb);
				if (this._state === GET_INFO) this.startLoop(cb);
			});
		}
		/**
		* Handles a data message.
		*
		* @param {Function} cb Callback
		* @private
		*/
		dataMessage(cb) {
			if (!this._fin) {
				this._state = GET_INFO;
				return;
			}
			const messageLength = this._messageLength;
			const fragments = this._fragments;
			this._totalPayloadLength = 0;
			this._messageLength = 0;
			this._fragmented = 0;
			this._numFragments = 0;
			this._fragments = [];
			if (this._opcode === 2) {
				let data;
				if (this._binaryType === "nodebuffer") data = concat(fragments, messageLength);
				else if (this._binaryType === "arraybuffer") data = toArrayBuffer(concat(fragments, messageLength));
				else if (this._binaryType === "blob") data = new Blob(fragments);
				else data = fragments;
				if (this._allowSynchronousEvents) {
					this.emit("message", data, true);
					this._state = GET_INFO;
				} else {
					this._state = DEFER_EVENT;
					setImmediate(() => {
						this.emit("message", data, true);
						this._state = GET_INFO;
						this.startLoop(cb);
					});
				}
			} else {
				const buf = concat(fragments, messageLength);
				if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
					cb(this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
					return;
				}
				if (this._state === INFLATING || this._allowSynchronousEvents) {
					this.emit("message", buf, false);
					this._state = GET_INFO;
				} else {
					this._state = DEFER_EVENT;
					setImmediate(() => {
						this.emit("message", buf, false);
						this._state = GET_INFO;
						this.startLoop(cb);
					});
				}
			}
		}
		/**
		* Handles a control message.
		*
		* @param {Buffer} data Data to handle
		* @return {(Error|RangeError|undefined)} A possible error
		* @private
		*/
		controlMessage(data, cb) {
			if (this._opcode === 8) {
				if (data.length === 0) {
					this._loop = false;
					this.emit("conclude", 1005, EMPTY_BUFFER);
					this.end();
				} else {
					const code = data.readUInt16BE(0);
					if (!isValidStatusCode(code)) {
						cb(this.createError(RangeError, `invalid status code ${code}`, true, 1002, "WS_ERR_INVALID_CLOSE_CODE"));
						return;
					}
					const buf = new FastBuffer(data.buffer, data.byteOffset + 2, data.length - 2);
					if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
						cb(this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
						return;
					}
					this._loop = false;
					this.emit("conclude", code, buf);
					this.end();
				}
				this._state = GET_INFO;
				return;
			}
			if (this._allowSynchronousEvents) {
				this.emit(this._opcode === 9 ? "ping" : "pong", data);
				this._state = GET_INFO;
			} else {
				this._state = DEFER_EVENT;
				setImmediate(() => {
					this.emit(this._opcode === 9 ? "ping" : "pong", data);
					this._state = GET_INFO;
					this.startLoop(cb);
				});
			}
		}
		/**
		* Builds an error object.
		*
		* @param {function(new:Error|RangeError)} ErrorCtor The error constructor
		* @param {String} message The error message
		* @param {Boolean} prefix Specifies whether or not to add a default prefix to
		*     `message`
		* @param {Number} statusCode The status code
		* @param {String} errorCode The exposed error code
		* @return {(Error|RangeError)} The error
		* @private
		*/
		createError(ErrorCtor, message, prefix, statusCode, errorCode) {
			this._loop = false;
			this._errored = true;
			const err = new ErrorCtor(prefix ? `Invalid WebSocket frame: ${message}` : message);
			Error.captureStackTrace(err, this.createError);
			err.code = errorCode;
			err[kStatusCode] = statusCode;
			return err;
		}
	};
	module.exports = Receiver;
}));

//#endregion
//#region node_modules/ws/lib/sender.js
var require_sender = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { Duplex: Duplex$3 } = __require("stream");
	const { randomFillSync } = __require("crypto");
	const { types: { isUint8Array } } = __require("util");
	const PerMessageDeflate = require_permessage_deflate();
	const { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
	const { isBlob, isValidStatusCode } = require_validation();
	const { mask: applyMask, toBuffer } = require_buffer_util();
	const kByteLength = Symbol("kByteLength");
	const maskBuffer = Buffer.alloc(4);
	const RANDOM_POOL_SIZE = 8 * 1024;
	let randomPool;
	let randomPoolPointer = RANDOM_POOL_SIZE;
	const DEFAULT = 0;
	const DEFLATING = 1;
	const GET_BLOB_DATA = 2;
	/**
	* HyBi Sender implementation.
	*/
	var Sender = class Sender {
		/**
		* Creates a Sender instance.
		*
		* @param {Duplex} socket The connection socket
		* @param {Object} [extensions] An object containing the negotiated extensions
		* @param {Function} [generateMask] The function used to generate the masking
		*     key
		*/
		constructor(socket, extensions, generateMask) {
			this._extensions = extensions || {};
			if (generateMask) {
				this._generateMask = generateMask;
				this._maskBuffer = Buffer.alloc(4);
			}
			this._socket = socket;
			this._firstFragment = true;
			this._compress = false;
			this._bufferedBytes = 0;
			this._queue = [];
			this._state = DEFAULT;
			this.onerror = NOOP;
			this[kWebSocket] = void 0;
		}
		/**
		* Frames a piece of data according to the HyBi WebSocket protocol.
		*
		* @param {(Buffer|String)} data The data to frame
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @return {(Buffer|String)[]} The framed data
		* @public
		*/
		static frame(data, options) {
			let mask;
			let merge = false;
			let offset = 2;
			let skipMasking = false;
			if (options.mask) {
				mask = options.maskBuffer || maskBuffer;
				if (options.generateMask) options.generateMask(mask);
				else {
					if (randomPoolPointer === RANDOM_POOL_SIZE) {
						/* istanbul ignore else  */
						if (randomPool === void 0) randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
						randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
						randomPoolPointer = 0;
					}
					mask[0] = randomPool[randomPoolPointer++];
					mask[1] = randomPool[randomPoolPointer++];
					mask[2] = randomPool[randomPoolPointer++];
					mask[3] = randomPool[randomPoolPointer++];
				}
				skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
				offset = 6;
			}
			let dataLength;
			if (typeof data === "string") if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) dataLength = options[kByteLength];
			else {
				data = Buffer.from(data);
				dataLength = data.length;
			}
			else {
				dataLength = data.length;
				merge = options.mask && options.readOnly && !skipMasking;
			}
			let payloadLength = dataLength;
			if (dataLength >= 65536) {
				offset += 8;
				payloadLength = 127;
			} else if (dataLength > 125) {
				offset += 2;
				payloadLength = 126;
			}
			const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
			target[0] = options.fin ? options.opcode | 128 : options.opcode;
			if (options.rsv1) target[0] |= 64;
			target[1] = payloadLength;
			if (payloadLength === 126) target.writeUInt16BE(dataLength, 2);
			else if (payloadLength === 127) {
				target[2] = target[3] = 0;
				target.writeUIntBE(dataLength, 4, 6);
			}
			if (!options.mask) return [target, data];
			target[1] |= 128;
			target[offset - 4] = mask[0];
			target[offset - 3] = mask[1];
			target[offset - 2] = mask[2];
			target[offset - 1] = mask[3];
			if (skipMasking) return [target, data];
			if (merge) {
				applyMask(data, mask, target, offset, dataLength);
				return [target];
			}
			applyMask(data, mask, data, 0, dataLength);
			return [target, data];
		}
		/**
		* Sends a close message to the other peer.
		*
		* @param {Number} [code] The status code component of the body
		* @param {(String|Buffer)} [data] The message component of the body
		* @param {Boolean} [mask=false] Specifies whether or not to mask the message
		* @param {Function} [cb] Callback
		* @public
		*/
		close(code, data, mask, cb) {
			let buf;
			if (code === void 0) buf = EMPTY_BUFFER;
			else if (typeof code !== "number" || !isValidStatusCode(code)) throw new TypeError("First argument must be a valid error code number");
			else if (data === void 0 || !data.length) {
				buf = Buffer.allocUnsafe(2);
				buf.writeUInt16BE(code, 0);
			} else {
				const length = Buffer.byteLength(data);
				if (length > 123) throw new RangeError("The message must not be greater than 123 bytes");
				buf = Buffer.allocUnsafe(2 + length);
				buf.writeUInt16BE(code, 0);
				if (typeof data === "string") buf.write(data, 2);
				else if (isUint8Array(data)) buf.set(data, 2);
				else throw new TypeError("Second argument must be a string or a Uint8Array");
			}
			const options = {
				[kByteLength]: buf.length,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 8,
				readOnly: false,
				rsv1: false
			};
			if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				buf,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender.frame(buf, options), cb);
		}
		/**
		* Sends a ping message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Boolean} [mask=false] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		ping(data, mask, cb) {
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer(data);
				byteLength = data.length;
				readOnly = toBuffer.readOnly;
			}
			if (byteLength > 125) throw new RangeError("The data size must not be greater than 125 bytes");
			const options = {
				[kByteLength]: byteLength,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 9,
				readOnly,
				rsv1: false
			};
			if (isBlob(data)) if (this._state !== DEFAULT) this.enqueue([
				this.getBlobData,
				data,
				false,
				options,
				cb
			]);
			else this.getBlobData(data, false, options, cb);
			else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender.frame(data, options), cb);
		}
		/**
		* Sends a pong message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Boolean} [mask=false] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		pong(data, mask, cb) {
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer(data);
				byteLength = data.length;
				readOnly = toBuffer.readOnly;
			}
			if (byteLength > 125) throw new RangeError("The data size must not be greater than 125 bytes");
			const options = {
				[kByteLength]: byteLength,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 10,
				readOnly,
				rsv1: false
			};
			if (isBlob(data)) if (this._state !== DEFAULT) this.enqueue([
				this.getBlobData,
				data,
				false,
				options,
				cb
			]);
			else this.getBlobData(data, false, options, cb);
			else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender.frame(data, options), cb);
		}
		/**
		* Sends a data message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Object} options Options object
		* @param {Boolean} [options.binary=false] Specifies whether `data` is binary
		*     or text
		* @param {Boolean} [options.compress=false] Specifies whether or not to
		*     compress `data`
		* @param {Boolean} [options.fin=false] Specifies whether the fragment is the
		*     last one
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		send(data, options, cb) {
			const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
			let opcode = options.binary ? 2 : 1;
			let rsv1 = options.compress;
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer(data);
				byteLength = data.length;
				readOnly = toBuffer.readOnly;
			}
			if (this._firstFragment) {
				this._firstFragment = false;
				if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) rsv1 = byteLength >= perMessageDeflate._threshold;
				this._compress = rsv1;
			} else {
				rsv1 = false;
				opcode = 0;
			}
			if (options.fin) this._firstFragment = true;
			const opts = {
				[kByteLength]: byteLength,
				fin: options.fin,
				generateMask: this._generateMask,
				mask: options.mask,
				maskBuffer: this._maskBuffer,
				opcode,
				readOnly,
				rsv1
			};
			if (isBlob(data)) if (this._state !== DEFAULT) this.enqueue([
				this.getBlobData,
				data,
				this._compress,
				opts,
				cb
			]);
			else this.getBlobData(data, this._compress, opts, cb);
			else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				this._compress,
				opts,
				cb
			]);
			else this.dispatch(data, this._compress, opts, cb);
		}
		/**
		* Gets the contents of a blob as binary data.
		*
		* @param {Blob} blob The blob
		* @param {Boolean} [compress=false] Specifies whether or not to compress
		*     the data
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @param {Function} [cb] Callback
		* @private
		*/
		getBlobData(blob, compress, options, cb) {
			this._bufferedBytes += options[kByteLength];
			this._state = GET_BLOB_DATA;
			blob.arrayBuffer().then((arrayBuffer) => {
				if (this._socket.destroyed) {
					const err = /* @__PURE__ */ new Error("The socket was closed while the blob was being read");
					process.nextTick(callCallbacks, this, err, cb);
					return;
				}
				this._bufferedBytes -= options[kByteLength];
				const data = toBuffer(arrayBuffer);
				if (!compress) {
					this._state = DEFAULT;
					this.sendFrame(Sender.frame(data, options), cb);
					this.dequeue();
				} else this.dispatch(data, compress, options, cb);
			}).catch((err) => {
				process.nextTick(onError, this, err, cb);
			});
		}
		/**
		* Dispatches a message.
		*
		* @param {(Buffer|String)} data The message to send
		* @param {Boolean} [compress=false] Specifies whether or not to compress
		*     `data`
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @param {Function} [cb] Callback
		* @private
		*/
		dispatch(data, compress, options, cb) {
			if (!compress) {
				this.sendFrame(Sender.frame(data, options), cb);
				return;
			}
			const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
			this._bufferedBytes += options[kByteLength];
			this._state = DEFLATING;
			perMessageDeflate.compress(data, options.fin, (_, buf) => {
				if (this._socket.destroyed) {
					callCallbacks(this, /* @__PURE__ */ new Error("The socket was closed while data was being compressed"), cb);
					return;
				}
				this._bufferedBytes -= options[kByteLength];
				this._state = DEFAULT;
				options.readOnly = false;
				this.sendFrame(Sender.frame(buf, options), cb);
				this.dequeue();
			});
		}
		/**
		* Executes queued send operations.
		*
		* @private
		*/
		dequeue() {
			while (this._state === DEFAULT && this._queue.length) {
				const params = this._queue.shift();
				this._bufferedBytes -= params[3][kByteLength];
				Reflect.apply(params[0], this, params.slice(1));
			}
		}
		/**
		* Enqueues a send operation.
		*
		* @param {Array} params Send operation parameters.
		* @private
		*/
		enqueue(params) {
			this._bufferedBytes += params[3][kByteLength];
			this._queue.push(params);
		}
		/**
		* Sends a frame.
		*
		* @param {(Buffer | String)[]} list The frame to send
		* @param {Function} [cb] Callback
		* @private
		*/
		sendFrame(list, cb) {
			if (list.length === 2) {
				this._socket.cork();
				this._socket.write(list[0]);
				this._socket.write(list[1], cb);
				this._socket.uncork();
			} else this._socket.write(list[0], cb);
		}
	};
	module.exports = Sender;
	/**
	* Calls queued callbacks with an error.
	*
	* @param {Sender} sender The `Sender` instance
	* @param {Error} err The error to call the callbacks with
	* @param {Function} [cb] The first callback
	* @private
	*/
	function callCallbacks(sender, err, cb) {
		if (typeof cb === "function") cb(err);
		for (let i = 0; i < sender._queue.length; i++) {
			const params = sender._queue[i];
			const callback = params[params.length - 1];
			if (typeof callback === "function") callback(err);
		}
	}
	/**
	* Handles a `Sender` error.
	*
	* @param {Sender} sender The `Sender` instance
	* @param {Error} err The error
	* @param {Function} [cb] The first pending callback
	* @private
	*/
	function onError(sender, err, cb) {
		callCallbacks(sender, err, cb);
		sender.onerror(err);
	}
}));

//#endregion
//#region node_modules/ws/lib/event-target.js
var require_event_target = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { kForOnEventAttribute, kListener } = require_constants();
	const kCode = Symbol("kCode");
	const kData = Symbol("kData");
	const kError = Symbol("kError");
	const kMessage = Symbol("kMessage");
	const kReason = Symbol("kReason");
	const kTarget = Symbol("kTarget");
	const kType = Symbol("kType");
	const kWasClean = Symbol("kWasClean");
	/**
	* Class representing an event.
	*/
	var Event = class {
		/**
		* Create a new `Event`.
		*
		* @param {String} type The name of the event
		* @throws {TypeError} If the `type` argument is not specified
		*/
		constructor(type) {
			this[kTarget] = null;
			this[kType] = type;
		}
		/**
		* @type {*}
		*/
		get target() {
			return this[kTarget];
		}
		/**
		* @type {String}
		*/
		get type() {
			return this[kType];
		}
	};
	Object.defineProperty(Event.prototype, "target", { enumerable: true });
	Object.defineProperty(Event.prototype, "type", { enumerable: true });
	/**
	* Class representing a close event.
	*
	* @extends Event
	*/
	var CloseEvent = class extends Event {
		/**
		* Create a new `CloseEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {Number} [options.code=0] The status code explaining why the
		*     connection was closed
		* @param {String} [options.reason=''] A human-readable string explaining why
		*     the connection was closed
		* @param {Boolean} [options.wasClean=false] Indicates whether or not the
		*     connection was cleanly closed
		*/
		constructor(type, options = {}) {
			super(type);
			this[kCode] = options.code === void 0 ? 0 : options.code;
			this[kReason] = options.reason === void 0 ? "" : options.reason;
			this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
		}
		/**
		* @type {Number}
		*/
		get code() {
			return this[kCode];
		}
		/**
		* @type {String}
		*/
		get reason() {
			return this[kReason];
		}
		/**
		* @type {Boolean}
		*/
		get wasClean() {
			return this[kWasClean];
		}
	};
	Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
	Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
	Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
	/**
	* Class representing an error event.
	*
	* @extends Event
	*/
	var ErrorEvent = class extends Event {
		/**
		* Create a new `ErrorEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {*} [options.error=null] The error that generated this event
		* @param {String} [options.message=''] The error message
		*/
		constructor(type, options = {}) {
			super(type);
			this[kError] = options.error === void 0 ? null : options.error;
			this[kMessage] = options.message === void 0 ? "" : options.message;
		}
		/**
		* @type {*}
		*/
		get error() {
			return this[kError];
		}
		/**
		* @type {String}
		*/
		get message() {
			return this[kMessage];
		}
	};
	Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
	Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
	/**
	* Class representing a message event.
	*
	* @extends Event
	*/
	var MessageEvent = class extends Event {
		/**
		* Create a new `MessageEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {*} [options.data=null] The message content
		*/
		constructor(type, options = {}) {
			super(type);
			this[kData] = options.data === void 0 ? null : options.data;
		}
		/**
		* @type {*}
		*/
		get data() {
			return this[kData];
		}
	};
	Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
	/**
	* This provides methods for emulating the `EventTarget` interface. It's not
	* meant to be used directly.
	*
	* @mixin
	*/
	const EventTarget = {
		addEventListener(type, handler, options = {}) {
			for (const listener of this.listeners(type)) if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) return;
			let wrapper;
			if (type === "message") wrapper = function onMessage(data, isBinary) {
				const event = new MessageEvent("message", { data: isBinary ? data : data.toString() });
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else if (type === "close") wrapper = function onClose(code, message) {
				const event = new CloseEvent("close", {
					code,
					reason: message.toString(),
					wasClean: this._closeFrameReceived && this._closeFrameSent
				});
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else if (type === "error") wrapper = function onError(error) {
				const event = new ErrorEvent("error", {
					error,
					message: error.message
				});
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else if (type === "open") wrapper = function onOpen() {
				const event = new Event("open");
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else return;
			wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
			wrapper[kListener] = handler;
			if (options.once) this.once(type, wrapper);
			else this.on(type, wrapper);
		},
		removeEventListener(type, handler) {
			for (const listener of this.listeners(type)) if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
				this.removeListener(type, listener);
				break;
			}
		}
	};
	module.exports = {
		CloseEvent,
		ErrorEvent,
		Event,
		EventTarget,
		MessageEvent
	};
	/**
	* Call an event listener
	*
	* @param {(Function|Object)} listener The listener to call
	* @param {*} thisArg The value to use as `this`` when calling the listener
	* @param {Event} event The event to pass to the listener
	* @private
	*/
	function callListener(listener, thisArg, event) {
		if (typeof listener === "object" && listener.handleEvent) listener.handleEvent.call(listener, event);
		else listener.call(thisArg, event);
	}
}));

//#endregion
//#region node_modules/ws/lib/extension.js
var require_extension = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { tokenChars } = require_validation();
	/**
	* Adds an offer to the map of extension offers or a parameter to the map of
	* parameters.
	*
	* @param {Object} dest The map of extension offers or parameters
	* @param {String} name The extension or parameter name
	* @param {(Object|Boolean|String)} elem The extension parameters or the
	*     parameter value
	* @private
	*/
	function push(dest, name, elem) {
		if (dest[name] === void 0) dest[name] = [elem];
		else dest[name].push(elem);
	}
	/**
	* Parses the `Sec-WebSocket-Extensions` header into an object.
	*
	* @param {String} header The field value of the header
	* @return {Object} The parsed object
	* @public
	*/
	function parse(header) {
		const offers = Object.create(null);
		let params = Object.create(null);
		let mustUnescape = false;
		let isEscaping = false;
		let inQuotes = false;
		let extensionName;
		let paramName;
		let start = -1;
		let code = -1;
		let end = -1;
		let i = 0;
		for (; i < header.length; i++) {
			code = header.charCodeAt(i);
			if (extensionName === void 0) if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (i !== 0 && (code === 32 || code === 9)) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				const name = header.slice(start, end);
				if (code === 44) {
					push(offers, name, params);
					params = Object.create(null);
				} else extensionName = name;
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
			else if (paramName === void 0) if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (code === 32 || code === 9) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				push(params, header.slice(start, end), true);
				if (code === 44) {
					push(offers, extensionName, params);
					params = Object.create(null);
					extensionName = void 0;
				}
				start = end = -1;
			} else if (code === 61 && start !== -1 && end === -1) {
				paramName = header.slice(start, i);
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
			else if (isEscaping) {
				if (tokenChars[code] !== 1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (start === -1) start = i;
				else if (!mustUnescape) mustUnescape = true;
				isEscaping = false;
			} else if (inQuotes) if (tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (code === 34 && start !== -1) {
				inQuotes = false;
				end = i;
			} else if (code === 92) isEscaping = true;
			else throw new SyntaxError(`Unexpected character at index ${i}`);
			else if (code === 34 && header.charCodeAt(i - 1) === 61) inQuotes = true;
			else if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (start !== -1 && (code === 32 || code === 9)) {
				if (end === -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				let value = header.slice(start, end);
				if (mustUnescape) {
					value = value.replace(/\\/g, "");
					mustUnescape = false;
				}
				push(params, paramName, value);
				if (code === 44) {
					push(offers, extensionName, params);
					params = Object.create(null);
					extensionName = void 0;
				}
				paramName = void 0;
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
		}
		if (start === -1 || inQuotes || code === 32 || code === 9) throw new SyntaxError("Unexpected end of input");
		if (end === -1) end = i;
		const token = header.slice(start, end);
		if (extensionName === void 0) push(offers, token, params);
		else {
			if (paramName === void 0) push(params, token, true);
			else if (mustUnescape) push(params, paramName, token.replace(/\\/g, ""));
			else push(params, paramName, token);
			push(offers, extensionName, params);
		}
		return offers;
	}
	/**
	* Builds the `Sec-WebSocket-Extensions` header field value.
	*
	* @param {Object} extensions The map of extensions and parameters to format
	* @return {String} A string representing the given object
	* @public
	*/
	function format(extensions) {
		return Object.keys(extensions).map((extension) => {
			let configurations = extensions[extension];
			if (!Array.isArray(configurations)) configurations = [configurations];
			return configurations.map((params) => {
				return [extension].concat(Object.keys(params).map((k) => {
					let values = params[k];
					if (!Array.isArray(values)) values = [values];
					return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
				})).join("; ");
			}).join(", ");
		}).join(", ");
	}
	module.exports = {
		format,
		parse
	};
}));

//#endregion
//#region node_modules/ws/lib/websocket.js
var require_websocket = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter$1 = __require("events");
	const https$1 = __require("https");
	const http$1 = __require("http");
	const net$1 = __require("net");
	const tls$1 = __require("tls");
	const { randomBytes: randomBytes$1, createHash: createHash$2 } = __require("crypto");
	const { Duplex: Duplex$2, Readable } = __require("stream");
	const { URL: URL$1 } = __require("url");
	const PerMessageDeflate = require_permessage_deflate();
	const Receiver = require_receiver();
	const Sender = require_sender();
	const { isBlob } = require_validation();
	const { BINARY_TYPES, CLOSE_TIMEOUT, EMPTY_BUFFER, GUID, kForOnEventAttribute, kListener, kStatusCode, kWebSocket, NOOP } = require_constants();
	const { EventTarget: { addEventListener, removeEventListener } } = require_event_target();
	const { format, parse } = require_extension();
	const { toBuffer } = require_buffer_util();
	const kAborted = Symbol("kAborted");
	const protocolVersions = [8, 13];
	const readyStates = [
		"CONNECTING",
		"OPEN",
		"CLOSING",
		"CLOSED"
	];
	const subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
	/**
	* Class representing a WebSocket.
	*
	* @extends EventEmitter
	*/
	var WebSocket = class WebSocket extends EventEmitter$1 {
		/**
		* Create a new `WebSocket`.
		*
		* @param {(String|URL)} address The URL to which to connect
		* @param {(String|String[])} [protocols] The subprotocols
		* @param {Object} [options] Connection options
		*/
		constructor(address, protocols, options) {
			super();
			this._binaryType = BINARY_TYPES[0];
			this._closeCode = 1006;
			this._closeFrameReceived = false;
			this._closeFrameSent = false;
			this._closeMessage = EMPTY_BUFFER;
			this._closeTimer = null;
			this._errorEmitted = false;
			this._extensions = {};
			this._paused = false;
			this._protocol = "";
			this._readyState = WebSocket.CONNECTING;
			this._receiver = null;
			this._sender = null;
			this._socket = null;
			if (address !== null) {
				this._bufferedAmount = 0;
				this._isServer = false;
				this._redirects = 0;
				if (protocols === void 0) protocols = [];
				else if (!Array.isArray(protocols)) if (typeof protocols === "object" && protocols !== null) {
					options = protocols;
					protocols = [];
				} else protocols = [protocols];
				initAsClient(this, address, protocols, options);
			} else {
				this._autoPong = options.autoPong;
				this._closeTimeout = options.closeTimeout;
				this._isServer = true;
			}
		}
		/**
		* For historical reasons, the custom "nodebuffer" type is used by the default
		* instead of "blob".
		*
		* @type {String}
		*/
		get binaryType() {
			return this._binaryType;
		}
		set binaryType(type) {
			if (!BINARY_TYPES.includes(type)) return;
			this._binaryType = type;
			if (this._receiver) this._receiver._binaryType = type;
		}
		/**
		* @type {Number}
		*/
		get bufferedAmount() {
			if (!this._socket) return this._bufferedAmount;
			return this._socket._writableState.length + this._sender._bufferedBytes;
		}
		/**
		* @type {String}
		*/
		get extensions() {
			return Object.keys(this._extensions).join();
		}
		/**
		* @type {Boolean}
		*/
		get isPaused() {
			return this._paused;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onclose() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onerror() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onopen() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onmessage() {
			return null;
		}
		/**
		* @type {String}
		*/
		get protocol() {
			return this._protocol;
		}
		/**
		* @type {Number}
		*/
		get readyState() {
			return this._readyState;
		}
		/**
		* @type {String}
		*/
		get url() {
			return this._url;
		}
		/**
		* Set up the socket and the internal resources.
		*
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Object} options Options object
		* @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Number} [options.maxBufferedChunks=0] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=0] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=0] The maximum allowed message size
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		* @private
		*/
		setSocket(socket, head, options) {
			const receiver = new Receiver({
				allowSynchronousEvents: options.allowSynchronousEvents,
				binaryType: this.binaryType,
				extensions: this._extensions,
				isServer: this._isServer,
				maxBufferedChunks: options.maxBufferedChunks,
				maxFragments: options.maxFragments,
				maxPayload: options.maxPayload,
				skipUTF8Validation: options.skipUTF8Validation
			});
			const sender = new Sender(socket, this._extensions, options.generateMask);
			this._receiver = receiver;
			this._sender = sender;
			this._socket = socket;
			receiver[kWebSocket] = this;
			sender[kWebSocket] = this;
			socket[kWebSocket] = this;
			receiver.on("conclude", receiverOnConclude);
			receiver.on("drain", receiverOnDrain);
			receiver.on("error", receiverOnError);
			receiver.on("message", receiverOnMessage);
			receiver.on("ping", receiverOnPing);
			receiver.on("pong", receiverOnPong);
			sender.onerror = senderOnError;
			if (socket.setTimeout) socket.setTimeout(0);
			if (socket.setNoDelay) socket.setNoDelay();
			if (head.length > 0) socket.unshift(head);
			socket.on("close", socketOnClose);
			socket.on("data", socketOnData);
			socket.on("end", socketOnEnd);
			socket.on("error", socketOnError);
			this._readyState = WebSocket.OPEN;
			this.emit("open");
		}
		/**
		* Emit the `'close'` event.
		*
		* @private
		*/
		emitClose() {
			if (!this._socket) {
				this._readyState = WebSocket.CLOSED;
				this.emit("close", this._closeCode, this._closeMessage);
				return;
			}
			if (this._extensions[PerMessageDeflate.extensionName]) this._extensions[PerMessageDeflate.extensionName].cleanup();
			this._receiver.removeAllListeners();
			this._readyState = WebSocket.CLOSED;
			this.emit("close", this._closeCode, this._closeMessage);
		}
		/**
		* Start a closing handshake.
		*
		*          +----------+   +-----------+   +----------+
		*     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
		*    |     +----------+   +-----------+   +----------+     |
		*          +----------+   +-----------+         |
		* CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
		*          +----------+   +-----------+   |
		*    |           |                        |   +---+        |
		*                +------------------------+-->|fin| - - - -
		*    |         +---+                      |   +---+
		*     - - - - -|fin|<---------------------+
		*              +---+
		*
		* @param {Number} [code] Status code explaining why the connection is closing
		* @param {(String|Buffer)} [data] The reason why the connection is
		*     closing
		* @public
		*/
		close(code, data) {
			if (this.readyState === WebSocket.CLOSED) return;
			if (this.readyState === WebSocket.CONNECTING) {
				abortHandshake(this, this._req, "WebSocket was closed before the connection was established");
				return;
			}
			if (this.readyState === WebSocket.CLOSING) {
				if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) this._socket.end();
				return;
			}
			this._readyState = WebSocket.CLOSING;
			this._sender.close(code, data, !this._isServer, (err) => {
				if (err) return;
				this._closeFrameSent = true;
				if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) this._socket.end();
			});
			setCloseTimer(this);
		}
		/**
		* Pause the socket.
		*
		* @public
		*/
		pause() {
			if (this.readyState === WebSocket.CONNECTING || this.readyState === WebSocket.CLOSED) return;
			this._paused = true;
			this._socket.pause();
		}
		/**
		* Send a ping.
		*
		* @param {*} [data] The data to send
		* @param {Boolean} [mask] Indicates whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when the ping is sent
		* @public
		*/
		ping(data, mask, cb) {
			if (this.readyState === WebSocket.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof data === "function") {
				cb = data;
				data = mask = void 0;
			} else if (typeof mask === "function") {
				cb = mask;
				mask = void 0;
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			if (mask === void 0) mask = !this._isServer;
			this._sender.ping(data || EMPTY_BUFFER, mask, cb);
		}
		/**
		* Send a pong.
		*
		* @param {*} [data] The data to send
		* @param {Boolean} [mask] Indicates whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when the pong is sent
		* @public
		*/
		pong(data, mask, cb) {
			if (this.readyState === WebSocket.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof data === "function") {
				cb = data;
				data = mask = void 0;
			} else if (typeof mask === "function") {
				cb = mask;
				mask = void 0;
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			if (mask === void 0) mask = !this._isServer;
			this._sender.pong(data || EMPTY_BUFFER, mask, cb);
		}
		/**
		* Resume the socket.
		*
		* @public
		*/
		resume() {
			if (this.readyState === WebSocket.CONNECTING || this.readyState === WebSocket.CLOSED) return;
			this._paused = false;
			if (!this._receiver._writableState.needDrain) this._socket.resume();
		}
		/**
		* Send a data message.
		*
		* @param {*} data The message to send
		* @param {Object} [options] Options object
		* @param {Boolean} [options.binary] Specifies whether `data` is binary or
		*     text
		* @param {Boolean} [options.compress] Specifies whether or not to compress
		*     `data`
		* @param {Boolean} [options.fin=true] Specifies whether the fragment is the
		*     last one
		* @param {Boolean} [options.mask] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when data is written out
		* @public
		*/
		send(data, options, cb) {
			if (this.readyState === WebSocket.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof options === "function") {
				cb = options;
				options = {};
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			const opts = {
				binary: typeof data !== "string",
				mask: !this._isServer,
				compress: true,
				fin: true,
				...options
			};
			if (!this._extensions[PerMessageDeflate.extensionName]) opts.compress = false;
			this._sender.send(data || EMPTY_BUFFER, opts, cb);
		}
		/**
		* Forcibly close the connection.
		*
		* @public
		*/
		terminate() {
			if (this.readyState === WebSocket.CLOSED) return;
			if (this.readyState === WebSocket.CONNECTING) {
				abortHandshake(this, this._req, "WebSocket was closed before the connection was established");
				return;
			}
			if (this._socket) {
				this._readyState = WebSocket.CLOSING;
				this._socket.destroy();
			}
		}
	};
	/**
	* @constant {Number} CONNECTING
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "CONNECTING", {
		enumerable: true,
		value: readyStates.indexOf("CONNECTING")
	});
	/**
	* @constant {Number} CONNECTING
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "CONNECTING", {
		enumerable: true,
		value: readyStates.indexOf("CONNECTING")
	});
	/**
	* @constant {Number} OPEN
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "OPEN", {
		enumerable: true,
		value: readyStates.indexOf("OPEN")
	});
	/**
	* @constant {Number} OPEN
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "OPEN", {
		enumerable: true,
		value: readyStates.indexOf("OPEN")
	});
	/**
	* @constant {Number} CLOSING
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "CLOSING", {
		enumerable: true,
		value: readyStates.indexOf("CLOSING")
	});
	/**
	* @constant {Number} CLOSING
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "CLOSING", {
		enumerable: true,
		value: readyStates.indexOf("CLOSING")
	});
	/**
	* @constant {Number} CLOSED
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "CLOSED", {
		enumerable: true,
		value: readyStates.indexOf("CLOSED")
	});
	/**
	* @constant {Number} CLOSED
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "CLOSED", {
		enumerable: true,
		value: readyStates.indexOf("CLOSED")
	});
	[
		"binaryType",
		"bufferedAmount",
		"extensions",
		"isPaused",
		"protocol",
		"readyState",
		"url"
	].forEach((property) => {
		Object.defineProperty(WebSocket.prototype, property, { enumerable: true });
	});
	[
		"open",
		"error",
		"close",
		"message"
	].forEach((method) => {
		Object.defineProperty(WebSocket.prototype, `on${method}`, {
			enumerable: true,
			get() {
				for (const listener of this.listeners(method)) if (listener[kForOnEventAttribute]) return listener[kListener];
				return null;
			},
			set(handler) {
				for (const listener of this.listeners(method)) if (listener[kForOnEventAttribute]) {
					this.removeListener(method, listener);
					break;
				}
				if (typeof handler !== "function") return;
				this.addEventListener(method, handler, { [kForOnEventAttribute]: true });
			}
		});
	});
	WebSocket.prototype.addEventListener = addEventListener;
	WebSocket.prototype.removeEventListener = removeEventListener;
	module.exports = WebSocket;
	/**
	* Initialize a WebSocket client.
	*
	* @param {WebSocket} websocket The client to initialize
	* @param {(String|URL)} address The URL to which to connect
	* @param {Array} protocols The subprotocols
	* @param {Object} [options] Connection options
	* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether any
	*     of the `'message'`, `'ping'`, and `'pong'` events can be emitted multiple
	*     times in the same tick
	* @param {Boolean} [options.autoPong=true] Specifies whether or not to
	*     automatically send a pong in response to a ping
	* @param {Number} [options.closeTimeout=30000] Duration in milliseconds to wait
	*     for the closing handshake to finish after `websocket.close()` is called
	* @param {Function} [options.finishRequest] A function which can be used to
	*     customize the headers of each http request before it is sent
	* @param {Boolean} [options.followRedirects=false] Whether or not to follow
	*     redirects
	* @param {Function} [options.generateMask] The function used to generate the
	*     masking key
	* @param {Number} [options.handshakeTimeout] Timeout in milliseconds for the
	*     handshake request
	* @param {Number} [options.maxBufferedChunks=262144] The maximum number of
	*     buffered data chunks
	* @param {Number} [options.maxFragments=16384] The maximum number of message
	*     fragments
	* @param {Number} [options.maxPayload=104857600] The maximum allowed message
	*     size
	* @param {Number} [options.maxRedirects=10] The maximum number of redirects
	*     allowed
	* @param {String} [options.origin] Value of the `Origin` or
	*     `Sec-WebSocket-Origin` header
	* @param {(Boolean|Object)} [options.perMessageDeflate=true] Enable/disable
	*     permessage-deflate
	* @param {Number} [options.protocolVersion=13] Value of the
	*     `Sec-WebSocket-Version` header
	* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
	*     not to skip UTF-8 validation for text and close messages
	* @private
	*/
	function initAsClient(websocket, address, protocols, options) {
		const opts = {
			allowSynchronousEvents: true,
			autoPong: true,
			closeTimeout: CLOSE_TIMEOUT,
			protocolVersion: protocolVersions[1],
			maxBufferedChunks: 256 * 1024,
			maxFragments: 16 * 1024,
			maxPayload: 100 * 1024 * 1024,
			skipUTF8Validation: false,
			perMessageDeflate: true,
			followRedirects: false,
			maxRedirects: 10,
			...options,
			socketPath: void 0,
			hostname: void 0,
			protocol: void 0,
			timeout: void 0,
			method: "GET",
			host: void 0,
			path: void 0,
			port: void 0
		};
		websocket._autoPong = opts.autoPong;
		websocket._closeTimeout = opts.closeTimeout;
		if (!protocolVersions.includes(opts.protocolVersion)) throw new RangeError(`Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`);
		let parsedUrl;
		if (address instanceof URL$1) parsedUrl = address;
		else try {
			parsedUrl = new URL$1(address);
		} catch {
			throw new SyntaxError(`Invalid URL: ${address}`);
		}
		if (parsedUrl.protocol === "http:") parsedUrl.protocol = "ws:";
		else if (parsedUrl.protocol === "https:") parsedUrl.protocol = "wss:";
		websocket._url = parsedUrl.href;
		const isSecure = parsedUrl.protocol === "wss:";
		const isIpcUrl = parsedUrl.protocol === "ws+unix:";
		let invalidUrlMessage;
		if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) invalidUrlMessage = "The URL's protocol must be one of \"ws:\", \"wss:\", \"http:\", \"https:\", or \"ws+unix:\"";
		else if (isIpcUrl && !parsedUrl.pathname) invalidUrlMessage = "The URL's pathname is empty";
		else if (parsedUrl.hash) invalidUrlMessage = "The URL contains a fragment identifier";
		if (invalidUrlMessage) {
			const err = new SyntaxError(invalidUrlMessage);
			if (websocket._redirects === 0) throw err;
			else {
				emitErrorAndClose(websocket, err);
				return;
			}
		}
		const defaultPort = isSecure ? 443 : 80;
		const key = randomBytes$1(16).toString("base64");
		const request = isSecure ? https$1.request : http$1.request;
		const protocolSet = /* @__PURE__ */ new Set();
		let perMessageDeflate;
		opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
		opts.defaultPort = opts.defaultPort || defaultPort;
		opts.port = parsedUrl.port || defaultPort;
		opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
		opts.headers = {
			...opts.headers,
			"Sec-WebSocket-Version": opts.protocolVersion,
			"Sec-WebSocket-Key": key,
			Connection: "Upgrade",
			Upgrade: "websocket"
		};
		opts.path = parsedUrl.pathname + parsedUrl.search;
		opts.timeout = opts.handshakeTimeout;
		if (opts.perMessageDeflate) {
			perMessageDeflate = new PerMessageDeflate({
				...opts.perMessageDeflate,
				isServer: false,
				maxPayload: opts.maxPayload
			});
			opts.headers["Sec-WebSocket-Extensions"] = format({ [PerMessageDeflate.extensionName]: perMessageDeflate.offer() });
		}
		if (protocols.length) {
			for (const protocol of protocols) {
				if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) throw new SyntaxError("An invalid or duplicated subprotocol was specified");
				protocolSet.add(protocol);
			}
			opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
		}
		if (opts.origin) if (opts.protocolVersion < 13) opts.headers["Sec-WebSocket-Origin"] = opts.origin;
		else opts.headers.Origin = opts.origin;
		if (parsedUrl.username || parsedUrl.password) opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
		if (isIpcUrl) {
			const parts = opts.path.split(":");
			opts.socketPath = parts[0];
			opts.path = parts[1];
		}
		let req;
		if (opts.followRedirects) {
			if (websocket._redirects === 0) {
				websocket._originalIpc = isIpcUrl;
				websocket._originalSecure = isSecure;
				websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
				const headers = options && options.headers;
				options = {
					...options,
					headers: {}
				};
				if (headers) for (const [key, value] of Object.entries(headers)) options.headers[key.toLowerCase()] = value;
			} else if (websocket.listenerCount("redirect") === 0) {
				const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
				if (!isSameHost || websocket._originalSecure && !isSecure) {
					delete opts.headers.authorization;
					delete opts.headers.cookie;
					if (!isSameHost) delete opts.headers.host;
					opts.auth = void 0;
				}
			}
			if (opts.auth && !options.headers.authorization) options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
			req = websocket._req = request(opts);
			if (websocket._redirects) websocket.emit("redirect", websocket.url, req);
		} else req = websocket._req = request(opts);
		if (opts.timeout) req.on("timeout", () => {
			abortHandshake(websocket, req, "Opening handshake has timed out");
		});
		req.on("error", (err) => {
			if (req === null || req[kAborted]) return;
			req = websocket._req = null;
			emitErrorAndClose(websocket, err);
		});
		req.on("response", (res) => {
			const location = res.headers.location;
			const statusCode = res.statusCode;
			if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
				if (++websocket._redirects > opts.maxRedirects) {
					abortHandshake(websocket, req, "Maximum redirects exceeded");
					return;
				}
				req.abort();
				let addr;
				try {
					addr = new URL$1(location, address);
				} catch (e) {
					emitErrorAndClose(websocket, /* @__PURE__ */ new SyntaxError(`Invalid URL: ${location}`));
					return;
				}
				initAsClient(websocket, addr, protocols, options);
			} else if (!websocket.emit("unexpected-response", req, res)) abortHandshake(websocket, req, `Unexpected server response: ${res.statusCode}`);
		});
		req.on("upgrade", (res, socket, head) => {
			websocket.emit("upgrade", res);
			if (websocket.readyState !== WebSocket.CONNECTING) return;
			req = websocket._req = null;
			const upgrade = res.headers.upgrade;
			if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
				abortHandshake(websocket, socket, "Invalid Upgrade header");
				return;
			}
			const digest = createHash$2("sha1").update(key + GUID).digest("base64");
			if (res.headers["sec-websocket-accept"] !== digest) {
				abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
				return;
			}
			const serverProt = res.headers["sec-websocket-protocol"];
			let protError;
			if (serverProt !== void 0) {
				if (!protocolSet.size) protError = "Server sent a subprotocol but none was requested";
				else if (!protocolSet.has(serverProt)) protError = "Server sent an invalid subprotocol";
			} else if (protocolSet.size) protError = "Server sent no subprotocol";
			if (protError) {
				abortHandshake(websocket, socket, protError);
				return;
			}
			if (serverProt) websocket._protocol = serverProt;
			const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
			if (secWebSocketExtensions !== void 0) {
				if (!perMessageDeflate) {
					abortHandshake(websocket, socket, "Server sent a Sec-WebSocket-Extensions header but no extension was requested");
					return;
				}
				let extensions;
				try {
					extensions = parse(secWebSocketExtensions);
				} catch (err) {
					abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Extensions header");
					return;
				}
				const extensionNames = Object.keys(extensions);
				if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
					abortHandshake(websocket, socket, "Server indicated an extension that was not requested");
					return;
				}
				try {
					perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
				} catch (err) {
					abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Extensions header");
					return;
				}
				websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
			}
			websocket.setSocket(socket, head, {
				allowSynchronousEvents: opts.allowSynchronousEvents,
				generateMask: opts.generateMask,
				maxBufferedChunks: opts.maxBufferedChunks,
				maxFragments: opts.maxFragments,
				maxPayload: opts.maxPayload,
				skipUTF8Validation: opts.skipUTF8Validation
			});
		});
		if (opts.finishRequest) opts.finishRequest(req, websocket);
		else req.end();
	}
	/**
	* Emit the `'error'` and `'close'` events.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {Error} The error to emit
	* @private
	*/
	function emitErrorAndClose(websocket, err) {
		websocket._readyState = WebSocket.CLOSING;
		websocket._errorEmitted = true;
		websocket.emit("error", err);
		websocket.emitClose();
	}
	/**
	* Create a `net.Socket` and initiate a connection.
	*
	* @param {Object} options Connection options
	* @return {net.Socket} The newly created socket used to start the connection
	* @private
	*/
	function netConnect(options) {
		options.path = options.socketPath;
		return net$1.connect(options);
	}
	/**
	* Create a `tls.TLSSocket` and initiate a connection.
	*
	* @param {Object} options Connection options
	* @return {tls.TLSSocket} The newly created socket used to start the connection
	* @private
	*/
	function tlsConnect(options) {
		options.path = void 0;
		if (!options.servername && options.servername !== "") options.servername = net$1.isIP(options.host) ? "" : options.host;
		return tls$1.connect(options);
	}
	/**
	* Abort the handshake and emit an error.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {(http.ClientRequest|net.Socket|tls.Socket)} stream The request to
	*     abort or the socket to destroy
	* @param {String} message The error message
	* @private
	*/
	function abortHandshake(websocket, stream, message) {
		websocket._readyState = WebSocket.CLOSING;
		const err = new Error(message);
		Error.captureStackTrace(err, abortHandshake);
		if (stream.setHeader) {
			stream[kAborted] = true;
			stream.abort();
			if (stream.socket && !stream.socket.destroyed) stream.socket.destroy();
			process.nextTick(emitErrorAndClose, websocket, err);
		} else {
			stream.destroy(err);
			stream.once("error", websocket.emit.bind(websocket, "error"));
			stream.once("close", websocket.emitClose.bind(websocket));
		}
	}
	/**
	* Handle cases where the `ping()`, `pong()`, or `send()` methods are called
	* when the `readyState` attribute is `CLOSING` or `CLOSED`.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {*} [data] The data to send
	* @param {Function} [cb] Callback
	* @private
	*/
	function sendAfterClose(websocket, data, cb) {
		if (data) {
			const length = isBlob(data) ? data.size : toBuffer(data).length;
			if (websocket._socket) websocket._sender._bufferedBytes += length;
			else websocket._bufferedAmount += length;
		}
		if (cb) {
			const err = /* @__PURE__ */ new Error(`WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`);
			process.nextTick(cb, err);
		}
	}
	/**
	* The listener of the `Receiver` `'conclude'` event.
	*
	* @param {Number} code The status code
	* @param {Buffer} reason The reason for closing
	* @private
	*/
	function receiverOnConclude(code, reason) {
		const websocket = this[kWebSocket];
		websocket._closeFrameReceived = true;
		websocket._closeMessage = reason;
		websocket._closeCode = code;
		if (websocket._socket[kWebSocket] === void 0) return;
		websocket._socket.removeListener("data", socketOnData);
		process.nextTick(resume, websocket._socket);
		if (code === 1005) websocket.close();
		else websocket.close(code, reason);
	}
	/**
	* The listener of the `Receiver` `'drain'` event.
	*
	* @private
	*/
	function receiverOnDrain() {
		const websocket = this[kWebSocket];
		if (!websocket.isPaused) websocket._socket.resume();
	}
	/**
	* The listener of the `Receiver` `'error'` event.
	*
	* @param {(RangeError|Error)} err The emitted error
	* @private
	*/
	function receiverOnError(err) {
		const websocket = this[kWebSocket];
		if (websocket._socket[kWebSocket] !== void 0) {
			websocket._socket.removeListener("data", socketOnData);
			process.nextTick(resume, websocket._socket);
			websocket.close(err[kStatusCode]);
		}
		if (!websocket._errorEmitted) {
			websocket._errorEmitted = true;
			websocket.emit("error", err);
		}
	}
	/**
	* The listener of the `Receiver` `'finish'` event.
	*
	* @private
	*/
	function receiverOnFinish() {
		this[kWebSocket].emitClose();
	}
	/**
	* The listener of the `Receiver` `'message'` event.
	*
	* @param {Buffer|ArrayBuffer|Buffer[])} data The message
	* @param {Boolean} isBinary Specifies whether the message is binary or not
	* @private
	*/
	function receiverOnMessage(data, isBinary) {
		this[kWebSocket].emit("message", data, isBinary);
	}
	/**
	* The listener of the `Receiver` `'ping'` event.
	*
	* @param {Buffer} data The data included in the ping frame
	* @private
	*/
	function receiverOnPing(data) {
		const websocket = this[kWebSocket];
		if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
		websocket.emit("ping", data);
	}
	/**
	* The listener of the `Receiver` `'pong'` event.
	*
	* @param {Buffer} data The data included in the pong frame
	* @private
	*/
	function receiverOnPong(data) {
		this[kWebSocket].emit("pong", data);
	}
	/**
	* Resume a readable stream
	*
	* @param {Readable} stream The readable stream
	* @private
	*/
	function resume(stream) {
		stream.resume();
	}
	/**
	* The `Sender` error event handler.
	*
	* @param {Error} The error
	* @private
	*/
	function senderOnError(err) {
		const websocket = this[kWebSocket];
		if (websocket.readyState === WebSocket.CLOSED) return;
		if (websocket.readyState === WebSocket.OPEN) {
			websocket._readyState = WebSocket.CLOSING;
			setCloseTimer(websocket);
		}
		this._socket.end();
		if (!websocket._errorEmitted) {
			websocket._errorEmitted = true;
			websocket.emit("error", err);
		}
	}
	/**
	* Set a timer to destroy the underlying raw socket of a WebSocket.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @private
	*/
	function setCloseTimer(websocket) {
		websocket._closeTimer = setTimeout(websocket._socket.destroy.bind(websocket._socket), websocket._closeTimeout);
	}
	/**
	* The listener of the socket `'close'` event.
	*
	* @private
	*/
	function socketOnClose() {
		const websocket = this[kWebSocket];
		this.removeListener("close", socketOnClose);
		this.removeListener("data", socketOnData);
		this.removeListener("end", socketOnEnd);
		websocket._readyState = WebSocket.CLOSING;
		if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
			const chunk = this.read(this._readableState.length);
			websocket._receiver.write(chunk);
		}
		websocket._receiver.end();
		this[kWebSocket] = void 0;
		clearTimeout(websocket._closeTimer);
		if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) websocket.emitClose();
		else {
			websocket._receiver.on("error", receiverOnFinish);
			websocket._receiver.on("finish", receiverOnFinish);
		}
	}
	/**
	* The listener of the socket `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function socketOnData(chunk) {
		if (!this[kWebSocket]._receiver.write(chunk)) this.pause();
	}
	/**
	* The listener of the socket `'end'` event.
	*
	* @private
	*/
	function socketOnEnd() {
		const websocket = this[kWebSocket];
		websocket._readyState = WebSocket.CLOSING;
		websocket._receiver.end();
		this.end();
	}
	/**
	* The listener of the socket `'error'` event.
	*
	* @private
	*/
	function socketOnError() {
		const websocket = this[kWebSocket];
		this.removeListener("error", socketOnError);
		this.on("error", NOOP);
		if (websocket) {
			websocket._readyState = WebSocket.CLOSING;
			this.destroy();
		}
	}
}));

//#endregion
//#region node_modules/ws/lib/stream.js
var require_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	require_websocket();
	const { Duplex: Duplex$1 } = __require("stream");
	/**
	* Emits the `'close'` event on a stream.
	*
	* @param {Duplex} stream The stream.
	* @private
	*/
	function emitClose(stream) {
		stream.emit("close");
	}
	/**
	* The listener of the `'end'` event.
	*
	* @private
	*/
	function duplexOnEnd() {
		if (!this.destroyed && this._writableState.finished) this.destroy();
	}
	/**
	* The listener of the `'error'` event.
	*
	* @param {Error} err The error
	* @private
	*/
	function duplexOnError(err) {
		this.removeListener("error", duplexOnError);
		this.destroy();
		if (this.listenerCount("error") === 0) this.emit("error", err);
	}
	/**
	* Wraps a `WebSocket` in a duplex stream.
	*
	* @param {WebSocket} ws The `WebSocket` to wrap
	* @param {Object} [options] The options for the `Duplex` constructor
	* @return {Duplex} The duplex stream
	* @public
	*/
	function createWebSocketStream(ws, options) {
		let terminateOnDestroy = true;
		const duplex = new Duplex$1({
			...options,
			autoDestroy: false,
			emitClose: false,
			objectMode: false,
			writableObjectMode: false
		});
		ws.on("message", function message(msg, isBinary) {
			const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
			if (!duplex.push(data)) ws.pause();
		});
		ws.once("error", function error(err) {
			if (duplex.destroyed) return;
			terminateOnDestroy = false;
			duplex.destroy(err);
		});
		ws.once("close", function close() {
			if (duplex.destroyed) return;
			duplex.push(null);
		});
		duplex._destroy = function(err, callback) {
			if (ws.readyState === ws.CLOSED) {
				callback(err);
				process.nextTick(emitClose, duplex);
				return;
			}
			let called = false;
			ws.once("error", function error(err) {
				called = true;
				callback(err);
			});
			ws.once("close", function close() {
				if (!called) callback(err);
				process.nextTick(emitClose, duplex);
			});
			if (terminateOnDestroy) ws.terminate();
		};
		duplex._final = function(callback) {
			if (ws.readyState === ws.CONNECTING) {
				ws.once("open", function open() {
					duplex._final(callback);
				});
				return;
			}
			if (ws._socket === null) return;
			if (ws._socket._writableState.finished) {
				callback();
				if (duplex._readableState.endEmitted) duplex.destroy();
			} else {
				ws._socket.once("finish", function finish() {
					callback();
				});
				ws.close();
			}
		};
		duplex._read = function() {
			if (ws.isPaused) ws.resume();
		};
		duplex._write = function(chunk, encoding, callback) {
			if (ws.readyState === ws.CONNECTING) {
				ws.once("open", function open() {
					duplex._write(chunk, encoding, callback);
				});
				return;
			}
			ws.send(chunk, callback);
		};
		duplex.on("end", duplexOnEnd);
		duplex.on("error", duplexOnError);
		return duplex;
	}
	module.exports = createWebSocketStream;
}));

//#endregion
//#region node_modules/ws/lib/subprotocol.js
var require_subprotocol = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { tokenChars } = require_validation();
	/**
	* Parses the `Sec-WebSocket-Protocol` header into a set of subprotocol names.
	*
	* @param {String} header The field value of the header
	* @return {Set} The subprotocol names
	* @public
	*/
	function parse(header) {
		const protocols = /* @__PURE__ */ new Set();
		let start = -1;
		let end = -1;
		let i = 0;
		for (; i < header.length; i++) {
			const code = header.charCodeAt(i);
			if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (i !== 0 && (code === 32 || code === 9)) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				const protocol = header.slice(start, end);
				if (protocols.has(protocol)) throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
				protocols.add(protocol);
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
		}
		if (start === -1 || end !== -1) throw new SyntaxError("Unexpected end of input");
		const protocol = header.slice(start, i);
		if (protocols.has(protocol)) throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
		protocols.add(protocol);
		return protocols;
	}
	module.exports = { parse };
}));

//#endregion
//#region node_modules/ws/lib/websocket-server.js
var require_websocket_server = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter = __require("events");
	const http = __require("http");
	const { Duplex } = __require("stream");
	const { createHash: createHash$1 } = __require("crypto");
	const extension = require_extension();
	const PerMessageDeflate = require_permessage_deflate();
	const subprotocol = require_subprotocol();
	const WebSocket = require_websocket();
	const { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
	const keyRegex = /^[+/0-9A-Za-z]{22}==$/;
	const RUNNING = 0;
	const CLOSING = 1;
	const CLOSED = 2;
	/**
	* Class representing a WebSocket server.
	*
	* @extends EventEmitter
	*/
	var WebSocketServer = class extends EventEmitter {
		/**
		* Create a `WebSocketServer` instance.
		*
		* @param {Object} options Configuration options
		* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {Boolean} [options.autoPong=true] Specifies whether or not to
		*     automatically send a pong in response to a ping
		* @param {Number} [options.backlog=511] The maximum length of the queue of
		*     pending connections
		* @param {Boolean} [options.clientTracking=true] Specifies whether or not to
		*     track clients
		* @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
		*     wait for the closing handshake to finish after `websocket.close()` is
		*     called
		* @param {Function} [options.handleProtocols] A hook to handle protocols
		* @param {String} [options.host] The hostname where to bind the server
		* @param {Number} [options.maxBufferedChunks=262144] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=16384] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=104857600] The maximum allowed message
		*     size
		* @param {Boolean} [options.noServer=false] Enable no server mode
		* @param {String} [options.path] Accept only connections matching this path
		* @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
		*     permessage-deflate
		* @param {Number} [options.port] The port where to bind the server
		* @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
		*     server to use
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		* @param {Function} [options.verifyClient] A hook to reject connections
		* @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
		*     class to use. It must be the `WebSocket` class or class that extends it
		* @param {Function} [callback] A listener for the `listening` event
		*/
		constructor(options, callback) {
			super();
			options = {
				allowSynchronousEvents: true,
				autoPong: true,
				maxBufferedChunks: 256 * 1024,
				maxFragments: 16 * 1024,
				maxPayload: 100 * 1024 * 1024,
				skipUTF8Validation: false,
				perMessageDeflate: false,
				handleProtocols: null,
				clientTracking: true,
				closeTimeout: CLOSE_TIMEOUT,
				verifyClient: null,
				noServer: false,
				backlog: null,
				server: null,
				host: null,
				path: null,
				port: null,
				WebSocket,
				...options
			};
			if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) throw new TypeError("One and only one of the \"port\", \"server\", or \"noServer\" options must be specified");
			if (options.port != null) {
				this._server = http.createServer((req, res) => {
					const body = http.STATUS_CODES[426];
					res.writeHead(426, {
						"Content-Length": body.length,
						"Content-Type": "text/plain"
					});
					res.end(body);
				});
				this._server.listen(options.port, options.host, options.backlog, callback);
			} else if (options.server) this._server = options.server;
			if (this._server) {
				const emitConnection = this.emit.bind(this, "connection");
				this._removeListeners = addListeners(this._server, {
					listening: this.emit.bind(this, "listening"),
					error: this.emit.bind(this, "error"),
					upgrade: (req, socket, head) => {
						this.handleUpgrade(req, socket, head, emitConnection);
					}
				});
			}
			if (options.perMessageDeflate === true) options.perMessageDeflate = {};
			if (options.clientTracking) {
				this.clients = /* @__PURE__ */ new Set();
				this._shouldEmitClose = false;
			}
			this.options = options;
			this._state = RUNNING;
		}
		/**
		* Returns the bound address, the address family name, and port of the server
		* as reported by the operating system if listening on an IP socket.
		* If the server is listening on a pipe or UNIX domain socket, the name is
		* returned as a string.
		*
		* @return {(Object|String|null)} The address of the server
		* @public
		*/
		address() {
			if (this.options.noServer) throw new Error("The server is operating in \"noServer\" mode");
			if (!this._server) return null;
			return this._server.address();
		}
		/**
		* Stop the server from accepting new connections and emit the `'close'` event
		* when all existing connections are closed.
		*
		* @param {Function} [cb] A one-time listener for the `'close'` event
		* @public
		*/
		close(cb) {
			if (this._state === CLOSED) {
				if (cb) this.once("close", () => {
					cb(/* @__PURE__ */ new Error("The server is not running"));
				});
				process.nextTick(emitClose, this);
				return;
			}
			if (cb) this.once("close", cb);
			if (this._state === CLOSING) return;
			this._state = CLOSING;
			if (this.options.noServer || this.options.server) {
				if (this._server) {
					this._removeListeners();
					this._removeListeners = this._server = null;
				}
				if (this.clients) if (!this.clients.size) process.nextTick(emitClose, this);
				else this._shouldEmitClose = true;
				else process.nextTick(emitClose, this);
			} else {
				const server = this._server;
				this._removeListeners();
				this._removeListeners = this._server = null;
				server.close(() => {
					emitClose(this);
				});
			}
		}
		/**
		* See if a given request should be handled by this server instance.
		*
		* @param {http.IncomingMessage} req Request object to inspect
		* @return {Boolean} `true` if the request is valid, else `false`
		* @public
		*/
		shouldHandle(req) {
			if (this.options.path) {
				const index = req.url.indexOf("?");
				if ((index !== -1 ? req.url.slice(0, index) : req.url) !== this.options.path) return false;
			}
			return true;
		}
		/**
		* Handle a HTTP Upgrade request.
		*
		* @param {http.IncomingMessage} req The request object
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Function} cb Callback
		* @public
		*/
		handleUpgrade(req, socket, head, cb) {
			socket.on("error", socketOnError);
			const key = req.headers["sec-websocket-key"];
			const upgrade = req.headers.upgrade;
			const version = +req.headers["sec-websocket-version"];
			if (req.method !== "GET") {
				abortHandshakeOrEmitwsClientError(this, req, socket, 405, "Invalid HTTP method");
				return;
			}
			if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid Upgrade header");
				return;
			}
			if (key === void 0 || !keyRegex.test(key)) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Missing or invalid Sec-WebSocket-Key header");
				return;
			}
			if (version !== 13 && version !== 8) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Missing or invalid Sec-WebSocket-Version header", { "Sec-WebSocket-Version": "13, 8" });
				return;
			}
			if (!this.shouldHandle(req)) {
				abortHandshake(socket, 400);
				return;
			}
			const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
			let protocols = /* @__PURE__ */ new Set();
			if (secWebSocketProtocol !== void 0) try {
				protocols = subprotocol.parse(secWebSocketProtocol);
			} catch (err) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid Sec-WebSocket-Protocol header");
				return;
			}
			const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
			const extensions = {};
			if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
				const perMessageDeflate = new PerMessageDeflate({
					...this.options.perMessageDeflate,
					isServer: true,
					maxPayload: this.options.maxPayload
				});
				try {
					const offers = extension.parse(secWebSocketExtensions);
					if (offers[PerMessageDeflate.extensionName]) {
						perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
						extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
					}
				} catch (err) {
					abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid or unacceptable Sec-WebSocket-Extensions header");
					return;
				}
			}
			if (this.options.verifyClient) {
				const info = {
					origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
					secure: !!(req.socket.authorized || req.socket.encrypted),
					req
				};
				if (this.options.verifyClient.length === 2) {
					this.options.verifyClient(info, (verified, code, message, headers) => {
						if (!verified) return abortHandshake(socket, code || 401, message, headers);
						this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
					});
					return;
				}
				if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
			}
			this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
		}
		/**
		* Upgrade the connection to WebSocket.
		*
		* @param {Object} extensions The accepted extensions
		* @param {String} key The value of the `Sec-WebSocket-Key` header
		* @param {Set} protocols The subprotocols
		* @param {http.IncomingMessage} req The request object
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Function} cb Callback
		* @throws {Error} If called more than once with the same socket
		* @private
		*/
		completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
			if (!socket.readable || !socket.writable) return socket.destroy();
			if (socket[kWebSocket]) throw new Error("server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration");
			if (this._state > RUNNING) return abortHandshake(socket, 503);
			const headers = [
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${createHash$1("sha1").update(key + GUID).digest("base64")}`
			];
			const ws = new this.options.WebSocket(null, void 0, this.options);
			if (protocols.size) {
				const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
				if (protocol) {
					headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
					ws._protocol = protocol;
				}
			}
			if (extensions[PerMessageDeflate.extensionName]) {
				const params = extensions[PerMessageDeflate.extensionName].params;
				const value = extension.format({ [PerMessageDeflate.extensionName]: [params] });
				headers.push(`Sec-WebSocket-Extensions: ${value}`);
				ws._extensions = extensions;
			}
			this.emit("headers", headers, req);
			socket.write(headers.concat("\r\n").join("\r\n"));
			socket.removeListener("error", socketOnError);
			ws.setSocket(socket, head, {
				allowSynchronousEvents: this.options.allowSynchronousEvents,
				maxBufferedChunks: this.options.maxBufferedChunks,
				maxFragments: this.options.maxFragments,
				maxPayload: this.options.maxPayload,
				skipUTF8Validation: this.options.skipUTF8Validation
			});
			if (this.clients) {
				this.clients.add(ws);
				ws.on("close", () => {
					this.clients.delete(ws);
					if (this._shouldEmitClose && !this.clients.size) process.nextTick(emitClose, this);
				});
			}
			cb(ws, req);
		}
	};
	module.exports = WebSocketServer;
	/**
	* Add event listeners on an `EventEmitter` using a map of <event, listener>
	* pairs.
	*
	* @param {EventEmitter} server The event emitter
	* @param {Object.<String, Function>} map The listeners to add
	* @return {Function} A function that will remove the added listeners when
	*     called
	* @private
	*/
	function addListeners(server, map) {
		for (const event of Object.keys(map)) server.on(event, map[event]);
		return function removeListeners() {
			for (const event of Object.keys(map)) server.removeListener(event, map[event]);
		};
	}
	/**
	* Emit a `'close'` event on an `EventEmitter`.
	*
	* @param {EventEmitter} server The event emitter
	* @private
	*/
	function emitClose(server) {
		server._state = CLOSED;
		server.emit("close");
	}
	/**
	* Handle socket errors.
	*
	* @private
	*/
	function socketOnError() {
		this.destroy();
	}
	/**
	* Close the connection when preconditions are not fulfilled.
	*
	* @param {Duplex} socket The socket of the upgrade request
	* @param {Number} code The HTTP response status code
	* @param {String} [message] The HTTP response body
	* @param {Object} [headers] Additional HTTP response headers
	* @private
	*/
	function abortHandshake(socket, code, message, headers) {
		message = message || http.STATUS_CODES[code];
		headers = {
			Connection: "close",
			"Content-Type": "text/html",
			"Content-Length": Buffer.byteLength(message),
			...headers
		};
		socket.once("finish", socket.destroy);
		socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message);
	}
	/**
	* Emit a `'wsClientError'` event on a `WebSocketServer` if there is at least
	* one listener for it, otherwise call `abortHandshake()`.
	*
	* @param {WebSocketServer} server The WebSocket server
	* @param {http.IncomingMessage} req The request object
	* @param {Duplex} socket The socket of the upgrade request
	* @param {Number} code The HTTP response status code
	* @param {String} message The HTTP response body
	* @param {Object} [headers] The HTTP response headers
	* @private
	*/
	function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
		if (server.listenerCount("wsClientError")) {
			const err = new Error(message);
			Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
			server.emit("wsClientError", err, socket, req);
		} else abortHandshake(socket, code, message, headers);
	}
}));

//#endregion
//#region node_modules/ws/wrapper.mjs
var import_stream = /* @__PURE__ */ __toESM(require_stream(), 1);
var import_extension = /* @__PURE__ */ __toESM(require_extension(), 1);
var import_permessage_deflate = /* @__PURE__ */ __toESM(require_permessage_deflate(), 1);
var import_receiver = /* @__PURE__ */ __toESM(require_receiver(), 1);
var import_sender = /* @__PURE__ */ __toESM(require_sender(), 1);
var import_subprotocol = /* @__PURE__ */ __toESM(require_subprotocol(), 1);
var import_websocket = /* @__PURE__ */ __toESM(require_websocket(), 1);
var import_websocket_server = /* @__PURE__ */ __toESM(require_websocket_server(), 1);

//#endregion
//#region src/residential/secure-channel.ts
/**
* End-to-end encryption for the residential proxy control channel.
*
* TLS only protects the hop to whatever terminates it -- a CDN, a load
* balancer or a reverse proxy all see plaintext tunnel bytes and a static
* bearer token. This layer sits inside the WebSocket so that the agent and the
* browserless process are the only parties holding keys, and it replaces the
* bearer token with a challenge/response that proves knowledge of the shared
* secret without ever putting it on the wire.
*/
const secureChannelInfo = "browserless-residential-proxy/v2";
const secureChannelKeyBytes = 32;
const secureChannelMacBytes = 32;
const secureChannelNonceBytes = 12;
const secureChannelPublicKeyBytes = 32;
const secureChannelTagBytes = 16;
const handshakeNonceBytes = 32;
const maxPadBytes = 255;
const padUnderBytes = 512;
const asBuffer = (value, bytes, name) => {
	if (typeof value !== "string") throw new Error(`Handshake field "${name}" is missing`);
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length !== bytes) throw new Error(`Handshake field "${name}" must be ${bytes} bytes`);
	return decoded;
};
const exportRawPublicKey = (key) => {
	const { x } = key.export({ format: "jwk" });
	if (!x) throw new Error("Unable to export the X25519 public key");
	return Buffer.from(x, "base64url");
};
const importRawPublicKey = (raw) => {
	if (raw.length !== secureChannelPublicKeyBytes) throw new Error("X25519 public keys must be 32 bytes");
	return createPublicKey({
		format: "jwk",
		key: {
			crv: "X25519",
			kty: "OKP",
			x: raw.toString("base64url")
		}
	});
};
const deriveKeys = (psk, serverPub, agentPub, serverNonce, agentNonce, shared) => {
	if (shared.every((byte) => byte === 0)) throw new Error("Rejected a degenerate X25519 shared secret");
	const ikm = Buffer.concat([shared, createHash("sha256").update(psk, "utf8").digest()]);
	const okm = Buffer.from(hkdfSync("sha256", ikm, Buffer.concat([serverNonce, agentNonce]), Buffer.concat([
		Buffer.from(secureChannelInfo, "utf8"),
		serverPub,
		agentPub
	]), secureChannelKeyBytes * 2 + secureChannelMacBytes));
	return {
		agentToServer: okm.subarray(0, 32),
		macKey: okm.subarray(64, 96),
		serverToAgent: okm.subarray(32, 64)
	};
};
const authMac = (keys, serverPub, agentPub, serverNonce, agentNonce) => createHmac("sha256", keys.macKey).update("agent-auth").update(serverPub).update(agentPub).update(serverNonce).update(agentNonce).digest();
/**
* Authenticated, ordered, padded framing over an already-established key pair.
* Each direction owns a key, so a plain counter is a safe nonce, and the
* receiver requires strictly increasing counters -- replayed or reordered
* frames are dropped rather than decrypted.
*/
var SecureChannel = class {
	receiveCounter = 0n;
	sendCounter = 0n;
	constructor(sendKey, receiveKey, sendCounter = 0n, receiveCounter = 0n) {
		this.sendKey = sendKey;
		this.receiveKey = receiveKey;
		this.sendCounter = sendCounter;
		this.receiveCounter = receiveCounter;
	}
	nonce(counter) {
		const nonce = Buffer.alloc(secureChannelNonceBytes);
		nonce.writeBigUInt64BE(counter, 4);
		return nonce;
	}
	sealWith(key, counter, plaintext) {
		const nonce = this.nonce(counter);
		const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: secureChannelTagBytes });
		cipher.setAAD(nonce, { plaintextLength: plaintext.length });
		return Buffer.concat([
			nonce,
			cipher.update(plaintext),
			cipher.final(),
			cipher.getAuthTag()
		]);
	}
	openWith(key, expected, frame) {
		const minimum = secureChannelNonceBytes + secureChannelTagBytes;
		if (frame.length < minimum) throw new Error("Encrypted frame is too short");
		const nonce = frame.subarray(0, secureChannelNonceBytes);
		if (nonce.readBigUInt64BE(4) !== expected) throw new Error("Encrypted frame arrived out of order");
		const tag = frame.subarray(frame.length - secureChannelTagBytes);
		const body = frame.subarray(secureChannelNonceBytes, frame.length - secureChannelTagBytes);
		const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: secureChannelTagBytes });
		decipher.setAAD(nonce, { plaintextLength: body.length });
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]);
	}
	/** Pads short frames so tunnel byte counts leak less about the payload. */
	pad(payload) {
		const padLength = payload.length < padUnderBytes ? (randomBytes(1)[0] ?? 0) % (maxPadBytes + 1) : 0;
		const header = Buffer.alloc(2);
		header.writeUInt16BE(padLength);
		return Buffer.concat([
			header,
			randomBytes(padLength),
			payload
		]);
	}
	unpad(plaintext) {
		if (plaintext.length < 2) throw new Error("Malformed padded frame");
		const padLength = plaintext.readUInt16BE(0);
		if (padLength > plaintext.length - 2) throw new Error("Malformed padded frame");
		return plaintext.subarray(2 + padLength);
	}
	seal(message) {
		const frame = this.sealWith(this.sendKey, this.sendCounter, this.pad(Buffer.from(JSON.stringify(message), "utf8")));
		this.sendCounter += 1n;
		return frame;
	}
	open(frame) {
		const plaintext = this.openWith(this.receiveKey, this.receiveCounter, frame);
		this.receiveCounter += 1n;
		const value = JSON.parse(this.unpad(plaintext).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Encrypted frame did not contain an object");
		return value;
	}
};
/** Agent half of the handshake: proves it holds the token, then checks the server does too. */
var AgentHandshake = class {
	keyPair = generateKeyPairSync("x25519");
	nonce = randomBytes(handshakeNonceBytes);
	pub = exportRawPublicKey(this.keyPair.publicKey);
	channel;
	constructor(psk, version) {
		this.psk = psk;
		this.version = version;
	}
	auth(frame, payload) {
		const hello = frame;
		if (!hello || hello.t !== "hello") throw new Error("Expected a \"hello\" handshake frame");
		if (hello.v !== this.version) throw new Error(`Server offered residential proxy protocol v${hello.v}, expected v${this.version}`);
		const serverPub = asBuffer(hello.pub, secureChannelPublicKeyBytes, "pub");
		const serverNonce = asBuffer(hello.nonce, handshakeNonceBytes, "nonce");
		const keys = deriveKeys(this.psk, serverPub, this.pub, serverNonce, this.nonce, diffieHellman({
			privateKey: this.keyPair.privateKey,
			publicKey: importRawPublicKey(serverPub)
		}));
		const channel = new SecureChannel(keys.agentToServer, keys.serverToAgent, 0n, 0n);
		this.channel = channel;
		return {
			auth: {
				box: channel.seal(payload).toString("base64url"),
				mac: authMac(keys, serverPub, this.pub, serverNonce, this.nonce).toString("base64url"),
				nonce: this.nonce.toString("base64url"),
				pub: this.pub.toString("base64url"),
				t: "auth"
			},
			channel
		};
	}
	/**
	* A server that cannot produce this frame does not hold the token, which
	* stops a hijacked DNS record or a hostile middlebox from collecting
	* tunnels from agents.
	*/
	confirm(frame) {
		const ready = frame;
		if (!this.channel) throw new Error("Handshake has not started");
		if (!ready || ready.t !== "ready" || typeof ready.box !== "string") throw new Error("Expected a \"ready\" handshake frame");
		if (this.channel.open(Buffer.from(ready.box, "base64url")).ok !== true) throw new Error("Server rejected the residential proxy handshake");
	}
};

//#endregion
//#region src/residential/protocol.ts
const residentialProxyAgentPath = "/residential-proxy/agent";
const residentialProxyProtocolVersion = 1;
/**
* v2 adds an encrypted handshake: the agent authenticates with a MAC instead
* of a bearer header, and every frame after the handshake is ciphertext.
*/
const residentialProxySecureProtocolVersion = 2;
const residentialProxyMaxFrameBytes = 1024 * 1024;
const parseResidentialProxyMessage = (raw) => {
	try {
		const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : "";
		if (!text || Buffer.byteLength(text) > residentialProxyMaxFrameBytes) return null;
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
};

//#endregion
//#region src/residential/control-proxy.ts
const socksVersion = 5;
const socksNoAuth = 0;
const socksUserPass = 2;
const socksConnect = 1;
const socksReserved = 0;
const socksAddressIPv4 = 1;
const socksAddressDomain = 3;
const socksAddressIPv6 = 4;
const connectHeaderLimit = 16 * 1024;
const socksErrors = {
	1: "general SOCKS server failure",
	2: "connection not allowed by ruleset",
	3: "network unreachable",
	4: "host unreachable",
	5: "connection refused",
	6: "TTL expired",
	7: "command not supported",
	8: "address type not supported"
};
const parseControlProxyURL = (value) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid control proxy URL "${value}"; expected socks5://host:port or http://host:port`);
	}
	const protocol = {
		"http:": "http",
		"https:": "https",
		"socks:": "socks",
		"socks5:": "socks",
		"socks5h:": "socks"
	}[url.protocol];
	if (!protocol) throw new Error(`Unsupported control proxy protocol "${url.protocol}"; use socks5, socks5h, http or https`);
	if (!url.hostname) throw new Error("Control proxy URL is missing a host");
	return {
		protocol,
		url
	};
};
/** Reads exactly `bytes` from a socket, buffering across chunk boundaries. */
const readExactly = (socket, bytes) => new Promise((resolve, reject) => {
	if (bytes === 0) return resolve(Buffer.alloc(0));
	const chunks = [];
	let length = 0;
	const cleanup = () => {
		socket.removeListener("readable", onReadable);
		socket.removeListener("error", onError);
		socket.removeListener("end", onEnd);
	};
	const onError = (error) => {
		cleanup();
		reject(error);
	};
	const onEnd = () => onError(/* @__PURE__ */ new Error("Control proxy closed the connection"));
	const onReadable = () => {
		let chunk;
		while ((chunk = socket.read(Math.min(bytes - length, 65536))) !== null) {
			chunks.push(chunk);
			length += chunk.length;
			if (length >= bytes) {
				cleanup();
				return resolve(Buffer.concat(chunks, bytes));
			}
		}
	};
	socket.on("readable", onReadable);
	socket.once("error", onError);
	socket.once("end", onEnd);
	onReadable();
});
const socksAddress = (host) => {
	if (net.isIPv4(host)) return Buffer.concat([Buffer.from([socksAddressIPv4]), Buffer.from(host.split(".").map(Number))]);
	if (net.isIPv6(host)) {
		const groups = host.split(":");
		const filled = [];
		const missing = 8 - groups.filter(Boolean).length;
		for (const group of groups) if (group === "") for (let index = 0; index < missing; index++) filled.push("0");
		else filled.push(group);
		const address = Buffer.alloc(16);
		filled.slice(0, 8).forEach((group, index) => {
			address.writeUInt16BE(parseInt(group || "0", 16), index * 2);
		});
		return Buffer.concat([Buffer.from([socksAddressIPv6]), address]);
	}
	const name = Buffer.from(host, "utf8");
	if (name.length > 255) throw new Error("Control proxy target host is too long");
	return Buffer.concat([Buffer.from([socksAddressDomain, name.length]), name]);
};
const socksHandshake = async (socket, url, host, port) => {
	const username = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	const methods = username ? [socksNoAuth, socksUserPass] : [socksNoAuth];
	socket.write(Buffer.from([
		socksVersion,
		methods.length,
		...methods
	]));
	const greeting = await readExactly(socket, 2);
	if (greeting[0] !== socksVersion) throw new Error("Control proxy is not a SOCKS5 server");
	if (greeting[1] === socksUserPass) {
		if (!username) throw new Error("Control proxy requires SOCKS5 credentials");
		const user = Buffer.from(username, "utf8");
		const pass = Buffer.from(password, "utf8");
		socket.write(Buffer.concat([
			Buffer.from([1, user.length]),
			user,
			Buffer.from([pass.length]),
			pass
		]));
		if ((await readExactly(socket, 2))[1] !== 0) throw new Error("Control proxy rejected the SOCKS5 credentials");
	} else if (greeting[1] !== socksNoAuth) throw new Error("Control proxy offered no supported SOCKS5 auth method");
	socket.write(Buffer.concat([
		Buffer.from([
			socksVersion,
			socksConnect,
			socksReserved
		]),
		socksAddress(host),
		Buffer.from([port >> 8, port & 255])
	]));
	const reply = await readExactly(socket, 4);
	const status = reply[1] ?? 255;
	if (status !== 0) throw new Error(`Control proxy refused the connection: ${socksErrors[status] ?? `code ${status}`}`);
	await readExactly(socket, (reply[3] === socksAddressIPv4 ? 4 : reply[3] === socksAddressIPv6 ? 16 : (await readExactly(socket, 1))[0] ?? 0) + 2);
};
const connectHandshake = async (socket, url, host, port) => {
	const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
	const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
	if (url.username) {
		const credentials = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, "utf8").toString("base64");
		headers.push(`Proxy-Authorization: Basic ${credentials}`);
	}
	socket.write(`${headers.join("\r\n")}\r\n\r\n`);
	let buffer = Buffer.alloc(0);
	while (!buffer.includes("\r\n\r\n")) {
		if (buffer.length > connectHeaderLimit) throw new Error("Control proxy sent oversized CONNECT headers");
		buffer = Buffer.concat([buffer, await readExactly(socket, 1)]);
	}
	const headerEnd = buffer.indexOf("\r\n\r\n");
	const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
	if (!/^HTTP\/1\.[01] 200/.test(statusLine)) throw new Error(`Control proxy refused CONNECT: ${statusLine}`);
	const rest = buffer.subarray(headerEnd + 4);
	if (rest.length) socket.unshift(rest);
};
const connectThroughControlProxy = async (proxy, host, port, timeout = 2e4) => {
	const { protocol, url } = parseControlProxyURL(proxy);
	const proxyPort = Number(url.port) || (protocol === "https" ? 443 : 1080);
	const socket = protocol === "https" ? tls.connect({
		host: url.hostname,
		port: proxyPort,
		servername: url.hostname
	}) : net.connect({
		host: url.hostname,
		port: proxyPort
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`Control proxy ${url.host} timed out`)), timeout);
		const settle = (error) => {
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		socket.once("error", settle);
		socket.once(protocol === "https" ? "secureConnect" : "connect", () => settle());
	}).catch((error) => {
		socket.destroy();
		throw error;
	});
	try {
		if (protocol === "socks") await socksHandshake(socket, url, host, port);
		else await connectHandshake(socket, url, host, port);
	} catch (error) {
		socket.destroy();
		throw error;
	}
	return socket;
};
/**
* An `http.Agent` whose sockets are dialled through the control proxy. Passed
* to `ws` so only the control WebSocket is affected.
*/
var ControlProxyAgent = class extends https.Agent {
	constructor(proxy, secureEndpoint) {
		super({
			keepAlive: false,
			maxSockets: 4
		});
		this.proxy = proxy;
		this.secureEndpoint = secureEndpoint;
		parseControlProxyURL(proxy);
		this.protocol = secureEndpoint ? "https:" : "http:";
	}
	createConnection(options, callback) {
		const host = options.host ?? "localhost";
		const port = Number(options.port) || (this.secureEndpoint ? 443 : 80);
		const fail = (error) => callback?.(error, void 0);
		connectThroughControlProxy(this.proxy, host, port).then((socket) => {
			if (!this.secureEndpoint) return callback?.(null, socket);
			const secured = tls.connect({
				host,
				servername: options.servername ?? (net.isIP(host) ? void 0 : host),
				socket
			});
			secured.once("error", (error) => socket.destroy(error));
			callback?.(null, secured);
		}).catch((error) => fail(error));
	}
};
const createControlProxyAgent = (proxy, secureEndpoint) => new ControlProxyAgent(proxy, secureEndpoint);

//#endregion
//#region src/residential/agent.ts
const blockedAddresses = new net.BlockList();
for (const [address, prefix, type] of [
	[
		"0.0.0.0",
		8,
		"ipv4"
	],
	[
		"10.0.0.0",
		8,
		"ipv4"
	],
	[
		"100.64.0.0",
		10,
		"ipv4"
	],
	[
		"127.0.0.0",
		8,
		"ipv4"
	],
	[
		"169.254.0.0",
		16,
		"ipv4"
	],
	[
		"172.16.0.0",
		12,
		"ipv4"
	],
	[
		"192.0.0.0",
		24,
		"ipv4"
	],
	[
		"192.0.2.0",
		24,
		"ipv4"
	],
	[
		"192.168.0.0",
		16,
		"ipv4"
	],
	[
		"198.18.0.0",
		15,
		"ipv4"
	],
	[
		"198.51.100.0",
		24,
		"ipv4"
	],
	[
		"203.0.113.0",
		24,
		"ipv4"
	],
	[
		"224.0.0.0",
		4,
		"ipv4"
	],
	[
		"240.0.0.0",
		4,
		"ipv4"
	],
	[
		"::",
		128,
		"ipv6"
	],
	[
		"::1",
		128,
		"ipv6"
	],
	[
		"fc00::",
		7,
		"ipv6"
	],
	[
		"fe80::",
		10,
		"ipv6"
	],
	[
		"ff00::",
		8,
		"ipv6"
	],
	[
		"2001:db8::",
		32,
		"ipv6"
	]
]) blockedAddresses.addSubnet(address, prefix, type);
const isPublicProxyAddress = (address) => {
	const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (/^::ffff:/.test(normalized) || /^(?:0+:){5}ffff:/.test(normalized)) return false;
	const family = net.isIP(normalized);
	if (!family) return false;
	return !blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
};
const hostMatchesAllowlist = (host, allowHosts) => {
	const normalized = host.toLowerCase().replace(/\.$/, "");
	return allowHosts.some((entry) => {
		const allowed = entry.trim().toLowerCase().replace(/\.$/, "");
		if (allowed === "*") return true;
		if (allowed.startsWith("*.")) {
			const suffix = allowed.slice(2);
			return normalized === suffix || normalized.endsWith(`.${suffix}`);
		}
		return normalized === allowed;
	});
};
var ResidentialProxyAgent = class {
	allowHosts;
	controlProxy;
	legacyPlaintext;
	channel;
	handshake;
	ready = false;
	allowPrivateNetworks;
	allowedPorts;
	descriptor;
	log;
	reconnect;
	serverURL;
	token;
	tunnels = /* @__PURE__ */ new Map();
	ws;
	constructor({ allowHosts = ["*"], allowInsecureServer = false, allowPrivateNetworks = false, allowedPorts = [80, 443], controlProxy, descriptor, legacyPlaintext = false, log = console.log, reconnect = true, serverURL, token }) {
		if (!token.trim()) throw new Error("An agent token is required");
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(descriptor.id)) throw new Error("Agent id must use 1-64 letters, numbers, _ or -");
		if (!/^[a-z]{2}$/i.test(descriptor.country)) throw new Error("Agent country must be a two-letter ISO country code");
		if (!Number.isInteger(descriptor.maxConnections) || descriptor.maxConnections < 1) throw new Error("Agent maxConnections must be a positive integer");
		if (!allowHosts.length) throw new Error("At least one allowed host is required");
		if (!allowedPorts.length || allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Allowed ports must be integers between 1 and 65535");
		for (const [name, value] of [["region", descriptor.region], ["city", descriptor.city]]) if (value && (value.length > 64 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error(`Agent ${name} contains invalid characters`);
		const parsed = new URL(serverURL);
		if (parsed.protocol === "http:") parsed.protocol = "ws:";
		if (parsed.protocol === "https:") parsed.protocol = "wss:";
		if (!["ws:", "wss:"].includes(parsed.protocol)) throw new Error("Agent server must use http(s) or ws(s)");
		const localServer = [
			"127.0.0.1",
			"::1",
			"localhost"
		].includes(parsed.hostname);
		if (parsed.protocol !== "wss:" && !localServer && !allowInsecureServer) throw new Error("Remote agent connections require wss://; use allowInsecureServer only for trusted development networks");
		parsed.pathname = residentialProxyAgentPath;
		parsed.search = "";
		if (legacyPlaintext) {
			parsed.searchParams.set("version", String(residentialProxyProtocolVersion));
			parsed.searchParams.set("agentId", descriptor.id);
			parsed.searchParams.set("country", descriptor.country.toLowerCase());
			if (descriptor.region) parsed.searchParams.set("region", descriptor.region);
			if (descriptor.city) parsed.searchParams.set("city", descriptor.city);
			parsed.searchParams.set("maxConnections", String(descriptor.maxConnections));
		} else parsed.searchParams.set("version", String(residentialProxySecureProtocolVersion));
		if (controlProxy) createControlProxyAgent(controlProxy, false);
		this.controlProxy = controlProxy;
		this.legacyPlaintext = legacyPlaintext;
		this.allowHosts = allowHosts;
		this.allowPrivateNetworks = allowPrivateNetworks;
		this.allowedPorts = new Set(allowedPorts);
		this.descriptor = descriptor;
		this.log = log;
		this.reconnect = reconnect;
		this.serverURL = parsed;
		this.token = token;
	}
	send(message) {
		if (this.ws?.readyState !== import_websocket.default.OPEN) return;
		if (!this.legacyPlaintext) {
			if (!this.channel || !this.ready) return;
			const frame = this.channel.seal(message);
			if (frame.length > residentialProxyMaxFrameBytes) throw new Error("Residential proxy frame exceeds the size limit");
			this.ws.send(frame);
			return;
		}
		const payload = JSON.stringify(message);
		if (Buffer.byteLength(payload) > residentialProxyMaxFrameBytes) throw new Error("Residential proxy frame exceeds the size limit");
		this.ws.send(payload);
	}
	closeTunnel(id, notify = false) {
		const tunnel = this.tunnels.get(id);
		if (!tunnel) return;
		this.tunnels.delete(id);
		tunnel.socket.destroy();
		if (notify) this.send({
			id,
			type: "end"
		});
	}
	async resolveTarget(host) {
		if (!hostMatchesAllowlist(host, this.allowHosts)) throw new Error(`Host "${host}" is not in the agent allowlist`);
		const addresses = await dns.lookup(host, {
			all: true,
			verbatim: true
		});
		const first = addresses[0];
		if (!first) throw new Error(`Host "${host}" did not resolve`);
		if (!this.allowPrivateNetworks && addresses.some(({ address }) => !isPublicProxyAddress(address))) throw new Error(`Host "${host}" resolves to a private or reserved address`);
		return first;
	}
	async openTunnel(message) {
		const { host, id, port } = message;
		if (this.tunnels.has(id)) throw new Error("Duplicate tunnel id");
		if (this.tunnels.size >= this.descriptor.maxConnections) throw new Error("Agent connection limit reached");
		if (!this.allowedPorts.has(port)) throw new Error(`Port ${port} is not allowed by this agent`);
		const target = await this.resolveTarget(host);
		const socket = net.connect({
			family: target.family,
			host: target.address,
			port
		});
		this.tunnels.set(id, { socket });
		socket.once("connect", () => {
			this.log(`Opened ${host}:${port} (${id.slice(0, 8)})`);
			this.send({
				id,
				type: "opened"
			});
		});
		socket.on("data", (data) => {
			try {
				this.send({
					data: data.toString("base64"),
					id,
					type: "data"
				});
			} catch {
				socket.destroy();
			}
		});
		socket.once("end", () => {
			this.tunnels.delete(id);
			this.send({
				id,
				type: "end"
			});
		});
		socket.once("error", (error) => {
			this.tunnels.delete(id);
			this.send({
				id,
				message: error.message,
				type: "error"
			});
		});
		socket.once("close", () => this.tunnels.delete(id));
	}
	toBuffer(raw) {
		if (Buffer.isBuffer(raw)) return raw;
		if (Array.isArray(raw)) return Buffer.concat(raw);
		if (raw instanceof ArrayBuffer) return Buffer.from(raw);
		return Buffer.from(String(raw), "utf8");
	}
	/**
	* Handshake frames are plaintext JSON; everything after `ready` is a sealed
	* binary frame. The ordering is fixed, so the phase flag is enough to tell
	* them apart.
	*/
	handleFrame(raw) {
		if (this.legacyPlaintext) {
			this.handleMessage(parseResidentialProxyMessage(raw));
			return;
		}
		if (!this.ready) {
			this.handleHandshakeFrame(raw);
			return;
		}
		try {
			this.handleMessage(this.channel.open(this.toBuffer(raw)));
		} catch (error) {
			this.log(`Rejected a residential proxy frame: ${error instanceof Error ? error.message : String(error)}`);
			this.ws?.close(1008, "Undecryptable residential proxy frame");
		}
	}
	handleHandshakeFrame(raw) {
		const frame = parseResidentialProxyMessage(raw);
		try {
			if (!frame || typeof frame.t !== "string") throw new Error("Malformed handshake frame");
			if (frame.t === "hello") {
				this.handshake = new AgentHandshake(this.token, residentialProxySecureProtocolVersion);
				const { auth, channel } = this.handshake.auth(frame, { descriptor: this.descriptor });
				this.channel = channel;
				this.ws?.send(JSON.stringify(auth));
				return;
			}
			if (frame.t === "ready") {
				this.handshake?.confirm(frame);
				this.ready = true;
				this.log(`Connected agent ${this.descriptor.id} (${this.descriptor.country.toUpperCase()}) over an encrypted channel`);
				return;
			}
			throw new Error(`Unexpected handshake frame "${frame.t}"`);
		} catch (error) {
			this.log(`Residential proxy handshake failed: ${error instanceof Error ? error.message : String(error)}`);
			this.ws?.close(1008, "Handshake failed");
		}
	}
	handleMessage(message) {
		if (!message || typeof message.type !== "string" || typeof message.id !== "string") {
			this.ws?.close(1003, "Invalid residential proxy frame");
			return;
		}
		if (message.type === "open") {
			if (typeof message.host !== "string" || !message.host || !Number.isInteger(message.port)) {
				this.send({
					id: message.id,
					message: "Invalid target",
					type: "error"
				});
				return;
			}
			this.openTunnel(message).catch((error) => this.send({
				id: message.id,
				message: error instanceof Error ? error.message : String(error),
				type: "error"
			}));
			return;
		}
		const tunnel = this.tunnels.get(message.id);
		if (!tunnel) return;
		if (message.type === "data" && typeof message.data === "string") tunnel.socket.write(Buffer.from(message.data, "base64"));
		else if (message.type === "end") tunnel.socket.end();
		else this.ws?.close(1003, "Unknown residential proxy frame type");
	}
	connectOnce(signal) {
		return new Promise((resolve, reject) => {
			let opened = false;
			this.channel = void 0;
			this.handshake = void 0;
			this.ready = false;
			const ws = new import_websocket.default(this.serverURL, {
				...this.controlProxy ? { agent: createControlProxyAgent(this.controlProxy, this.serverURL.protocol === "wss:") } : {},
				headers: this.legacyPlaintext ? { "x-residential-proxy-token": this.token } : {},
				maxPayload: residentialProxyMaxFrameBytes
			});
			this.ws = ws;
			const abort = () => ws.close(1e3, "Agent stopped");
			signal?.addEventListener("abort", abort, { once: true });
			ws.once("open", () => {
				opened = true;
				if (this.legacyPlaintext) this.log(`Connected agent ${this.descriptor.id} (${this.descriptor.country.toUpperCase()})`);
			});
			ws.on("message", (data) => this.handleFrame(data));
			ws.once("error", (error) => {
				if (!opened) reject(error);
			});
			ws.once("close", (code, reason) => {
				signal?.removeEventListener("abort", abort);
				for (const id of this.tunnels.keys()) this.closeTunnel(id);
				this.ws = void 0;
				this.channel = void 0;
				this.handshake = void 0;
				this.ready = false;
				this.log(`Agent disconnected (${code}${reason.length ? `: ${reason}` : ""})`);
				resolve();
			});
		});
	}
	async run(signal) {
		let delay = 1e3;
		while (!signal?.aborted) {
			try {
				await this.connectOnce(signal);
				delay = 1e3;
			} catch (error) {
				this.log(`Agent connection failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!this.reconnect || signal?.aborted) break;
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 2, 3e4);
		}
	}
	stop() {
		this.ws?.close(1e3, "Agent stopped");
		for (const id of this.tunnels.keys()) this.closeTunnel(id);
	}
};
const makeResidentialProxyAgentId = () => randomUUID();

//#endregion
//#region src/residential.ts
/**
* The hosts this exit will carry when RESIDENTIAL_PROXY_ALLOW_HOSTS is unset:
* every source in the catalog, as `*.host` so subdomains match.
*
* Not `*`, for two reasons that were measured rather than assumed
* (2026-09-17). First, a headless Chrome opens several background connections
* per render — Google update and telemetry endpoints — and with `*` every one
* of them takes a slot on this agent; at the default of 8 that usually leaves
* room for the real target, at 4 it never did, and the target's CONNECT was
* refused as `ERR_TUNNEL_CONNECTION_FAILED`. A narrow allowlist makes those
* CONNECTs fail immediately without occupying a slot. Second, this lends out
* a network connection, and the sensible default is to lend it only for the
* sites this tool actually fetches.
*/
function catalogAllowHosts() {
	const hosts = /* @__PURE__ */ new Set();
	for (const vendor of VENDORS) {
		const host = vendor.searchSite.split("/")[0].toLowerCase().replace(/^www\./, "");
		if (host) hosts.add(`*.${host}`);
	}
	for (const host of [
		"*.coveo.com",
		"*.cloudflare.com",
		"*.google.com",
		"*.gstatic.com",
		"*.recaptcha.net"
	]) hosts.add(host);
	return [...hosts];
}
/** Lower than the upstream default of 20: this is somebody's laptop. */
const DEFAULT_MAX_CONNECTIONS = 8;
const RESIDENTIAL_OFFER_HEADER = "x-labee-residential-offer";
/**
* Exposes the connection state the base class tracks internally, so callers can
* ask "is a residential exit available right now?" without inspecting logs.
*/
var ObservableResidentialAgent = class extends ResidentialProxyAgent {
	get connected() {
		return this.ready;
	}
};
function truthy(value) {
	return [
		"1",
		"true",
		"yes",
		"on"
	].includes((value ?? "").trim().toLowerCase());
}
function optional$1(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
/**
* Read the configuration, or null when the feature is simply not enabled.
*
* Enabled-but-unusable throws instead of returning null, and the distinction is
* the point: silence is right for a feature nobody asked for, and wrong for one
* that was asked for and cannot start. The caller turns the throw into a
* stderr line, never a crash.
*/
function residentialConfig(env = process.env) {
	if (!truthy(env.PROTOCOLS_RESIDENTIAL_PROXY)) return null;
	if (!truthy(env.RESIDENTIAL_PROXY_CONSENT)) throw new Error("PROTOCOLS_RESIDENTIAL_PROXY is on but RESIDENTIAL_PROXY_CONSENT is not set. Lending this machine's network connection requires explicit consent from its owner.");
	const token = optional$1(env.RESIDENTIAL_PROXY_AGENT_TOKEN);
	if (!token) throw new Error("RESIDENTIAL_PROXY_AGENT_TOKEN is required to register a residential exit");
	const serverUrl = optional$1(env.RESIDENTIAL_PROXY_URL) ?? optional$1(env.BROWSERLESS_URL);
	if (!serverUrl) throw new Error("RESIDENTIAL_PROXY_URL (or BROWSERLESS_URL) must point at a self-hosted browserless server");
	const country = optional$1(env.RESIDENTIAL_PROXY_COUNTRY);
	if (!country || !/^[a-z]{2}$/i.test(country)) throw new Error("RESIDENTIAL_PROXY_COUNTRY must be a two-letter ISO country code");
	const configuredMax = Number(env.RESIDENTIAL_PROXY_MAX_CONNECTIONS);
	const maxConnections = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_CONNECTIONS;
	const configuredHosts = optional$1(env.RESIDENTIAL_PROXY_ALLOW_HOSTS);
	const allowHosts = configuredHosts ? configuredHosts.split(",").map((h) => h.trim()).filter(Boolean) : catalogAllowHosts();
	const safeHostname = hostname().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
	const id = optional$1(env.RESIDENTIAL_PROXY_AGENT_ID) ?? `${safeHostname || "labee"}-${makeResidentialProxyAgentId().slice(0, 8)}`;
	return {
		allowHosts: allowHosts.length ? allowHosts : ["*"],
		city: optional$1(env.RESIDENTIAL_PROXY_CITY),
		controlProxy: optional$1(env.RESIDENTIAL_PROXY_CONTROL_PROXY),
		country,
		id,
		maxConnections,
		region: optional$1(env.RESIDENTIAL_PROXY_REGION),
		serverUrl,
		token
	};
}
let active = null;
let activeConfig = null;
const requestResidentialOffer = new AsyncLocalStorage();
function selectorFromConfig(cfg) {
	return {
		city: cfg.city,
		country: cfg.country,
		region: cfg.region
	};
}
function offerFromConfig(cfg) {
	return {
		agentId: cfg.id,
		allowHosts: [...cfg.allowHosts],
		selector: selectorFromConfig(cfg)
	};
}
/** The connected local exit, if this process currently owns one. */
function activeResidentialOffer() {
	if (!active?.connected || !activeConfig) return null;
	return offerFromConfig(activeConfig);
}
/**
* Encode routing metadata for an authenticated MCP request. Base64url keeps
* user-supplied geo labels out of raw HTTP header syntax.
*/
function encodeResidentialOffer(offer) {
	return Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
}
/** Parse and strictly bound an offer received by the remote MCP endpoint. */
function decodeResidentialOffer(value) {
	if (!value || value.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const decoded = Buffer.from(value, "base64url");
		if (decoded.length > 8192) return null;
		const parsed = JSON.parse(decoded.toString("utf8"));
		if (typeof parsed.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(parsed.agentId)) return null;
		if (!Array.isArray(parsed.allowHosts) || parsed.allowHosts.length < 1 || parsed.allowHosts.length > 128) return null;
		if (parsed.allowHosts.some((entry) => typeof entry !== "string")) return null;
		const allowHosts = parsed.allowHosts.map((entry) => entry.trim().toLowerCase());
		if (allowHosts.some((entry) => !entry || entry.length > 253 || /[\u0000-\u0020\u007f/\\:@]/.test(entry) || entry !== "*" && !/^(?:\*\.)?[a-z0-9.-]+$/.test(entry))) return null;
		const country = parsed.selector?.country;
		if (typeof country !== "string") return null;
		if (!/^[a-z]{2}$/i.test(country)) return null;
		const optionalLabel = (label) => {
			if (label === void 0) return void 0;
			if (typeof label !== "string") return null;
			const text = label.trim();
			if (!text || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) return null;
			return text;
		};
		const city = optionalLabel(parsed.selector?.city);
		const region = optionalLabel(parsed.selector?.region);
		if (city === null || region === null) return null;
		return {
			agentId: parsed.agentId,
			allowHosts,
			selector: {
				...city ? { city } : {},
				country,
				...region ? { region } : {}
			}
		};
	} catch {
		return null;
	}
}
/** Run one remote MCP request with its caller's residential capability. */
function withResidentialOffer(offer, fn) {
	return offer ? requestResidentialOffer.run(offer, fn) : fn();
}
function currentResidentialOffer() {
	return requestResidentialOffer.getStore() ?? activeResidentialOffer();
}
/**
* The selector for a render of `url`, or null when the render should leave
* from the server's own address instead.
*
* A host outside this exit's allowlist must not be routed residentially: the
* agent would refuse the CONNECT and the whole render would fail, where a
* datacenter render might have succeeded. That case is real — the open-access
* tiers in fulltext.ts hand this fallback arbitrary publisher and repository
* URLs, none of which are in the catalog.
*/
function residentialSelectorFor(url) {
	const offer = currentResidentialOffer();
	if (!offer) return null;
	try {
		return hostMatchesAllowlist(new URL(url).hostname, offer.allowHosts) ? offer.selector : null;
	} catch {
		return null;
	}
}
/**
* Wait, bounded, for the exit to finish registering. Registration is
* asynchronous and the first fetch after startup used to lose the race and go
* out from the datacenter — which is not an error, just not what the operator
* enabled the exit for. Resolves false at once when no exit is configured, so
* the common case costs nothing.
*/
async function awaitResidentialReady(timeoutMs) {
	if (requestResidentialOffer.getStore()) return true;
	const agent = active;
	if (!agent) return false;
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (!agent.connected) {
		if (active !== agent || Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
	return active === agent;
}
/**
* Start the agent in the background. Returns null when the feature is off.
* `log` defaults to stderr because stdout on this process carries the MCP
* JSON-RPC stream and must not be written to by anything else.
*/
function startResidentialAgent(log = (m) => process.stderr.write(`${m}\n`), env = process.env) {
	let cfg;
	try {
		cfg = residentialConfig(env);
	} catch (error) {
		log(`[residential] not started: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	if (!cfg) return null;
	const controller = new AbortController();
	const agent = new ObservableResidentialAgent({
		allowHosts: cfg.allowHosts,
		allowedPorts: [80, 443],
		controlProxy: cfg.controlProxy,
		descriptor: {
			city: cfg.city,
			country: cfg.country,
			id: cfg.id,
			maxConnections: cfg.maxConnections,
			region: cfg.region
		},
		log: (message) => log(`[residential] ${message}`),
		serverURL: cfg.serverUrl,
		token: cfg.token
	});
	active = agent;
	activeConfig = cfg;
	agent.run(controller.signal).catch((error) => log(`[residential] agent stopped: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
		if (active === agent) {
			active = null;
			activeConfig = null;
		}
	});
	log(`[residential] offering this machine as an exit (${cfg.country.toUpperCase()}${cfg.region ? `/${cfg.region}` : ""}), id ${cfg.id}, max ${cfg.maxConnections} connections`);
	return {
		get connected() {
			return agent.connected;
		},
		id: cfg.id,
		get offer() {
			return agent.connected ? offerFromConfig(cfg) : null;
		},
		stop() {
			controller.abort();
			agent.stop();
		}
	};
}

//#endregion
//#region src/publisher-search.ts
const CHALLENGE = /human verification|confirm you are human|verify (?:you are|that you are) human|just a moment|checking your browser|safeLine WAF|access denied|something went wrong/i;
function titleScore(title) {
	const text = title.trim();
	if (!text) return -1e3;
	const generic = /^(promotion|view|learn more|read more|details|buy|shop|pdf|html|protocol|sds|price|specifications?(?:\s*&\s*change notifications)?|publications?)$/i.test(text);
	return Math.min(text.length, 200) - (generic ? 500 : 0);
}
function canonicalResultUrl(raw) {
	try {
		const url = new URL(raw);
		url.hash = "";
		return url.toString();
	} catch {
		return raw;
	}
}
const QUERY_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"in",
	"of",
	"on",
	"or",
	"protocol",
	"the",
	"to",
	"with"
]);
function words(text) {
	return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}
/** Rank first-party links by query coverage without discarding synonym matches. */
function relevanceScore(result, query) {
	const queryWords = [...new Set(words(query).filter((word) => !QUERY_STOPWORDS.has(word)))];
	if (queryWords.length === 0) return 0;
	const titleWords = words(result.title);
	const bodyWords = words(`${result.title} ${result.snippet}`);
	const titleSet = new Set(titleWords);
	const bodySet = new Set(bodyWords);
	const titleMatches = queryWords.filter((word) => titleSet.has(word)).length;
	const bodyMatches = queryWords.filter((word) => bodySet.has(word)).length;
	const phrase = queryWords.join(" ");
	return (titleWords.join(" ").includes(phrase) ? 1e4 : 0) + (bodyWords.join(" ").includes(phrase) ? 4e3 : 0) + titleMatches * 1e3 + bodyMatches * 200 + (titleMatches === queryWords.length ? 2e3 : 0) + (bodyMatches === queryWords.length ? 500 : 0);
}
function resultsFromPage(vendor, page, query, limit) {
	if (CHALLENGE.test(`${page.title}\n${page.bodyText.slice(0, 2e3)}`)) return [];
	const byUrl = /* @__PURE__ */ new Map();
	for (const link of page.links) {
		if (!link.text.trim() || !vendor.publisherResult.test(link.href)) continue;
		if (vendor.publisherResultClass && !vendor.publisherResultClass.test(link.className ?? "")) continue;
		const url = canonicalResultUrl(link.href);
		const snippet = link.snippet.trim();
		const candidate = {
			title: link.text.trim().slice(0, 500),
			url,
			snippet: snippet === link.text.trim() ? "" : snippet.slice(0, 700),
			discoveredBy: ["publisher-browserless"]
		};
		const current = byUrl.get(url);
		if (!current) byUrl.set(url, candidate);
		else if (titleScore(candidate.title) > titleScore(current.title)) byUrl.set(url, candidate);
	}
	return [...byUrl.values()].map((result, index) => ({
		result,
		index,
		score: relevanceScore(result, query)
	})).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(({ result }) => result);
}
/** Search one publisher's own rendered search UI, datacenter first. */
async function searchPublisher(vendor, query, limit, opts = {}) {
	const started = Date.now();
	const cfg = browserlessConfig();
	if (!cfg) return {
		results: [],
		status: "unavailable",
		elapsedMs: Date.now() - started,
		error: "BROWSERLESS_TOKEN is not configured"
	};
	const searchUrl = vendor.searchUrl(query);
	const entryUrl = vendor.interactiveSearch?.startUrl ?? searchUrl;
	try {
		await opts.validateUrl?.(entryUrl);
	} catch {
		return {
			results: [],
			status: "error",
			elapsedMs: Date.now() - started,
			error: "publisher search URL rejected by URL policy"
		};
	}
	const doFetch = opts.fetchImpl ?? fetch;
	const runPublisherSearch = (residential) => vendor.publisherScrapeSelector ? scrapeSearchWithBrowserless(searchUrl, vendor.publisherScrapeSelector, doFetch, cfg, residential) : searchWithBrowserless(searchUrl, query, doFetch, cfg, vendor.interactiveSearch, vendor.shadowSearch, residential);
	let residentialSelector = null;
	let residentialAttempted = false;
	if (vendor.publisherResidentialFirst) {
		await awaitResidentialReady(4e3);
		residentialSelector = residentialSelectorFor(entryUrl);
		if (residentialSelector) {
			residentialAttempted = true;
			const residential = await runPublisherSearch(residentialSelector);
			const residentialResults = residential ? resultsFromPage(vendor, residential, query, limit) : [];
			if (residentialResults.length > 0) return {
				results: residentialResults,
				source: "publisher-browserless-residential",
				status: "ok",
				elapsedMs: Date.now() - started
			};
		}
	}
	const direct = await runPublisherSearch();
	const directResults = direct ? resultsFromPage(vendor, direct, query, limit) : [];
	if (directResults.length > 0) return {
		results: directResults,
		source: "publisher-browserless",
		status: "ok",
		elapsedMs: Date.now() - started
	};
	if (!residentialAttempted) await awaitResidentialReady(4e3);
	const selector = residentialAttempted ? null : residentialSelector ?? residentialSelectorFor(entryUrl);
	if (selector) {
		const residential = await runPublisherSearch(selector);
		const residentialResults = residential ? resultsFromPage(vendor, residential, query, limit) : [];
		if (residentialResults.length > 0) return {
			results: residentialResults,
			source: "publisher-browserless-residential",
			status: "ok",
			elapsedMs: Date.now() - started
		};
	}
	return {
		results: [],
		status: direct ? "empty" : "error",
		elapsedMs: Date.now() - started,
		error: direct ? "publisher page rendered but exposed no credible result links" : "publisher Browserless search failed"
	};
}

//#endregion
//#region src/agent/url-policy.ts
function blockedIpv4(address) {
	const p = address.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = p;
	return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 || a >= 224;
}
function blockedIpv6(address) {
	const value = address.toLowerCase().split("%", 1)[0];
	if (value === "::" || value === "::1") return true;
	if (/^(fc|fd)/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)) return true;
	if (value.startsWith("2001:db8:")) return true;
	const words = ipv6Words(value);
	if (!words) return true;
	if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 65535) && blockedIpv4(ipv4FromWords(words[6], words[7]))) return true;
	if (words[0] === 100 && words[1] === 65435 && words.slice(2, 6).every((word) => word === 0) && blockedIpv4(ipv4FromWords(words[6], words[7]))) return true;
	if (words[0] === 100 && words[1] === 65435 && words[2] === 1) return true;
	return false;
}
function ipv4FromWords(high, low) {
	return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
/** Expand an IPv6 literal into eight 16-bit words. */
function ipv6Words(address) {
	let value = address;
	const dotted = /(^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	if (dotted) {
		const octets = dotted[2].split(".").map(Number);
		if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		const high = octets[0] << 8 | octets[1];
		const low = octets[2] << 8 | octets[3];
		const replacement = `${high.toString(16)}:${low.toString(16)}`;
		value = `${value.slice(0, dotted.index + dotted[1].length)}${replacement}`;
	}
	if ((value.match(/::/g) ?? []).length > 1) return null;
	const [leftRaw, rightRaw] = value.split("::");
	const parse = (part) => {
		if (!part) return [];
		const pieces = part.split(":");
		if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/i.test(piece))) return null;
		return pieces.map((piece) => Number.parseInt(piece, 16));
	};
	const left = parse(leftRaw);
	const right = parse(rightRaw);
	if (!left || !right) return null;
	if (value.includes("::")) {
		const fill = 8 - left.length - right.length;
		if (fill < 1) return null;
		return [
			...left,
			...Array(fill).fill(0),
			...right
		];
	}
	return left.length === 8 ? left : null;
}
function isPublicAddress(address) {
	const family = isIP(address);
	if (family === 4) return !blockedIpv4(address);
	if (family === 6) return !blockedIpv6(address);
	return false;
}
function normalizedHost(host) {
	return host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}
function allowedHost(host, allowed) {
	const normalized = normalizedHost(host);
	return allowed.some((item) => {
		const base = normalizedHost(item);
		return normalized === base || normalized.endsWith(`.${base}`);
	});
}
async function assertSafePublicUrl(raw, allowedHosts = [], lookup$1 = lookup) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("unsafe-url: invalid URL");
	}
	if (url.protocol !== "https:") throw new Error("unsafe-url: only HTTPS navigation is allowed");
	if (url.username || url.password) throw new Error("unsafe-url: URL credentials are forbidden");
	const host = normalizedHost(url.hostname);
	if (!host || host === "localhost" || host.endsWith(".localhost")) throw new Error("unsafe-url: localhost is forbidden");
	if (allowedHosts.length > 0 && !allowedHost(host, allowedHosts)) throw new Error(`unsafe-url: host ${host} is outside the source allowlist`);
	if (isIP(host)) {
		if (!isPublicAddress(host)) throw new Error(`unsafe-url: non-public address ${host}`);
		return url;
	}
	const answers = await lookup$1(host, {
		all: true,
		verbatim: true
	});
	if (answers.length === 0 || answers.some((answer) => !isPublicAddress(answer.address))) throw new Error(`unsafe-url: ${host} resolves to a non-public address`);
	return url;
}
function assertLoopbackCdpEndpoint(raw) {
	const url = new URL(raw);
	const host = normalizedHost(url.hostname);
	if (url.protocol !== "http:" || !(host === "127.0.0.1" || host === "::1")) throw new Error("CDP endpoint must use HTTP on a literal loopback address");
	if (url.username || url.password) throw new Error("CDP endpoint credentials are forbidden");
	if (url.pathname !== "/" || url.search || url.hash || url.href !== `${url.origin}/`) throw new Error("CDP endpoint must be an origin with no path, query, or fragment");
	return url;
}
/** Validate the browser websocket advertised by a loopback CDP discovery page. */
function assertLoopbackCdpWebSocketEndpoint(raw, control) {
	const url = new URL(raw);
	const host = normalizedHost(url.hostname);
	const controlHost = normalizedHost(control.hostname);
	if (url.protocol !== "ws:" || !(host === "127.0.0.1" || host === "::1")) throw new Error("CDP websocket must use WS on a literal loopback address");
	if (host !== controlHost || url.port !== control.port) throw new Error("CDP websocket must use the same loopback address and port as discovery");
	if (url.username || url.password || url.search || url.hash || url.href.includes("?") || url.href.includes("#")) throw new Error("CDP websocket credentials, query, and fragment are forbidden");
	if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(url.pathname)) throw new Error("CDP websocket path is invalid");
	return url;
}

//#endregion
//#region src/cookies.ts
/**
* The per-hop URL policy every cookie-following fetch should use. Tests and
* embedders that inject a synthetic fetch get a no-op, because a fake host will
* never satisfy the public-address policy; real network calls always get the
* real check, on every redirect hop.
*/
function defaultUrlValidator(opts) {
	if (opts.validateUrl) return opts.validateUrl;
	if (opts.fetchImpl && opts.fetchImpl !== fetch) return async () => void 0;
	return async (candidate) => {
		await assertSafePublicUrl(candidate, []);
	};
}
/** RFC 6265 §5.1.4: the default path is the directory of the request path. */
function defaultPath(pathname) {
	if (!pathname.startsWith("/")) return "/";
	const cut = pathname.lastIndexOf("/");
	return cut <= 0 ? "/" : pathname.slice(0, cut);
}
/** RFC 6265 §5.1.3, minus the public-suffix check (see `acceptDomain`). */
function domainMatches(host, domain, hostOnly) {
	if (host === domain) return true;
	if (hostOnly) return false;
	return host.endsWith(`.${domain}`);
}
/** RFC 6265 §5.1.4 path-match: equal, a prefix ending in `/`, or a `/` boundary. */
function pathMatches(requestPath, cookiePath) {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}
/**
* Whether a `Domain` attribute may be honoured for this request host. A real
* jar consults the Public Suffix List so `example.co.uk` cannot set a cookie
* for `.co.uk`. We have no PSL and do not want the dependency, so we require
* the attribute to domain-match the host it came from and to contain a dot.
* That blocks cross-site injection, which is the property that matters here;
* an over-broad cookie from a host we deliberately requested is not a threat
* we are defending against.
*/
function acceptDomain(host, domain) {
	if (!domain.includes(".")) return false;
	return host === domain || host.endsWith(`.${domain}`);
}
function parseExpiry(attrs) {
	const maxAge = attrs.get("max-age");
	if (maxAge !== void 0) {
		const secs = Number(maxAge);
		if (Number.isFinite(secs)) return Date.now() + secs * 1e3;
	}
	const expires = attrs.get("expires");
	if (expires !== void 0) {
		const when = Date.parse(expires);
		if (!Number.isNaN(when)) return when;
	}
}
var CookieJar = class CookieJar {
	/** Keyed by name + domain + path, per RFC 6265 §5.3 step 11. */
	jar = /* @__PURE__ */ new Map();
	static key(c) {
		return `${c.name}\u0000${c.domain}\u0000${c.path}`;
	}
	/** Absorb every `Set-Cookie` on `res`, interpreted relative to `requestUrl`. */
	harvest(res, requestUrl) {
		const raws = res.headers.getSetCookie?.() ?? [];
		if (raws.length === 0) return;
		const { hostname, pathname } = new URL(requestUrl);
		const host = hostname.toLowerCase();
		for (const raw of raws) {
			const parts = raw.split(";");
			const pair = parts[0]?.trim() ?? "";
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			const attrs = /* @__PURE__ */ new Map();
			for (const attr of parts.slice(1)) {
				const a = attr.trim();
				if (!a) continue;
				const i = a.indexOf("=");
				if (i < 0) attrs.set(a.toLowerCase(), "");
				else attrs.set(a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim());
			}
			const rawDomain = (attrs.get("domain") ?? "").replace(/^\./, "").toLowerCase();
			const hostOnly = rawDomain === "";
			const domain = hostOnly ? host : rawDomain;
			if (!hostOnly && !acceptDomain(host, domain)) continue;
			const attrPath = attrs.get("path");
			const path = attrPath && attrPath.startsWith("/") ? attrPath : defaultPath(pathname);
			const expiresAt = parseExpiry(attrs);
			const cookie = {
				name,
				value,
				domain,
				path,
				secure: attrs.has("secure"),
				hostOnly,
				...expiresAt !== void 0 ? { expiresAt } : {}
			};
			if (expiresAt !== void 0 && expiresAt <= Date.now()) this.jar.delete(CookieJar.key(cookie));
			else this.jar.set(CookieJar.key(cookie), cookie);
		}
	}
	/** The `Cookie` header value for `url`, or "" when nothing matches. */
	header(url) {
		const { hostname, pathname, protocol } = new URL(url);
		const host = hostname.toLowerCase();
		const isSecure = protocol === "https:";
		const now = Date.now();
		const matched = [];
		for (const c of this.jar.values()) {
			if (c.expiresAt !== void 0 && c.expiresAt <= now) {
				this.jar.delete(CookieJar.key(c));
				continue;
			}
			if (c.secure && !isSecure) continue;
			if (!domainMatches(host, c.domain, c.hostOnly)) continue;
			if (!pathMatches(pathname || "/", c.path)) continue;
			matched.push(c);
		}
		matched.sort((a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name));
		return matched.map((c) => `${c.name}=${c.value}`).join("; ");
	}
	get size() {
		return this.jar.size;
	}
};
const MAX_REDIRECT_HOPS = 8;
/**
* Follow redirects by hand, carrying cookies across hops the way a browser
* would — including across sibling subdomains, which is what an identity-provider
* handshake needs.
*
* Manual redirect handling is mandatory rather than a convenience: automatic
* following would let a public URL bounce to loopback, a private network, or a
* cloud metadata endpoint before `validateUrl` could inspect the next hop.
*/
async function fetchFollowingWithCookies(doFetch, url, init, timeoutMs, validateUrl, jar = new CookieJar()) {
	let current = url;
	for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
		await validateUrl(current);
		const cookie = jar.header(current);
		const res = await fetchWithRetry(doFetch, current, {
			...init,
			redirect: "manual",
			headers: {
				...init.headers,
				...cookie ? { Cookie: cookie } : {}
			}
		}, timeoutMs, { retries: 0 });
		jar.harvest(res, current);
		if (res.status < 300 || res.status >= 400) return res;
		const location = res.headers.get("location");
		if (!location) return res;
		const next = new URL(location, current).toString();
		if (next === current && hop > 0) return res;
		current = next;
	}
	throw new Error(`redirect count exceeded after ${MAX_REDIRECT_HOPS} hops`);
}

//#endregion
//#region src/entitlement.ts
/** Escape a detected institution name before splicing it into a pattern. */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const DENY_RE = [
	/does not provide access to this content/i,
	/your institution does not have access/i,
	/no access to this content/i,
	/\bbuy (?:this )?(?:article|chapter|pdf)\b/i,
	/\bpurchase (?:this )?(?:article|pdf|access)\b/i,
	/\brent this article\b/i,
	/\bget access\b/i
];
const GRANT_RE = [
	/you have full access to this (?:article|content|protocol)/i,
	/\bfull access\b[^.]{0,60}\bvia\b/i,
	/access provided by/i,
	/\byou have access\b/i
];
/**
* Read a publisher landing page for an entitlement statement.
*
* `institution` is the name detected from the network. When the page names it
* directly the verdict is strong; the generic patterns are the fallback for
* publishers that phrase it impersonally.
*/
function classifyEntitlement(html, institution) {
	if (institution) {
		const name = escapeRe(institution);
		if (new RegExp(`${name}[^.]{0,80}does not provide access`, "i").test(html)) return {
			status: "not-entitled",
			evidence: `"${institution} does not provide access"`
		};
		if (new RegExp(`full access[^.]{0,80}${name}`, "i").test(html)) return {
			status: "entitled",
			evidence: `"full access … ${institution}"`
		};
	}
	for (const re of DENY_RE) {
		const m = re.exec(html);
		if (m) return {
			status: "not-entitled",
			evidence: `"${m[0]}"`
		};
	}
	for (const re of GRANT_RE) {
		const m = re.exec(html);
		if (m) return {
			status: "entitled",
			evidence: `"${m[0]}"`
		};
	}
	return {
		status: "unknown",
		evidence: "no entitlement statement on the page"
	};
}
const cache = /* @__PURE__ */ new Map();
function entitlementKey(url, journal) {
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		host = url;
	}
	return `${host}::${(journal ?? "").toLowerCase()}`;
}
function cachedEntitlement(key) {
	return cache.get(key);
}
function rememberEntitlement(key, verdict) {
	if (verdict.status !== "unknown") cache.set(key, verdict);
}

//#endregion
//#region src/extract.ts
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Publisher preview that says the protocol body requires subscription access. */
function looksLikeSubscriptionPreview(url, text) {
	if (getVendorForUrl(url)?.publisherFetch !== "abstract-only") return false;
	return /(?:preview of subscription content|access (?:this article |the full (?:article|text) )?(?:through|via) your institution|institutional access|subscribe to (?:this journal|read)|buy this article|purchase (?:this|the) article|full (?:article|text) access)/i.test(text);
}
/** Collapse HTML-ish markup to text while preserving paragraph breaks. */
function htmlToText(html) {
	const main = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html) ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
	let s = main ? main[1] : html;
	s = s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
	s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|h[1-6]|li|tr)\s*>/gi, "\n");
	return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Extract text from a PDF response via `unpdf` (lazily loaded). */
async function pdfToText(res) {
	try {
		const { getDocumentProxy, extractText } = await import("unpdf");
		const { text } = await extractText(await getDocumentProxy(new Uint8Array(await res.arrayBuffer())), { mergePages: true });
		const joined = Array.isArray(text) ? text.join("\n") : text;
		return typeof joined === "string" && joined.trim() ? joined : null;
	} catch {
		return null;
	}
}
function cap(text, maxChars) {
	const t = text.trim();
	if (t.length <= maxChars) return t;
	return `${t.slice(0, maxChars)}\n\n…[truncated; full document at the link]`;
}
/**
* protocols.io renders its protocol pages client-side — the served HTML is a
* ~100-byte shell with no readable text — but appending `.json` to a
* `/view/<slug>` URL returns the whole protocol, no API token needed. (The
* documented /api/v3|v4 endpoints do require a bearer token; this one doesn't.)
*/
function protocolsIoJsonUrl(url) {
	try {
		const u = new URL(url);
		if (!/(^|\.)protocols\.io$/i.test(u.hostname)) return null;
		if (!/^\/view\/[^/]+/.test(u.pathname)) return null;
		if (u.pathname.endsWith(".json")) return url;
		return `${u.origin}${u.pathname.replace(/\/+$/, "")}.json`;
	} catch {
		return null;
	}
}
/** Render a protocols.io table entity (a 2D cell array) as a markdown table. */
function renderTableEntity(data) {
	const rows = data?.data;
	if (!Array.isArray(rows) || rows.length === 0) return "";
	const cells = rows.map((r) => Array.isArray(r) ? r.map((c) => decodeEntities(String(c ?? "").replace(/<br\s*\/?>/gi, " / ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()) : []);
	const width = Math.max(...cells.map((r) => r.length));
	if (width === 0) return "";
	const pad = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
	const [head, ...body] = cells;
	return [
		pad(head),
		`|${" --- |".repeat(width)}`,
		...body.map(pad)
	].join("\n");
}
/**
* Steps arrive as Draft.js state. Plain prose is in `blocks[].text`, but the
* reaction tables and notes — the part a bench scientist actually needs — are
* `atomic` blocks pointing into `entityMap`. Reading only `blocks[].text` gets
* you "Set up the following reaction:" and then silently drops the reaction.
*/
function draftJsText(step) {
	if (typeof step !== "string") return "";
	try {
		const parsed = JSON.parse(step);
		const entities = parsed.entityMap ?? {};
		const out = [];
		for (const b of parsed.blocks ?? []) {
			if (b.type === "atomic") {
				for (const range of b.entityRanges ?? []) {
					const ent = entities[String(range.key)];
					if (!ent) continue;
					if (ent.type === "tables") {
						const t = renderTableEntity(ent.data);
						if (t) out.push(t);
					} else if (ent.type === "notes") {
						const nested = draftJsText(JSON.stringify(ent.data));
						if (nested) out.push(`> ${nested.split("\n").join("\n> ")}`);
					}
				}
				continue;
			}
			const text = (b.text ?? "").trim();
			if (text) out.push(text);
		}
		return out.join("\n");
	} catch {
		return "";
	}
}
/** Render a protocols.io protocol JSON payload as readable markdown. */
function renderProtocolsIo(payload) {
	const p = payload;
	if (!p || typeof p !== "object") return "";
	const out = [];
	if (p.title) out.push(`# ${p.title}`);
	const authors = (p.authors ?? []).map((a) => a?.name).filter(Boolean);
	if (authors.length) out.push(`_Authors: ${authors.join(", ")}_`);
	const desc = draftJsText(p.description) || stripTags(p.description ?? "").trim();
	if (desc) out.push(desc);
	const steps = Array.isArray(p.steps) ? p.steps : [];
	let body = 0;
	steps.forEach((s, i) => {
		const text = draftJsText(s?.step);
		if (text) {
			body++;
			out.push(`## Step ${i + 1}\n\n${text}`);
		}
	});
	if (body === 0) {
		const doc = draftJsText(p.document);
		if (doc) out.push(doc);
	}
	return out.join("\n\n").trim();
}
/**
* One jar per `extractOaContent` call, so the whole redirect chain — including
* a hop onto a sibling subdomain and back — shares cookies. See cookies.ts for
* why domain scoping rather than hostname keying is the load-bearing detail.
*/
async function fetchAllowingCookieGate(doFetch, url, init, timeoutMs, validateUrl, jar) {
	return fetchFollowingWithCookies(doFetch, url, init, timeoutMs, validateUrl, jar);
}
/**
* Fetch `url` and extract its readable text. Returns null on any failure
* (non-200, oversized, unsupported/undecodable, or a PDF with no `unpdf`
* available) so the caller can fall back to returning the bare link. Never
* throws.
*/
async function extractDirect(url, opts, maxChars) {
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 15e3;
	const validateUrl = defaultUrlValidator(opts);
	const jar = new CookieJar();
	try {
		const jsonUrl = protocolsIoJsonUrl(url);
		if (jsonUrl) {
			const jres = await fetchAllowingCookieGate(doFetch, jsonUrl, { headers: {
				"User-Agent": userAgent(url.length),
				Accept: "application/json"
			} }, timeoutMs, validateUrl, jar);
			if (jres.status === 200) {
				const text = renderProtocolsIo(await jres.json());
				if (text) return {
					text: cap(text, maxChars),
					format: "json"
				};
			}
		}
		const res = await fetchAllowingCookieGate(doFetch, url, { headers: {
			"User-Agent": userAgent(url.length),
			Accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8"
		} }, timeoutMs, validateUrl, jar);
		if (res.status !== 200) return null;
		const ct = (res.headers.get("content-type") ?? "").toLowerCase();
		if (Number(res.headers.get("content-length") ?? "0") > MAX_DOWNLOAD_BYTES) return null;
		if (ct.includes("pdf") || /\.pdf($|\?)/i.test(url)) {
			const text = await pdfToText(res);
			return text && text.trim() ? {
				text: cap(text, maxChars),
				format: "pdf"
			} : null;
		}
		const isXml = ct.includes("xml") || /\.xml($|\?)/i.test(url);
		const raw = await res.text();
		if (isXml) {
			const body = /<body[\s>]([\s\S]*?)<\/body>/i.exec(raw);
			const text = stripTags(body ? body[1] : raw);
			return text ? {
				text: cap(text, maxChars),
				format: "xml"
			} : null;
		}
		const text = htmlToText(raw);
		if (!text || looksLikeBotWall(text)) return null;
		return {
			text: cap(text, maxChars),
			format: "html"
		};
	} catch {
		return null;
	}
}
/**
* A PDF rendered in a browser opens in the PDF viewer, which replaces the JS
* context the extractor would read — the remote browser returns an error rather
* than the document. JSON endpoints come back wrapped in viewer markup for the
* same reason. Neither is worth a round trip.
*/
function suitableForBrowser(url) {
	return !/\.(?:pdf|json|xml)(?:$|\?)/i.test(url);
}
/** How long the first render will wait for a configured residential exit. */
function residentialReadyTimeoutMs() {
	const configured = Number(process.env.RESIDENTIAL_PROXY_READY_TIMEOUT_MS);
	return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 3e4) : 4e3;
}
/**
* Retrieve through the remote browser. The server's datacenter route is always
* tried first; a failed/challenged render or subscription-only preview is then
* retried through a registered local residential exit.
*/
async function extractViaBrowser(url, opts, maxChars, residentialOverride) {
	const cfg = browserlessConfig();
	if (!cfg || !suitableForBrowser(url)) return null;
	try {
		await defaultUrlValidator(opts)(url);
	} catch {
		return null;
	}
	const doFetch = opts.fetchImpl ?? fetch;
	const accept = (html, via) => {
		if (!html) return null;
		const text = htmlToText(html);
		if (!text || looksLikeBotWall(text) || looksLikeSoftNotFound(text)) return null;
		return {
			text: cap(text, maxChars),
			format: "html",
			via
		};
	};
	const datacenter = accept(await renderWithBrowserless(url, doFetch, cfg), "browserless");
	const subscriptionPreview = Boolean(datacenter && looksLikeSubscriptionPreview(url, datacenter.text));
	if (datacenter && !subscriptionPreview) return datacenter;
	if (!residentialOverride) await awaitResidentialReady(residentialReadyTimeoutMs());
	const selector = residentialOverride ?? residentialSelectorFor(url);
	if (!selector) return datacenter;
	try {
		if (endpointFlavor(assertBrowserlessEndpoint(cfg.endpoint)) === "hosted") return datacenter;
	} catch {
		return datacenter;
	}
	const residential = accept(await renderWithBrowserless(url, doFetch, cfg, selector), "browserless-residential");
	if (residential) {
		residential.residentialAttempted = true;
		residential.residentialReason = subscriptionPreview ? "subscription-preview" : "render-failure";
	}
	if (datacenter) datacenter.residentialAttempted = true;
	return residential ?? datacenter;
}
/**
* Catalog publisher pages use AWS Browserless first, matching the search path
* that discovered them. Arbitrary repository/PDF/XML locations retain the
* cheaper direct-first order. Either route falls through when it fails.
*/
async function extractOaContent(url, opts, maxChars) {
	const publisherPage = Boolean(getVendorForUrl(url) && suitableForBrowser(url));
	if (publisherPage) {
		const rendered = await extractViaBrowser(url, opts, maxChars);
		if (rendered) return rendered;
	}
	const direct = await extractDirect(url, opts, maxChars);
	if (direct) return direct;
	return publisherPage ? null : extractViaBrowser(url, opts, maxChars);
}
const BOT_WALL_RE = /checking your browser before accessing|just a moment(?:\.\.\.)?|performing security verification|(?:verify|confirm) (?:you are|that you are) human|human verification|safeline waf|enable javascript and cookies to continue|verifying you are (a )?human|request unsuccessful\.\s*incapsula|attention required!\s*\|\s*cloudflare|not automatically redirected after \d+ seconds|please (enable|turn on) (javascript|cookies) to (continue|proceed)/i;
const CITATION_PDF_RES = [/<meta[^>]+\bname=["']citation_pdf_url["'][^>]*\bcontent=["']([^"']+)["']/i, /<meta[^>]+\bcontent=["']([^"']+)["'][^>]*\bname=["']citation_pdf_url["']/i];
/** The publisher's own PDF URL for an article landing page, if it advertises one. */
function findCitationPdfUrl(html, baseUrl) {
	for (const re of CITATION_PDF_RES) {
		const m = re.exec(html);
		if (m?.[1]) try {
			return new URL(decodeEntities(m[1]), baseUrl).toString();
		} catch {
			return null;
		}
	}
	return null;
}
async function extractEntitledArticle(url, opts, maxChars, institution) {
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 2e4;
	const validateUrl = defaultUrlValidator(opts);
	const jar = new CookieJar();
	try {
		const res = await fetchAllowingCookieGate(doFetch, url, { headers: {
			"User-Agent": userAgent(url.length),
			Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8"
		} }, timeoutMs, validateUrl, jar);
		if (res.status !== 200) return {
			extracted: null,
			entitlement: "unknown",
			evidence: `HTTP ${res.status}`
		};
		if ((res.headers.get("content-type") ?? "").toLowerCase().includes("pdf")) {
			const direct = await pdfToText(res);
			return direct?.trim() ? {
				extracted: {
					text: cap(direct, maxChars),
					format: "pdf"
				},
				entitlement: "entitled",
				evidence: "the DOI resolved straight to a PDF"
			} : {
				extracted: null,
				entitlement: "unknown",
				evidence: "PDF could not be parsed"
			};
		}
		const html = await res.text();
		const landing = htmlToText(html);
		const verdict = classifyEntitlement(html, institution);
		const pdfUrl = findCitationPdfUrl(html, res.url || url);
		if (pdfUrl && verdict.status !== "not-entitled") {
			const pres = await fetchAllowingCookieGate(doFetch, pdfUrl, { headers: {
				"User-Agent": userAgent(url.length),
				Accept: "application/pdf,*/*;q=0.8"
			} }, timeoutMs, validateUrl, jar);
			if (pres.status === 200) {
				const text = await pdfToText(pres);
				if (text && text.trim().length > landing.length) return {
					extracted: {
						text: cap(text, maxChars),
						format: "pdf"
					},
					entitlement: "entitled",
					evidence: verdict.status === "entitled" ? verdict.evidence : "the publisher served the full PDF"
				};
			}
		}
		return {
			extracted: landing && !looksLikeBotWall(landing) ? {
				text: cap(landing, maxChars),
				format: "html"
			} : null,
			entitlement: verdict.status,
			evidence: verdict.evidence
		};
	} catch (err) {
		return {
			extracted: null,
			entitlement: "unknown",
			evidence: err instanceof Error ? err.message : "retrieval failed"
		};
	}
}
/**
* True when extraction produced a bot challenge rather than an article. Returning
* one as content is worse than returning nothing: the caller records `ok`, the
* agent reads "Checking your browser…" as the protocol, and the health table
* counts a success. Short *and* matching — a real article that merely quotes one
* of these phrases will run past the length bound.
*/
function looksLikeBotWall(text) {
	return text.length < 1500 && BOT_WALL_RE.test(text);
}

//#endregion
//#region src/network-context.ts
const DEFAULT_LOOKUP_URL = "https://ipinfo.io/json";
const DEFAULT_TIMEOUT_MS$1 = 4e3;
/**
* Organisation-name signals. Deliberately includes non-English spellings
* (universität/université/universidad all share the "universit" stem) and the
* national research-and-education networks, whose ASNs front entire
* university systems: Internet2 and ESnet (US), JISC/Janet (UK), GÉANT (EU),
* RENATER (FR), SURF (NL), DFN (DE), CERNET (CN), SINET (JP), AARNet (AU).
*/
const ACADEMIC_ORG_RE = /\b(?:universi[td]\w*|college|institute of technology|polytechnic\w*|academy of sciences|research (?:council|institute|network)|school of medicine|teaching hospital|internet2|esnet|geant|renater|surfnet|surf b\.?v|jisc|janet|dfn-verein|cernet|sinet|aarnet|nordunet|funet|cesnet|garr|rediris|max planck|helmholtz|fraunhofer|leibniz|cnrs|inserm|csic|riken|tubitak)\b/i;
/** Academic/education TLD shapes: .edu, .ac.uk, .edu.au, .ac.jp, .edu.cn … */
const ACADEMIC_HOST_RE = /(?:^|\.)(?:edu|ac)(?:\.[a-z]{2,3})?$/i;
let cached;
let inFlight;
function fromEnvOverride() {
	const forced = process.env.PROTOCOLS_NETWORK_KIND?.trim().toLowerCase();
	if (forced !== "academic" && forced !== "commercial" && forced !== "unknown") return void 0;
	return {
		kind: forced,
		reason: "PROTOCOLS_NETWORK_KIND override",
		detectedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/** Classify from whatever signals we managed to gather. Pure, so it is testable. */
function classify(signals) {
	const { org, rdns } = signals;
	if (rdns) {
		const host = rdns.replace(/\.$/, "").toLowerCase();
		if (ACADEMIC_HOST_RE.test(host)) return {
			kind: "academic",
			reason: `reverse DNS ${host}`
		};
	}
	if (org && ACADEMIC_ORG_RE.test(org)) return {
		kind: "academic",
		reason: `network operator "${org}"`
	};
	if (rdns && ACADEMIC_ORG_RE.test(rdns)) return {
		kind: "academic",
		reason: `reverse DNS ${rdns}`
	};
	if (org) return {
		kind: "commercial",
		reason: `network operator "${org}"`
	};
	if (rdns) return {
		kind: "commercial",
		reason: `reverse DNS ${rdns}`
	};
	return {
		kind: "unknown",
		reason: "no network signals available"
	};
}
async function lookupPublicIp(timeoutMs) {
	const url = process.env.PROTOCOLS_NETWORK_LOOKUP_URL || DEFAULT_LOOKUP_URL;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				"User-Agent": "labee-protocol-searcher/network-context"
			}
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
async function reverseDns(ip) {
	try {
		return (await reverse(ip))[0];
	} catch {
		return;
	}
}
/**
* Resolve the network context, at most once per process. Concurrent callers
* share one in-flight detection rather than racing duplicate lookups.
*/
async function detectNetworkContext(opts = {}) {
	if (cached) return cached;
	const override = fromEnvOverride();
	if (override) return cached = override;
	if (inFlight) return inFlight;
	inFlight = (async () => {
		const detectedAt = (/* @__PURE__ */ new Date()).toISOString();
		if (process.env.PROTOCOLS_NETWORK_DETECT?.trim().toLowerCase() === "off") return {
			kind: "unknown",
			reason: "detection disabled",
			detectedAt
		};
		const info = await lookupPublicIp(Number(process.env.PROTOCOLS_NETWORK_TIMEOUT_MS) || opts.timeoutMs || DEFAULT_TIMEOUT_MS$1);
		const ip = typeof info?.ip === "string" ? info.ip : void 0;
		const org = typeof info?.org === "string" ? info.org : void 0;
		const rdns = (typeof info?.hostname === "string" ? info.hostname : void 0) ?? (ip ? await reverseDns(ip) : void 0);
		const { kind, reason } = classify({
			...org ? { org } : {},
			...rdns ? { rdns } : {}
		});
		return {
			kind,
			reason,
			detectedAt,
			...ip ? { ip } : {},
			...org ? { org } : {},
			...rdns ? { rdns } : {}
		};
	})();
	try {
		cached = await inFlight;
		return cached;
	} finally {
		inFlight = void 0;
	}
}
/** The cached context, or undefined when detection has not run yet. */
function networkContext() {
	return cached;
}
/**
* True when this process is calling from a network that may carry institutional
* subscriptions. Callers use it to decide whether attempting a publisher page
* is worth a round trip — never to claim entitlement it has not observed.
*/
function onAcademicNetwork() {
	return cached?.kind === "academic";
}
/**
* The institution's own name, with the ASN prefix stripped — "AS26488 Santa Clara
* University" becomes "Santa Clara University". Publishers print this name on the
* page when they recognise the IP, both to grant ("full access via …") and to
* refuse ("… does not provide access to this content"), so it is the key that
* makes entitlement detection publisher-neutral.
*/
function institutionName() {
	const org = cached?.org?.trim();
	if (!org) return void 0;
	const name = org.replace(/^AS\d+\s+/i, "").trim();
	return name.length > 2 ? name : void 0;
}
/** One-line summary for the startup banner. */
function describeNetworkContext(ctx) {
	const where = ctx.ip ? ` ${ctx.ip}` : "";
	return `network: ${ctx.kind}${where} (${ctx.reason})`;
}

//#endregion
//#region src/fulltext.ts
const SEARCH_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const FULLTEXT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
const OPENALEX_BASE = "https://api.openalex.org/works";
const NCBI_TOOL = "labee-protocol-searcher";
const DEFAULT_TIMEOUT_MS = 12e3;
const MAX_CHARS = 2e4;
function contactEmail() {
	return process.env.PROTOCOLS_CONTACT_EMAIL || "labee-protocol-searcher@example.com";
}
/** Machine-readable status footer the agent can branch on. */
function withStatus$2(text, status, reason) {
	return `${text}${reason ? `\n\n_reason: ${reason}_` : ""}\n\n_status: ${status}_`;
}
/**
* Europe PMC's rendered PDF for an article that is free to read but sits outside
* the Open Access Subset.
*
* These are records with `inEPMC: Y` and `isOpenAccess: N`: the publisher granted
* PMC the right to *display* the full text, but not the redistribution licence
* that puts an article in the OA subset. Consequently the `fullTextXML` endpoint
* and NCBI's OA service both decline it (`idIsNotOpenAccess`) — which is why the
* tiers above come up empty — while Europe PMC still lists a "Free pdf" URL that
* any browser can open.
*
* Retrieving it circumvents no authentication, paywall or challenge; the flag it
* disregards is about redistribution rights, not access. That is a licence
* judgement rather than a technical one, so it is opt-out-able:
* PROTOCOLS_DISPLAY_ONLY_FETCH=off. The result is labelled `display-only-full-text`
* so it is never mistaken for open-access content that may be redistributed.
*/
function displayOnlyPdfUrl(result) {
	if (!result.pmcid) return null;
	if (result.isOpenAccess === "Y") return null;
	if (result.inEPMC !== "Y") return null;
	if (!(result.fullTextUrlList?.fullTextUrl ?? []).some((u) => u.availability?.startsWith("Free") && u.documentStyle === "pdf")) return null;
	return `https://europepmc.org/articles/${result.pmcid}?pdf=render`;
}
/**
* Publishers that serve the article PDF from a stable, public URL derivable from
* the DOI.
*
* Bio-protocol is the motivating case: its HTML article page sits behind a
* SafeLine WAF challenge that no automated client can pass, while the PDF itself
* is served straight from `en.bio-protocol.org/pdf/` with no gate at all. The
* articles are CC BY-NC, so this is the publisher's own open copy — a different
* endpoint, not a way around the challenge.
*
* Add a publisher here only when the mapping is deterministic and the content is
* openly licensed.
*/
const DIRECT_PDF = [{
	re: /^10\.21769\/bioprotoc\.(\d+)$/i,
	build: (m) => `https://en.bio-protocol.org/pdf/Bio-protocol${m[1]}.pdf`
}];
function directPdfUrl(doi) {
	if (!doi) return null;
	const clean = doi.trim().replace(/^doi:/i, "");
	for (const { re, build } of DIRECT_PDF) {
		const m = clean.match(re);
		if (m) return build(m);
	}
	return null;
}
/**
* Recover the canonical DOI from a Bio-protocol article URL without requesting
* its SafeLine-protected HTML page. Bio-protocol uses the same numeric article
* id in its DOI and public PDF URL.
*/
function bioProtocolDoiFromUrl(raw) {
	try {
		const url = new URL(raw);
		const host = url.hostname.toLowerCase();
		if (![
			"bio-protocol.org",
			"www.bio-protocol.org",
			"en.bio-protocol.org"
		].includes(host)) return null;
		if (!/^\/(?:en\/)?bpdetail\/?$/i.test(url.pathname)) return null;
		const id = url.searchParams.get("id")?.trim();
		return id && /^\d+$/.test(id) ? `10.21769/BioProtoc.${id}` : null;
	} catch {
		return null;
	}
}
/** Build the Europe PMC search query that best resolves a raw identifier. */
function resolveQuery(id) {
	const s = id.trim();
	if (/^PMC\d+$/i.test(s)) return `PMCID:${s.toUpperCase()}`;
	if (/^\d+$/.test(s)) return `EXT_ID:${s} AND SRC:MED`;
	if (/^10\.\S+\/\S+/.test(s) || s.toLowerCase().startsWith("doi:")) return `DOI:"${s.replace(/^doi:/i, "")}"`;
	return s;
}
/** Human-facing citation link for an article we couldn't get full text for. */
function articleUrl(r, fallbackId) {
	if (r.doi) return `https://doi.org/${r.doi}`;
	if (r.pmcid) return `https://europepmc.org/article/PMC/${r.pmcid}`;
	if (r.source && r.id) return `https://europepmc.org/article/${r.source}/${r.id}`;
	return `https://europepmc.org/search?query=${encodeURIComponent(fallbackId)}`;
}
const SEC_TOKEN = /<sec\b[^>]*>|<\/sec>/gi;
/** Ranges of the top-level (depth-0) <sec>…</sec> blocks in `xml`. */
function topSecRanges(xml) {
	const ranges = [];
	let depth = 0;
	let blockStart = -1;
	let innerStart = -1;
	SEC_TOKEN.lastIndex = 0;
	let m;
	while (m = SEC_TOKEN.exec(xml)) if (!(m[0][1] === "/")) {
		if (depth === 0) {
			blockStart = m.index;
			innerStart = m.index + m[0].length;
		}
		depth++;
	} else if (depth > 0) {
		depth--;
		if (depth === 0 && blockStart !== -1) {
			ranges.push({
				blockStart,
				innerStart,
				innerEnd: m.index,
				blockEnd: m.index + m[0].length
			});
			blockStart = -1;
		}
	}
	return ranges;
}
/** Inner contents of each top-level <sec>. */
function topSecs(xml) {
	return topSecRanges(xml).map((r) => xml.slice(r.innerStart, r.innerEnd));
}
/** Remove the top-level <sec>…</sec> blocks, leaving only this level's markup. */
function stripTopSecs(xml) {
	const ranges = topSecRanges(xml);
	if (ranges.length === 0) return xml;
	let out = "";
	let last = 0;
	for (const r of ranges) {
		out += xml.slice(last, r.blockStart);
		last = r.blockEnd;
	}
	out += xml.slice(last);
	return out;
}
/** Flatten a <sec> block (and its children) into ordered, depth-tagged rows. */
function flattenSec(inner, depth, out) {
	const titleM = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(inner);
	const title = titleM ? stripTags(titleM[1]) : "";
	const children = topSecs(inner);
	let self = stripTopSecs(inner);
	if (titleM) self = self.replace(titleM[0], "");
	const text = stripTags(self);
	out.push({
		title,
		text,
		depth
	});
	for (const c of children) flattenSec(c, depth + 1, out);
}
const PROCEDURE_RE = /method|protocol|procedure|step|materials|reagent|prepar|assay|workflow/i;
/**
* Render JATS full text to markdown. With `section`, returns only matching
* sections (and lists the titles when nothing matches). Otherwise renders all
* sections in document order, but when the budget is exceeded keeps procedure
* sections and drops the rest, naming what was omitted so the agent can
* re-fetch a specific section.
*/
function jatsToMarkdown(xml, section, maxChars) {
	const bodyM = /<body[\s>]([\s\S]*?)<\/body>/i.exec(xml);
	const body = bodyM ? bodyM[1] : xml;
	const flat = [];
	for (const s of topSecs(body)) flattenSec(s, 2, flat);
	if (flat.length === 0) {
		const text = stripTags(body);
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…[truncated; full text at the article link]` : text;
	}
	if (section) {
		const q = section.toLowerCase();
		const hits = flat.filter((s) => s.title.toLowerCase().includes(q));
		if (hits.length === 0) return `No section matching "${section}". Available sections: ${flat.filter((s) => s.title).map((s) => s.title).join(" · ") || "(untitled)"}.`;
		return renderSections(hits, maxChars).markdown;
	}
	const { markdown, omitted } = renderSections(flat, maxChars);
	return `${flat.length > 1 ? `_Sections: ${flat.filter((s) => s.title).map((s) => s.title).join(" · ")}._\n\n` : ""}${markdown}${omitted.length > 0 ? `\n\n…[${omitted.length} section(s) omitted for length: ${omitted.join(" · ")}. Re-fetch with \`section\` to read one in full.]` : ""}`;
}
/** Concatenate sections within a char budget, keeping procedure ones first. */
function renderSections(sections, maxChars) {
	const ordered = [...sections].sort((a, b) => {
		return (PROCEDURE_RE.test(a.title) ? 0 : 1) - (PROCEDURE_RE.test(b.title) ? 0 : 1);
	});
	const rendered = new Array(sections.length).fill(null);
	const omitted = [];
	let used = 0;
	for (const s of ordered) {
		const idx = sections.indexOf(s);
		const block = [s.title ? `${"#".repeat(Math.min(s.depth, 6))} ${s.title}` : "", s.text].filter(Boolean).join("\n\n");
		if (!block) continue;
		if (used > 0 && used + block.length > maxChars) {
			omitted.push(s.title || "(untitled)");
			continue;
		}
		rendered[idx] = block;
		used += block.length + 2;
	}
	return {
		markdown: rendered.filter((b) => b !== null).join("\n\n"),
		omitted
	};
}
/**
* The PMCID in an Unpaywall location URL. Unpaywall writes PMC links both ways —
* `/pmc/articles/PMC3868217` and, for older records, `/pmc/articles/3004291` —
* and missing the bare form sends us scraping the PMC website (which answers
* with a bot challenge) instead of asking an API for the same article.
*/
function pmcidFromUrl(url) {
	const prefixed = /(PMC\d+)/i.exec(url);
	if (prefixed) return prefixed[1].toUpperCase();
	const bare = /\/pmc\/articles\/(\d+)/i.exec(url);
	return bare ? `PMC${bare[1]}` : void 0;
}
/**
* Ask Unpaywall for an open-access copy of a DOI. Prefers a location we can
* still render (one bearing a PMCID → re-resolvable to fullTextXML); otherwise
* returns the best direct OA link. Never throws — a miss just returns null.
*/
async function tryUnpaywall(doi, doFetch, timeoutMs) {
	if (!doi) return null;
	try {
		const res = await fetchWithRetry(doFetch, `${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(contactEmail())}`, { headers: { Accept: "application/json" } }, timeoutMs, { retries: 1 });
		if (res.status !== 200) return null;
		const json = await res.json();
		if (!json.is_oa) return null;
		const locs = [json.best_oa_location, ...json.oa_locations ?? []].filter((l) => Boolean(l));
		for (const loc of locs) {
			const pmcid = pmcidFromUrl(`${loc.url ?? ""} ${loc.url_for_pdf ?? ""}`);
			if (pmcid) return {
				pmcid,
				...loc.url_for_pdf ?? loc.url ? { oaUrl: loc.url_for_pdf ?? loc.url } : {},
				license: loc.license,
				version: loc.version
			};
		}
		const best = json.best_oa_location ?? locs[0];
		const link = best?.url_for_pdf ?? best?.url;
		if (link) return {
			oaUrl: link,
			license: best?.license,
			version: best?.version
		};
		return null;
	} catch {
		return null;
	}
}
/**
* OpenAlex is deliberately a late metadata fallback. Newly deposited PMC copies
* can appear there before Europe PMC adds a PMCID to its search record (Current
* Protocols e70422 is a measured example). OpenAlex does not serve the article;
* it only lets us retain the public repository URL instead of incorrectly
* concluding that no copy exists.
*/
async function tryOpenAlex(doi, doFetch, timeoutMs) {
	if (!doi) return null;
	try {
		const id = `https://doi.org/${doi}`;
		const res = await fetchWithRetry(doFetch, `${OPENALEX_BASE}/${encodeURIComponent(id)}?mailto=${encodeURIComponent(contactEmail())}`, { headers: { Accept: "application/json" } }, timeoutMs, { retries: 1 });
		if (res.status !== 200) return null;
		const json = await res.json();
		if (!json.open_access?.is_oa) return null;
		const locations = [json.best_oa_location, ...json.locations ?? []].filter((location) => Boolean(location));
		const urlCandidates = [json.open_access.oa_url, ...locations.flatMap((location) => [location.pdf_url, location.landing_page_url])].filter((candidate) => Boolean(candidate));
		const oaUrl = urlCandidates.find((candidate) => Boolean(pmcidFromUrl(candidate))) ?? urlCandidates[0];
		if (!oaUrl) return null;
		const selected = locations.find((location) => location.pdf_url === oaUrl || location.landing_page_url === oaUrl);
		const license = selected?.license?.trim() || void 0;
		const version = selected?.version?.trim() || void 0;
		const pmcid = pmcidFromUrl(oaUrl);
		return {
			oaUrl,
			...pmcid ? { pmcid } : {},
			...license ? { license } : {},
			...version ? { version } : {},
			...json.open_access.oa_status ? { oaStatus: json.open_access.oa_status } : {}
		};
	} catch {
		return null;
	}
}
/** GET a PMCID's JATS from Europe PMC and render it, or null if unavailable. */
async function fetchEpmcFulltext(pmcid, doFetch, timeoutMs, section) {
	const res = await fetchWithRetry(doFetch, `${FULLTEXT_BASE}/${pmcid}/fullTextXML`, { headers: { Accept: "application/xml" } }, timeoutMs);
	if (res.status !== 200) return null;
	return jatsToMarkdown(await res.text(), section, MAX_CHARS) || null;
}
/**
* The same PMCID from NCBI, which serves author manuscripts Europe PMC's
* open-access endpoint 404s on. When the publisher has opted out of XML
* download NCBI returns the record without a `<body>` (and says so in a
* comment) — that's a miss, not text, so require a body before rendering.
*/
async function fetchNcbiFulltext(pmcid, doFetch, timeoutMs, section) {
	const key = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : "";
	const res = await fetchWithRetry(doFetch, `${EUTILS_BASE}/efetch.fcgi?db=pmc&retmode=xml&id=${encodeURIComponent(pmcid.replace(/^PMC/i, ""))}&tool=${NCBI_TOOL}&email=${encodeURIComponent(contactEmail())}${key}`, { headers: { Accept: "application/xml" } }, timeoutMs);
	if (res.status !== 200) return null;
	const xml = await res.text();
	if (!/<body[\s>]/i.test(xml)) return null;
	return jatsToMarkdown(xml, section, MAX_CHARS) || null;
}
/** Europe PMC first (it's the OA-licensed copy), then NCBI for manuscripts. */
async function fetchPmcFulltext(pmcid, doFetch, timeoutMs, section) {
	const epmc = await fetchEpmcFulltext(pmcid, doFetch, timeoutMs, section);
	if (epmc) return {
		markdown: epmc,
		via: "Europe PMC"
	};
	const ncbi = await fetchNcbiFulltext(pmcid, doFetch, timeoutMs, section);
	if (ncbi) return {
		markdown: ncbi,
		via: "NCBI E-utilities"
	};
	return null;
}
/**
* The abstract Europe PMC already returned in step 1, as a last resort before a
* bare link. Costs no extra request — `resultType=core` carries it — and for a
* paywalled protocol it still states the aim, principle and typical timing.
*/
function abstractBlock(result) {
	const abstract = stripTags(result.abstractText ?? "").trim();
	if (abstract.length < 100) return null;
	const mesh = (result.meshHeadingList?.meshHeading ?? []).map((m) => m.descriptorName).filter((d) => Boolean(d));
	const meshLine = mesh.length > 0 ? `\n\n_MeSH: ${mesh.slice(0, 12).join(" · ")}._` : "";
	return `## Abstract\n\n${abstract.length > MAX_CHARS ? `${abstract.slice(0, MAX_CHARS)}…` : abstract}${meshLine}`;
}
/** DOI for an id: from the resolved record, or the id itself if DOI-shaped. */
function doiFor(result, id) {
	if (result.doi) return result.doi;
	const m = /(10\.\S+\/\S+)/.exec(id.replace(/^doi:/i, ""));
	return m ? m[1] : void 0;
}
function displayOnlyEnabled() {
	return process.env.PROTOCOLS_DISPLAY_ONLY_FETCH?.trim().toLowerCase() !== "off";
}
function displayOnlyLink(heading, pmcid, url, citation) {
	return withStatus$2(`${heading}\n\nA full-text PMC copy is free to read in a browser, but it is outside the Open Access Subset and carries no explicit redistribution licence. Labee therefore keeps it as display-only instead of calling it openly licensed:\n\n${url}\n\nPMCID: ${pmcid}\n\nCitation: ${citation}`, "display-only-link");
}
/**
* Fetch open-access full text for a DOI / PMID / PMCID and return it as
* markdown, falling back through Unpaywall to a citation link. Never throws for
* the "unavailable" case — only for hard fetch failures the caller reports as a
* tool error.
*/
async function getProtocolFulltext(id, opts = {}) {
	const trimmed = id.trim();
	if (!trimmed) return "Error: `id` is required (a DOI, PMID, or PMCID).";
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const section = opts.section;
	const directFromInput = directPdfUrl(trimmed);
	if (directFromInput) {
		const extracted = await extractOaContent(directFromInput, {
			fetchImpl: doFetch,
			timeoutMs
		}, MAX_CHARS);
		if (extracted?.format === "pdf" && extracted.text.trim()) return withStatus$2(`# ${trimmed.replace(/^doi:/i, "")}\n\n_Source: publisher open-access PDF (${directFromInput})._\n\n${extracted.text}`, "ok");
	}
	const sres = await fetchWithRetry(doFetch, `${SEARCH_BASE}?query=${encodeURIComponent(resolveQuery(trimmed))}&format=json&pageSize=1&resultType=core`, { headers: { Accept: "application/json" } }, timeoutMs);
	if (sres.status !== 200) throw new Error(`Europe PMC HTTP ${sres.status}`);
	const result = (await sres.json()).resultList?.result?.[0];
	if (!result) return withStatus$2(`No Europe PMC record found for "${trimmed}". It may not be indexed; try a DOI, PMID, or PMCID.`, "not-found", "not-indexed");
	const heading = `# ${(result.title ?? "").replace(/<[^>]+>/g, "").trim() || trimmed}`;
	const doi = doiFor(result, trimmed);
	const entitledEnabled = process.env.PROTOCOLS_ENTITLED_FETCH?.trim().toLowerCase() !== "off";
	let entitlementNote = "";
	if (doi && entitledEnabled && onAcademicNetwork()) {
		const via = institutionName() ?? networkContext()?.org ?? "this network";
		const journal = result.journalInfo?.journal?.title;
		const key = entitlementKey(`https://doi.org/${doi}`, journal);
		const known = cachedEntitlement(key);
		if (known?.status === "not-entitled") entitlementNote = `\n\n_${via} does not appear to subscribe to ${journal ?? "this journal"} (${known.evidence}), so the publisher's copy was not attempted._`;
		else {
			const outcome = await extractEntitledArticle(`https://doi.org/${doi}`, {
				fetchImpl: doFetch,
				timeoutMs
			}, MAX_CHARS, institutionName());
			rememberEntitlement(key, {
				status: outcome.entitlement,
				evidence: outcome.evidence
			});
			const body = outcome.extracted;
			if (body && body.text.trim().length > 2e3 && !looksLikeBotWall(body.text)) return withStatus$2(`${heading}\n\n_Source: publisher ${body.format} via institutional access (${via}${journal ? ` · ${journal}` : ""}) — NOT open access; redistribution is governed by that subscription._\n\n${body.text}`, "entitled-full-text");
			if (outcome.entitlement === "not-entitled") entitlementNote = `\n\n_${via} does not provide access to ${journal ?? "this journal"} (publisher said: ${outcome.evidence})._`;
		}
	}
	if (result.pmcid) {
		const hit = await fetchPmcFulltext(result.pmcid, doFetch, timeoutMs, section);
		if (hit) return withStatus$2(`${heading}\n\n_Source: ${hit.via} full text (${result.pmcid})._\n\n${hit.markdown}`, "ok");
	}
	const direct = directPdfUrl(doi);
	if (direct && direct !== directFromInput) {
		const extracted = await extractOaContent(direct, {
			fetchImpl: doFetch,
			timeoutMs
		}, MAX_CHARS);
		if (extracted?.format === "pdf" && extracted.text.trim()) return withStatus$2(`${heading}\n\n_Source: publisher open-access PDF (${direct})._\n\n${extracted.text}`, "ok");
	}
	const displayOnly = displayOnlyEnabled() ? displayOnlyPdfUrl(result) : null;
	if (displayOnly) {
		const extracted = await extractOaContent(displayOnly, {
			fetchImpl: doFetch,
			timeoutMs
		}, MAX_CHARS);
		if (extracted?.text?.trim() && !looksLikeBotWall(extracted.text)) return withStatus$2(`${heading}\n\n_Source: Europe PMC free-to-read PDF (${result.pmcid}) — free to read but outside the Open Access Subset, so it carries no redistribution licence._\n\n${extracted.text}`, "display-only-full-text");
	}
	const oa = await tryUnpaywall(doi, doFetch, timeoutMs);
	if (oa?.pmcid) {
		const hit = await fetchPmcFulltext(oa.pmcid, doFetch, timeoutMs, section);
		if (hit) {
			const lic = oa.license ? ` · ${oa.license}` : "";
			return withStatus$2(`${heading}\n\n_Source: Unpaywall → ${hit.via} full text (${oa.pmcid}${lic})._\n\n${hit.markdown}`, "ok");
		}
		if (displayOnlyEnabled() && oa.oaUrl && !oa.license) return displayOnlyLink(heading, oa.pmcid, oa.oaUrl, articleUrl(result, trimmed));
	}
	const openAlex = await tryOpenAlex(doi, doFetch, timeoutMs);
	if (openAlex?.pmcid) {
		const hit = await fetchPmcFulltext(openAlex.pmcid, doFetch, timeoutMs, section);
		if (hit) {
			const lic = openAlex.license ? ` · ${openAlex.license}` : "";
			return withStatus$2(`${heading}\n\n_Source: OpenAlex → ${hit.via} full text (${openAlex.pmcid}${lic})._\n\n` + hit.markdown, "ok");
		}
		if (displayOnlyEnabled() && !openAlex.license) return displayOnlyLink(heading, openAlex.pmcid, openAlex.oaUrl, articleUrl(result, trimmed));
	}
	if (openAlex?.oaUrl) {
		const meta = [
			openAlex.version,
			openAlex.license,
			openAlex.oaStatus
		].filter(Boolean).join(", ");
		const extracted = await extractOaContent(openAlex.oaUrl, {
			fetchImpl: doFetch,
			timeoutMs
		}, MAX_CHARS);
		if (extracted) {
			const status = openAlex.license ? "ok" : "display-only-full-text";
			return withStatus$2(`${heading}\n\n_Source: OpenAlex ${openAlex.license ? "open-access" : "free-to-read, with no explicit redistribution licence"} ${extracted.format}, best-effort extraction from ${openAlex.oaUrl}${meta ? ` (${meta})` : ""}._\n\n${extracted.text}`, status);
		}
		return withStatus$2(`${heading}\n\nOpenAlex reports a public copy, but Labee could not extract it automatically${meta ? ` (${meta})` : ""}:\n\n${openAlex.oaUrl}\n\nCitation: ${articleUrl(result, trimmed)}`, openAlex.license ? "oa-link" : "display-only-link");
	}
	if (oa?.oaUrl) {
		const meta = [oa.version, oa.license].filter(Boolean).join(", ");
		const extracted = await extractOaContent(oa.oaUrl, {
			fetchImpl: doFetch,
			timeoutMs
		}, MAX_CHARS);
		if (extracted) return withStatus$2(`${heading}\n\n_Source: Unpaywall open-access ${extracted.format}, best-effort extraction from ${oa.oaUrl}${meta ? ` (${meta})` : ""}._\n\n${extracted.text}`, "ok");
		return withStatus$2(`${heading}\n\nNo machine-readable full text, but Unpaywall found an open-access copy${meta ? ` (${meta})` : ""}:\n\n${oa.oaUrl}\n\nCitation: ${articleUrl(result, trimmed)}`, "oa-link");
	}
	const pmcNote = result.pmcid ? `\n\nA PMC copy exists and is free to read in a browser, though its full text isn't served for download: https://www.ncbi.nlm.nih.gov/pmc/articles/${result.pmcid}/` : "";
	const abstract = abstractBlock(result);
	if (abstract) return withStatus$2(`${heading}\n\n_Source: Europe PMC abstract — no public open-access full text was found at retrieval time._\n\n${abstract}${pmcNote}${entitlementNote}\n\nRead the full protocol at: ${articleUrl(result, trimmed)}`, "abstract-only", "no-public-full-text");
	return withStatus$2(`${heading}\n\nNo public open-access full text was found at retrieval time via Europe PMC, NCBI, Unpaywall or OpenAlex.${pmcNote}\n\nRead it at: ${articleUrl(result, trimmed)}`, "no-open-fulltext", "no-public-full-text");
}

//#endregion
//#region src/search.ts
/** Normalize a URL to `host/path` without the `www.` prefix, lowercased. */
function normalizeUrl(url) {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "").toLowerCase() + u.pathname.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}
/**
* Find the vendor a result URL belongs to. Matches by `searchSite` prefix on a
* host boundary (so "neb.com" never matches "neb.com.evil.com") and prefers
* the most specific match.
*/
function matchVendor(url, vendors) {
	const norm = normalizeUrl(url);
	const host = norm.split("/")[0];
	let best;
	for (const v of vendors) {
		const site = v.searchSite.replace(/^www\./, "").toLowerCase();
		if (host !== site.split("/")[0]) continue;
		if (norm === site || norm.startsWith(site)) {
			if (!best || v.searchSite.length > best.searchSite.length) best = v;
		}
	}
	return best;
}
function chunk(items, size) {
	const out = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
async function mapPool(items, concurrency, fn) {
	const out = Array.from({ length: items.length });
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}
async function searchProtocols(query, opts = {}) {
	const trimmed = query.trim();
	const { vendors, unknown } = resolveVendors(opts.vendors);
	if (!trimmed) return {
		query: "",
		vendors: [],
		unknownVendors: unknown,
		partial: false
	};
	const limit = Math.max(1, Math.min(10, Math.floor(opts.limit ?? 5)));
	const batchSize = Math.max(1, opts.batchSize ?? 1);
	const concurrency = Math.max(1, opts.concurrency ?? 4);
	const providerOpts = opts.providerOpts ?? {};
	const buckets = new Map(vendors.map((v) => [v.id, {
		id: v.id,
		name: v.name,
		searchUrl: v.searchUrl(trimmed),
		results: []
	}]));
	let partial = false;
	const needsFallback = /* @__PURE__ */ new Set();
	await mapPool(vendors, Math.min(concurrency, 2), async (vendor) => {
		const bucket = buckets.get(vendor.id);
		const outcome = await searchPublisher(vendor, trimmed, limit, providerOpts);
		bucket.providers = [{
			id: "publisher-browserless",
			status: outcome.status,
			count: outcome.results.length,
			elapsedMs: outcome.elapsedMs,
			...outcome.error ? { error: outcome.error } : {}
		}];
		if (outcome.results.length > 0) {
			bucket.results = outcome.results;
			if (outcome.source) bucket.source = outcome.source;
		} else needsFallback.add(vendor.id);
	});
	await mapPool(vendors.filter((v) => v.kind === "journal" && needsFallback.has(v.id)), concurrency, async (v) => {
		const bucket = buckets.get(v.id);
		const outcome = await searchJournal(v.journal, trimmed, limit, providerOpts);
		bucket.providers = [...bucket.providers ?? [], ...outcome.providers];
		if (outcome.results.length > 0) {
			bucket.results = outcome.results;
			bucket.source = outcome.source;
			if (outcome.error) {
				partial = true;
				bucket.error = outcome.error;
			}
		} else {
			partial = true;
			bucket.error = outcome.error ?? "no results";
		}
	});
	await mapPool(chunk(vendors.filter((v) => v.kind === "vendor" && needsFallback.has(v.id)), batchSize), concurrency, async (group) => {
		const sites = group.map((v) => `site:${v.searchSite}`).join(" OR ");
		const outcome = await webSearch(group.length === 1 ? `${sites} ${trimmed}` : `(${sites}) ${trimmed}`, limit * group.length, providerOpts);
		for (const v of group) {
			const bucket = buckets.get(v.id);
			bucket.providers = [...bucket.providers ?? [], ...outcome.providers];
		}
		if (outcome.results.length === 0) {
			partial = true;
			const reason = outcome.error ?? "no results";
			const attribution = outcome.provider === "none" ? "" : ` (via ${outcome.provider})`;
			for (const v of group) {
				const bucket = buckets.get(v.id);
				if (bucket.results.length === 0) bucket.error = `${reason}${attribution}`;
			}
			return;
		}
		for (const r of outcome.results) {
			const vendor = matchVendor(r.url, group);
			if (!vendor) continue;
			const bucket = buckets.get(vendor.id);
			if (bucket.results.length < limit) {
				bucket.results.push(r);
				bucket.source = outcome.provider;
			}
		}
		for (const v of group) if (buckets.get(v.id).results.length === 0) {
			partial = true;
			buckets.get(v.id).error ??= `no results (via ${outcome.provider})`;
		}
	});
	return {
		query: trimmed,
		vendors: Array.from(buckets.values()),
		unknownVendors: unknown,
		partial
	};
}
function gradeForEvidence(evidence) {
	if (evidence.availability === "likely-fetchable") return "full";
	if (evidence.availability === "unlikely-fetchable") return "none";
	return "partial";
}
/**
* Derive a fetchable id from a journal result URL (DOI / PMCID / PMID).
* `resolvable` says only whether we found an identifier `fetch` knows how to
* look up — whether that lookup finds open text is the journal's
* `fetchability`, which the caller applies.
*/
function idForArticleUrl(url) {
	const bioProtocolDoi = bioProtocolDoiFromUrl(url);
	if (bioProtocolDoi) return {
		id: `doi:${bioProtocolDoi}`,
		resolvable: true
	};
	const doi = /doi\.org\/(10\.\S+)/i.exec(url);
	if (doi) return {
		id: `doi:${doi[1].replace(/-v\d*$/i, "")}`,
		resolvable: true
	};
	const pmc = /(PMC\d+)/i.exec(url);
	if (pmc) return {
		id: `pmcid:${pmc[1].toUpperCase()}`,
		resolvable: true
	};
	const med = /europepmc\.org\/article\/MED\/(\d+)/i.exec(url);
	if (med) return {
		id: `pmid:${med[1]}`,
		resolvable: true
	};
	return {
		id: `url:${url}`,
		resolvable: false
	};
}
async function search(query, opts = {}) {
	const trimmed = query.trim();
	if (!trimmed) return {
		query: "",
		results: [],
		sources: [],
		unknownSources: [],
		partial: false
	};
	const requested = opts.sources;
	const wantRebase = requested ? requested.some((s) => s.trim().toLowerCase() === "rebase") : looksLikeEnzymeQuery(trimmed);
	const vendorIds = requested ? requested.filter((s) => s.trim().toLowerCase() !== "rebase") : void 0;
	const base = Boolean(requested) && (vendorIds?.length ?? 0) === 0 ? {
		query: trimmed,
		vendors: [],
		unknownVendors: [],
		partial: false
	} : await searchProtocols(trimmed, {
		...vendorIds ? { vendors: vendorIds } : {},
		...opts.limit !== void 0 ? { limit: opts.limit } : {},
		...opts.batchSize !== void 0 ? { batchSize: opts.batchSize } : {},
		...opts.concurrency !== void 0 ? { concurrency: opts.concurrency } : {},
		...opts.providerOpts ? { providerOpts: opts.providerOpts } : {}
	});
	const results = [];
	const sources = [];
	let partial = base.partial;
	for (const b of base.vendors) {
		const vendor = getVendor(b.id);
		const kind = vendor?.kind ?? "vendor";
		const effectiveQuery = vendor ? b.source?.startsWith("publisher-browserless") ? `${trimmed} on ${vendor.searchSite}` : kind === "journal" ? `${trimmed} in ${b.name}` : `site:${vendor.searchSite} ${trimmed}` : void 0;
		const rows = [];
		const seen = /* @__PURE__ */ new Set();
		const grade = vendor?.fetchability ?? "partial";
		for (const r of b.results) {
			let id;
			let fetchable;
			if (kind === "journal") {
				const article = idForArticleUrl(r.url);
				id = article.id;
				fetchable = article.resolvable ? grade : vendor?.publisherFetch === "full" ? "full" : vendor?.publisherFetch === "abstract-only" ? "partial" : "none";
			} else {
				id = `url:${r.url}`;
				fetchable = vendor?.ungated?.test(r.url) ? "full" : grade;
			}
			if (seen.has(id)) continue;
			seen.add(id);
			const availability = kind === "journal" && id.startsWith("doi:") ? assessDoiAvailability(grade, r.oaEvidence ?? []) : void 0;
			if (availability) fetchable = gradeForEvidence(availability);
			rows.push({
				id,
				source: b.id,
				kind: kind === "journal" ? "article" : "vendor-page",
				title: r.title,
				url: r.url,
				snippet: r.snippet,
				fetchable,
				...r.discoveredBy?.length ? { discoveredBy: r.discoveredBy } : {},
				...availability ? { availability } : {}
			});
		}
		if (vendor?.ungated) {
			const gated = (row) => row.url && vendor.ungated.test(row.url) ? 0 : 1;
			rows.sort((a, b) => gated(a) - gated(b));
		}
		sources.push({
			id: b.id,
			name: b.name,
			kind,
			searchUrl: b.searchUrl,
			...effectiveQuery ? { query: effectiveQuery } : {},
			...b.source ? { route: b.source } : {},
			count: rows.length,
			...b.providers ? { providers: b.providers } : {},
			...b.error ? { error: b.error } : {}
		});
		results.push(...rows);
	}
	if (wantRebase) try {
		const hits = await searchRebase(trimmed, {
			...opts.providerOpts ?? {},
			...opts.by ? { by: opts.by } : {}
		});
		sources.push({
			id: "rebase",
			name: "REBASE (restriction enzymes)",
			kind: "database",
			query: `${trimmed} (by ${opts.by ?? (looksLikeEnzymeQuery(trimmed) ? "auto" : "name")})`,
			count: hits.length
		});
		for (const h of hits) results.push({
			id: `rebase:${h.name}`,
			source: "rebase",
			kind: "enzyme",
			title: h.title,
			snippet: h.snippet,
			fetchable: "full"
		});
		if (hits.length === 0) partial = true;
	} catch (err) {
		partial = true;
		sources.push({
			id: "rebase",
			name: "REBASE (restriction enzymes)",
			kind: "database",
			count: 0,
			error: err instanceof Error ? err.message : "lookup failed"
		});
	}
	return {
		query: trimmed,
		results,
		sources,
		unknownSources: base.unknownVendors,
		partial
	};
}
/** How each fetchability grade reads in a result listing. */
const FETCHABLE_LABEL = {
	full: "fetchable",
	partial: "may-not-fetch",
	none: "links-only"
};
function resultFetchabilityLabel(result) {
	const evidence = result.availability;
	if (!evidence) return FETCHABLE_LABEL[result.fetchable];
	if (evidence.confidence === "metadata") return `likely-fetchable (current ${[...new Set((evidence.signals ?? []).map((signal) => signal.split(":")[0]))].join("+") || "OA"} metadata)`;
	return `${FETCHABLE_LABEL[result.fetchable]} (journal prior; DOI untested)`;
}
/** Render a UnifiedResponse as compact, model-friendly markdown with ids. */
function renderSearch(resp) {
	if (!resp.query) return "No query provided.";
	const lines = [`# Search: "${resp.query}"`, ""];
	if (resp.unknownSources.length > 0) lines.push(`> Unknown source ids ignored: ${resp.unknownSources.join(", ")}`, "");
	const bySource = /* @__PURE__ */ new Map();
	for (const r of resp.results) {
		const arr = bySource.get(r.source);
		if (arr) arr.push(r);
		else bySource.set(r.source, [r]);
	}
	for (const s of resp.sources) {
		const rs = bySource.get(s.id) ?? [];
		lines.push(`## ${s.name} _(${s.kind})_`);
		if (s.query) lines.push(`Query: \`${s.query}\``);
		if (s.searchUrl) lines.push(`Search page: ${s.searchUrl}`);
		if (s.providers) lines.push(`Backends: ${s.providers.map((p) => `${p.id}=${p.status}(${p.count})`).join(" · ")}`);
		if (rs.length === 0) {
			lines.push(`_No extractable results${s.error ? ` (${s.error})` : ""}._`, "");
			continue;
		}
		for (const r of rs) {
			lines.push(`- ${r.url ? `[${r.title}](${r.url})` : r.title}`);
			lines.push(`  \`${r.id}\` · ${resultFetchabilityLabel(r)}${r.snippet ? ` — ${r.snippet}` : ""}`);
		}
		lines.push("");
	}
	lines.push(`_${resp.results.length} result${resp.results.length === 1 ? "" : "s"} across ${resp.sources.length} source${resp.sources.length === 1 ? "" : "s"}. Call \`fetch\` with a result's id to read it. Every label is a prediction, not an observation: metadata labels come from open-access signals this search just received; journal-prior labels mean only the journal's usual behaviour is known. \`links-only\` results should be opened directly._`);
	return lines.join("\n");
}

//#endregion
//#region src/fetch.ts
const PMCID = /^PMC\d+$/i;
const PMID = /^\d+$/;
const DOI = /^10\.\S+\/\S+/;
const ENZYME_NAME = /^[A-Za-z]{2,}[IVX]+$/;
const IUPAC_SITE = /^[ACGTRYSWKMBDHVN]+$/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):([\s\S]*)$/i;
function withStatus$1(text, status, reason) {
	return `${text}${reason ? `\n\n_reason: ${reason}_` : ""}\n\n_status: ${status}_`;
}
function notFetchable(url) {
	return withStatus$1(`This page couldn't be retrieved automatically because the request failed or the site refused automated reading. This is a technical retrieval failure, not evidence that a subscription is required.

Open it directly: ${url}`, "not-fetchable", "technical-retrieval-failure");
}
/** Max characters of extracted vendor-page text to return. */
const WEB_PAGE_MAX_CHARS = 4e4;
/**
* Retrieve a vendor/web page's readable text. Some vendors (neb.com) answer a
* plain request with 403; `extractOaContent` returns null for any non-200 rather
* than throwing, so those degrade to the bare link instead of failing the call.
* We make one ordinary request and take no for an answer.
*/
async function fetchWebPage(url, opts) {
	if (!/^https?:\/\//i.test(url)) return notFetchable(url);
	const bioProtocolPdf = directPdfUrl(bioProtocolDoiFromUrl(url) ?? void 0);
	if (bioProtocolPdf) {
		const pdf = await extractOaContent(bioProtocolPdf, opts, WEB_PAGE_MAX_CHARS);
		if (pdf?.format === "pdf" && pdf.text.trim()) return withStatus$1(`_Source: publisher open-access PDF (${bioProtocolPdf})._\n\n${pdf.text}`, "ok");
	}
	const extracted = await extractOaContent(url, opts, WEB_PAGE_MAX_CHARS);
	if (!extracted?.text?.trim()) return notFetchable(url);
	if (looksLikeSubscriptionPreview(url, extracted.text)) return withStatus$1(`_Source: ${url} (publisher abstract/preview; the protocol body requires institutional or individual subscription access). ${extracted.residentialAttempted ? "Labee also tried an available registered residential exit before returning this result." : "No registered residential exit was available for this request, so no residential retry was made."} This is an expected access limitation, not a technical retrieval error._\n\n${extracted.text}`, "abstract-only", "subscription-required");
	if (extracted.via === "browserless-residential" && extracted.residentialReason === "subscription-preview") return withStatus$1(`_Source: ${url} (publisher full text read through the registered residential network after the datacenter received a subscription preview — NOT open access; access and redistribution remain governed by that subscription)._\n\n${extracted.text}`, "entitled-full-text");
	if (extracted.via) return withStatus$1(`_Source: ${url} (${extracted.via === "browserless-residential" ? "read through a registered residential proxy" : "read in a remote browser"}; no redistribution licence was detected)._\n\n${extracted.text}`, "display-only-full-text");
	return withStatus$1(`_Source: ${url} (${extracted.format} extraction)._\n\n${extracted.text}`, "ok");
}
/** Fetch the content behind a search-result id (or a bare identifier). */
async function fetchResource(id, opts = {}) {
	const raw = id.trim();
	if (!raw) return "Error: `id` is required.";
	const m = SCHEME.exec(raw);
	const scheme = m ? m[1].toLowerCase() : "";
	const rest = (m ? m[2] : raw).trim();
	switch (scheme) {
		case "rebase": return withStatus$1(await findRestrictionEnzyme(rest, opts), "ok");
		case "doi":
		case "pmid":
		case "pmcid": return getProtocolFulltext(rest, opts);
		case "url": return fetchWebPage(rest, opts);
		case "http":
		case "https": return fetchWebPage(raw, opts);
	}
	if (PMCID.test(raw) || PMID.test(raw) || DOI.test(raw)) return getProtocolFulltext(raw, opts);
	if (ENZYME_NAME.test(raw) || IUPAC_SITE.test(raw)) return withStatus$1(await findRestrictionEnzyme(raw, opts), "ok");
	return withStatus$1(`Unrecognised id "${raw}". Pass an id from \`search\` (\`rebase:…\`, \`doi:…\`, \`pmid:…\`, \`pmcid:…\`, \`url:…\`) or a bare DOI / PMID / PMCID / enzyme name.`, "bad-id", "invalid-id");
}
/**
* Resolve a batch of ids concurrently (bounded), returning one row per id in
* request order. A row that throws is captured as an error message rather than
* failing the whole batch — mirroring how `search` reports partial results.
*/
async function fetchResources(ids, opts = {}) {
	const out = Array.from({ length: ids.length });
	let next = 0;
	const concurrency = Math.min(3, ids.length);
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (true) {
			const i = next++;
			if (i >= ids.length) return;
			const id = ids[i];
			try {
				out[i] = {
					id,
					text: await fetchResource(id, opts)
				};
			} catch (err) {
				out[i] = {
					id,
					text: withStatus$1(`Error fetching \`${id}\`: ${err instanceof Error ? err.message : "fetch failed"}`, "error", "technical-execution-failure")
				};
			}
		}
	});
	await Promise.all(workers);
	return out;
}

//#endregion
//#region src/agent/resolvers.ts
const STATUS_RE = /_status:\s*([a-z-]+)_/gi;
const URL_RE = /https?:\/\/[^\s<>()\[\]{}"']+/gi;
function parseFetchStatus(text) {
	let status = "no-status";
	for (const match of text.matchAll(STATUS_RE)) status = match[1];
	return status;
}
function extractHttpUrls(text) {
	const out = /* @__PURE__ */ new Set();
	for (const match of text.matchAll(URL_RE)) {
		const raw = match[0].replace(/[.,;:!?]+$/, "");
		try {
			const url = new URL(raw);
			if (url.protocol === "http:" || url.protocol === "https:") out.add(url.toString());
		} catch {}
	}
	return [...out];
}
function isVerifiedStatus(status) {
	return status === "ok" || status === "entitled-full-text" || status === "display-only-full-text";
}

//#endregion
//#region src/agent/host-browser.ts
const TASK_TTL_MS = 600 * 1e3;
const MAX_CAPTURE_CHARS = 25e4;
const MAX_COMMIT_CHARS = 1e6;
const MAX_CACHE_ENTRIES = 100;
const pendingSearches = /* @__PURE__ */ new Map();
const pendingFetches = /* @__PURE__ */ new Map();
const captureCache = /* @__PURE__ */ new Map();
function cleanExpired(now = Date.now()) {
	for (const [id, pending] of pendingSearches) if (now - pending.createdAt > TASK_TTL_MS) pendingSearches.delete(id);
	for (const [id, pending] of pendingFetches) if (now - pending.createdAt > TASK_TTL_MS) pendingFetches.delete(id);
}
function publicHttpsUrl(raw, field) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${field} is invalid`);
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${field} must be credential-free HTTPS`);
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || isIP(host.replace(/^\[|\]$/g, "")) !== 0) throw new Error(`${field} must use a public hostname`);
	return url;
}
function nebUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("capture URL is invalid");
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("capture URL must be credential-free HTTPS");
	if (host !== "neb.com" && !host.endsWith(".neb.com")) throw new Error(`capture URL host ${host || "(empty)"} is not an NEB domain`);
	return url;
}
function boundedString(value, field, required = false, preserveWhitespace = false) {
	if (typeof value !== "string") {
		if (required) throw new Error(`${field} is required`);
		return;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		if (required) throw new Error(`${field} is required`);
		return;
	}
	if (value.length > MAX_CAPTURE_CHARS) throw new Error(`${field} exceeds ${MAX_CAPTURE_CHARS.toLocaleString()} characters`);
	return preserveWhitespace ? value : trimmed;
}
function cacheCapture(capture) {
	captureCache.delete(capture.id);
	captureCache.set(capture.id, capture);
	while (captureCache.size > MAX_CACHE_ENTRIES) {
		const oldest = captureCache.keys().next().value;
		if (!oldest) break;
		captureCache.delete(oldest);
	}
}
function prepareHostBrowserSearch(query, limit, base) {
	cleanExpired();
	const normalizedLimit = Math.max(1, Math.min(10, Math.floor(limit || 5)));
	const captureId = randomUUID();
	const searchUrl = `https://www.neb.com/en-us/search#q=${encodeURIComponent(query.trim())}`;
	pendingSearches.set(captureId, {
		query: query.trim(),
		limit: normalizedLimit,
		searchUrl,
		base,
		createdAt: Date.now()
	});
	return {
		kind: "neb-search",
		captureId,
		query: query.trim(),
		limit: normalizedLimit,
		searchUrl,
		instructions: [
			"Open searchUrl in Codex's integrated Browser.",
			"Read the rendered NEB results; do not replace them with web-search results.",
			"Open up to limit result links in the same integrated Browser profile and capture main/article HTML when available, otherwise visible text.",
			"Call neb_search_commit with captureId and the captured results."
		]
	};
}
function commitHostBrowserSearch(captureId, captures) {
	cleanExpired();
	const pending = pendingSearches.get(captureId);
	if (!pending) throw new Error("captureId is invalid or expired; call search with browser=host again");
	if (captures.length === 0) throw new Error("at least one rendered NEB result is required");
	if (captures.length > pending.limit) throw new Error(`at most ${pending.limit} results may be committed`);
	const results = [];
	const capturedIds = [];
	const formats = {};
	const seen = /* @__PURE__ */ new Set();
	let totalChars = 0;
	for (const raw of captures) {
		const requested = nebUrl(raw.url);
		const final = raw.finalUrl ? nebUrl(raw.finalUrl) : requested;
		const title = boundedString(raw.title, "title", true);
		const snippet = boundedString(raw.snippet, "snippet");
		const html = boundedString(raw.html, "html", false, true);
		const text = boundedString(raw.text, "text", false, true);
		if (!html && !text) throw new Error(`capture for ${final.toString()} must include html or text`);
		totalChars += (html?.length ?? 0) + (text?.length ?? 0);
		if (totalChars > MAX_COMMIT_CHARS) throw new Error(`capture batch exceeds ${MAX_COMMIT_CHARS.toLocaleString()} characters`);
		const id = `url:${final.toString()}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const format = html ? "html" : "rendered-text";
		cacheCapture({
			id,
			url: final.toString(),
			title,
			...html ? { html } : {},
			...text ? { text } : {},
			format,
			origin: "neb-integrated-browser",
			createdAt: Date.now()
		});
		results.push({
			id,
			source: "neb",
			kind: "vendor-page",
			title,
			url: final.toString(),
			...snippet ? { snippet } : {},
			fetchable: "full"
		});
		capturedIds.push(id);
		formats[id] = format;
	}
	pendingSearches.delete(captureId);
	return {
		response: {
			query: pending.query,
			results: [...pending.base.results, ...results],
			sources: [...pending.base.sources, {
				id: "neb",
				name: "New England Biolabs (NEB)",
				kind: "vendor",
				query: `rendered NEB search: ${pending.query}`,
				searchUrl: pending.searchUrl,
				count: results.length
			}],
			unknownSources: pending.base.unknownSources,
			partial: pending.base.partial
		},
		capturedIds,
		formats
	};
}
function expectedTitleFromNative(nativeText) {
	return nativeText.match(/^#\s+(.+)$/m)?.[1]?.trim() || void 0;
}
function normalizedDoi(id) {
	const raw = id.trim().replace(/^doi:\s*/i, "");
	return /^(10\.\d{4,9}\/\S+)$/i.exec(raw)?.[1]?.replace(/[.,;]+$/, "").toLowerCase();
}
function titleLooksRelated(expected, actual) {
	if (!expected) return true;
	const tokens = (value) => new Set(value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
	const wanted = tokens(expected);
	if (wanted.size === 0) return true;
	const observed = tokens(actual);
	let overlap = 0;
	for (const token of wanted) if (observed.has(token)) overlap += 1;
	return overlap / wanted.size >= .5;
}
function prepareChromeSessionFetch(id, url, nativeText) {
	cleanExpired();
	const requested = publicHttpsUrl(url, "fallback URL").toString();
	const captureId = randomUUID();
	const expectedTitle = expectedTitleFromNative(nativeText);
	pendingFetches.set(captureId, {
		id: id.trim(),
		url: requested,
		...expectedTitle ? { expectedTitle } : {},
		createdAt: Date.now()
	});
	return {
		kind: "chrome-fetch",
		captureId,
		id: id.trim(),
		url: requested,
		...expectedTitle ? { expectedTitle } : {},
		instructions: [
			"Use Codex's connected Chrome session only because the user explicitly authorized this fallback.",
			"Reuse an already-open matching article tab when possible; otherwise open url in that same Chrome session.",
			"Do not read, export, or print cookies. Chrome sends its own session state to the publisher.",
			"Verify the DOI and title, then capture main/article HTML or complete rendered text.",
			"If the publisher exposes only a Download PDF control, download it through Chrome and extract its text locally.",
			"Call chrome_fetch_commit with captureId, the requested url, finalUrl, title, and captured html or text."
		]
	};
}
function commitChromeSessionFetch(captureId, raw) {
	cleanExpired();
	const pending = pendingFetches.get(captureId);
	if (!pending) throw new Error("captureId is invalid or expired; call fetch with browser=chrome again");
	const requested = publicHttpsUrl(raw.url, "url");
	if (requested.toString() !== pending.url) throw new Error("url must exactly match the Chrome fallback task URL");
	const final = raw.finalUrl ? publicHttpsUrl(raw.finalUrl, "finalUrl") : requested;
	const title = boundedString(raw.title, "title", true);
	const html = boundedString(raw.html, "html", false, true);
	const text = boundedString(raw.text, "text", false, true);
	if (!html && !text) throw new Error("Chrome capture must include html or text");
	const body = `${html ?? ""}\n${text ?? ""}`;
	if (body.trim().length < 200) throw new Error("Chrome capture is too short to be article full text");
	const doi = normalizedDoi(pending.id);
	let identityUrl = final.toString();
	try {
		identityUrl = decodeURIComponent(identityUrl);
	} catch {}
	const identityText = `${identityUrl}\n${title}\n${body}`.toLowerCase();
	if (!(doi ? identityText.includes(doi) || identityText.includes(doi.split("/")[1]) : false) && !titleLooksRelated(pending.expectedTitle, title)) throw new Error("Chrome capture title/DOI does not match the requested article");
	const format = html ? "html" : "rendered-text";
	cacheCapture({
		id: pending.id,
		url: final.toString(),
		title,
		...html ? { html } : {},
		...text ? { text } : {},
		format,
		origin: "chrome-session",
		createdAt: Date.now()
	});
	pendingFetches.delete(captureId);
	return {
		id: pending.id,
		format,
		content: fetchHostBrowserCapture(pending.id)
	};
}
function fetchHostBrowserCapture(id) {
	const capture = captureCache.get(id.trim());
	if (!capture) return void 0;
	captureCache.delete(capture.id);
	captureCache.set(capture.id, capture);
	if (capture.origin === "chrome-session") return [
		capture.html ? `<!-- Source: ${capture.url} — entitled publisher HTML captured through the user's explicitly authorized connected Chrome session. Access and redistribution remain governed by the publisher or subscription terms. -->` : `_Source: ${capture.url} (entitled publisher text captured through the user's explicitly authorized connected Chrome session; access and redistribution remain governed by the publisher or subscription terms)._`,
		"",
		capture.html ?? capture.text,
		"",
		"_status: entitled-full-text_"
	].join("\n");
	if (capture.html) return [
		`<!-- Source: ${capture.url} — HTML captured by Codex's integrated Browser during NEB search. No redistribution licence was detected. -->`,
		"",
		capture.html,
		"",
		"_status: display-only-full-text_"
	].join("\n");
	return [
		`_Source: ${capture.url} (rendered text captured by Codex's integrated Browser during NEB search; raw HTML was not available and no redistribution licence was detected)._`,
		"",
		capture.text,
		"",
		"_status: display-only-full-text_"
	].join("\n");
}

//#endregion
//#region src/agent/browser-fetch.ts
function withStatus(text, status) {
	return `${text}\n\n_status: ${status}_`;
}
function requestedUrl(id, nativeText) {
	const raw = id.trim();
	const candidate = raw.toLowerCase().startsWith("url:") ? raw.slice(4).trim() : raw;
	if (/^https?:\/\//i.test(candidate)) return candidate;
	return extractHttpUrls(nativeText)[0];
}
function chromeFallbackUrl(id, nativeText) {
	const raw = id.trim();
	const withoutPrefix = raw.replace(/^doi:\s*/i, "");
	const doi = /^(10\.\d{4,9}\/\S+)$/i.exec(withoutPrefix)?.[1]?.replace(/[.,;]+$/, "");
	if (doi) return `https://doi.org/${doi}`;
	const pmcid = raw.replace(/^pmcid:\s*/i, "").match(/^(PMC\d+)$/i)?.[1];
	if (pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid.toUpperCase()}/`;
	const pmid = raw.replace(/^pmid:\s*/i, "").match(/^(\d{5,10})$/)?.[1];
	if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
	return requestedUrl(id, nativeText);
}
async function fetchResourceWithChromeSessionFallback(id, opts = {}) {
	const nativeText = await fetchResource(id, opts);
	if (isVerifiedStatus(parseFetchStatus(nativeText))) return nativeText;
	const url = chromeFallbackUrl(id, nativeText);
	if (!url) return nativeText;
	const task = prepareChromeSessionFetch(id, url, nativeText);
	return [
		nativeText,
		"",
		"_status: chrome-browser-required_",
		"",
		"chromeBrowserTask:",
		JSON.stringify(task, null, 2)
	].join("\n");
}
function sourceForUrl(url) {
	if (url.hostname === "neb.com" || url.hostname.endsWith(".neb.com")) return "neb";
	return "web";
}
/**
* Sibling domains a source legitimately redirects between, so a brand
* consolidation does not read as an unsafe redirect.
*
* Merck is the motivating case: an emdmillipore.com product URL now lands on
* www.sigmaaldrich.com. Real Chrome follows that happily, but with only the
* requested hostname allowlisted the policy rejected the destination and the
* adapter reported `unsafe-url` — which surfaces to the caller as
* `not-fetchable`, indistinguishable from the site refusing us. The page was
* never blocked at all.
*
* Each group is an explicit allowlist, not a wildcard: the policy still has to
* name every host it will accept.
*/
const SIBLING_HOSTS = [["neb.com", "www.neb.com"], [
	"emdmillipore.com",
	"www.emdmillipore.com",
	"merckmillipore.com",
	"www.merckmillipore.com",
	"sigmaaldrich.com",
	"www.sigmaaldrich.com"
]];
function inGroup(hostname, group) {
	const host = hostname.toLowerCase();
	return group.some((base) => host === base || host.endsWith(`.${base}`));
}
function browserHosts(url) {
	const hosts = [url.hostname];
	for (const group of SIBLING_HOSTS) if (inGroup(url.hostname, group)) hosts.push(...group);
	if (url.hostname === "neb.com" || url.hostname.endsWith(".neb.com")) hosts.push("challenges.cloudflare.com", "static.cloudflareinsights.com");
	return [...new Set(hosts)];
}
/**
* The first link on a NEB page that matches the vendor's `ungated` pattern —
* a PDF manual served without the Cloudflare challenge that gates the HTML.
* The pattern lives on the vendor record so search and fetch agree on it.
*/
function ungatedNebDocument(links) {
	const pattern = getVendor("neb")?.ungated;
	if (!pattern) return void 0;
	return links?.find((link) => pattern.test(link));
}
function officialNebMirror(links) {
	for (const link of links ?? []) try {
		const url = new URL(link);
		if ((url.hostname === "protocols.io" || url.hostname.endsWith(".protocols.io")) && /^\/view\//.test(url.pathname)) return url.toString();
	} catch {}
}
async function fetchResourceWithBrowser(id, opts = {}, browser) {
	const nativeText = await fetchResource(id, opts);
	if (!browser || isVerifiedStatus(parseFetchStatus(nativeText))) return nativeText;
	const rawUrl = requestedUrl(id, nativeText);
	if (!rawUrl) return nativeText;
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return nativeText;
	}
	if (!(await browser.available()).available) return nativeText;
	const hit = await browser.retrieve({
		url: url.toString(),
		sourceId: sourceForUrl(url),
		allowedHosts: browserHosts(url),
		maxChars: 8e4,
		timeoutMs: 2e4
	});
	if (hit.status === "interaction-required") return withStatus(`The Labee browser is waiting for manual verification at ${hit.finalUrl ?? url.toString()}. Complete the visible check, then retry this fetch.`, "interaction-required");
	if (hit.status !== "ok" || !hit.text?.trim()) return nativeText;
	if (sourceForUrl(url) === "neb") {
		if (hit.html?.trim() && hit.provenance.route.endsWith("-cache")) return withStatus(`<!-- Source: ${hit.finalUrl ?? url.toString()} — rendered HTML captured during NEB search in the same default Chrome profile. No redistribution licence was detected. -->\n\n${hit.html}`, "display-only-full-text");
		const manual = ungatedNebDocument(hit.links);
		if (manual) {
			const native = await fetchResource(`url:${manual}`, opts);
			if (isVerifiedStatus(parseFetchStatus(native))) return native;
		}
		const mirror = officialNebMirror(hit.links);
		if (mirror) {
			const mirrored = await fetchResource(`url:${mirror}`, opts);
			if (isVerifiedStatus(parseFetchStatus(mirrored))) return mirrored;
		}
	}
	return withStatus(`_Source: ${hit.finalUrl ?? url.toString()} (public publisher page read in the Labee browser; no redistribution licence was detected)._\n\n${hit.text}`, "display-only-full-text");
}
async function fetchResourcesWithBrowser(ids, opts = {}, browser) {
	if (!browser) return fetchResources(ids, opts);
	const rows = [];
	for (const id of ids) try {
		rows.push({
			id,
			text: await fetchResourceWithBrowser(id, opts, browser)
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "fetch failed";
		rows.push({
			id,
			text: withStatus(`Error fetching \`${id}\`: ${message}`, "error")
		});
	}
	return rows;
}

//#endregion
//#region src/agent/browser.ts
const MAX_BROWSER_TEXT$1 = 8e4;
const ACCESS_WALL_RE = /sign in to (?:view|access|continue)|institutional access|purchase (?:this )?article|subscribe to (?:read|access)|log in through your institution/i;
/** Require multiple independent signals before browser DOM counts as protocol content. */
function looksLikeProtocolEvidence(text) {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length < 800 || ACCESS_WALL_RE.test(normalized.slice(0, 3e3))) return false;
	return [
		/\b(?:protocol|materials and methods|procedure|step\s*\d+)\b/i,
		/\b(?:add|mix|incubate|centrifuge|wash|resuspend|pipette|amplif(?:y|ication))\b/i,
		/\b\d+(?:\.\d+)?\s*(?:µl|μl|ul|ml|µg|μg|mg|°c|rpm|×?\s*g|min(?:ute)?s?|hours?)\b/i
	].filter((pattern) => pattern.test(normalized)).length >= 2;
}
const MAX_DISCOVERY_BYTES = 64 * 1024;
function evidence(status, detail, extra = {}) {
	return {
		status,
		...detail ? { detail } : {},
		...extra,
		provenance: extra.provenance ?? {
			adapter: "playwright-cdp",
			route: "publisher-dom"
		}
	};
}
var CdpBrowserAdapter = class {
	id = "playwright-cdp";
	endpoint;
	connectOverCdp;
	browser;
	verifiedWebSocketEndpoint;
	constructor(endpoint = process.env.PROTOCOLS_BROWSER_CDP_URL ?? "http://127.0.0.1:9222", connectOverCdp, ownsBrowser = false) {
		this.ownsBrowser = ownsBrowser;
		this.endpoint = assertLoopbackCdpEndpoint(endpoint);
		this.connectOverCdp = connectOverCdp;
	}
	async available() {
		this.verifiedWebSocketEndpoint = void 0;
		try {
			const probe = new URL("/json/version", this.endpoint);
			const res = await fetch(probe, {
				redirect: "manual",
				signal: AbortSignal.timeout(2e3)
			});
			if (!res.ok) return {
				available: false,
				reason: `CDP probe returned HTTP ${res.status}`
			};
			const raw = await res.text();
			if (Buffer.byteLength(raw) > MAX_DISCOVERY_BYTES) return {
				available: false,
				reason: "CDP discovery response exceeded 64 KiB"
			};
			const parsed = JSON.parse(raw);
			if (typeof parsed.webSocketDebuggerUrl !== "string") return {
				available: false,
				reason: "CDP discovery response omitted webSocketDebuggerUrl"
			};
			this.verifiedWebSocketEndpoint = assertLoopbackCdpWebSocketEndpoint(parsed.webSocketDebuggerUrl, this.endpoint).toString();
			return { available: true };
		} catch (err) {
			return {
				available: false,
				reason: err instanceof Error ? err.message : "CDP unavailable"
			};
		}
	}
	async connectedBrowser() {
		if (this.browser?.isConnected()) return { browser: this.browser };
		if (!this.verifiedWebSocketEndpoint) return { reason: "CDP websocket was not verified" };
		try {
			this.browser = await (this.connectOverCdp ?? (async (endpoint) => {
				const { chromium } = await import("playwright-core");
				return chromium.connectOverCDP(endpoint, {
					timeout: 5e3,
					isLocal: true,
					noDefaults: true
				});
			}))(this.verifiedWebSocketEndpoint);
			return { browser: this.browser };
		} catch (err) {
			this.browser = void 0;
			return { reason: err instanceof Error ? err.message : "CDP connection unavailable" };
		}
	}
	async retrieve(request) {
		try {
			await assertSafePublicUrl(request.url, request.allowedHosts);
		} catch (err) {
			return evidence("unsafe-url", err instanceof Error ? err.message : "unsafe URL");
		}
		const state = await this.available();
		if (!state.available) return evidence("unavailable", state.reason);
		const connected = await this.connectedBrowser();
		if (!connected.browser) return evidence("unavailable", connected.reason);
		let page;
		let keepPage = false;
		try {
			const context = connected.browser.contexts()[0];
			if (!context) return evidence("unavailable", "CDP browser has no context");
			page = await context.newPage();
			page.on("popup", (popup) => void popup.close());
			page.on("download", (download) => void download.cancel());
			await page.route("**/*", async (route) => {
				const req = route.request();
				if (!this.ownsBrowser && [
					"image",
					"media",
					"font",
					"websocket"
				].includes(req.resourceType())) {
					await route.abort("blockedbyclient");
					return;
				}
				try {
					await assertSafePublicUrl(req.url().replace(/^wss:/i, "https:"), request.allowedHosts);
					await route.continue();
				} catch {
					await route.abort("blockedbyclient");
				}
			});
			const response = await page.goto(request.url, {
				waitUntil: "domcontentloaded",
				timeout: request.timeoutMs
			});
			if (!response || response.status() === 404) return evidence("not-found", "browser navigation returned 404");
			await assertSafePublicUrl(page.url(), request.allowedHosts);
			const readContent = async () => {
				let fallback = {
					text: "",
					html: ""
				};
				for (const selector of [
					"article",
					"main",
					"body"
				]) {
					const locator = page.locator(selector).first();
					const text = (await locator.innerText({ timeout: 2e3 }).catch(() => "")).trim();
					const html = text ? (await locator.innerHTML({ timeout: 2e3 }).catch(() => "")).trim() : "";
					if (text.length > fallback.text.length) fallback = {
						text,
						html
					};
					if (text.length >= 200) return {
						text,
						html
					};
				}
				return fallback;
			};
			const challengePresent = async (text) => {
				if (looksLikeBotWall(text)) return true;
				const title = await page.title().catch(() => "");
				if (/just a moment|security verification|verify (?:you are|that you are) human/i.test(title)) return true;
				return await page.locator("iframe[src*=\"challenges.cloudflare.com\"], #challenge-running, #challenge-stage, .cf-challenge").count().catch(() => 0) > 0;
			};
			let { text, html } = await readContent();
			const responseStatus = response.status();
			const startedOnBotWall = await challengePresent(text);
			if (startedOnBotWall && (request.interactionTimeoutMs ?? 0) > 0) {
				const deadline = Date.now() + request.interactionTimeoutMs;
				while (Date.now() < deadline && await challengePresent(text)) {
					if (request.signal?.aborted) return evidence("timeout", "browser request cancelled");
					await page.waitForTimeout(Math.min(1e3, Math.max(1, deadline - Date.now())));
					({text, html} = await readContent());
				}
			}
			if (!text) return evidence("blocked", responseStatus >= 400 ? `browser navigation returned HTTP ${responseStatus}` : "page is empty");
			if (await challengePresent(text)) {
				keepPage = true;
				return evidence("interaction-required", "complete the visible browser verification, then retry", {
					finalUrl: page.url(),
					title: await page.title()
				});
			}
			if (responseStatus >= 400 && !startedOnBotWall) return evidence("blocked", `browser navigation returned HTTP ${responseStatus}`);
			if (!looksLikeProtocolEvidence(text)) return evidence("not-found", "page did not contain enough procedural evidence");
			const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.href).filter((href) => /^https?:\/\//i.test(href)).slice(0, 100)).catch(() => []);
			const maxChars = Math.min(request.maxChars, MAX_BROWSER_TEXT$1);
			const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…[truncated]` : text;
			const boundedHtml = html.length > maxChars ? `${html.slice(0, maxChars)}\n<!-- truncated -->` : html;
			return evidence("ok", void 0, {
				finalUrl: page.url(),
				title: await page.title(),
				text: bounded,
				...boundedHtml ? { html: boundedHtml } : {},
				links: [...new Set(links)],
				format: "dom",
				provenance: {
					adapter: this.id,
					route: "publisher-dom",
					capturedUrl: page.url()
				}
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "browser retrieval failed";
			return evidence(/timeout/i.test(message) ? "timeout" : "blocked", message);
		} finally {
			if (!keepPage) await page?.close().catch(() => void 0);
		}
	}
	async close() {
		if (this.ownsBrowser) {
			if (!this.browser?.isConnected()) {
				if ((await this.available()).available) await this.connectedBrowser();
			}
			await this.browser?.close().catch(() => void 0);
		}
		this.browser = void 0;
		this.verifiedWebSocketEndpoint = void 0;
	}
};

//#endregion
//#region src/agent/default-browser.ts
const MAX_BROWSER_TEXT = 8e4;
const APPLE_EVENTS_PERMISSION = "In Chrome, enable View > Developer > Allow JavaScript from Apple Events, then retry.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function appleString(value) {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
function defaultAppleScript(script) {
	return new Promise((resolve, reject) => {
		execFile("osascript", ["-e", script], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(new Error(error.message));
				return;
			}
			resolve(String(stdout).trim());
		});
	});
}
function isJavaScriptPermissionError(error) {
	return /javascript through applescript is turned off|allow javascript from apple events/i.test(String(error));
}
function pageScript() {
	return `(() => { const body = document.body; const text = (body?.innerText || "").trim(); const html = body?.innerHTML || ""; const links = Array.from(document.querySelectorAll("a[href]"), a => a.href).filter(h => /^https?:\\/\\//i.test(h)).slice(0, 100); return JSON.stringify({ url: location.href, title: document.title, text, html, links, readyState: document.readyState }); })()`;
}
function browserEvidence(status, detail, extra = {}) {
	return {
		status,
		...detail ? { detail } : {},
		...extra,
		provenance: extra.provenance ?? {
			adapter: "chrome-default-applescript",
			route: "default-profile-dom"
		}
	};
}
/**
* Drives one Labee-owned window in the user's ordinary Chrome profile.
* Existing windows and tabs are never enumerated, inspected, or closed.
*/
var DefaultBrowserAdapter = class {
	id = "chrome-default-applescript";
	platform;
	interactionTimeoutMs;
	runAppleScript;
	sleepImpl;
	state = "stopped";
	detail;
	windowId;
	launchPromise;
	queue = Promise.resolve();
	cache = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.platform = options.platform ?? process.platform;
		const configuredInteractionTimeout = Number((options.env ?? process.env).PROTOCOLS_BROWSER_INTERACTION_TIMEOUT_MS);
		this.interactionTimeoutMs = options.interactionTimeoutMs ?? (Number.isFinite(configuredInteractionTimeout) && configuredInteractionTimeout >= 0 ? Math.min(configuredInteractionTimeout, 12e4) : 2e4);
		this.runAppleScript = options.runAppleScript ?? defaultAppleScript;
		this.sleepImpl = options.sleepImpl ?? sleep;
	}
	status() {
		return {
			state: this.state,
			profile: "default",
			...this.windowId !== void 0 ? { windowId: this.windowId } : {},
			...this.detail ? { detail: this.detail } : {}
		};
	}
	script(body) {
		return this.runAppleScript(`tell application "Google Chrome"\n${body}\nend tell`);
	}
	async windowExists() {
		if (this.windowId === void 0) return false;
		try {
			return (await this.script(`return exists window id ${this.windowId}`)).trim() === "true";
		} catch {
			return false;
		}
	}
	async createWindow() {
		const raw = await this.script("set labeeWindow to make new window\nreturn id of labeeWindow");
		const id = Number(raw.trim());
		if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Chrome did not return a valid window id");
		return id;
	}
	async executeJavaScript(javascript) {
		if (this.windowId === void 0) throw new Error("Labee Chrome window is not open");
		return this.script(`return execute active tab of window id ${this.windowId} javascript ${appleString(javascript)}`);
	}
	async launch() {
		if (this.launchPromise) return this.launchPromise;
		this.launchPromise = this.launchOnce().finally(() => {
			this.launchPromise = void 0;
		});
		return this.launchPromise;
	}
	async launchOnce() {
		if (this.platform !== "darwin") {
			this.state = "error";
			this.detail = "default-profile mode currently requires macOS and Google Chrome";
			return this.status();
		}
		this.state = "starting";
		this.detail = void 0;
		try {
			if (!await this.windowExists()) this.windowId = await this.createWindow();
			await this.executeJavaScript("document.title");
			this.state = "ready";
		} catch (error) {
			if (isJavaScriptPermissionError(error)) {
				this.state = "permission-required";
				this.detail = APPLE_EVENTS_PERMISSION;
			} else {
				this.state = "error";
				this.detail = error instanceof Error ? error.message : "could not open the default Chrome profile";
			}
		}
		return this.status();
	}
	async available() {
		const status = await this.launch();
		return status.state === "ready" || status.state === "interaction-required" ? { available: true } : {
			available: false,
			...status.detail ? { reason: status.detail } : {}
		};
	}
	serialized(operation) {
		const run = this.queue.then(operation, operation);
		this.queue = run.then(() => void 0, () => void 0);
		return run;
	}
	cacheKey(url) {
		try {
			return new URL(url).toString();
		} catch {
			return url;
		}
	}
	async snapshot() {
		const raw = await this.executeJavaScript(pageScript());
		const parsed = JSON.parse(raw);
		return {
			url: typeof parsed.url === "string" ? parsed.url : "",
			title: typeof parsed.title === "string" ? parsed.title : "",
			text: typeof parsed.text === "string" ? parsed.text : "",
			html: typeof parsed.html === "string" ? parsed.html : "",
			links: Array.isArray(parsed.links) ? parsed.links.filter((link) => typeof link === "string") : [],
			readyState: typeof parsed.readyState === "string" ? parsed.readyState : ""
		};
	}
	isChallenge(snapshot) {
		return looksLikeBotWall(snapshot.text) || /just a moment|security verification|verify (?:you are|that you are) human/i.test(snapshot.title) || /challenges\.cloudflare\.com|challenge-running|challenge-stage|cf-challenge/i.test(snapshot.html);
	}
	async retrieve(request) {
		return this.serialized(async () => {
			try {
				await assertSafePublicUrl(request.url, request.allowedHosts);
			} catch (error) {
				return browserEvidence("unsafe-url", error instanceof Error ? error.message : "unsafe URL");
			}
			const cached = this.cache.get(this.cacheKey(request.url));
			if (cached) return {
				...cached,
				provenance: {
					...cached.provenance,
					adapter: this.id,
					route: `${cached.provenance.route}-cache`
				}
			};
			const available = await this.available();
			if (!available.available || this.windowId === void 0) return browserEvidence("unavailable", available.reason, { provenance: {
				adapter: this.id,
				route: "default-profile-launch"
			} });
			try {
				const previousUrl = await this.script(`return URL of active tab of window id ${this.windowId}`).catch(() => "");
				await this.script(`set URL of active tab of window id ${this.windowId} to ${appleString(request.url)}`);
				const navigationDeadline = Date.now() + request.timeoutMs;
				let snapshot;
				let navigationComplete = false;
				const requestedUrl = new URL(request.url).toString();
				while (Date.now() < navigationDeadline) {
					if (request.signal?.aborted) return browserEvidence("timeout", "browser request cancelled");
					try {
						snapshot = await this.snapshot();
					} catch (error) {
						if (isJavaScriptPermissionError(error)) throw error;
						await this.sleepImpl(250);
						continue;
					}
					const navigationObserved = snapshot.url === requestedUrl || snapshot.url !== previousUrl;
					let snapshotUrl;
					try {
						snapshotUrl = new URL(snapshot.url);
					} catch {}
					const isHttpsDocument = snapshotUrl?.protocol === "https:";
					if (navigationObserved && isHttpsDocument && (snapshot.readyState === "interactive" || snapshot.readyState === "complete")) {
						try {
							await assertSafePublicUrl(snapshot.url, request.allowedHosts);
						} catch (error) {
							return browserEvidence("unsafe-url", error instanceof Error ? error.message : "unsafe URL");
						}
						navigationComplete = true;
						break;
					}
					await this.sleepImpl(250);
				}
				if (!snapshot || !navigationComplete) return browserEvidence("timeout", "default-profile browser navigation timed out");
				if (this.isChallenge(snapshot) && (request.interactionTimeoutMs ?? this.interactionTimeoutMs) > 0) {
					this.state = "interaction-required";
					this.detail = "complete the visible browser verification, then retry";
					const deadline = Date.now() + (request.interactionTimeoutMs ?? this.interactionTimeoutMs);
					while (Date.now() < deadline && this.isChallenge(snapshot)) {
						if (request.signal?.aborted) return browserEvidence("timeout", "browser request cancelled");
						await this.sleepImpl(Math.min(1e3, Math.max(1, deadline - Date.now())));
						snapshot = await this.snapshot();
					}
				}
				await assertSafePublicUrl(snapshot.url, request.allowedHosts);
				if (this.isChallenge(snapshot)) return browserEvidence("interaction-required", "complete the visible browser verification, then retry", {
					finalUrl: snapshot.url,
					title: snapshot.title
				});
				if (!snapshot.text.trim()) return browserEvidence("blocked", "page is empty");
				if (/\b(?:404|page not found|not found)\b/i.test(`${snapshot.title} ${snapshot.text.slice(0, 500)}`)) return browserEvidence("not-found", "browser page reported that the resource was not found");
				const maxChars = Math.min(request.maxChars, MAX_BROWSER_TEXT);
				const text = snapshot.text.length > maxChars ? `${snapshot.text.slice(0, maxChars)}\n\n…[truncated]` : snapshot.text;
				const html = snapshot.html.length > maxChars ? `${snapshot.html.slice(0, maxChars)}\n<!-- truncated -->` : snapshot.html;
				const result = browserEvidence("ok", void 0, {
					finalUrl: snapshot.url,
					title: snapshot.title,
					text,
					...html ? { html } : {},
					links: [...new Set(snapshot.links)],
					format: "dom",
					provenance: {
						adapter: this.id,
						route: "default-profile-dom",
						capturedUrl: snapshot.url
					}
				});
				this.state = "ready";
				this.detail = void 0;
				this.cache.set(this.cacheKey(request.url), result);
				if (snapshot.url) this.cache.set(this.cacheKey(snapshot.url), result);
				return result;
			} catch (error) {
				if (isJavaScriptPermissionError(error)) {
					this.state = "permission-required";
					this.detail = APPLE_EVENTS_PERMISSION;
					return browserEvidence("unavailable", this.detail);
				}
				const message = error instanceof Error ? error.message : "default-profile browser retrieval failed";
				return browserEvidence(/timeout/i.test(message) ? "timeout" : "blocked", message);
			}
		});
	}
	async close() {
		const id = this.windowId;
		this.windowId = void 0;
		if (id !== void 0) await this.script(`if exists window id ${id} then close window id ${id}`).catch(() => void 0);
		this.state = "stopped";
		this.detail = void 0;
		this.cache.clear();
	}
};
let singleton;
function defaultBrowser() {
	singleton ??= new DefaultBrowserAdapter();
	return singleton;
}
async function shutdownDefaultBrowser() {
	await singleton?.close();
}
function browserAdapterForMode(mode) {
	if (!mode || mode === "off") return void 0;
	return mode === "default" ? defaultBrowser() : new CdpBrowserAdapter();
}

//#endregion
//#region src/mcp.ts
/** Every searchable source id: the vendors/journals plus the REBASE database. */
const SOURCE_IDS = [...VENDOR_IDS, "rebase"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
function packageVersion() {
	try {
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const version = JSON.parse(raw).version;
		if (typeof version === "string" && version) return version;
	} catch {}
	return "0.0.0";
}
const SERVER_INFO = {
	name: "labee-protocol-searcher",
	version: packageVersion()
};
const SERVER_INSTRUCTIONS = "Search uses each publisher's own page through the configured AWS Browserless deployment by default, then falls back to scholarly or web-search databases only when the publisher search fails. For an explicitly requested visible NEB browser session, call search with browser=host. Open the returned hostBrowserTask.searchUrl in the integrated Browser, read its rendered results, open selected NEB result pages in that same Browser profile, then call neb_search_commit with the captureId and captured HTML or visible text. A later fetch of a committed id returns the cached capture without reopening NEB. Do not substitute generic web-search results or silently switch to system Chrome, browser=default, or CDP. Use those fallbacks only when the integrated Browser is unavailable and the user explicitly authorizes one. For journal articles that native retrieval cannot resolve, an explicit fetch(browser=chrome) returns a chromeBrowserTask. Reuse the connected Chrome session without reading cookies, verify the DOI/title, capture article HTML or downloaded-PDF text, and call chrome_fetch_commit. Treat that capture as entitled content, not open-access content.";
const OPTIONAL_LABEE_AUTH = [{ type: "noauth" }, {
	type: "oauth2",
	scopes: ["protocols:search"]
}];
/** Search-to-fetch browser handoff for the lifetime of the authoritative MCP process. */
const sameProfileBrowserById = /* @__PURE__ */ new Map();
const TOOLS = [
	{
		name: "search",
		securitySchemes: OPTIONAL_LABEE_AUTH,
		_meta: { securitySchemes: OPTIONAL_LABEE_AUTH },
		title: "Search protocols, reagents & enzymes",
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
			idempotentHint: false
		},
		description: "Search laboratory-protocol, reagent, and restriction-enzyme sources for a technique, kit, reagent, product, enzyme, or recognition site. Every journal/vendor is searched on its own publisher page through AWS Browserless first. Failed journal searches fall back to scholarly APIs (Crossref/Europe PMC), and failed vendor searches fall back to site-scoped web search. Restriction enzymes use REBASE (NEB's open database — auto-included for enzyme-shaped queries like 'EcoRI' or 'GAATTC'). Returns a ranked list of results, each with a stable `id`, a `source`, and a `fetchable` grade — fresh exact DOI observations from the daily CI index win, current OA metadata is next, and the source grade is the fallback prior. Call `fetch` with a result's id to read its content; vendor pages included. Prefer Codex's integrated Browser for browser tasks because it uses a separate profile and provides a shared view. For NEB, pass `browser: host` so both the rendered search and selected result pages use the integrated Browser; commit those captures with `neb_search_commit`, and a following `fetch` returns the same captured HTML. Do not silently switch to system Chrome. Use `browser: default` or `cdp` only when the integrated Browser is unavailable and the user explicitly authorizes that fallback.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "What to search for, e.g. 'RNA extraction from FFPE', 'Gibson assembly', 'BsaI', 'GAATTC'."
				},
				sources: {
					type: "array",
					items: {
						type: "string",
						enum: SOURCE_IDS
					},
					description: `Optional subset of source ids to search. Omit to search all (REBASE is auto-included for enzyme queries). Valid ids: ${SOURCE_IDS.join(", ")}.`
				},
				limit: {
					type: "number",
					description: "Max results per source (1-10, default 5)."
				},
				browser: {
					type: "string",
					enum: [
						"off",
						"cdp",
						"default",
						"host"
					],
					description: "Optional visible NEB browser override. The omitted/default path uses AWS Browserless. `host` delegates NEB search and result capture to Codex's integrated Browser via neb_search_commit. `default` uses system Chrome and must only be selected as an explicitly authorized fallback."
				}
			},
			required: ["query"]
		}
	},
	{
		name: "neb_search_commit",
		title: "Commit rendered NEB browser search results",
		annotations: {
			readOnlyHint: false,
			openWorldHint: false,
			idempotentHint: false
		},
		description: "Complete a host-browser NEB search prepared by `search(browser: host)`. Submit only results rendered by the NEB search page, after opening each selected result in the same Codex integrated-Browser profile. Labee caches exact HTML when supplied, otherwise rendered visible text; later `fetch` calls return that cached capture without another NEB navigation.",
		inputSchema: {
			type: "object",
			properties: {
				captureId: {
					type: "string",
					description: "Opaque capture id returned by search(browser: host)."
				},
				results: {
					type: "array",
					minItems: 1,
					maxItems: 10,
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							url: {
								type: "string",
								description: "NEB result URL from the rendered search page."
							},
							finalUrl: {
								type: "string",
								description: "Final NEB URL after browser redirects."
							},
							snippet: { type: "string" },
							html: {
								type: "string",
								description: "Exact rendered main/article HTML when available."
							},
							text: {
								type: "string",
								description: "Rendered visible text fallback."
							}
						},
						required: ["title", "url"]
					}
				}
			},
			required: ["captureId", "results"]
		}
	},
	{
		name: "fetch",
		securitySchemes: OPTIONAL_LABEE_AUTH,
		_meta: { securitySchemes: OPTIONAL_LABEE_AUTH },
		title: "Fetch a result's content by id",
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
			idempotentHint: false
		},
		description: "Retrieve the content of one or more `search` results by id. `rebase:<enzyme>` returns the structured restriction-enzyme record (recognition site, cut position, isoschizomers, methylation sensitivity, and which vendors incl. NEB supply it — from REBASE, so no neb.com scraping). `doi:` / `pmid:` / `pmcid:` returns open-access article full text (Europe PMC, then NCBI for PMC author manuscripts, then Unpaywall; the abstract if the article is paywalled), rendered section-by-section — pass `section` to read just one (e.g. 'Methods'). A `url:` page is fetched and its readable text extracted; most vendors work, but a few (notably neb.com, sigmaaldrich.com, emdmillipore.com) refuse automated requests and return their link instead — `search` grades each result so you know which to expect. When a publisher page returns a subscription-only preview, fetch retries it through an available registered residential exit before returning `abstract-only`; this uses only access already attached to that network and does not create an entitlement. After a host-browser NEB search is committed, fetch returns the exact HTML or rendered text captured by that same integrated Browser profile without reopening NEB. Default-profile searches likewise reuse their captured HTML. Pass `browser: chrome` only after explicit user authorization: if native journal retrieval fails, fetch returns a bounded task for the plugin to reuse the connected Chrome session, and `chrome_fetch_commit` stores verified article HTML or downloaded-PDF text as entitled content. Pass `ids` to fetch a batch in one call (each returns its own row). Bare DOIs, PMIDs, PMCIDs, and enzyme names also work. Every result ends with a `_status: …_` line (ok, entitled-full-text, display-only-full-text, display-only-link, abstract-only, no-open-fulltext, oa-link, not-fetchable, not-found, bad-id). A non-full-text result also includes `_reason: …_`; for example, `subscription-required` is an expected access limitation, while `technical-retrieval-failure` means the automated request actually failed.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "A single result id (`rebase:…`, `doi:…`, `pmid:…`, `pmcid:…`, `url:…`) or a bare DOI / PMID / PMCID / enzyme name."
				},
				ids: {
					type: "array",
					items: { type: "string" },
					description: "Several ids to fetch at once (alternative to `id`)."
				},
				section: {
					type: "string",
					description: "For article full text only: a case-insensitive section-title substring (e.g. 'Methods', 'Protocol') to return just that section instead of the whole article."
				},
				browser: {
					type: "string",
					enum: [
						"off",
						"cdp",
						"default",
						"host",
						"chrome"
					],
					description: "Optional browser recovery. `host` reads a capture committed from Codex's integrated Browser; `default` uses Labee's AppleScript window; `cdp` connects to PROTOCOLS_BROWSER_CDP_URL; `chrome` prepares an explicit plugin handoff that reuses Codex's connected Chrome session without reading cookies; `off` uses native retrieval."
				}
			}
		}
	},
	{
		name: "chrome_fetch_commit",
		title: "Commit a connected-Chrome article capture",
		annotations: {
			readOnlyHint: false,
			openWorldHint: false,
			idempotentHint: false
		},
		description: "Complete a journal fallback prepared by `fetch(browser: chrome)`. Submit content only from the explicitly authorized connected Chrome session, after verifying the article DOI/title. The requested `url` must match the task exactly. Labee stores captured article HTML or text extracted from a Chrome-downloaded publisher PDF as `entitled-full-text`; it never labels this material open access.",
		inputSchema: {
			type: "object",
			properties: {
				captureId: {
					type: "string",
					description: "Opaque id returned by fetch(browser: chrome)."
				},
				title: {
					type: "string",
					description: "Article title observed in Chrome or the downloaded PDF."
				},
				url: {
					type: "string",
					description: "Exact requested URL from chromeBrowserTask.url."
				},
				finalUrl: {
					type: "string",
					description: "Final publisher or PDF URL after Chrome redirects."
				},
				html: {
					type: "string",
					description: "Rendered main/article HTML when available."
				},
				text: {
					type: "string",
					description: "Complete rendered article text or locally extracted PDF text."
				}
			},
			required: [
				"captureId",
				"title",
				"url"
			]
		}
	},
	{
		name: "browser_launch",
		title: "Open Labee's fallback system-Chrome window",
		annotations: {
			readOnlyHint: false,
			openWorldHint: true,
			idempotentHint: true
		},
		description: "Fallback only: open or reconnect to one Labee-owned window in the user's normal Chrome profile. Prefer Codex's integrated Browser; call this tool only when it is unavailable and the user explicitly authorizes system Chrome. Existing windows and tabs are never inspected or closed. Chrome must allow JavaScript from Apple Events.",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "browser_status",
		title: "Get Labee browser status",
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
			idempotentHint: true
		},
		description: "Report whether Labee's dedicated default-profile window is ready or needs permission/verification.",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "browser_close",
		title: "Close Labee's Chrome window",
		annotations: {
			readOnlyHint: false,
			openWorldHint: false,
			idempotentHint: true
		},
		description: "Close only the dedicated Chrome window created by Labee; existing user windows remain open.",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "list_sources",
		title: "List searchable sources",
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
			idempotentHint: true
		},
		description: "List the sources `search` can query — journals, reagent vendors, and the REBASE restriction- enzyme database — with their ids, kind, and whether their results are fetchable.",
		inputSchema: {
			type: "object",
			properties: {}
		}
	}
];
function toolText(text, isError = false) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError
	};
}
async function callTool(name, args) {
	if (name === "list_sources") {
		const FETCH_NOTE = {
			full: "fetchable",
			partial: "sometimes fetchable — may return a link instead",
			none: "links-only — site refuses automated requests"
		};
		const lines = VENDORS.map((v) => `- ${v.id} [${v.kind}]: ${v.name} — ${v.blurb} (${FETCH_NOTE[v.fetchability]})`);
		lines.unshift("- rebase [database]: REBASE — restriction-enzyme facts (recognition site, cut, methylation, suppliers incl. NEB) (fetchable)");
		const providers = providerStatus().map((p) => `${p.id}${p.available ? "" : " (not configured)"}`).join(", ");
		return toolText([
			"Sources (call `search`, then `fetch` a result's id):",
			...lines,
			"",
			"Primary publisher search: AWS Browserless (when BROWSERLESS_TOKEN is configured).",
			`Fallback web-search providers (vendors): ${providers}.`,
			`Fallback journal providers: ${journalProviderOrder().join(" → ")}.`,
			"Set BRAVE_API_KEY or GOOGLE_API_KEY+GOOGLE_CSE_CX for vendor-search fallback; set PROTOCOLS_CONTACT_EMAIL to enable the Unpaywall open-access full-text fallback."
		].join("\n"));
	}
	if (name === "search") {
		const query = typeof args.query === "string" ? args.query : "";
		if (!query.trim()) return toolText("Error: `query` is required.", true);
		const sources = Array.isArray(args.sources) ? args.sources.filter((x) => typeof x === "string") : void 0;
		const limit = typeof args.limit === "number" ? args.limit : void 0;
		const browserMode = [
			"off",
			"cdp",
			"default",
			"host"
		].includes(String(args.browser)) ? args.browser : void 0;
		const wantsNeb = sources ? sources.some((source) => source.trim().toLowerCase() === "neb") : true;
		if (browserMode === "host" && wantsNeb) {
			const nonNebSources = sources ? sources.filter((source) => source.trim().toLowerCase() !== "neb") : [...VENDOR_IDS.filter((source) => source !== "neb"), ...looksLikeEnzymeQuery(query) ? ["rebase"] : []];
			const base = nonNebSources.length > 0 ? await search(query, {
				sources: nonNebSources,
				...limit !== void 0 ? { limit } : {}
			}) : {
				query: query.trim(),
				results: [],
				sources: [],
				unknownSources: [],
				partial: false
			};
			const task = prepareHostBrowserSearch(query, limit ?? 5, base);
			return toolText([
				...base.sources.length > 0 ? [renderSearch(base), ""] : [],
				"_status: host-browser-required_",
				"",
				"hostBrowserTask:",
				JSON.stringify(task, null, 2)
			].join("\n"));
		}
		const resp = await search(query, {
			...sources ? { sources } : {},
			...limit !== void 0 ? { limit } : {}
		});
		const browser = browserAdapterForMode(browserMode === "host" ? void 0 : browserMode);
		const captures = [];
		if (browser) for (const result of resp.results.filter((item) => item.source === "neb" && item.url)) {
			const url = new URL(result.url);
			const hit = await browser.retrieve({
				url: url.toString(),
				sourceId: "neb",
				allowedHosts: browserHosts(url),
				maxChars: 8e4,
				timeoutMs: 12e3,
				interactionTimeoutMs: 5e3
			});
			if (browserMode === "cdp" || browserMode === "default") sameProfileBrowserById.set(result.id, browserMode);
			if (hit.status === "ok") captures.push(`- ${result.id}: rendered HTML cached for same-profile fetch`);
			else {
				captures.push(`- ${result.id}: browser capture ${hit.status}${hit.detail ? ` (${hit.detail})` : ""}`);
				if (hit.status === "interaction-required") break;
			}
		}
		return toolText([renderSearch(resp), ...captures.length > 0 ? [
			"",
			"Same-profile NEB browser capture:",
			...captures
		] : []].join("\n"));
	}
	if (name === "neb_search_commit") {
		const captureId = typeof args.captureId === "string" ? args.captureId : "";
		const results = Array.isArray(args.results) ? args.results.filter((item) => Boolean(item) && typeof item === "object") : [];
		if (!captureId) return toolText("Error: `captureId` is required.", true);
		const committed = commitHostBrowserSearch(captureId, results);
		return toolText([
			renderSearch(committed.response),
			"",
			"Host-browser NEB captures cached:",
			...committed.capturedIds.map((id) => `- ${id}: ${committed.formats[id]}`)
		].join("\n"));
	}
	if (name === "chrome_fetch_commit") {
		const captureId = typeof args.captureId === "string" ? args.captureId : "";
		const title = typeof args.title === "string" ? args.title : "";
		const url = typeof args.url === "string" ? args.url : "";
		if (!captureId) return toolText("Error: `captureId` is required.", true);
		const committed = commitChromeSessionFetch(captureId, {
			title,
			url,
			...typeof args.finalUrl === "string" ? { finalUrl: args.finalUrl } : {},
			...typeof args.html === "string" ? { html: args.html } : {},
			...typeof args.text === "string" ? { text: args.text } : {}
		});
		return toolText([
			`Connected-Chrome capture cached for \`${committed.id}\` as ${committed.format}.`,
			"",
			committed.content
		].join("\n"));
	}
	if (name === "fetch") {
		const section = typeof args.section === "string" ? args.section : void 0;
		const opts = section ? { section } : {};
		const requestedBrowserMode = [
			"off",
			"cdp",
			"default",
			"host",
			"chrome"
		].includes(String(args.browser)) ? args.browser : void 0;
		const list = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === "string" && x.trim() !== "") : [];
		const single = typeof args.id === "string" && args.id.trim() ? args.id : "";
		if (single) list.unshift(single);
		if (list.length === 0) return toolText("Error: `id` (or `ids`) is required.", true);
		const inheritedBrowserMode = list.map((id) => sameProfileBrowserById.get(id)).find((mode) => Boolean(mode));
		const browserMode = requestedBrowserMode === "off" ? "off" : requestedBrowserMode ?? inheritedBrowserMode;
		if (browserMode === "chrome") {
			if (list.length === 1) return toolText(fetchHostBrowserCapture(list[0]) ?? await fetchResourceWithChromeSessionFallback(list[0], opts));
			return toolText((await Promise.all(list.map(async (id) => ({
				id,
				text: fetchHostBrowserCapture(id) ?? await fetchResourceWithChromeSessionFallback(id, opts)
			})))).map((r) => `# ${r.id}\n\n${r.text}`).join("\n\n---\n\n"));
		}
		const browser = browserAdapterForMode(browserMode === "host" ? void 0 : browserMode);
		if (list.length === 1) return toolText(fetchHostBrowserCapture(list[0]) ?? await fetchResourceWithBrowser(list[0], opts, browser));
		const capturedRows = list.map((id) => ({
			id,
			text: fetchHostBrowserCapture(id)
		}));
		return toolText((capturedRows.every((row) => row.text === void 0) ? await fetchResourcesWithBrowser(list, opts, browser) : await Promise.all(capturedRows.map(async (row) => ({
			id: row.id,
			text: row.text ?? await fetchResourceWithBrowser(row.id, opts, browser)
		})))).map((r) => `# ${r.id}\n\n${r.text}`).join("\n\n---\n\n"));
	}
	if (name === "browser_launch") return toolText(JSON.stringify(await defaultBrowser().launch(), null, 2));
	if (name === "browser_status") return toolText(JSON.stringify(defaultBrowser().status(), null, 2));
	if (name === "browser_close") {
		const browser = defaultBrowser();
		await browser.close();
		sameProfileBrowserById.clear();
		return toolText(JSON.stringify(browser.status(), null, 2));
	}
	return toolText(`Error: unknown tool "${name}".`, true);
}
/**
* Pure request handler: maps a JSON-RPC request to its response, or `null` for
* notifications (no id, or initialized) that must not be answered. Never throws
* — tool errors are surfaced as MCP tool results with `isError: true`.
*/
async function dispatch(req) {
	const id = req.id ?? null;
	switch (req.method) {
		case "initialize": {
			const requested = req.params?.protocolVersion;
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO,
					instructions: SERVER_INSTRUCTIONS
				}
			};
		}
		case "notifications/initialized": return null;
		case "ping": return {
			jsonrpc: "2.0",
			id,
			result: {}
		};
		case "tools/list": return {
			jsonrpc: "2.0",
			id,
			result: { tools: TOOLS }
		};
		case "tools/call": {
			const params = req.params ?? {};
			const name = typeof params.name === "string" ? params.name : "";
			const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
			try {
				return {
					jsonrpc: "2.0",
					id,
					result: await callTool(name, args)
				};
			} catch (err) {
				return {
					jsonrpc: "2.0",
					id,
					result: toolText(`Error: ${err instanceof Error ? err.message : "tool execution failed"}`, true)
				};
			}
		}
		default:
			if (req.id === void 0 || req.id === null) return null;
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: -32601,
					message: `Method not found: ${req.method}`
				}
			};
	}
}

//#endregion
//#region src/http.ts
/** Cap request bodies. The box this runs on is memory-tight and no legitimate
*  MCP message is anywhere near this large. */
const MAX_BODY_BYTES = 1e6;
function jsonResponse(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** JSON-RPC error shaped as a top-level response (no id — the request never parsed). */
function rpcError(res, status, code, message) {
	jsonResponse(res, status, {
		jsonrpc: "2.0",
		id: null,
		error: {
			code,
			message
		}
	});
}
/**
* Constant-time bearer check. Compares lengths first because timingSafeEqual
* throws on a length mismatch — that leaks length only, which the token's fixed
* width already does.
*/
function tokenMatches(presented, expected) {
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
function bearerFrom(req) {
	const header = req.headers.authorization;
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}
/** Read the whole body, rejecting anything over MAX_BODY_BYTES. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/**
* Handle one MCP HTTP request. Exported so it can be mounted inside another
* Node HTTP server rather than only run standalone.
*/
async function handleMcpRequest(req, res, options = {}) {
	const { token } = options;
	if (token) {
		const presented = bearerFrom(req);
		if (!presented || !tokenMatches(presented, token)) {
			res.setHeader("www-authenticate", "Bearer realm=\"mcp\"");
			rpcError(res, 401, -32001, "Unauthorized");
			return;
		}
	}
	if (req.method === "GET" || req.method === "DELETE") {
		res.setHeader("allow", "POST");
		rpcError(res, 405, -32e3, `${req.method} is not supported by this endpoint`);
		return;
	}
	if (req.method !== "POST") {
		res.setHeader("allow", "POST");
		rpcError(res, 405, -32e3, "Method Not Allowed");
		return;
	}
	let raw;
	try {
		raw = await readBody(req);
	} catch (err) {
		rpcError(res, 413, -32600, err instanceof Error ? err.message : "could not read request body");
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		rpcError(res, 400, -32700, "Parse error");
		return;
	}
	const batch = Array.isArray(parsed);
	const messages = batch ? parsed : [parsed];
	if (batch && messages.length === 0) {
		rpcError(res, 400, -32600, "Invalid Request: empty batch");
		return;
	}
	const results = [];
	const rawOffer = req.headers[RESIDENTIAL_OFFER_HEADER];
	if (Array.isArray(rawOffer)) {
		rpcError(res, 400, -32600, "Invalid residential capability header");
		return;
	}
	const residentialOffer = decodeResidentialOffer(rawOffer);
	if (rawOffer && !residentialOffer) {
		rpcError(res, 400, -32600, "Invalid residential capability header");
		return;
	}
	await withResidentialOffer(residentialOffer, async () => {
		for (const message of messages) {
			const response = await dispatch(message);
			if (response) results.push(response);
		}
	});
	if (results.length === 0) {
		res.writeHead(202).end();
		return;
	}
	jsonResponse(res, 200, batch ? results : results[0]);
}
/**
* Start the MCP server over Streamable HTTP. Resolves with a `close` handle once
* the server is listening.
*/
function runHttpServer(port, host, options = {}) {
	const path = options.path ?? "/mcp";
	const server = createServer((req, res) => {
		const pathname = (req.url ?? "/").split("?")[0];
		if (pathname === "/healthz") {
			jsonResponse(res, 200, { status: "ok" });
			return;
		}
		if (pathname !== path) {
			rpcError(res, 404, -32601, `Not found: ${pathname}`);
			return;
		}
		handleMcpRequest(req, res, options).catch((err) => {
			const message = err instanceof Error ? err.message : "internal error";
			process.stderr.write(`[labee-protocol-searcher] request failed: ${message}\n`);
			if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
			else res.end();
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			const address = server.address();
			const actualPort = typeof address === "object" && address ? address.port : port;
			process.stderr.write(`[labee-protocol-searcher] MCP server ready on http://${host}:${actualPort}${path}${options.token ? " (bearer auth enabled)" : " (UNAUTHENTICATED)"}\n`);
			resolve({
				port: actualPort,
				close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done()))
			});
		});
	});
}

//#endregion
//#region src/labee-oauth.ts
const REFRESH_SKEW_MS = 300 * 1e3;
const AUTH_TIMEOUT_MS = 600 * 1e3;
function defaultAuthFile() {
	return process.env.LABEE_OAUTH_FILE?.trim() || join(homedir(), ".config", "labee", "protocol-search-oauth.json");
}
function issuerFor(resource) {
	return new URL(resource).origin;
}
function randomValue(bytes) {
	return randomBytes(bytes).toString("base64url");
}
function challenge(value) {
	return createHash("sha256").update(value).digest("base64url");
}
function readSession(file, resource) {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		if (typeof value.accessToken !== "string" || typeof value.clientId !== "string" || typeof value.expiresAt !== "number" || typeof value.issuer !== "string" || typeof value.refreshToken !== "string" || value.resource !== resource || typeof value.scope !== "string") return null;
		return value;
	} catch {
		return null;
	}
}
function saveSession(file, session) {
	mkdirSync(dirname(file), {
		recursive: true,
		mode: 448
	});
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(session)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	renameSync(temp, file);
}
function doneHtml(ok, message) {
	const title = ok ? "Labee connected" : "Labee connection failed";
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f3;color:#222}main{max-width:520px;padding:32px;text-align:center}</style><main><h1>${title}</h1><p>${message}</p></main>`;
}
var LabeeOAuthClient = class {
	authFile;
	fetchImpl;
	issuer;
	log;
	pending = null;
	session;
	constructor(options) {
		this.options = options;
		this.authFile = options.authFile ?? defaultAuthFile();
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.issuer = issuerFor(options.resource);
		this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
		this.session = readSession(this.authFile, options.resource);
	}
	status() {
		return {
			authenticated: Boolean(this.session && this.session.expiresAt > Date.now()),
			...this.pending ? { authorizationUrl: this.pending.authorizationUrl } : {},
			...this.session ? { expiresAt: new Date(this.session.expiresAt).toISOString() } : {},
			source: this.session ? "oauth" : "none"
		};
	}
	async disconnect() {
		const refreshToken = this.session?.refreshToken;
		this.closePending();
		this.session = null;
		try {
			rmSync(this.authFile, { force: true });
		} catch {}
		if (!refreshToken) return;
		try {
			await this.fetchImpl(`${this.issuer}/oauth/revoke`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					token: refreshToken,
					token_type_hint: "refresh_token"
				})
			});
		} catch (error) {
			this.log(`[labee-auth] token revocation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async accessToken() {
		if (!this.session) return void 0;
		if (this.session.expiresAt > Date.now() + REFRESH_SKEW_MS) return this.session.accessToken;
		try {
			const body = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.session.refreshToken,
				client_id: this.session.clientId,
				resource: this.options.resource
			});
			const response = await this.fetchImpl(`${this.issuer}/oauth/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			await this.acceptTokens(await response.json(), this.session.clientId);
			return this.session?.accessToken;
		} catch (error) {
			this.log(`[labee-auth] token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			await this.disconnect();
			return;
		}
	}
	async beginAuthorization() {
		if (this.pending) return this.pending.authorizationUrl;
		const codeVerifier = randomValue(48);
		const state = randomValue(24);
		const server = createServer();
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		server.unref();
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("Could not start the Labee OAuth callback listener");
		}
		const redirectUri = `http://127.0.0.1:${address.port}/callback`;
		const registration = await this.fetchImpl(`${this.issuer}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Labee Protocol Searcher for Codex",
				redirect_uris: [redirectUri],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"]
			})
		});
		if (!registration.ok) {
			server.close();
			throw new Error(`Labee OAuth registration failed (HTTP ${registration.status})`);
		}
		const registered = await registration.json();
		if (typeof registered.client_id !== "string") {
			server.close();
			throw new Error("Labee OAuth registration returned no client id");
		}
		const url = new URL(`${this.issuer}/oauth/authorize`);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: registered.client_id,
			redirect_uri: redirectUri,
			code_challenge: challenge(codeVerifier),
			code_challenge_method: "S256",
			resource: this.options.resource,
			scope: "protocols:search openid email",
			state
		}).toString();
		server.on("request", (request, response) => {
			this.handleCallback(request.url ?? "/", response, {
				clientId: registered.client_id,
				codeVerifier,
				redirectUri,
				state
			});
		});
		const timer = setTimeout(() => {
			this.log("[labee-auth] authorization timed out");
			this.closePending();
		}, AUTH_TIMEOUT_MS);
		timer.unref();
		this.pending = {
			authorizationUrl: url.toString(),
			server,
			timer
		};
		return url.toString();
	}
	async handleCallback(rawUrl, response, flow) {
		try {
			const callback = new URL(rawUrl, flow.redirectUri);
			if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== flow.state) {
				response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
				response.end(doneHtml(false, "The OAuth callback could not be verified."));
				return;
			}
			const code = callback.searchParams.get("code");
			const authError = callback.searchParams.get("error");
			if (!code) throw new Error(authError || "No authorization code was returned");
			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: flow.clientId,
				redirect_uri: flow.redirectUri,
				code_verifier: flow.codeVerifier,
				resource: this.options.resource
			});
			const tokenResponse = await this.fetchImpl(`${this.issuer}/oauth/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body
			});
			if (!tokenResponse.ok) throw new Error(`Token exchange failed (HTTP ${tokenResponse.status})`);
			await this.acceptTokens(await tokenResponse.json(), flow.clientId);
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(doneHtml(true, "You can close this tab and return to Codex."));
			this.log("[labee-auth] connected to Labee");
		} catch (error) {
			response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
			response.end(doneHtml(false, error instanceof Error ? error.message : String(error)));
			this.log(`[labee-auth] authorization failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setTimeout(() => this.closePending(), 100).unref();
		}
	}
	async acceptTokens(raw, clientId) {
		const value = raw;
		if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string" || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in)) throw new Error("Labee returned a malformed OAuth token response");
		this.session = {
			accessToken: value.access_token,
			clientId,
			expiresAt: Date.now() + Math.max(1, value.expires_in) * 1e3,
			issuer: this.issuer,
			refreshToken: value.refresh_token,
			resource: this.options.resource,
			scope: typeof value.scope === "string" ? value.scope : "protocols:search"
		};
		try {
			saveSession(this.authFile, this.session);
		} catch (error) {
			this.log(`[labee-auth] could not persist credentials: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	closePending() {
		if (!this.pending) return;
		clearTimeout(this.pending.timer);
		this.pending.server.close();
		this.pending = null;
	}
};

//#endregion
//#region src/stdio-proxy.ts
const DEFAULT_REMOTE_MCP_URL = "https://labee.online/api/protocols/mcp";
const DEFAULT_REMOTE_TIMEOUT_MS = 3e5;
const TRANSPORT_ERROR_CODE = -32002;
function optional(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function isLoopback(hostname) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function assertRemoteMcpUrl(value) {
	const parsed = new URL(value);
	if (parsed.username || parsed.password) throw new Error("Remote MCP URL must not contain credentials");
	if (parsed.hash) throw new Error("Remote MCP URL must not contain a fragment");
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) throw new Error("Remote MCP URL must use HTTPS unless it is loopback");
	return parsed.toString();
}
function remoteMcpConfig(env = process.env) {
	const rawTimeout = Number(env.PROTOCOLS_REMOTE_MCP_TIMEOUT_MS);
	const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : DEFAULT_REMOTE_TIMEOUT_MS;
	const url = assertRemoteMcpUrl(optional(env.PROTOCOLS_REMOTE_MCP_URL) ?? DEFAULT_REMOTE_MCP_URL);
	return {
		timeoutMs,
		token: optional(env.PROTOCOLS_REMOTE_MCP_TOKEN) ?? optional(env.MCP_BEARER_TOKEN) ?? optional(env.PROTOCOLS_MCP_TOKEN),
		url
	};
}
function parseJson(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return;
	}
}
function isResidentialToolCall(value) {
	if (Array.isArray(value)) return value.some(isResidentialToolCall);
	if (!value || typeof value !== "object") return false;
	const request = value;
	return request.method === "tools/call" && (request.params?.name === "search" || request.params?.name === "fetch");
}
/** Only search/fetch can cause a publisher browser route. */
function messageMayNeedResidential(raw) {
	return isResidentialToolCall(parseJson(raw));
}
function responseIds(raw) {
	const parsed = parseJson(raw);
	const messages = Array.isArray(parsed) ? parsed : [parsed];
	if (parsed === void 0 || Array.isArray(parsed) && parsed.length === 0) return [null];
	const ids = [];
	for (const message of messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			ids.push(null);
			continue;
		}
		const request = message;
		if (typeof request.method === "string" && request.id === void 0) continue;
		if (request.id === null || typeof request.id === "string" || typeof request.id === "number") ids.push(request.id);
		else ids.push(null);
	}
	return ids.length ? ids : null;
}
function transportErrorResponse(raw, message) {
	const ids = responseIds(raw);
	if (!ids) return null;
	const responses = ids.map((id) => ({
		jsonrpc: "2.0",
		id,
		error: {
			code: TRANSPORT_ERROR_CODE,
			message
		}
	}));
	return JSON.stringify(Array.isArray(parseJson(raw)) ? responses : responses[0]);
}
function parseEventStream(body) {
	for (const event of body.split(/\r?\n\r?\n/)) {
		const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
		if (!data) continue;
		const parsed = parseJson(data);
		if (parsed !== void 0) return parsed;
	}
}
function normalizedRemoteBody(contentType, body) {
	const parsed = contentType.includes("text/event-stream") ? parseEventStream(body) : parseJson(body);
	if (parsed === void 0) throw new Error("Remote MCP returned a malformed response");
	return JSON.stringify(parsed);
}
function remoteErrorMessage(status, body) {
	const parsed = parseJson(body);
	return `Remote MCP HTTP ${status}${typeof parsed?.error?.message === "string" ? `: ${parsed.error.message}` : ""}`;
}
/** Sessionless today, but preserves MCP session/version headers for compatible remotes. */
var RemoteMcpClient = class {
	fetchImpl;
	tokenProvider;
	protocolVersion;
	sessionId;
	constructor(config, options = {}) {
		this.config = config;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.tokenProvider = options.tokenProvider;
	}
	async forward(raw, offer = null) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			const headers = {
				accept: "application/json, text/event-stream",
				"content-type": "application/json"
			};
			const token = this.config.token ?? await this.tokenProvider?.();
			if (token) headers.authorization = `Bearer ${token}`;
			if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
			if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
			if (offer) headers[RESIDENTIAL_OFFER_HEADER] = encodeResidentialOffer(offer);
			const response = await this.fetchImpl(this.config.url, {
				body: raw,
				headers,
				method: "POST",
				redirect: "error",
				signal: controller.signal
			});
			const returnedSession = response.headers.get("mcp-session-id")?.trim();
			if (returnedSession) this.sessionId = returnedSession;
			if (response.status === 202 || response.status === 204) return null;
			const body = await response.text();
			if (!response.ok) throw new Error(remoteErrorMessage(response.status, body));
			const normalized = normalizedRemoteBody(response.headers.get("content-type") ?? "", body);
			if (parseJson(raw)?.method === "initialize") {
				const reply = parseJson(normalized);
				if (typeof reply.result?.protocolVersion === "string") this.protocolVersion = reply.result.protocolVersion;
			}
			return normalized;
		} finally {
			clearTimeout(timeout);
		}
	}
};
function configuredResidentialReadyTimeout() {
	const value = Number(process.env.RESIDENTIAL_PROXY_READY_TIMEOUT_MS);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 4e3;
}
/** Start the local stdio-to-remote HTTP bridge. Resolves after stdin and in-flight calls drain. */
function runStdioProxy(options = {}) {
	const config = remoteMcpConfig();
	const auth = options.auth ?? new LabeeOAuthClient({ resource: config.url });
	const client = options.client ?? new RemoteMcpClient(config, { tokenProvider: () => auth.accessToken() });
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
	const readyTimeout = options.residentialReadyTimeoutMs ?? configuredResidentialReadyTimeout();
	return new Promise((resolve) => {
		let buffer = "";
		let inputClosed = false;
		let pending = 0;
		const maybeResolve = () => {
			if (inputClosed && pending === 0) resolve();
		};
		const closeInput = () => {
			inputClosed = true;
			maybeResolve();
		};
		const forwardLine = (line) => {
			pending++;
			(async () => {
				try {
					const parsed = parseJson(line);
					if (parsed?.method === "tools/call" && parsed.params?.name === "labee_auth") {
						const action = parsed.params.arguments?.action;
						let text;
						let structuredContent;
						if (action === "disconnect") {
							await auth.disconnect();
							text = "Disconnected this plugin from Labee.";
							structuredContent = { ...auth.status() };
						} else if (action === "status") {
							structuredContent = { ...auth.status() };
							text = structuredContent.authenticated ? "This plugin is connected to Labee." : "This plugin is not connected to Labee.";
						} else {
							const authorizationUrl = await auth.beginAuthorization();
							structuredContent = {
								...auth.status(),
								authorizationUrl
							};
							text = `Open this Labee sign-in link, create an account or sign in, approve access, then return to Codex:\n\n${authorizationUrl}`;
						}
						output.write(`${JSON.stringify({
							jsonrpc: "2.0",
							id: parsed.id ?? null,
							result: {
								content: [{
									type: "text",
									text
								}],
								structuredContent
							}
						})}\n`);
						return;
					}
					let offer = null;
					if (messageMayNeedResidential(line)) {
						await awaitResidentialReady(readyTimeout);
						offer = activeResidentialOffer();
					}
					let response = await client.forward(line, offer);
					if (response && parsed?.method === "tools/list") {
						const value = parseJson(response);
						if (Array.isArray(value?.result?.tools)) {
							value.result.tools.push({
								name: "labee_auth",
								title: "Connect or disconnect a Labee account",
								description: "Connect this plugin to labee.online with OAuth, check connection status, or disconnect. New accounts receive introductory search credit.",
								annotations: {
									readOnlyHint: false,
									openWorldHint: true,
									idempotentHint: false
								},
								securitySchemes: [{ type: "noauth" }],
								inputSchema: {
									type: "object",
									properties: { action: {
										type: "string",
										enum: [
											"connect",
											"status",
											"disconnect"
										],
										default: "connect"
									} }
								}
							});
							response = JSON.stringify(value);
						}
					}
					if (response) output.write(`${response}\n`);
				} catch (error) {
					const response = transportErrorResponse(line, error instanceof Error ? error.message : "Remote MCP request failed");
					if (response) output.write(`${response}\n`);
				} finally {
					pending--;
					maybeResolve();
				}
			})();
		};
		log("[labee-protocol-searcher] stdio proxy ready; all MCP requests forward to the remote service");
		input.setEncoding("utf8");
		input.on("data", (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) forwardLine(line);
			}
		});
		input.once("end", closeInput);
		input.once("close", closeInput);
	});
}

//#endregion
//#region src/local-config.ts
const RESIDENTIAL_KEYS = new Set([
	"PROTOCOLS_RESIDENTIAL_PROXY",
	"RESIDENTIAL_PROXY_CONSENT",
	"RESIDENTIAL_PROXY_AGENT_TOKEN",
	"RESIDENTIAL_PROXY_URL",
	"BROWSERLESS_URL",
	"RESIDENTIAL_PROXY_COUNTRY",
	"RESIDENTIAL_PROXY_REGION",
	"RESIDENTIAL_PROXY_CITY",
	"RESIDENTIAL_PROXY_MAX_CONNECTIONS",
	"RESIDENTIAL_PROXY_ALLOW_HOSTS",
	"RESIDENTIAL_PROXY_READY_TIMEOUT_MS",
	"RESIDENTIAL_PROXY_AGENT_ID",
	"RESIDENTIAL_PROXY_CONTROL_PROXY"
]);
function defaultLocalConfigPath(env = process.env) {
	return env.LABEE_LOCAL_CONFIG?.trim() || join(homedir(), ".config", "labee", "protocol-searcher.env");
}
/** Load a small, non-shell env file used only for the opt-in local residential
* bridge. Existing process variables always win. Files readable by group or
* others are refused because they contain the agent credential. */
function loadLocalResidentialConfig(env = process.env, file = defaultLocalConfigPath(env)) {
	let raw;
	try {
		const stat = statSync(file);
		if ((stat.mode & 63) !== 0) return {
			loaded: [],
			warning: `ignored ${file}: permissions must be 0600`
		};
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return {
			loaded: [],
			warning: `ignored ${file}: it is owned by another user`
		};
		raw = readFileSync(file, "utf8");
	} catch (error) {
		return error.code === "ENOENT" ? { loaded: [] } : {
			loaded: [],
			warning: `could not read ${file}`
		};
	}
	const loaded = [];
	for (const sourceLine of raw.split(/\r?\n/)) {
		const line = sourceLine.trim();
		if (!line || line.startsWith("#")) continue;
		const equals = line.indexOf("=");
		if (equals < 1) continue;
		const key = line.slice(0, equals).trim();
		if (!RESIDENTIAL_KEYS.has(key) || env[key] != null) continue;
		let value = line.slice(equals + 1).trim();
		if (value.length >= 2 && (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		if (!value || /[\u0000\r\n]/.test(value)) continue;
		env[key] = value;
		loaded.push(key);
	}
	return { loaded };
}

//#endregion
//#region src/index.ts
function parseArgs(argv) {
	const out = {
		json: false,
		listSources: false,
		http: false
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--query" || a === "-q") out.query = argv[++i] ?? "";
		else if (a === "--fetch" || a === "-f") out.fetchId = argv[++i] ?? "";
		else if (a === "--sources" || a === "-s") out.sources = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		else if (a === "--limit" || a === "-l") out.limit = Number(argv[++i]);
		else if (a === "--json") out.json = true;
		else if (a === "--list-sources") out.listSources = true;
		else if (a === "--http") out.http = true;
		else if (a === "--port") out.port = Number(argv[++i]);
		else if (a === "--host") out.host = argv[++i] ?? "";
		else if (a === "--browser") {
			const mode = argv[++i] ?? "";
			if (mode !== "off" && mode !== "cdp" && mode !== "default") throw new Error("--browser must be one of: off, cdp, default");
			out.browser = mode;
		} else if (a && !a.startsWith("-") && out.query === void 0) out.query = a;
	}
	return out;
}
/**
* Start the HTTP transport. Binds loopback by default: the deployed topology
* puts nginx in front, so the port itself should never face the internet.
*/
async function runHttp(args) {
	const port = args.port ?? Number(process.env.PROTOCOLS_MCP_PORT ?? process.env.PORT ?? 3001);
	const host = args.host ?? process.env.PROTOCOLS_MCP_HOST ?? "127.0.0.1";
	const token = process.env.PROTOCOLS_MCP_TOKEN?.trim();
	const path = process.env.PROTOCOLS_MCP_PATH_PREFIX ?? "/mcp";
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${args.port ?? process.env.PROTOCOLS_MCP_PORT}`);
	if (!token && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error(`Refusing to bind ${host} without PROTOCOLS_MCP_TOKEN set. Set a token, or bind 127.0.0.1 and put a proxy in front.`);
	await runHttpServer(port, host, {
		...token ? { token } : {},
		path
	});
	await new Promise(() => {});
}
async function runCli(args) {
	if (args.listSources) {
		const rows = [{
			id: "rebase",
			name: "REBASE (restriction enzymes)",
			kind: "database",
			fetchability: "full"
		}, ...VENDORS.map((v) => ({
			id: v.id,
			name: v.name,
			kind: v.kind,
			fetchability: v.fetchability
		}))];
		if (args.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
		else for (const r of rows) process.stdout.write(`${r.id}\t[${r.kind}] ${r.name}\t${r.fetchability}\n`);
		return;
	}
	if (args.fetchId !== void 0) {
		const browser = browserAdapterForMode(args.browser);
		process.stdout.write(await fetchResourceWithBrowser(args.fetchId, {}, browser) + "\n");
		return;
	}
	const resp = await search(args.query, {
		...args.sources ? { sources: args.sources } : {},
		...args.limit !== void 0 ? { limit: args.limit } : {}
	});
	process.stdout.write((args.json ? JSON.stringify(resp, null, 2) : renderSearch(resp)) + "\n");
}
const args = parseArgs(process.argv.slice(2));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
	shutdownDefaultBrowser().finally(() => process.exit(0));
});
/**
* First step in every mode: establish what kind of network we are on. Entitlement
* to publisher content is decided by IP, so retrieval behaves differently from a
* university range than from a datacenter, and a caller reading the results
* deserves to know which one produced them. Never fatal — an unreachable
* detector resolves to "unknown".
*/
async function detectNetwork() {
	try {
		const ctx = await detectNetworkContext();
		process.stderr.write(`[labee-protocol-searcher] ${describeNetworkContext(ctx)}\n`);
	} catch (err) {
		process.stderr.write(`[labee-protocol-searcher] network detection skipped: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}
if (args.query !== void 0 || args.fetchId !== void 0 || args.listSources) {
	const residential = args.query !== void 0 || args.fetchId !== void 0 ? startResidentialAgent() : null;
	detectNetwork().then(() => runCli(args)).finally(() => {
		residential?.stop();
		return shutdownDefaultBrowser();
	}).catch((err) => {
		process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
} else if (args.http) detectNetwork().then(() => runHttp(args)).catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
else {
	const localConfig = loadLocalResidentialConfig();
	if (localConfig.warning) process.stderr.write(`[labee-protocol-searcher] ${localConfig.warning}\n`);
	const residential = startResidentialAgent();
	Promise.resolve().then(() => runStdioProxy()).finally(() => {
		residential?.stop();
		return shutdownDefaultBrowser();
	}).then(() => process.exit(0)).catch((err) => {
		process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}

//#endregion
export {  };