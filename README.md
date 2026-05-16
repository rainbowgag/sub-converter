# 机场订阅转换网站

一个零依赖 Node.js MVP：输入机场订阅链接，自动识别常见订阅格式，输出 Mihomo / Clash Meta 可用的 `proxies:` YAML 或完整配置。

## 功能

- 支持 Clash YAML、Base64 URI 列表、纯文本 URI 列表、部分 sing-box JSON。
- 支持 `ss`、`vmess`、`vless`、`trojan`、`hysteria`、`hysteria2`、`tuic`、`anytls` 的基础字段转换。
- 使用内存短缓存，减少上游机场请求压力。
- 生成加密订阅链接 `/sub/{token}`，不把原始订阅 URL 明文放在链接路径里。
- 内置 SSRF 防护、响应体大小限制、请求超时、简单限流。

## 运行

```bash
npm run dev
```

如果 PowerShell 禁止 `npm.ps1`，可以运行：

```powershell
npm.cmd run dev
```

打开：

```text
http://127.0.0.1:3000
```

## VPS 一键部署

Debian / Ubuntu 服务器可以直接运行：

```bash
sudo bash scripts/deploy-ubuntu.sh
```

脚本会自动检查并安装 Node.js 20，创建 systemd 服务，最后用：

```text
http://服务器IP:3000
```

访问。更多说明见 [DEPLOY.md](DEPLOY.md)。

支持多 VPS 中继拉取。主站可配置 `FETCH_RELAYS`，当当前 VPS 被机场风控、拉不到节点时，自动切换到其他 VPS 代拉。配置方法见 [DEPLOY.md](DEPLOY.md)。

## 生产建议

- 设置 `SUB_TOKEN_SECRET`，不要使用默认开发密钥。
- 用 Redis 替换内存缓存，保留 5-10 分钟 TTL。
- 反向代理层增加 HTTPS、请求速率限制和访问日志脱敏。
- 不要记录原始订阅 URL、节点密码、UUID。
