# sub-converter

机场订阅转换网站。支持把机场订阅转换成 Mihomo / Clash Meta 可用配置，并支持多个 VPS 中继自动拉取。

## 1. 主站 VPS 安装基础工具

Debian / Ubuntu 执行：

```bash
apt-get update
apt-get install -y git curl ca-certificates
```

## 2. 主站 VPS 一键部署

```bash
git clone https://github.com/rainbowgag/sub-converter.git
cd sub-converter
sudo PORT=3000 bash scripts/deploy-ubuntu.sh
```

部署完成后访问：

```text
http://主站VPS_IP:3000
```

## 3. 生成中继密钥

在主站或任意一台 VPS 执行一次：

```bash
openssl rand -hex 32
```

复制输出的长字符串。主站和所有中继 VPS 都要使用同一个 `RELAY_SECRET`。

## 4. 中继 VPS 安装基础工具

每台中继 VPS 都先执行：

```bash
apt-get update
apt-get install -y git curl ca-certificates
```

## 5. 中继 VPS 一键部署并自动注册到主站

把 `你的中继密钥` 换成第 3 步生成的密钥，把 `主站VPS_IP` 换成主站 IP：

```bash
git clone https://github.com/rainbowgag/sub-converter.git
cd sub-converter
sudo RELAY_SECRET='你的中继密钥' \
MAIN_SERVER='http://主站VPS_IP:3000' \
PORT=3000 \
bash scripts/deploy-ubuntu.sh
```

如果已经部署过，只需要更新：

```bash
cd ~/sub-converter
git pull
sudo RELAY_SECRET='你的中继密钥' \
MAIN_SERVER='http://主站VPS_IP:3000' \
PORT=3000 \
bash scripts/deploy-ubuntu.sh
```

部署完成后，中继会自动注册到主站。以后新增中继 VPS，只需要在新中继上执行本步骤，不需要回主站改配置。

## 6. 查看主站已注册中继

在主站 VPS 执行：

```bash
curl -H "Authorization: Bearer 你的中继密钥" \
  http://127.0.0.1:3000/api/relays
```

正常会返回已注册的中继列表。

如果你仍然想手动写固定中继列表，也可以在主站使用 `FETCH_RELAYS`：

```bash
sudo RELAY_SECRET='你的中继密钥' \
FETCH_RELAYS='http://美国VPS_IP:3000,http://日本VPS_IP:3000' \
PORT=3000 \
bash scripts/deploy-ubuntu.sh
```

## 7. 用户访问主站

```text
http://主站VPS_IP:3000
```

主站会自动尝试：

```text
主站自己 -> 中继1 -> 中继2 -> 中继3
```

谁先成功拉到可转换节点，就使用谁。

## 8. 测试中继是否可用

在主站 VPS 执行：

```bash
curl -H "Authorization: Bearer 你的中继密钥" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' \
  http://中继VPS_IP:3000/api/relay-fetch
```

如果返回 JSON，并且里面有 `body` 字段，说明主站可以访问这个中继。

## 9. 删除不需要的中继

在主站 VPS 执行：

```bash
curl -X POST \
  -H "Authorization: Bearer 你的中继密钥" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://要删除的中继VPS_IP:3000"}' \
  http://127.0.0.1:3000/api/unregister-relay
```

然后查看列表确认：

```bash
curl -H "Authorization: Bearer 你的中继密钥" \
  http://127.0.0.1:3000/api/relays
```

如果要彻底停掉那台中继 VPS，登录中继 VPS 执行：

```bash
systemctl stop sub-converter
systemctl disable sub-converter
```

## 10. 更换短链网站

默认短链接口：

```text
https://d.flysub.org/short
```

如果要换短链网站，在主站 VPS 执行：

```bash
cd ~/sub-converter

sudo SHORTENER_ENDPOINT='https://你的短链域名/short' \
RELAY_SECRET='你的中继密钥' \
FETCH_RELAYS='http://美国VPS_IP:3000,http://日本VPS_IP:3000' \
PORT=3000 \
bash scripts/deploy-ubuntu.sh
```

短链接口需要兼容下面格式：

```text
POST /short
form-data: longUrl=base64(长链接)
```

返回格式：

```json
{
  "Code": 1,
  "ShortUrl": "https://短链/abc"
}
```

## 11. 常用命令

查看状态：

```bash
systemctl status sub-converter --no-pager
```

查看日志：

```bash
journalctl -u sub-converter -f
```

重启：

```bash
systemctl restart sub-converter
```

## 12. 注意

- 主站和中继的 `RELAY_SECRET` 必须一致。
- 中继自动注册需要主站的 `3000` 端口可被中继访问。
- 中继 VPS 的 `3000` 端口需要主站能访问。
- 如果云厂商有安全组，需要放行 TCP `3000`。
- 不要随便修改 `/etc/sub-converter.env` 里的 `SUB_TOKEN_SECRET`，否则旧的 `/sub/...` 订阅链接会失效。
