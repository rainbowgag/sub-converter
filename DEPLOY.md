# Debian / Ubuntu 一键部署

适用于 Debian 11/12、Ubuntu 20.04/22.04/24.04。

## 方式一：IP + 端口访问

进入项目目录后执行：

```bash
sudo bash scripts/deploy-ubuntu.sh
```

脚本会自动：

- 检查并安装 Node.js 20
- 安装项目依赖
- 自动生成 `SUB_TOKEN_SECRET`
- 自动识别服务器公网 IP
- 写入 systemd 服务
- 打开 UFW 的 `3000/tcp` 端口，如果 UFW 已启用
- 启动服务

完成后访问：

```text
http://你的服务器IP:3000
```

## 指定端口

```bash
sudo PORT=8080 bash scripts/deploy-ubuntu.sh
```

访问：

```text
http://你的服务器IP:8080
```

## 指定公网访问地址

如果你以后绑定域名或使用反向代理：

```bash
sudo PUBLIC_BASE_URL=https://sub.example.com bash scripts/deploy-ubuntu.sh
```

## 管理服务

```bash
systemctl status sub-converter
journalctl -u sub-converter -f
systemctl restart sub-converter
systemctl stop sub-converter
```

## 多 VPS 自动切换拉取

所有 VPS 都部署同一个项目。能成功拉机场订阅的 VPS 作为“中继”，主转换站配置中继列表。

### 1. 生成一个共享中继密钥

在任意机器执行：

```bash
openssl rand -hex 32
```

假设得到：

```text
abc123...
```

下面所有主站和中继站都使用同一个 `RELAY_SECRET`。

### 2. 在中继 VPS 上部署

```bash
git clone https://github.com/rainbowgag/sub-converter.git
cd sub-converter
sudo RELAY_SECRET='abc123...' PORT=3000 bash scripts/deploy-ubuntu.sh
```

中继需要能被主站访问，例如：

```text
http://中继VPS_IP:3000
```

### 3. 在主转换站配置中继列表

多个中继用英文逗号分隔：

```bash
sudo RELAY_SECRET='abc123...' \
  FETCH_RELAYS='http://美国VPS_IP:3000,http://日本VPS_IP:3000,http://德国VPS_IP:3000' \
  bash scripts/deploy-ubuntu.sh
```

主站转换逻辑：

```text
主站自己拉取
  -> 解析不到节点时请求第一个中继
  -> 失败再请求第二个中继
  -> 直到某个中继拉到可转换节点
```

### 4. 测试中继是否可用

在主站机器上执行：

```bash
curl -H "Authorization: Bearer abc123..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/sub"}' \
  http://中继VPS_IP:3000/api/relay-fetch
```

如果返回 JSON 且包含 `body` 字段，说明主站能调用这个中继。

## 重要说明

`SUB_TOKEN_SECRET` 保存在：

```text
/etc/sub-converter.env
```

不要随便修改它。修改后，已经生成的 `/sub/...` 订阅链接会失效。
