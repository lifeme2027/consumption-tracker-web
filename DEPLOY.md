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
    "Limits": { "ChallengePerMinute": 10, "VerifyPerMinute": 20, "ApiPerMinute": 300, "CatalogPerMinute": 600 }
  }
}
```

说明：

- `Auth:Domain`：写入待签名消息，用户签名时可见，必须等于线上域名 `life.kastop.com`。
- `DevLogin`：保持 `false`。即使设为 `true`，非 `Development` 环境也不会注册该路由。
- `Storage:DataDir`：相对路径相对于站点目录；也可改成绝对路径（如 `D:\WebData\life`），并给该目录同样的写权限——这样升级时更不容易误删。
- `Storage:CheckpointMinutes`（默认 60）：每隔多少分钟把 SQLite 预写日志（WAL）并回主库并截断；`Storage:VacuumHours`（默认 24）：每隔多少小时对库做一次 VACUUM。上次 VACUUM 的时间记在 `App_Data\life.db.vacuumed` 标记文件的修改时间里，所以 IIS 回收 / 重启不会让它从头计时——**不要删这个文件**。设为 0 会关闭对应维护，**不建议**（隐私页写明了这两项）。数据库连接始终开启 `secure_delete`（被删内容擦零）。
- 所有设置也可用环境变量覆盖（双下划线分隔，如 `Life__Auth__SessionHours=8`）。

## 商品库（可选，条码查询）

扫码后先查商品库，没有再用本机历史记忆，最后手动填写。商品库是**只读**的 SQLite 文件 `catalog.db`，由桌面版仓库里的 CatalogConverter 从 xlsx 转出：

```
CatalogConverter 商品库.xlsx catalog.db
```

（源码与用法见桌面版仓库 `composehk/consumption-tracker-desktop` 的 `tools/CatalogConverter/` 和该仓库 README；转换在你自己的电脑上做，xlsx 不需要上传到服务器；Windows 单文件 exe 用该目录下的 `./publish.sh` 生成，Windows 示例：`CatalogConverter.exe "D:\Web\data\商品库240325.xlsx" "D:\Web\data\catalog.db" --verify`，已存在需加 `--overwrite`。）

1. 把转好的 `catalog.db` 放到 **`D:\Web\data\catalog.db`**。它在站点目录 `D:\Web\life` **之外**，所以升级（覆盖站点目录）不会影响它；要更新商品库，直接替换这个文件即可（每次查询都重新打开文件，不需要重启站点）。
2. 在 `D:\Web\life\appsettings.Production.json` 里加上（该文件不在发布包内，升级时用 `robocopy ... /XF appsettings.Production.json` 也不会被覆盖）：

```json
{
  "Life": {
    "Catalog": { "Path": "D:\\Web\\data\\catalog.db" }
  }
}
```

   也可用环境变量 `Life__Catalog__Path`。`Path` 留空（默认）= 不启用商品库，接口返回 `available:false`，页面自动回退到本机记忆。
3. **权限：给 IIS 应用程序池身份（`IIS AppPool\<池名>`）对 `catalog.db` 授予"读取"权限即可**（只读，不需要写权限，也不要给写权限；程序以 `Mode=ReadOnly` 打开，不会创建 `-wal`/`-journal` 文件）。
4. 接口：`POST /api/catalog/lookup`，请求体 `{"barcode":"..."}`。**必须是 POST**：条码在请求体里，不会出现在网址，所以 IIS 日志里没有条码。程序**不记录**条码（应用日志含 Debug 级别也不含，测试覆盖），也不写任何库。返回只含名称、分类、单位、规格、参考售价，**不含进价和产地**。不需要登录，也不使用 Cookie；有独立的限流（`Life:Limits:CatalogPerMinute`，默认 600 次/分钟/IP）。
5. 验证：`curl -X POST https://life.kastop.com/api/catalog/lookup -H "Content-Type: application/json" -H "X-Requested-With: life-web" -d "{\"barcode\":\"<条码>\"}"`（同源 Origin 检查通过的浏览器请求同理）。返回 `available:true` 表示库已就绪。
6. 隐私：用户可在页面「数据」页关闭「查询商品库」，关闭后页面不发送任何条码查询请求。隐私页已如实说明这一点。商品库内容属于私有数据：不要放进站点目录、发布包或代码仓库。

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

## 备份与日志（手动管理，不承诺自动清理）

隐私页（`privacy.html` / `privacy-en.html`）如实告知用户：**服务器上已存在的备份和 IIS 访问日志不会随“删除”自动清除，由管理员手动清理，不承诺自动清理，也不承诺具体的保留期限**。因此：

- 用户在云端点“一键删除”时，程序会擦零（`secure_delete`）、立即截断 WAL，并每 24 小时 VACUUM；但**已经存在的备份副本不会被程序删除**，旧备份里仍可能有用户已经删除的数据。
- 管理员可手动清理旧备份和日志（备份目录建议按日期命名，如 `D:\Backup\life\2026-10-25`，升级步骤里已是这个格式；IIS 日志默认在 `C:\inetpub\logs\LogFiles\W3SVC<站点ID>\`，含时间、客户端 IP、请求路径、状态码、User-Agent，不含记录内容）。
- 备份和日志请放在受控位置并限制访问权限（备份是明文），不要对外承诺超出上述内容的清理期限。

## 运维提示

- 日志：默认只记 Warning 以上，且**不含记录内容**。排错需要标准输出日志时可临时把 `web.config` 里 `stdoutLogEnabled` 改为 `true` 并创建 `logs` 目录，排完请改回 `false`。
- 数据导出：用户可自行在“数据”页导出；服务器侧备份请定期复制 `App_Data`。
- 数据库文件包含用户明文记录（用药名称、用药人、剂量等属健康敏感信息），请限制服务器上对 `App_Data` 与备份目录的访问，建议启用磁盘加密（BitLocker），并定期备份到受控位置；备份和日志由管理员手动清理（见上节“备份与日志”）。

## `/box`：ScaleBridge Web 版（静态子路径，随本站一起发布）

- 内容是 [composehk/scalebridge](https://github.com/composehk/scalebridge) 的 `web/`（纯静态：ES 模块、零运行时依赖、无后端接口），已构建并**提交**在 `src/ConsumptionTracker.Web/wwwroot/box/`，随 `dotnet publish` 一起进发布包。**没有新服务、没有计划任务，也不动数据目录。**
- `/box` 与 `/box/` 都打开首页；其它文件在 `/box/…` 下。`/box` 下的响应由 `Api/BoxSite.cs` 与 `Api/Security.cs` 处理：
  - `Content-Security-Policy`：`default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`；
  - `Permissions-Policy`：`bluetooth=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()`（仅 `/box` 开 `bluetooth`；站点其它路径的响应头不变）；
  - 首页等无哈希文件 `no-cache`；带内容哈希的 `*.<10位十六进制>.js|css` 为 `public, max-age=31536000, immutable`；不设 Cookie。
- Web Bluetooth 只在 Chromium 系浏览器、HTTPS（或 localhost）下可用。IIS 上站点本来就是 HTTPS，无需额外配置；`web.config` 不用改。
- 更新 `/box` 内容：在 scalebridge 仓库 `web/` 里改完并推送后，在那边执行 `node web/scripts/sync-to-site.mjs <本仓库路径>`（`--check` 只校验不写），再提交这里的 `wwwroot/box/` 变更。同步脚本会删掉旧的哈希文件。
- 隐私：`/box` 的数据只在访问者浏览器的 IndexedDB 里，不上传；站点访问日志只会有 `/box/…` 静态文件的 GET 记录，**不含任何体重数据**（页面不向服务器发任何数据）。
- 蓝牙连接路径为实验性（仅按规范实现，未真机验证）；页面上的示例记录均标「演示数据」。

回归：`dotnet test`（含 `BoxSiteTests`：响应头、其它路径不变、`/box` 与 `/box/`、路径穿越、静态约束）；`scripts/e2e` 的 `box.test.js`（真浏览器；Chrome 需带 `--enable-features=WebBluetooth`，否则 Linux 版 Chrome 没有 `navigator.bluetooth`，控制台会对 `Permissions-Policy` 里的 `bluetooth` 给出一条“Unrecognized feature”的浏览器提示，与站点无关）。
