# NOTES

## 设计决策

- **会话 token**：256 位随机数，库中只存 SHA-256；固定过期；重启 / IIS 回收后会话仍有效。
- **挑战（challenge）**：保存在进程内存，一次性、短有效期、有待用数量上限；进程重启后未使用的挑战作废（用户重新点登录即可）。
- **金额**：全程整数“分”；小计 = round(单价分 × 数量)，四舍五入远离零。
- **三端一致的输入规则**（价格→分按十进制字符串精确解析 + half-up，严格千分位，数量最多 6 位小数）见 `shared-vectors/README.md`；向量 `shared-vectors/money.json`、`quantity.json` 与桌面仓库逐字节相同，C# 的 `MoneyTests` 与前端 `scripts/test-money.js`（`wwwroot/money.js`）都逐条校验。
- **隔离**：地址作为每条 SQL 的条件与主键一部分；没有“按 id 全局取记录”的代码路径。
- **搜索**：POST + JSON 体，避免关键词出现在 URL 与 IIS 访问日志。
- CSP 里 `style-src-attr 'unsafe-inline'` 仅为兼容 html5-qrcode 的内联样式属性；`script-src` 仍是 `'self'`。

## 默认本地模式（免登录）

- **存储适配层**：`life-local.js`（IndexedDB：库 `life-local`，stores `records` / `products`）与 `life-remote.js`（映射到 `/api`）实现同一组方法（meta / lookup / add / update / remove / restore / query / stats / duplicates / assignBatch / exportJson / exportCsv / importText / wipe），界面与校验共用一份；`life-mode.js` 的 ModeController 决定当前用哪一个。
- **默认本地**：打开页面不发任何 `/api` 请求（`/api/config` 只在点“登录”时请求；仅当 localStorage `life.mode=cloud`（上次是云端）时才探测一次 `/api/auth/me`）。**没有匿名服务器账号**，服务端 API 鉴权不变（匿名 401），未新增匿名写接口。
- **登录后不自动同步**：本地与云端互不影响；上传 = 本地 `exportJson()` → 云端 `import`（合并/覆盖，覆盖在服务端同一事务里）；下载 = 云端导出 → 本地 `importText`（合并/覆盖，覆盖先整份预检，有任何一条不合格整体中止、本地不变）。两个按钮都先确认并说明语义。
- **删除撤销**：界面在删除前持有完整记录；撤销 = `store.restore(records)`（本地 IDB put；云端 `POST /api/records/restore`，≤1000 条，逐条校验，仍受地址隔离与 CSRF 约束）。
- **重复提醒**：`store.duplicates(barcode, date, excludeId)`：编码非空且同一天已有同编码记录时，保存前确认，可继续。
- **本地模式的取舍**：数据在浏览器里，清除浏览器数据/无痕/换设备即丢，没有任何找回手段（所以首次打开有“建议定期导出”提示，页面常驻说明）；同浏览器的其他使用者能看到数据；IndexedDB 在个别浏览器的隐私模式不可用时，本地功能会提示改用普通窗口或登录云端。
- 本地模式遵循与服务端 Core 相同的**严格**校验（不是手机端更宽松的 CSV 容错），保证“本地数据一定能无损上传云端”。
- 测试：`scripts/js-tests`（node:test + fake-indexeddb，CI 运行）覆盖本地存储、远程适配、模式切换/上传下载语义；`LocalModeFrontendTests` 静态检查本地模块无网络调用、页面无内联脚本/样式、CSP 严格。

## 已知限制

- 挑战在内存，多实例部署需改为共享存储（目前单实例 IIS，无此问题）。
- 限流按 IP（反向代理 / CDN 后需要配置转发头，见 DEPLOY.md）。
- 任何持有合法 Kaspa 密钥的人都可创建账户，单账户记录数有上限（默认 50000）作为约束。
- 相机扫码需要 HTTPS（或 localhost）。
- 签名 / 地址代码复用自 xiangqi-dotnet，已用官方向量和自生成密钥测试，但**未与真实 KasWare 钱包做端到端验证**。
- 数据**未做端到端加密**，服务器端可读取明文。

## 二期：端到端加密（E2E）

目标：服务器只存密文，管理员无法读取内容。

- 由钱包对固定消息（带版本号与域名）做确定性签名，HKDF 派生数据密钥；浏览器用 WebCrypto AES-GCM 加密记录字段（名称、备注、用药人、剂量、批次等）。
- 服务器只保留不需要明文的字段（日期、金额用于统计的取舍需要评估——若要彻底隐藏，则统计改为客户端计算）。
- 代价：服务端无法搜索 / 统计 / 导出明文，需要把这些逻辑搬到前端；密钥丢失 = 数据不可恢复，需要导出 / 备份与恢复流程。
- 前置：确认 KasWare 签名是否确定性（Schnorr BIP340 带随机辅助数据时不确定，需要改用固定派生方案）。
