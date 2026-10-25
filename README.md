# 日常消费 / 用药记录（网站版）

个人记账 / 用药记录小站，部署在 `https://life.kastop.com`。与桌面版、手机版的数据格式兼容。

> **默认免登录（本地模式）**：打开页面就是登记页，所有功能（登记/扫码、查看、修改、删除、统计、导入导出）不需要登录，数据只存在**你的浏览器**（IndexedDB），**不会发送到服务器**。清除浏览器数据或换设备会丢失，请定期导出备份。
>
> **登录 Kaspa 钱包是可选的**（页头「登录 Kaspa 钱包（可选，云端保存）」）：登录后进入**云端模式**，数据存在服务器上，按 Kaspa 地址隔离，**没有端到端加密、不承诺匿名**（服务器端可读取明文，管理员在技术上可访问数据库文件；端到端加密列为二期，见 [NOTES.md](NOTES.md)）。**登录后不会自动同步**，需要时在“数据”页手动「上传本地数据到账户」/「从账户下载到本地」（均需确认，可选合并或覆盖），点「退出云端」回到本地模式。

本站是**纯记录工具**：不涉及支付、转账或任何交易；**永远不会索要私钥或助记词**；登录签名不产生链上交易。

## 功能

- **两种模式、同一套界面与校验**：统一存储适配层 `wwwroot/life-local.js`（LocalStore：IndexedDB）与 `life-remote.js`（RemoteStore：现有 `/api`），`life-mode.js` 管模式切换；两者金额/数量/长度限制、CSV/JSON 导入规则完全一致（`shared-vectors/limits.json` 等向量由测试加载）。
- **删除撤销**（约 6 秒内，撤销 = 写回原记录含原 id/创建时间）、**同编码同日重复登记提醒**（可继续保存）、必填项标记。
- **Kaspa 地址身份（可选，云端模式）**（`kaspa:q…` 主网，bech32 校验和强制校验）：连接 KasWare（`requestAccounts` + `signMessage(..., {type:"schnorr"})`），或手动粘贴签名。
- **记录增删改查**：条码、名称、单价（分）、数量、分类（含“药品”）、备注、日期、批次名称、用药人、剂量/规格。
- 筛选：日期区间、分类、批次、关键词；日/月统计、分类占比，与列表口径一致。
- **扫码**：本地打包的 html5-qrcode（无 CDN）、手动输入、USB 扫码枪（条码框保持焦点，回车查询）。
- **导入/导出**：JSON（`app=consumption-tracker`，`version=2`，同时含 `price`(元) 与 `priceCents`）、CSV（UTF-8 BOM）。
- **一键导出全部数据**、**一键删除全部数据**（二次确认），本地与云端模式都可用。
- 中文界面，移动端自适应。无第三方脚本 / 统计。

## 登录流程

1. 前端 `POST /api/auth/challenge {address}` → 服务器生成 **随机 Nonce + 时间戳** 的待签名消息（一次性、默认 300 秒有效、绑定该地址）。
2. 钱包对消息做 Kaspa 个人消息 **Schnorr** 签名（BLAKE2b-256 带 `PersonalMessageSigningHash` 密钥 → BIP340）。
3. `POST /api/auth/verify {address, nonce, signature}`：服务器用**自己保存的消息**验签，并校验“签名公钥 = 地址里的公钥”。挑战**首次使用即作废**（无论成败），防重放。
4. 成功后下发 **HttpOnly、SameSite=Strict、（生产）Secure** 的短期会话 Cookie（默认 12 小时）；服务器只保存 token 的 SHA-256。
5. **没有“只输入地址就登录”的后门。** 仅 `Development` 环境且显式 `Life:Auth:DevLogin=true` 时才注册 `/api/auth/dev-login`（默认关闭，生产环境不存在该路由）。

签名/地址代码复用自 `composehk/xiangqi-dotnet`（`Kaspa/KaspaMessageSigner.cs` 等），未重写密码学；用 rusty-kaspa 官方向量和自生成密钥做了单元测试。

## 安全要点

- 服务端 API 鉴权不变：匿名访问任何数据接口一律 401，**没有任何匿名写接口、没有匿名服务器账号**；本地模式下页面不向服务器提交任何记录。
- 数据隔离：地址是每条 SQL 的条件和主键的一部分，所有读/改/删都按登录会话的地址限定；越权访问他人记录一律 404。
- CSRF：SameSite=Strict + 所有非 GET 的 `/api` 请求必须带 `X-Requested-With: life-web` + Origin 与 Host 一致性检查。
- 限流（按 IP）：challenge 10/分钟、verify 20/分钟、其他 API 300/分钟；请求体上限 64 KB（导入 5 MB）。
- 安全响应头：CSP（`default-src 'none'; connect-src 'self'; script-src 'self'` …，禁止外部连接）、`nosniff`、`no-referrer`、`frame-ancestors 'none'`；`web.config` 移除 `Server` / `X-Powered-By`。
- 日志不记录记录内容（名称、备注、用药人等）；关键词查询用 POST 请求体，不进 URL / IIS 日志。
- SQLite（WAL）存放在 `App_Data`（可配置）。

## 开发

```bash
dotnet build
dotnet test                      # xUnit：地址/签名/隔离/CRUD/统计/导入导出/越权/伪造 token/挑战重放…
(cd scripts/js-tests && npm ci && node --test)   # 本地存储适配层 / 远程适配层 / 模式切换（node:test + fake-indexeddb）
bash scripts/smoke.sh            # Kestrel + curl 端到端冒烟（注册→列表→删除→导出→重启仍在）

# 本地跑起来（Development + 免签名登录开关，仅本机开发用）
ASPNETCORE_ENVIRONMENT=Development Life__Auth__DevLogin=true \
  dotnet run --project src/ConsumptionTracker.Web
```

发布包（Windows IIS，框架依赖，需 .NET 8 Hosting Bundle）：

```bash
dotnet publish src/ConsumptionTracker.Web -c Release -r win-x64 --self-contained false -o publish/life
```

部署见 [DEPLOY.md](DEPLOY.md)。CI（GitHub Actions）构建、测试、冒烟并上传 win-x64 发布包 artifact。

## 目录

```
src/ConsumptionTracker.Core   与桌面版共享的模型/校验/统计/导入导出
src/ConsumptionTracker.Web    ASP.NET Core 8 最小 API + SQLite + wwwroot 前端
tests/ConsumptionTracker.Web.Tests
scripts/smoke.sh
scripts/js-tests              前端存储适配层与模式切换的 node 测试
shared-vectors                三端共用向量（money / quantity / limits / csv-text）
```

## 许可与第三方

html5-qrcode 2.3.8（Apache-2.0，`wwwroot/vendor/html5-qrcode.LICENSE.txt`），本地提供，不走 CDN。
