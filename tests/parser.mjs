import assert from "node:assert/strict";
import fs from "node:fs";
import { parseSubscription, renderProxiesOnly } from "../server.js";

const clashYaml = `proxies:
  - {"name":"Traffic Reset: 29 Days Left","type":"anytls","server":"example.com","port":601,"password":"secret","udp":true,"client-fingerprint":"chrome","sni":"sni.example.com","skip-cert-verify":true}
  - name: HK-01
    type: trojan
    server: hk.example.com
    port: 443
    password: pass
    udp: true
    sni: hk.example.com
`;

const nodes = parseSubscription(clashYaml);
assert.equal(nodes.length, 2);
assert.equal(nodes[0].type, "anytls");
assert.equal(nodes[0]["client-fingerprint"], "chrome");
assert.equal(nodes[1].type, "trojan");

const anytlsUri = "anytls://secret@example.com:8443?udp=1&fp=chrome&sni=edge.example.com&insecure=1#AnyTLS%2001";
const uriNodes = parseSubscription(anytlsUri);
assert.equal(uriNodes.length, 1);
assert.equal(uriNodes[0].name, "AnyTLS 01");
assert.equal(uriNodes[0]["skip-cert-verify"], true);

const base64 = Buffer.from(anytlsUri).toString("base64");
assert.equal(parseSubscription(base64).length, 1);

const output = renderProxiesOnly(uriNodes);
assert.match(output, /^proxies:\n  - \{"name":"AnyTLS 01"/);
assert.match(output, /"type":"anytls"/);

const ssrdogPath = "E:/E/谷歌下载/SSRDOG";
if (fs.existsSync(ssrdogPath)) {
  const ssrdog = fs.readFileSync(ssrdogPath, "utf8");
  const ssrdogNodes = parseSubscription(ssrdog);
  assert.equal(ssrdogNodes.length, 39);
  assert.equal(ssrdogNodes[0].type, "anytls");
  assert.equal(ssrdogNodes[0].server, "asvf5ofzgyic23yn.redug8dqjjktoapmdfmqymrvi0iupi.com");
  assert.equal(ssrdogNodes[0]["skip-cert-verify"], true);
}

console.log("parser tests passed");
