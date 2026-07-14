import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
const TOKEN_SECRET = crypto
  .createHash("sha256")
  .update(process.env.SUB_TOKEN_SECRET || "local-development-secret-change-me")
  .digest();
const RELAY_SECRET = process.env.RELAY_SECRET || "";
const FETCH_RELAYS = (process.env.FETCH_RELAYS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const SHORTENER_ENDPOINT = process.env.SHORTENER_ENDPOINT || "https://d.flysub.org/short";

const RAW_TTL_MS = Number(process.env.RAW_CACHE_TTL_MS || 10 * 60 * 1000);
const OUTPUT_TTL_MS = Number(process.env.OUTPUT_CACHE_TTL_MS || 10 * 60 * 1000);
const STALE_TTL_MS = Number(process.env.STALE_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_BODY_BYTES = Number(process.env.MAX_UPSTREAM_BYTES || 5 * 1024 * 1024);
const MAX_NODES = Number(process.env.MAX_NODES || 3000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 8000);

const rawCache = new Map();
const outputCache = new Map();
const rateMap = new Map();
const publicDir = path.join(process.cwd(), "public");
const registeredRelaysPath = path.join(process.cwd(), "registered-relays.json");
let registeredRelays = [];

function now() {
  return Date.now();
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/yaml; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cacheGet(store, key, allowStale = false) {
  const item = store.get(key);
  if (!item) return null;
  if (item.expiresAt > now()) return { ...item, stale: false };
  if (allowStale && item.staleUntil > now()) return { ...item, stale: true };
  store.delete(key);
  return null;
}

function cacheSet(store, key, value, ttlMs, staleTtlMs = ttlMs) {
  store.set(key, {
    value,
    expiresAt: now() + ttlMs,
    staleUntil: now() + staleTtlMs,
  });
}

function cleanupCaches() {
  const t = now();
  for (const [key, item] of rawCache) {
    if (item.staleUntil <= t) rawCache.delete(key);
  }
  for (const [key, item] of outputCache) {
    if (item.staleUntil <= t) outputCache.delete(key);
  }
  for (const [key, bucket] of rateMap) {
    if (bucket.resetAt <= t) rateMap.delete(key);
  }
}

setInterval(cleanupCaches, 60_000).unref();

async function loadRegisteredRelays() {
  try {
    const text = await fs.readFile(registeredRelaysPath, "utf8");
    const data = JSON.parse(text);
    registeredRelays = Array.isArray(data.relays) ? data.relays.filter((item) => item?.url).slice(0, 200) : [];
  } catch {
    registeredRelays = [];
  }
}

async function saveRegisteredRelays() {
  const data = JSON.stringify({ relays: registeredRelays }, null, 2);
  await fs.writeFile(registeredRelaysPath, data);
}

function normalizeRelayUrl(input) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Relay url must be http or https");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function getRelayUrls() {
  const urls = [...FETCH_RELAYS, ...registeredRelays.map((relay) => relay.url)];
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

async function registerRelay(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  const existing = registeredRelays.find((relay) => relay.url === normalized);
  const item = {
    url: normalized,
    registeredAt: existing?.registeredAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  registeredRelays = [item, ...registeredRelays.filter((relay) => relay.url !== normalized)].slice(0, 200);
  await saveRegisteredRelays();
  return item;
}

async function unregisterRelay(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  const before = registeredRelays.length;
  registeredRelays = registeredRelays.filter((relay) => relay.url !== normalized);
  await saveRegisteredRelays();
  return {
    url: normalized,
    removed: registeredRelays.length !== before,
    count: registeredRelays.length,
  };
}

function getClientIp(req) {
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req) {
  const ip = getClientIp(req);
  const key = hash(ip);
  const t = now();
  const bucket = rateMap.get(key) || { count: 0, resetAt: t + 60_000 };
  if (bucket.resetAt <= t) {
    bucket.count = 0;
    bucket.resetAt = t + 60_000;
  }
  bucket.count += 1;
  rateMap.set(key, bucket);
  return bucket.count <= 60;
}

async function readRequestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const n = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const ranges = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["100.64.0.0", 10],
      ["224.0.0.0", 4],
    ];
    return ranges.some(([base, bits]) => {
      const b = base.split(".").map(Number);
      const baseN = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (baseN & mask);
    });
  }
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

async function assertSafeUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("订阅链接不是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("只允许 http/https 订阅链接");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("订阅链接格式不安全");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("不允许请求本机地址");
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error("不允许请求内网、回环或云元数据地址");
  }
  return url;
}

async function fetchUpstream(subUrl) {
  const safeUrl = await assertSafeUrl(subUrl);
  const key = hash(safeUrl.toString());
  const cached = cacheGet(rawCache, key, true);
  if (cached && !cached.stale) return { body: cached.value, stale: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(safeUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "ClashMeta/1.18 Mihomo/1.18 SubConverter/0.1",
        accept: "text/plain, application/yaml, application/json, */*",
      },
    });
    if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("上游响应为空");
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) throw new Error("上游订阅内容过大");
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8").trim();
    cacheSet(rawCache, key, body, RAW_TTL_MS, STALE_TTL_MS);
    return { body, stale: false };
  } catch (error) {
    if (cached) return { body: cached.value, stale: true, warning: error.message };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamViaRelay(relayBase, subUrl) {
  if (!RELAY_SECRET) throw new Error("未配置 RELAY_SECRET，无法使用中继拉取");
  const relayUrl = new URL("/api/relay-fetch", relayBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS + 3000);
  try {
    const response = await fetch(relayUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RELAY_SECRET}`,
      },
      body: JSON.stringify({ url: subUrl }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `中继 ${relayBase} 返回 HTTP ${response.status}`);
    if (!data.body || typeof data.body !== "string") throw new Error(`中继 ${relayBase} 没有返回订阅内容`);
    return {
      body: Buffer.from(data.body, "base64").toString("utf8").trim(),
      stale: Boolean(data.stale),
      warning: data.warning,
      source: relayBase,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRelayBody(subUrl) {
  const upstream = await fetchUpstream(subUrl);
  return {
    body: Buffer.from(upstream.body, "utf8").toString("base64"),
    stale: upstream.stale,
    warning: upstream.warning,
  };
}

function encryptToken(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", TOKEN_SECRET, iv);
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function decryptToken(token) {
  const packed = Buffer.from(token, "base64url");
  if (packed.length < 29) throw new Error("订阅 token 无效");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", TOKEN_SECRET, iv);
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(data.toString("utf8"));
}

function tryBase64Decode(text) {
  const compact = text.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || /[^A-Za-z0-9+/=_-]/.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
    if (/^(ss|ssr|vmess|vless|trojan|hysteria2?|tuic|anytls):\/\//m.test(decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

function decodeName(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function trimName(name) {
  const clean = String(name || "Unnamed").replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

function boolParam(value, fallback = undefined) {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function pickSni(params) {
  return params.get("sni") || params.get("peer") || params.get("host") || params.get("servername") || undefined;
}

function normalizeNode(node) {
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null || value === "") continue;
    normalized[key] = value;
  }
  if (!normalized.name || !normalized.type || !normalized.server || !normalized.port) return null;
  normalized.name = trimName(normalized.name);
  normalized.port = safePort(normalized.port);
  if (!normalized.port) return null;
  return normalized;
}

function parseStandardUri(line) {
  const hashIndex = line.indexOf("#");
  const name = hashIndex >= 0 ? decodeName(line.slice(hashIndex + 1)) : "";
  const withoutHash = hashIndex >= 0 ? line.slice(0, hashIndex) : line;
  const protocol = withoutHash.split("://")[0];
  if (protocol === "vmess") return parseVmessUri(withoutHash, name);
  if (protocol === "ss") return parseSsUri(withoutHash, name);
  if (["vless", "trojan", "hysteria", "hysteria2", "tuic", "anytls"].includes(protocol)) {
    return parseUrlLikeProxy(withoutHash, name, protocol);
  }
  return null;
}

function parseVmessUri(uri, fallbackName) {
  try {
    const payload = uri.slice("vmess://".length);
    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return normalizeNode({
      name: data.ps || fallbackName,
      type: "vmess",
      server: data.add,
      port: data.port,
      uuid: data.id,
      alterId: Number(data.aid || 0),
      cipher: data.scy || "auto",
      tls: data.tls === "tls",
      network: data.net,
      sni: data.sni || data.host,
      "skip-cert-verify": false,
    });
  } catch {
    return null;
  }
}

function parseSsUri(uri, fallbackName) {
  try {
    const body = uri.slice("ss://".length);
    const noHash = body.split("#")[0];
    const [main, queryText = ""] = noHash.split("?");
    const decodedMain = main.includes("@") ? main : Buffer.from(main, "base64").toString("utf8");
    const at = decodedMain.lastIndexOf("@");
    if (at < 0) return null;
    const methodPassword = decodedMain.slice(0, at);
    const serverPort = decodedMain.slice(at + 1);
    const colon = serverPort.lastIndexOf(":");
    const methodSplit = methodPassword.indexOf(":");
    const params = new URLSearchParams(queryText);
    return normalizeNode({
      name: fallbackName,
      type: "ss",
      server: serverPort.slice(0, colon),
      port: serverPort.slice(colon + 1),
      cipher: methodPassword.slice(0, methodSplit),
      password: methodPassword.slice(methodSplit + 1),
      udp: boolParam(params.get("udp"), true),
    });
  } catch {
    return null;
  }
}

function parseUrlLikeProxy(uri, fallbackName, type) {
  try {
    const url = new URL(uri);
    const params = url.searchParams;
    const base = {
      name: fallbackName || params.get("name"),
      type,
      server: url.hostname,
      port: url.port,
      udp: boolParam(params.get("udp"), true),
      sni: pickSni(params),
      "skip-cert-verify": boolParam(params.get("allowInsecure") || params.get("skip-cert-verify") || params.get("insecure"), false),
      "client-fingerprint": params.get("fp") || params.get("client-fingerprint") || params.get("fingerprint") || "chrome",
    };
    if (type === "vless") {
      base.uuid = decodeURIComponent(url.username);
      base.tls = ["tls", "reality"].includes(params.get("security"));
      base.network = params.get("type") || undefined;
      base.flow = params.get("flow") || undefined;
      base["reality-opts"] = params.get("pbk")
        ? { "public-key": params.get("pbk"), "short-id": params.get("sid") || "" }
        : undefined;
    } else if (type === "trojan" || type === "anytls" || type === "hysteria" || type === "hysteria2" || type === "tuic") {
      base.password = decodeURIComponent(url.username);
      if (type === "tuic") base.uuid = params.get("uuid") || undefined;
      if (type === "hysteria2") base.obfs = params.get("obfs") || undefined;
      if (type === "hysteria2") base["obfs-password"] = params.get("obfs-password") || params.get("obfsPassword") || undefined;
    }
    return normalizeNode(base);
  } catch {
    return null;
  }
}

function splitTopLevelJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) objects.push(text.slice(start, i + 1));
    }
  }
  return objects;
}

function parseInlineJsonProxyLines(text) {
  const nodes = [];
  for (const objectText of splitTopLevelJsonObjects(text)) {
    try {
      const obj = JSON.parse(objectText);
      const node = normalizeNode(obj);
      if (node) nodes.push(node);
    } catch {
      // Keep probing other objects.
    }
  }
  return nodes;
}

function coerceScalar(value) {
  const clean = String(value).trim().replace(/^["']|["']$/g, "");
  if (clean === "true") return true;
  if (clean === "false") return false;
  const number = Number(clean);
  if (clean !== "" && Number.isFinite(number)) return number;
  return clean;
}

function splitTopLevel(input, separator = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function parseYamlFlowMap(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const body = trimmed.slice(1, -1).trim();
  const output = {};
  for (const pair of splitTopLevel(body)) {
    const colon = splitTopLevel(pair, ":");
    if (colon.length < 2) continue;
    const key = colon.shift().trim().replace(/^["']|["']$/g, "");
    const value = colon.join(":").trim();
    output[key] = coerceScalar(value);
  }
  return output;
}

function parseSimpleYamlProxies(text) {
  const nodes = parseInlineJsonProxyLines(text);
  const lines = text.split(/\r?\n/);
  let inProxies = false;
  let current = null;
  const flush = () => {
    const node = current ? normalizeNode(current) : null;
    if (node) nodes.push(node);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (/^proxies\s*:\s*$/.test(line.trim())) {
      inProxies = true;
      continue;
    }
    if (inProxies && /^[A-Za-z0-9_-]+\s*:/.test(line) && !line.startsWith(" ")) {
      flush();
      break;
    }
    if (!inProxies) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ")) {
      flush();
      const rest = trimmed.slice(2).trim();
      current = parseYamlFlowMap(rest) || {};
      if (rest.includes(":")) {
        if (!rest.startsWith("{")) {
          const idx = rest.indexOf(":");
          current[rest.slice(0, idx).trim()] = coerceScalar(rest.slice(idx + 1));
        }
      }
    } else if (current && trimmed.includes(":")) {
      const idx = trimmed.indexOf(":");
      current[trimmed.slice(0, idx).trim()] = coerceScalar(trimmed.slice(idx + 1));
    }
  }
  flush();
  return dedupeNodes(nodes);
}

function parseSingBoxJson(text) {
  try {
    const data = JSON.parse(text);
    const outbounds = Array.isArray(data.outbounds) ? data.outbounds : [];
    return outbounds
      .filter((item) => item.type && !["direct", "block", "dns", "selector", "urltest"].includes(item.type))
      .map((item) =>
        normalizeNode({
          name: item.tag,
          type: item.type === "shadowsocks" ? "ss" : item.type,
          server: item.server,
          port: item.server_port,
          password: item.password,
          uuid: item.uuid,
          cipher: item.method,
          udp: true,
          sni: item.tls?.server_name,
          "skip-cert-verify": item.tls?.insecure,
        }),
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseUriList(text) {
  const decoded = tryBase64Decode(text) || text;
  const nodes = [];
  for (const line of decoded.split(/\r?\n/)) {
    const clean = line.trim();
    if (!/^(ss|vmess|vless|trojan|hysteria2?|tuic|anytls):\/\//.test(clean)) continue;
    const node = parseStandardUri(clean);
    if (node) nodes.push(node);
    if (nodes.length >= MAX_NODES) break;
  }
  return dedupeNodes(nodes);
}

function dedupeNodes(nodes) {
  const seen = new Set();
  const output = [];
  for (const node of nodes) {
    const key = `${node.type}|${node.server}|${node.port}|${node.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(node);
    if (output.length >= MAX_NODES) break;
  }
  return output;
}

export function parseSubscription(text) {
  const parsers = [parseSimpleYamlProxies, parseSingBoxJson, parseUriList];
  for (const parser of parsers) {
    const nodes = parser(text);
    if (nodes.length) return nodes;
  }
  return [];
}

function previewText(text, maxLength = 140) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isInfoNode(node) {
  return /traffic|expire|reset|\bgb\b|\bmb\b|流量|到期|重置|剩余/i.test(node.name);
}

function applyOptions(nodes, options = {}) {
  let output = nodes;
  if (options.infoNodes === "remove") output = output.filter((node) => !isInfoNode(node));
  if (options.keyword) {
    const keyword = String(options.keyword).trim().toLowerCase();
    if (keyword) output = output.filter((node) => node.name.toLowerCase().includes(keyword));
  }
  return output.slice(0, MAX_NODES);
}

async function fetchSourceAndParse(source, url, options) {
  const upstream = source.type === "direct" ? await fetchUpstream(url) : await fetchUpstreamViaRelay(source.label, url);
  const parsed = parseSubscription(upstream.body);
  const nodes = applyOptions(parsed, options);
  if (!nodes.length) {
    throw new Error(`no nodes, upstream preview: ${previewText(upstream.body) || "empty response"}`);
  }
  return {
    nodes,
    warning: upstream.warning,
    stale: upstream.stale,
    source: source.label,
  };
}

async function fetchAndParseWithFallback(url, options) {
  const attempts = [];
  const relayUrls = getRelayUrls();
  const sources = [{ type: "direct", label: "direct" }, ...relayUrls.map((relay) => ({ type: "relay", label: relay }))];

  if (relayUrls.length) {
    const pending = sources.map((source) =>
      fetchSourceAndParse(source, url, options)
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({
          ok: false,
          attempt: `${source.label}: ${error instanceof Error ? error.message : "fetch failed"}`,
        })),
    );

    return await new Promise((resolve, reject) => {
      let settled = 0;
      for (const task of pending) {
        task.then((outcome) => {
          settled += 1;
          if (outcome.ok) {
            resolve(outcome.result);
            return;
          }
          attempts.push(outcome.attempt);
          if (settled === pending.length) {
            reject(new Error(`No convertible nodes found. Attempts: ${attempts.join("; ")}`));
          }
        });
      }
    });
  }

  for (const source of sources) {
    try {
      return await fetchSourceAndParse(source, url, options);
    } catch (error) {
      attempts.push(`${source.label}: ${error instanceof Error ? error.message : "fetch failed"}`);
    }
  }

  throw new Error(`No convertible nodes found. Attempts: ${attempts.join("; ")}`);
}

function toMihomoNode(node) {
  const output = {};
  const serverName = node.type === "vless" ? node.servername || node.sni : node.servername;
  const allowed = [
    "name",
    "type",
    "server",
    "port",
    "password",
    "uuid",
    "cipher",
    "alterId",
    "udp",
    "tls",
    "network",
    "flow",
    "servername",
    "sni",
    "client-fingerprint",
    "skip-cert-verify",
    "reality-opts",
    "obfs",
    "obfs-password",
  ];
  for (const key of allowed) {
    if (key === "servername" && serverName) {
      output.servername = serverName;
      continue;
    }
    if (key === "sni" && node.type === "vless" && serverName) continue;
    if (node[key] !== undefined && node[key] !== null && node[key] !== "") output[key] = node[key];
  }
  return output;
}

function isPlainYamlScalar(value) {
  if (!value) return false;
  if (/^(true|false|null|~)$/i.test(value)) return false;
  if (/^[+-]?(\d+|\d+\.\d+)$/.test(value)) return false;
  if (/[:#,[\]{}&*!|>'"%@`]/.test(value)) return false;
  if (/^\s|\s$/.test(value)) return false;
  return /^[\p{L}\p{N}_.\-\/]+(?: [\p{L}\p{N}_.\-\/]+)*$/u.test(value);
}

function yamlFlowValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => yamlFlowValue(item)).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== "")
      .map(([key, item]) => `${key}: ${yamlFlowValue(item)}`)
      .join(", ")}}`;
  }
  const text = String(value);
  if (isPlainYamlScalar(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function renderYamlFlowMap(value) {
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .map(([key, item]) => `${key}: ${yamlFlowValue(item)}`)
    .join(", ")}}`;
}

export function renderProxiesOnly(nodes, warning) {
  const lines = [];
  if (warning) lines.push(`# Warning: upstream fetch failed, served stale cache. ${warning}`);
  lines.push("proxies:");
  for (const node of nodes) {
    lines.push(`  - ${renderYamlFlowMap(toMihomoNode(node))}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderFullConfig(nodes, warning) {
  const proxyNames = nodes.map((node) => node.name);
  const lines = [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "",
    renderProxiesOnly(nodes, warning).trimEnd(),
    "",
    "proxy-groups:",
    "  - name: PROXY",
    "    type: select",
    "    proxies:",
    "      - AUTO",
    "      - DIRECT",
    ...proxyNames.map((name) => `      - ${JSON.stringify(name)}`),
    "  - name: AUTO",
    "    type: url-test",
    "    url: https://www.gstatic.com/generate_204",
    "    interval: 300",
    "    proxies:",
    ...proxyNames.map((name) => `      - ${JSON.stringify(name)}`),
    "",
    "rules:",
    "  - GEOIP,CN,DIRECT",
    "  - MATCH,PROXY",
  ];
  return `${lines.join("\n")}\n`;
}

async function convertSubscription({ url, options = {} }) {
  const outputMode = options.outputMode === "full" ? "full" : "proxies";
  const cacheKey = hash(JSON.stringify({ url, options: { ...options, outputMode } }));
  const cached = cacheGet(outputCache, cacheKey, true);
  if (cached && !cached.stale) return { yaml: cached.value, cached: true, stale: false };

  const upstream = await fetchUpstream(url);
  const parsed = parseSubscription(upstream.body);
  const nodes = applyOptions(parsed, options);
  if (!nodes.length) throw new Error("没有识别到可转换的节点");
  const yaml = outputMode === "full" ? renderFullConfig(nodes, upstream.warning) : renderProxiesOnly(nodes, upstream.warning);
  cacheSet(outputCache, cacheKey, yaml, OUTPUT_TTL_MS, STALE_TTL_MS);
  return {
    yaml,
    count: nodes.length,
    cached: false,
    stale: upstream.stale,
    warning: upstream.warning,
  };
}

async function convertSubscriptionWithRelays({ url, options = {} }) {
  const outputMode = options.outputMode === "full" ? "full" : "proxies";
  const cacheKey = hash(JSON.stringify({ url, relays: getRelayUrls(), options: { ...options, outputMode } }));
  const cached = cacheGet(outputCache, cacheKey, true);
  if (cached && !cached.stale) return { yaml: cached.value, cached: true, stale: false };

  const result = await fetchAndParseWithFallback(url, options);
  const yaml = outputMode === "full" ? renderFullConfig(result.nodes, result.warning) : renderProxiesOnly(result.nodes, result.warning);
  cacheSet(outputCache, cacheKey, yaml, OUTPUT_TTL_MS, STALE_TTL_MS);
  return {
    yaml,
    count: result.nodes.length,
    cached: false,
    stale: result.stale,
    warning: result.warning,
    source: result.source,
  };
}

function base64Utf8(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

async function shortenUrl(longUrl) {
  let parsed;
  try {
    parsed = new URL(longUrl);
  } catch {
    throw new Error("待缩短的订阅链接不是有效 URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("短链接只支持 http/https 地址");
  }

  const form = new FormData();
  form.append("longUrl", base64Utf8(longUrl));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(SHORTENER_ENDPOINT, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`短链服务返回 HTTP ${response.status}`);
    const data = await response.json();
    if (data?.Code !== 1 || !data?.ShortUrl) {
      throw new Error(data?.Message || "短链服务没有返回有效短链接");
    }
    return data.ShortUrl;
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "public, max-age=300",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

export const server = http.createServer(async (req, res) => {
  try {
    if (!checkRateLimit(req)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });
    const requestUrl = new URL(req.url || "/", PUBLIC_BASE_URL);

    if (req.method === "POST" && requestUrl.pathname === "/api/convert") {
      const body = await readRequestJson(req);
      if (!body.url || typeof body.url !== "string") return json(res, 400, { error: "请提供订阅链接" });
      const options = {
        outputMode: body.outputMode === "full" ? "full" : "proxies",
        infoNodes: body.infoNodes === "remove" ? "remove" : "keep",
        keyword: body.keyword || "",
      };
      const result = await convertSubscriptionWithRelays({ url: body.url, options });
      const token = encryptToken({ url: body.url, options, createdAt: now() });
      return json(res, 200, {
        ...result,
        subscribeUrl: `${PUBLIC_BASE_URL}/sub/${token}`,
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/shorten") {
      const body = await readRequestJson(req);
      if (!body.url || typeof body.url !== "string") return json(res, 400, { error: "请提供要缩短的订阅链接" });
      const shortUrl = await shortenUrl(body.url);
      return json(res, 200, { shortUrl });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/relay-fetch") {
      if (!RELAY_SECRET) return json(res, 403, { error: "Relay is disabled" });
      if (req.headers.authorization !== `Bearer ${RELAY_SECRET}`) return json(res, 401, { error: "Unauthorized relay request" });
      const body = await readRequestJson(req);
      if (!body.url || typeof body.url !== "string") return json(res, 400, { error: "Missing upstream url" });
      const result = await fetchRelayBody(body.url);
      return json(res, 200, result);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/register-relay") {
      if (!RELAY_SECRET) return json(res, 403, { error: "Relay registration is disabled" });
      if (req.headers.authorization !== `Bearer ${RELAY_SECRET}`) return json(res, 401, { error: "Unauthorized relay registration" });
      const body = await readRequestJson(req);
      if (!body.url || typeof body.url !== "string") return json(res, 400, { error: "Missing relay url" });
      const relay = await registerRelay(body.url);
      return json(res, 200, { relay, count: getRelayUrls().length });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/unregister-relay") {
      if (!RELAY_SECRET) return json(res, 403, { error: "Relay unregister is disabled" });
      if (req.headers.authorization !== `Bearer ${RELAY_SECRET}`) return json(res, 401, { error: "Unauthorized relay unregister" });
      const body = await readRequestJson(req);
      if (!body.url || typeof body.url !== "string") return json(res, 400, { error: "Missing relay url" });
      const result = await unregisterRelay(body.url);
      return json(res, 200, result);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/relays") {
      if (!RELAY_SECRET) return json(res, 403, { error: "Relay list is disabled" });
      if (req.headers.authorization !== `Bearer ${RELAY_SECRET}`) return json(res, 401, { error: "Unauthorized relay list request" });
      return json(res, 200, { relays: getRelayUrls() });
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/sub/")) {
      const token = requestUrl.pathname.slice("/sub/".length);
      const payload = decryptToken(token);
      const result = await convertSubscriptionWithRelays(payload);
      return text(res, 200, result.yaml, {
        "subscription-userinfo": "upload=0; download=0; total=0; expire=0",
      });
    }

    if (req.method === "GET") return serveStatic(req, res, requestUrl.pathname);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    if (req.url?.startsWith("/sub/")) return text(res, 502, `# Convert failed: ${message}\nproxies: []\n`);
    json(res, 400, { error: message });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await loadRegisteredRelays();
  server.listen(PORT, HOST, () => {
    console.log(`Airport subscription converter listening at ${PUBLIC_BASE_URL}`);
  });
}
