# mac-remote

用手机网页控制这台 Mac：打开 / 切换 / 隐藏 / 退出应用，以及控制中心里的 Wi-Fi、蓝牙、Clash Verge 系统代理、亮度、深色模式、夜览、台前调度、音量、输出设备和媒体键。

```
手机浏览器 ──HTTPS──▶ nginx(TLS) ──▶ relay (Node, 127.0.0.1:3030)                         [Azure]
                                          ▲ WSS 出站长连接（设备令牌）
                                          │
MacRemote.app（菜单栏，持有系统权限）──spawn──▶ agent (Node) ──execFile──▶ macctl(Swift) / 系统命令   [Mac]
```

- **Mac 不监听任何端口**：agent 主动连出去，校园网 / NAT 后面也能用。
- **白名单在 Mac 上执行**：所有能力都是 `shared/actions.js` 里的具名动作；relay 只转发，参数校验和风险判断（`agent/policy.js`）都在 agent 里。全系统没有执行任意命令的入口。
- **公网只暴露一个中性登录页**（密码 + TOTP）；控制界面的 HTML/JS 也必须登录后才下发，全站 `noindex`。

## 目录

| 路径 | 作用 |
|---|---|
| `shared/actions.js` | 动作目录 + 参数形状校验（三端共用） |
| `agent/` | Mac 端：注册表、策略、各项控制、状态快照、relay 客户端、审计 |
| `helper/macctl.swift` | 原生小助手：应用列表/图标/退出、CoreAudio 输出设备、媒体键、夜览、内建屏亮度 |
| `launcher/` | `MacRemote.app` 菜单栏壳：拉起 agent、显示连接状态、一键暂停、登录时启动 |
| `relay/` | Azure 端：登录（scrypt + TOTP + 会话）、转发、静态资源闸门；`deploy/` 里是 systemd 与 nginx 模板 |
| `web/public/` | 公开的中性登录页与 PWA 图标 |
| `web/app/` | 控制界面（仅登录后可访问） |
| `scripts/preview.js` | 本机 UI 预览：读取真实状态，所有修改仅模拟 |
| `scripts/smoke-relay.js` | 端到端冒烟测试（登录 → 状态 → 图标 → 一次无害动作） |

## 本机开发

```bash
npm run setup          # 安装 agent / relay 依赖并编译 bin/macctl
npm test               # 参数校验、TOTP、会话、限流、策略不变量、relay 安全边界
npm run preview        # http://127.0.0.1:3099/app/ （无需登录，改动仅模拟）
node agent/cli.js state.get                              # 直接调用单个动作
node agent/cli.js sound.volume.set '{"value":30}'
```

完整链路（本机 relay + agent）：

```bash
MAC_REMOTE_CONFIG=/tmp/agent-dev.json node agent/setup.js ws://127.0.0.1:3030/agent   # 打印 AGENT_TOKEN_SHA256
node relay/setup.js --env /tmp/relay-dev.env --agent-hash <上一步的哈希>               # 设置密码、生成 TOTP
node --env-file=/tmp/relay-dev.env relay/server.js
MAC_REMOTE_CONFIG=/tmp/agent-dev.json node agent/index.js
```

## 在 Mac 上常驻

```bash
node agent/setup.js wss://control.dkz12345.com/agent  # 生成设备令牌；把打印的 AGENT_TOKEN_SHA256 填进服务器的 relay/.env
bash launcher/build.sh                                 # 编译、签名、安装 ~/Applications/MacRemote.app
open ~/Applications/MacRemote.app
```

首次运行时按提示授权：**蓝牙**（开关蓝牙）、**自动化 → System Events**（深色模式）、**辅助功能**（媒体键，菜单里有入口）。菜单栏里可以勾选「登录时自动启动」，也可以随时「暂停远程控制」。

## 部署：control.dkz12345.com

relay 部署在 `leo@20.48.14.96:/opt/apps/mac-remote-relay`：systemd 服务 `mac-remote-relay`（只监听 127.0.0.1:3030），nginx 站点 `control.dkz12345.com`（模板见 `relay/deploy/`），Let's Encrypt 证书由 certbot 续期。

更新代码：

```bash
rsync -az --delete --exclude node_modules --exclude data --exclude .env -e "ssh -i <私钥>" relay web shared leo@20.48.14.96:/opt/apps/mac-remote-relay/
ssh -i <私钥> leo@20.48.14.96 'cd /opt/apps/mac-remote-relay/relay && npm ci --omit=dev && sudo systemctl restart mac-remote-relay'
```

登录密码和 TOTP 只在服务器上生成，设置或更换都用这一条（需要交互终端，TOTP 设置密钥加进手机验证器，iOS「密码」App 即可）：

```bash
ssh -t -i <私钥> leo@20.48.14.96 'cd /opt/apps/mac-remote-relay/relay && node setup.js --env .env && sudo systemctl restart mac-remote-relay'
```

Mac 重新配对（`node agent/setup.js wss://control.dkz12345.com/agent --force`）后，要把新打印的 `AGENT_TOKEN_SHA256` 同步到服务器的 `relay/.env`。

## 风险策略

`agent/policy.js` 是唯一决定「能不能做」的地方（Leo 定的规则）：

- Wi-Fi 只能远程打开，**不能远程关闭**（关掉就失联了）。
- **MacRemote 自己和 Clash Verge 不能被远程退出**。
- 强制退出要在手机上**确认**。Clash Verge 系统代理的开关直接执行：agent 直连中继、不走系统代理，开关它不会让手机失联；开启前会先检查 Clash 是否在监听，免得 Mac 上的应用断网。
- **没有关机、重启、睡眠**：动作目录里根本没有这类动作；`test/power.test.js` 会扫描动作目录和 agent 源码，一旦有人加进来就报错。

对应测试：`test/policy.test.js`、`test/power.test.js`。

## 已知限制

- 合盖的 MacBook 断电或拔掉外接屏会睡眠，届时无法远程访问。
- 外接显示器的 DDC 很不稳定（连着读几乎都失败，间隔 400 毫秒约一半成功，偶尔还会收到上一条指令的回复）：所有 m1ddc 调用排队、每条之间停 400 毫秒，同一个读数出现两次才采用，刚写入的值优先于读数。MonitorControl 同时调节时滑块可能不同步。
- 夜览与内建屏亮度依赖私有框架，系统更新后若失效会自动隐藏对应控件。
- 媒体键只能控制播放，不显示曲目信息（macOS 15.4 起限制了 MediaRemote）。
