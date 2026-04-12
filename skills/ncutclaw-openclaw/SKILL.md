---
name: ncutclaw-openclaw
emoji: ⚙️
description: 本环境没有全局 openclaw CLI。所有 openclaw 命令必须通过本 skill 提供的脚本执行。OpenClaw 服务由 NCUTclaw Electron 守护进程管理。
---

# NCUTclaw OpenClaw CLI

## MANDATORY — 必读

**本环境没有全局安装 `openclaw` CLI。** 直接执行 `openclaw` 命令会失败。

所有需要调用 openclaw CLI 的操作（包括但不限于 `config`、`cron`、`skills`、`plugins`、`models`、`status` 等），
**必须且只能**通过本 skill 提供的 wrapper 脚本执行。不要尝试：

- ❌ `openclaw config get ...`（全局命令不存在）
- ❌ `npx openclaw ...`（环境变量不正确）
- ❌ 直接调用 `node openclaw.mjs ...`（缺少必要的环境变量和路径）

正确做法是使用本 skill 的脚本，它会自动设置所有必要的环境变量和路径。

OpenClaw 服务由 NCUTclaw Electron 守护进程管理（自动拉起、熔断保护），禁止通过 CLI 直接启停服务。

## 执行方式

本 skill 提供 Windows 脚本，位于 skill 目录的 `scripts/` 下。

### Windows

```cmd
<skill_dir>\scripts\openclaw-win.cmd <command> [args...]
```

> `<skill_dir>` 是本 SKILL.md 所在的目录路径。

## 允许的命令

### config — 配置管理

```cmd
REM 读取配置值
<skill_dir>\scripts\openclaw-win.cmd config get <dot.path>

REM 设置配置值
<skill_dir>\scripts\openclaw-win.cmd config set <dot.path> <value>

REM 删除配置值
<skill_dir>\scripts\openclaw-win.cmd config unset <dot.path>
```

示例:
```cmd
REM 查看当前网关端口
<skill_dir>\scripts\openclaw-win.cmd config get gateway.port

REM 设置默认模型
<skill_dir>\scripts\openclaw-win.cmd config set agents.defaults.model.primary "claude-opus-4-6"
```

> 配置生效规则：OpenClaw 的配置修改统一支持热加载，修改后自动在进程内生效。
> 严禁执行任何服务重启行为（包括但不限于 `gateway/daemon restart`、`kill PID`、`taskkill`）。

#### [MANDATORY] 修改前官方 Schema 校验规则

对所有会修改 `openclaw.json` 的操作，必须先完成官方文档校验：

1. **先查官方文档**：修改前必须先查询 OpenClaw 官方文档中对应配置项
2. **无法确认即拒绝**：若未找到对应官方文档，必须拒绝本次修改
3. **只允许写入官方定义字段**：禁止新增未定义字段
4. **先确认再落盘**：只有在确认变更符合官方 schema 后，才允许执行写入

#### [MANDATORY] 配置修改失败自动回滚规则

1. **先备份后修改**：执行修改前，先保存修改前快照
2. **失败即回滚**：如果修改失败，必须立即回滚
3. **只回滚本次变更**：不得覆盖更早的历史有效配置
4. **回滚后复核**：回滚完成后，重新读取确认已恢复

### cron — 定时任务

```cmd
<skill_dir>\scripts\openclaw-win.cmd cron list
<skill_dir>\scripts\openclaw-win.cmd cron add --trigger "<cron_expression>" --action "<prompt>"
<skill_dir>\scripts\openclaw-win.cmd cron edit <job_id> --trigger "<cron_expression>"
<skill_dir>\scripts\openclaw-win.cmd cron enable <job_id>
<skill_dir>\scripts\openclaw-win.cmd cron disable <job_id>
<skill_dir>\scripts\openclaw-win.cmd cron rm <job_id>
<skill_dir>\scripts\openclaw-win.cmd cron run <job_id>
<skill_dir>\scripts\openclaw-win.cmd cron runs
<skill_dir>\scripts\openclaw-win.cmd cron status
```

### models — 模型配置

```cmd
<skill_dir>\scripts\openclaw-win.cmd models list
<skill_dir>\scripts\openclaw-win.cmd models status
<skill_dir>\scripts\openclaw-win.cmd models set <model_id>
```

### skills — Skills 管理

```cmd
<skill_dir>\scripts\openclaw-win.cmd skills list
<skill_dir>\scripts\openclaw-win.cmd skills info <skill_name>
<skill_dir>\scripts\openclaw-win.cmd skills check
```

### plugins — 插件管理

```cmd
<skill_dir>\scripts\openclaw-win.cmd plugins list
<skill_dir>\scripts\openclaw-win.cmd plugins info <plugin_id>
<skill_dir>\scripts\openclaw-win.cmd plugins enable <plugin_id>
<skill_dir>\scripts\openclaw-win.cmd plugins disable <plugin_id>
```

### 其他允许的命令

```cmd
<skill_dir>\scripts\openclaw-win.cmd status
<skill_dir>\scripts\openclaw-win.cmd health
<skill_dir>\scripts\openclaw-win.cmd doctor
<skill_dir>\scripts\openclaw-win.cmd memory search <query>
<skill_dir>\scripts\openclaw-win.cmd sessions list
```

## 禁止的命令

以下命令**绝对禁止执行**，OpenClaw 服务生命周期由 NCUTclaw Electron 守护进程统一管理：

| 命令 | 原因 |
|------|------|
| `gateway run/start/stop/restart` | 服务由 Electron 管理 |
| `gateway install/uninstall` | 系统服务安装由 Electron 控制 |
| `daemon start/stop/restart` | 同上 |
| `reset` | 破坏性操作，会清除所有配置和状态 |
| `uninstall` | 破坏性操作 |

> **注意**: `gateway status` 是**允许的**（只读查询）。

## 故障排查

### PID 无效（进程不存在）

配置热加载过程中状态可能短暂更新。等待几秒后重新查询即可。

### 命令执行报 Gateway 连接失败

先检查健康状态：
```cmd
<skill_dir>\scripts\openclaw-win.cmd health
```
如果持续失败，执行 `doctor` 并收集日志，不要进行任何重启操作。
