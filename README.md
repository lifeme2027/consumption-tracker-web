# 日常消费 / 用药记录（网站版）

用 Kaspa 地址登录的个人记账 / 用药记录小站，部署在 `https://life.kastop.com`。与桌面版、手机版的数据格式兼容。

> **数据存放在服务器，不对外分享。** 数据按 Kaspa 地址隔离（每个地址只能读写自己的数据）。
> 这**不是匿名服务**，也**没有端到端加密**：服务器端可读取明文，管理员在技术上可访问数据库文件。端到端加密列为二期（见 [NOTES.md](NOTES.md)）。

本站是**纯记录工具**：不涉及支付、转账或任何交易；**永远不会索要私钥或助记词**；登录签名不产生链上交易。

## 功能

- **Kaspa 地址身份**（`kaspa:q…` 主网，bech32 校验和强制校验）：连接 KasWare（`requestAccounts` + `signMessage(..., {type:"schnorr"})`），或手动粘贴签名。
- **记录增删改查**：条码、名称、单价（分）、数量、分类（含“药品”）、备注、日期、批次名称、用药人、剂量/规格。
- 筛选：日期区间、分类、批次、关键词；日/月统计、分类占比，与列表口径一致。
- **扫码**：本地打包的 html5-qrcode（无 CDN）、手动输入、USB 扫码枪（条码框保持焦点，回车查询）。
- **导入/导出**：JSON（`app=consumption-tracker`，`version=2`，同时含 `price`(元) 与 `priceCents`）、CSV（UTF-8 BOM）。
- **一键导出全部数据**、**一键删除全部数据**（二次确认）。
- 中文界面，移动端自适应。无第三方脚本 / 统计。

## 登录流程

1. 前端 `POST /api/auth/challenge {address}` → 服务器生成 **随机 Nonce + 时间戳** 的待签名消息（一次性、默认 300 秒有效、绑定该地址）。
2. 钱包对消息做 Kaspa 个人消息 **Schnorr** 签名（BLAKE2b-256 带 `PersonalMessageSigningHash` 密钥 → BIP340）。
3. `POST /api/auth/verify {address, nonce, signature}`：服务器用**自己保存的消息**验签，并校验“签名公钥 = 地址里的公钥”。挑战**首次使用即作废**（无论成败），防重放。
4. 成功后下发 **HttpOnly、SameSite=Strict、（生产）Secure** 的短期会话 Cookie（默认 12 小时）；服务器只保存 token 的 SHA-256。
5. **没有“只输入地址就登录”的后门。** 仅 `Development` 环境且显式 `Life:Auth:DevLogin=true` 时才注册 `/api/auth/dev-login`（默认关闭，生产环境不存在该路由）。

签名/地址代码复用自 `composehk/xiangqi-dotnet`（`Kaspa/KaspaMessageSigner.cs` 等），未重写密码学；用 rusty-kaspa 官方向量和自生成密钥做了单元测试。

## 安全要点

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
```

## 许可与第三方

html5-qrcode 2.3.8（Apache-2.0，`wwwroot/vendor/html5-qrcode.LICENSE.txt`），本地提供，不走 CDN。
