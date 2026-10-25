# 部署说明（Windows IIS，`life.kastop.com`，目录 `D:\Web\life`）

发布包：`life-publish.zip`（`dotnet publish -c Release -r win-x64 --self-contained false`，框架依赖、in-process 托管）。

## 前置条件（已就绪项请核对）

| 项 | 要求 |
|---|---|
| 运行时 | .NET 8 Hosting Bundle（8.0.x，已装；安装后需 `iisreset` 或重启 W3SVC） |
| 站点 | IIS 站点 `life`，物理路径 `D:\Web\life`，绑定 `life.kastop.com`（HTTPS，使用 `*.kastop.com` 证书） |
| 应用程序池 | 与站点同名 `life`，**.NET CLR 版本：无托管代码**，管道模式集成 |
| DNS | `life.kastop.com` 已解析到服务器 |

## 首次部署

1. 解压 `life-publish.zip`，把**全部内容**复制到 `D:\Web\life`（`web.config` 与 `ConsumptionTrackerWeb.exe` 在目录根）。
2. **App_Data 写权限**（SQLite 数据库所在目录，必须可写）：应用池标识是 `IIS AppPool\life`（站点和应用池同名），给它修改权限；也可以给 `IIS_IUSRS`：
   ```bat
   icacls D:\Web\life\App_Data /grant "IIS AppPool\life":(OI)(CI)M
   icacls D:\Web\life\App_Data /grant "IIS_IUSRS":(OI)(CI)M
   ```
   整个站点目录给应用池 **读取和执行**（`(OI)(CI)RX`）；不要给站点根目录写权限，只给 `App_Data`。
   > 用的是 ApplicationPoolIdentity 且应用池名不是 `life` 时，把上面的 `life` 换成实际应用池名。
3. 创建 `D:\Web\life\appsettings.Production.json`（见下，**不在发布包内**，也不入库）。
4. 重启站点 / 回收应用池，访问 `https://life.kastop.com/healthz` 应返回 `ok`，再访问首页。

## 生产配置（`appsettings.Production.json`）

IIS 下默认环境为 `Production`（不要设置 `ASPNETCORE_ENVIRONMENT=Development`）。示例：

```json
{
  "AllowedHosts": "life.kastop.com",
  "Life": {
    "Kaspa": { "Network": "mainnet" },
    "Auth": {
      "Domain": "life.kastop.com",
      "ChallengeSeconds": 300,
      "SessionHours": 12,
      "DevLogin": false
    },
    "Storage": {
      "DataDir": "App_Data",
      "DatabaseFile": "life.db",
      "MaxRecordsPerUser": 50000,
      "CheckpointMinutes": 60,
      "VacuumHours": 24
    },
    "Cookie": { "Name": "ct_session", "RequireSecure": true },
    "Limits": { "ChallengePerMinute": 10, "VerifyPerMinute": 20, "ApiPerMinute": 300 }
  }
}
```

说明：

- `Auth:Domain`：写入待签名消息，用户签名时可见，必须等于线上域名 `life.kastop.com`。
- `DevLogin`：保持 `false`。即使设为 `true`，非 `Development` 环境也不会注册该路由。
- `Storage:DataDir`：相对路径相对于站点目录；也可改成绝对路径（如 `D:\WebData\life`），并给该目录同样的写权限——这样升级时更不容易误删。
- `Storage:CheckpointMinutes`（默认 60）：每隔多少分钟把 SQLite 预写日志（WAL）并回主库并截断；`Storage:VacuumHours`（默认 24）：每隔多少小时对库做一次 VACUUM。上次 VACUUM 的时间记在 `App_Data\life.db.vacuumed` 标记文件的修改时间里，所以 IIS 回收 / 重启不会让它从头计时——**不要删这个文件**。设为 0 会关闭对应维护，**不建议**（隐私页写明了这两项）。数据库连接始终开启 `secure_delete`（被删内容擦零）。
- 所有设置也可用环境变量覆盖（双下划线分隔，如 `Life__Auth__SessionHours=8`）。

## 域名 / HTTPS / Cookie

- 站点主要走 HTTPS（`*.kastop.com` 证书）。**需要给 :80 做 301 → HTTPS**（`web.config` 里没有这条规则，要在 IIS 的 :80 绑定上配置，或用 URL Rewrite）。URL Rewrite 示例（加进站点 `web.config` 的 `<system.webServer>` 内；需已安装 URL Rewrite 模块）：
  ```xml
  <rewrite>
    <rules>
      <rule name="HTTP to HTTPS" stopProcessing="true">
        <match url="(.*)" />
        <conditions><add input="{HTTPS}" pattern="off" ignoreCase="true" /></conditions>
        <action type="Redirect" url="https://life.kastop.com/{R:1}" redirectType="Permanent" />
      </rule>
    </rules>
  </rewrite>
  ```
  配好后用 `curl -I http://life.kastop.com/` 验证返回 301 且 `Location` 为 https。HSTS（`max-age=31536000`）只对已经访问过 HTTPS 的浏览器生效，首次访问仍依赖这个跳转。
- **证书续期**：当前 `*.kastop.com` 证书（Let's Encrypt）**2026-11-29 11:28 UTC（北京时间 19:28）到期**。请确认 win-acme（或所用工具）的自动续期计划任务正常，并在到期前确认新证书已绑定到站点 :443（`Get-ChildItem Cert:\LocalMachine\My` 看到期时间，或浏览器查看证书）。服务端目前仅 TLS 1.2（Windows Server 2019 及更早的 Schannel 不支持 1.3），属已知。
- **AllowedHosts**：仓库默认是 `*`；生产的 `appsettings.Production.json` 必须设为 `"life.kastop.com"`（上面示例已写），上线后用 `curl -H "Host: evil.example" https://<本机IP>/healthz -k` 应返回 400。
- 会话 Cookie：`HttpOnly; SameSite=Strict; Secure`，不设置 `Domain`（仅 `life.kastop.com` 主机本身使用）。`Cookie:RequireSecure` 在生产必须为 `true`（默认即为 `true`）；若误用 HTTP 访问将无法登录。
- 相机扫码需要 HTTPS，已满足。
- 若前面有反向代理 / CDN：需要保证 `Host` 头为 `life.kastop.com`，并让应用看到真实客户端 IP（否则限流会把所有人当成同一个 IP）。直连 IIS 则无需处理。
- `web.config` 已移除 `Server` / `X-Powered-By` 响应头，并限制请求体 6 MB。

## 升级（保留数据与配置）

升级包**不含** `App_Data` 与 `appsettings.Production.json`，但仍请按下面做：

1. **先备份**：复制 `D:\Web\life\App_Data`（至少 `life.db`、`life.db-wal`、`life.db-shm`）和 `appsettings.Production.json` 到 `D:\Backup\life\<日期>\`。建议停止站点后再复制，保证 WAL 已落盘。
2. 停止站点（或在站点根放 `app_offline.htm`）。
3. 解压新包，**覆盖**到 `D:\Web\life`。**不要整目录删除再复制；不要覆盖或删除 `App_Data` 和 `appsettings.Production.json`。**
   也可以用 robocopy 只镜像程序文件：
   ```bat
   robocopy C:\temp\life-new D:\Web\life /E /XD App_Data logs /XF appsettings.Production.json
   ```
   （不要加 `/MIR` 或 `/PURGE`，否则会删掉目标目录里“源里没有”的 `App_Data` 与生产配置。）
4. 启动站点，检查 `/healthz` 与登录；若有数据库结构升级，由程序启动时自动完成。

## 回滚

1. 停止站点。
2. 把上一版程序文件放回 `D:\Web\life`（升级前请保留上一版 zip 或程序目录副本，如 `D:\Backup\life\<日期>\app`）。
3. 若新版本对数据库做过结构升级且旧版不能读：用升级前备份的 `App_Data` 覆盖回去（会丢失升级后新增的数据；故升级前备份很重要）。
4. 启动站点并验证。

## 数据保留与清理（隐私页对外承诺的期限，请务必执行）

隐私页（`privacy.html` / `privacy-en.html`）向用户承诺：**服务器上的明文备份最长保留 30 天，IIS 访问日志最长保留 30 天**。这两项不是程序自动做的，由管理员的计划任务保证。

要点：

- 用户在云端点“一键删除”时，程序会擦零（`secure_delete`）、立即截断 WAL、并每 24 小时 VACUUM；但**已经存在的备份副本不会被程序删除**——所以备份必须有保留期，且保留期内旧备份里仍有“已删除”的数据（隐私页已如实告知）。
- 备份目录请按日期命名（如 `D:\Backup\life\2026-10-25`，升级步骤里已是这个格式），清理脚本按目录名里的日期判断。
- **第一次上线本版本时，请先手工处理已经存在的旧备份**：目录里可能有超过 30 天的备份，不会自动消失。先 `-WhatIf` 试跑，确认后再正式运行。
- 备份和日志都要放在受控位置并限制访问权限（备份是明文）。

清理脚本：仓库 `scripts/ops/cleanup-life.ps1`（**不在发布包内**，单独复制到服务器，如 `D:\Web\life-ops\cleanup-life.ps1`；不要放进站点目录 `D:\Web\life`）。它做三件事：删除早于 30 天的备份目录、删除早于 30 天的 IIS 日志（`*.log`）、删除早于 30 天的应用 stdout 日志。**不会碰 `App_Data` 和 `appsettings.Production.json`。**

```powershell
# 1) 先试跑，只列出将被删除的内容
powershell -ExecutionPolicy Bypass -File D:\Web\life-ops\cleanup-life.ps1 -WhatIf
# 2) 如果 IIS 日志不在默认目录，指定实际目录（IIS 管理器 → 站点 → 日志 → 目录，注意是 W3SVC<站点ID> 的上一级）
powershell -ExecutionPolicy Bypass -File D:\Web\life-ops\cleanup-life.ps1 -IisLogDir 'D:\Logs\IIS' -WhatIf
```

计划任务示例（每天 03:30，以 SYSTEM 运行；在管理员 PowerShell 里执行一次）：

```powershell
$act = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File D:\Web\life-ops\cleanup-life.ps1 -Days 30'
$trg = New-ScheduledTaskTrigger -Daily -At 3:30am
Register-ScheduledTask -TaskName 'life-retention-cleanup' -Action $act -Trigger $trg `
  -User 'SYSTEM' -RunLevel Highest -Description 'life.kastop.com: 备份与 IIS 日志保留 30 天'
```

建议再加一个备份计划任务（每天一次，停站点后复制或使用 SQLite 在线备份均可），备份目录名用 `yyyy-MM-dd`。每月核对一次：备份目录里最老的目录不超过 30 天、IIS 日志目录里最老的文件不超过 30 天（`Get-ChildItem D:\Backup\life | Sort-Object Name | Select-Object -First 1`）。

IIS 日志说明：IIS 默认在 `C:\inetpub\logs\LogFiles\W3SVC<站点ID>\` 写访问日志，内容含时间、客户端 IP、请求路径、状态码、User-Agent。应用把记录内容放在请求体里（搜索也是 POST），**日志里没有记录内容**，但有 IP 与访问时间，属个人数据，所以隐私页也写明了。如需缩短，可在 IIS 日志设置里改“滚动”周期，或把 `-Days` 改小；**不要**调到比隐私页承诺的 30 天更长。

## 运维提示

- 日志：默认只记 Warning 以上，且**不含记录内容**。排错需要标准输出日志时可临时把 `web.config` 里 `stdoutLogEnabled` 改为 `true` 并创建 `logs` 目录，排完请改回 `false`。
- 数据导出：用户可自行在“数据”页导出；服务器侧备份请定期复制 `App_Data`。
- 数据库文件包含用户明文记录（用药名称、用药人、剂量等属健康敏感信息），请限制服务器上对 `App_Data` 与备份目录的访问，建议启用磁盘加密（BitLocker），并定期备份到受控位置；备份保留期见上节“数据保留与清理”（最长 30 天）。
