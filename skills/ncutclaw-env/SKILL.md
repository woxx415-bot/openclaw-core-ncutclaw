---
name: ncutclaw-env
emoji: 🔧
description: OpenClaw skill 全链路环境诊断与安装工具。安装 CLI、包管理器、运行时环境时必须使用此 skill。遵循先检测后安装原则。
---

# Env Doctor — NCUTclaw 全链路环境诊断与安装

## 强制规范 [MANDATORY]

所有 CLI、工具、运行时、包管理器的安装操作**必须**遵循以下流程，不可跳过任何步骤：

### 步骤 1：检测平台与架构

```powershell
# Windows (PowerShell)
$OS = "Windows"
$ARCH = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$WinVer = [System.Environment]::OSVersion.Version
Write-Host "平台: $OS, 架构: $ARCH, Windows 版本: $($WinVer.Major).$($WinVer.Minor).$($WinVer.Build)"
```

### 步骤 2：全量环境快照

在安装任何东西之前，**先一次性探测系统已有的全部工具和版本**，避免重复安装。

```powershell
# Windows — 全量环境快照（先切 UTF-8 防乱码）
chcp 65001 >nul
Write-Host "=== 系统环境快照 ==="
Write-Host "--- 平台 ---"
$ver = [System.Environment]::OSVersion.Version
Write-Host "OS: Windows, Build: $($ver.Major).$($ver.Minor).$($ver.Build), Arch: $(if ([Environment]::Is64BitOperatingSystem) {'x64'} else {'x86'})"
Write-Host ""
Write-Host "--- Shell 环境 ---"
Write-Host "当前 Shell: $($PSVersionTable.PSVersion) (PowerShell)"
$policy = Get-ExecutionPolicy -Scope CurrentUser
Write-Host "执行策略 (CurrentUser): $policy"
Write-Host ""
Write-Host "--- 包管理器 ---"
foreach ($pm in @("scoop", "winget", "choco")) {
    $c = Get-Command $pm -ErrorAction SilentlyContinue
    if ($c) { Write-Host "$pm`: 已安装" } else { Write-Host "$pm`: 未安装" }
}
Write-Host ""
Write-Host "--- 基础运行时 ---"
foreach ($cmd in @("node", "npm", "python", "pip", "go", "uv", "curl.exe", "git")) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($c) {
        try { $v = & $cmd --version 2>&1 | Select-Object -First 1; Write-Host "$cmd`: $v" }
        catch { Write-Host "$cmd`: 已安装 (版本获取失败)" }
    } else { Write-Host "$cmd`: 未安装" }
}
Write-Host ""
Write-Host "--- CLI 工具 ---"
foreach ($cmd in @("gh", "jq", "rg", "ffmpeg", "whisper", "claude", "codex")) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($c) { Write-Host "$cmd`: 已安装" } else { Write-Host "$cmd`: 未安装" }
}
```

**已安装的工具直接跳过**，仅安装缺失的部分。

### 步骤 3：检测网络环境

安装工具前必须确认网络连通性。国内用户访问境外源（GitHub、npm）经常超时，**必须优先配置镜像**。

```powershell
# Windows — 网络检测
chcp 65001 >nul
Write-Host "=== 网络连通性检测 ==="
@("https://github.com", "https://raw.githubusercontent.com", "https://registry.npmjs.org", "https://pypi.org") | ForEach-Object {
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        Invoke-WebRequest -Uri $_ -TimeoutSec 3 -UseBasicParsing | Out-Null
        $sw.Stop()
        if ($sw.ElapsedMilliseconds -gt 2000) {
            "慢速 ($($sw.ElapsedMilliseconds)ms): $_ — 建议配置镜像"
        } else {
            "可达 ($($sw.ElapsedMilliseconds)ms): $_"
        }
    } catch { "不可达: $_ — 必须配置镜像" }
}
```

**判定规则**:
- 任一源**不可达** → 必须先配置镜像
- 任一源**响应超过 2 秒** → 强烈建议配置镜像
- 全部可达且速度正常 → 可直接安装

### 步骤 4：检测前置依赖链

安装任何工具前，沿依赖链**自底向上**检测，缺失的先补上：

```
第 0 层 网络环境   镜像源 / 代理（国内用户必须优先配置）
  ↓
第 1 层 包管理器   scoop(首选) / winget / choco
  ↓
第 2 层 基础运行时  node+npm / python+pip / go / uv
  ↓
第 3 层 目标 CLI   gh / ffmpeg / whisper / ...
  ↓
第 4 层 环境变量   OPENAI_API_KEY / GEMINI_API_KEY / ...
```

### 步骤 5：执行安装

根据当前平台执行安装。

### 步骤 6：安装后验证

```powershell
<工具名> --version  # 或等效验证命令
```

验证失败 → 排查错误并重试。验证成功 → 告知用户安装结果。

---

## Windows 包管理器决策树 [MANDATORY]

```
1. 检测已有包管理器（按优先级）：
   a. Get-Command scoop  → 存在？ → 使用 Scoop
   b. Get-Command winget → 存在？ → 使用 winget
   c. Get-Command choco  → 存在？ → 使用 Chocolatey
2. 全部不存在 → 安装 Scoop（首选，无需管理员权限）
3. Scoop 安装失败 → 降级方案：
   a. 尝试 Scoop 国内镜像
   b. 检测 winget (Windows 11 预装)
   c. 从官网下载 .msi 安装包
```

**原则：检测到什么就用什么，不要在已有包管理器的系统上安装新的。**

---

## 基础运行时安装参考

| 运行时 | Scoop | winget | 官网安装包 |
|--------|-------|--------|-----------|
| node+npm | `scoop install nodejs` | `winget install OpenJS.NodeJS.LTS` | https://nodejs.org/ 下载 .msi |
| python+pip | `scoop install python` | `winget install Python.Python.3.12` | https://www.python.org/ 下载 .exe |
| go | `scoop install go` | `winget install GoLang.Go` | https://go.dev/dl/ 下载 .msi |
| uv | `scoop install uv` | `winget install astral-sh.uv` | `irm https://astral.sh/uv/install.ps1 \| iex` |

## 包管理器安装参考

| 包管理器 | 检测 | 安装（国内镜像） | 安装（直连） |
|---------|------|----------------|------------|
| Scoop | `Get-Command scoop` | `irm https://gitee.com/glsnames/scoop-installer/raw/master/bin/install.ps1 \| iex` | `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser; irm get.scoop.sh \| iex` |
| winget | `Get-Command winget` | Windows 11 预装；Windows 10 从 Microsoft Store 安装 "App Installer" | 同左 |

## 跨平台工具名称差异

| 工具 | Windows 命令 | 说明 |
|------|-------------|------|
| Python | `python` | Windows 上 `python3` 通常不存在 |
| pip | `pip` | 与 Python 命令保持一致 |
| curl | `curl.exe` | PowerShell 中 `curl` 是 `Invoke-WebRequest` 的别名 |

## 注意事项

- 环境变量类依赖（API Key）无法通过命令安装，需引导用户到服务商网站注册获取
- **国内用户安装前务必先配置镜像源**
- Windows 上 `python` 和 `pip` 是标准命令名，不要使用 `python3`/`pip3`
