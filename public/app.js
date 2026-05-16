const urlInput = document.querySelector("#url");
const outputMode = document.querySelector("#outputMode");
const infoNodes = document.querySelector("#infoNodes");
const keyword = document.querySelector("#keyword");
const convert = document.querySelector("#convert");
const copySub = document.querySelector("#copySub");
const shortenSub = document.querySelector("#shortenSub");
const copyYaml = document.querySelector("#copyYaml");
const statusBox = document.querySelector("#status");
const preview = document.querySelector("#preview");
const meta = document.querySelector("#meta");

let latestYaml = "";
let latestSubUrl = "";
let latestShortUrl = "";

function setStatus(message, type = "idle") {
  statusBox.className = `status ${type}`;
  statusBox.textContent = message;
}

function fallbackCopy(value) {
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

async function copyText(value, label) {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      setStatus(`${label}已复制`, "ok");
      return true;
    }
  } catch {
    // Fall through to the legacy copy path.
  }

  if (fallbackCopy(value)) {
    setStatus(`${label}已复制`, "ok");
    return true;
  }

  setStatus(`${label}：${value}`, "warn");
  return false;
}

convert.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("请先输入原始订阅链接", "error");
    return;
  }

  convert.disabled = true;
  copySub.disabled = true;
  shortenSub.disabled = true;
  copyYaml.disabled = true;
  setStatus("正在拉取、识别并转换订阅...", "idle");

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        outputMode: outputMode.value,
        infoNodes: infoNodes.value,
        keyword: keyword.value.trim(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "转换失败");

    latestYaml = data.yaml;
    latestSubUrl = data.subscribeUrl;
    latestShortUrl = "";
    preview.textContent = latestYaml;
    meta.textContent = `${data.count || 0} 个节点 · ${data.cached ? "命中缓存" : "重新转换"}${data.source ? ` · 来源 ${data.source}` : ""}${data.stale ? " · 使用旧缓存兜底" : ""}`;
    copySub.disabled = false;
    shortenSub.disabled = false;
    copyYaml.disabled = false;
    setStatus(data.warning ? `转换完成，但上游异常：${data.warning}` : "转换完成", data.warning ? "warn" : "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "转换失败";
    setStatus(message, "error");
  } finally {
    convert.disabled = false;
  }
});

copySub.addEventListener("click", () => {
  if (latestShortUrl) copyText(latestShortUrl, "短链接");
  else if (latestSubUrl) copyText(latestSubUrl, "订阅链接");
});

shortenSub.addEventListener("click", async () => {
  if (!latestSubUrl) {
    setStatus("请先转换生成订阅链接", "error");
    return;
  }

  shortenSub.disabled = true;
  setStatus("正在生成短链接...", "idle");

  try {
    const response = await fetch("/api/shorten", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: latestSubUrl }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "短链接生成失败");

    latestShortUrl = data.shortUrl;
    const copied = await copyText(latestShortUrl, "短链接");
    if (!copied) setStatus(`短链接已生成，请手动复制：${latestShortUrl}`, "warn");
  } catch (error) {
    const message = error instanceof Error ? error.message : "短链接生成失败";
    setStatus(message, "error");
  } finally {
    shortenSub.disabled = false;
  }
});

copyYaml.addEventListener("click", () => {
  if (latestYaml) copyText(latestYaml, "YAML");
});
