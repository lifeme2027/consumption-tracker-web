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
      "MaxRecordsPerUser": 50000
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
- 所有设置也可用环境变量覆盖（双下划线分隔，如 `Life__Auth__SessionHours=8`）。

## 域名 / HTTPS / Cookie

- 站点只开 HTTPS（`*.kastop.com` 证书）；建议在 IIS 里把 HTTP 301 重定向到 HTTPS（URL Rewrite 或 HTTP 重定向功能）。
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

## 运维提示

- 日志：默认只记 Warning 以上，且**不含记录内容**。排错需要标准输出日志时可临时把 `web.config` 里 `stdoutLogEnabled` 改为 `true` 并创建 `logs` 目录，排完请改回 `false`。
- 数据导出：用户可自行在“数据”页导出；服务器侧备份请定期复制 `App_Data`。
- 数据库文件包含用户明文记录，请限制服务器上对 `App_Data` 的访问，并定期备份到受控位置。
