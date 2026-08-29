# pi-openai-codex-usage

[English](./README.md) | 简体中文

> **非官方扩展。** 与 OpenAI 无任何关联。数据来自官方 Codex 客户端使用的同一个 ChatGPT 用量接口（`/backend-api/wham/usage`）。该接口不是公开文档化的 API，随时可能变化，本扩展也可能随时失效。

在 [pi coding agent](https://github.com/earendil-works/pi-mono) 的 footer 中展示 ChatGPT Codex 订阅用量，并提供完整的 `/codex-usage` 报告。

```
codex 5h ████████░ 43% · 7d █████████░ 12% ↻5h 12m
```

## 功能

使用 `openai-codex` 模型时，footer 显示**活跃配额桶**（服务端对当前模型计量的那个桶，例如 `codex` 或 `spark`），每个窗口一根 8 格进度条（最多两根）、**剩余百分比**和最近一次重置倒计时。数据陈旧会打标记。多桶套餐、只有周窗口的套餐、额度余额（Credits）、获得的复位信用（含消耗操作）、套餐类型与消费控制，都在 `/codex-usage` 报告里。

## 安装

```bash
pi install npm:pi-openai-codex-usage
```

或从 git 安装：

```bash
pi install git:github.com/frederick-wang/pi-openai-codex-usage
```

需要在 Pi 中 `/login` 登录 OpenAI Codex（ChatGPT Plus/Pro 订阅 OAuth）。扩展绝不会读取 Codex CLI 自己的认证文件。

## 命令

- `/codex-usage` — 完整报告（全部桶、额度余额、复位信用、套餐、消费控制、数据新鲜度）。
- `/codex-usage --json` — 稳定的机器可读快照（键名固定英文）。TUI 模式在 overlay 中展示；`print` 模式输出到 stdout；其他模式拒绝执行。
- `/codex-usage --refresh` — 跳过限流立即抓取。

复位信用可以在报告中消耗：流程会先校验账户身份，再针对选项的标题/描述/过期时间请求确认，最后解释结果（这是本扩展唯一会改变服务端状态的操作）。

## 认证与隐私

- 凭据来自 Pi 自身的 `openai-codex` 认证；扩展从不刷新或写入凭据，从不读取 `~/.codex/auth.json`。
- 账户 id 只存在于内存中（用于账户切换检测），绝不写入日志、持久化或导出。
- 持久化到 `~/.pi/agent/pi-openai-codex-usage-snapshots.jsonl` 的快照不含 token、原始响应头、账户 id。
- 无遥测；除用量接口外无任何网络请求。

## 配置

- `PI_OPENAI_CODEX_USAGE_LANG=zh|en` — 界面语言（默认：跟随系统语言，再英文）。

## 说明

- 窗口标签由服务端返回的时长动态生成（`5h`、`7d`……），可能变化，绝不写死。
- 数据在激活时、每次回合结束后、温和的心跳中以及执行命令时抓取——不是固定高频轮询。
- 服务端没有返回的窗口一律显示 `n/a`，绝不显示假的 0%。
