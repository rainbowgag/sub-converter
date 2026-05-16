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

## 重要说明

`SUB_TOKEN_SECRET` 保存在：

```text
/etc/sub-converter.env
```

不要随便修改它。修改后，已经生成的 `/sub/...` 订阅链接会失效。
