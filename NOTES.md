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

## 界面语言（中英文）

- 页眉有「English / 中文」切换按钮，默认中文，选择保存在 localStorage `life.lang`。**目前只覆盖导入 / 上传 / 下载的提示与逐条原因**（成功摘要、整体中止、被跳过/不合格的记录清单、导入文件整体不可用的原因），其余界面（按钮、表单、对话框、其他提示）仍是中文。
- 云端模式：服务端返回 `errorEn` / `reasonEn` / `labelEn`；本地模式：`life-i18n.js` 的字典翻译 Core 同款原因，查不到时退回中文原文。字典与 `shared-vectors/reasons.json` 逐项一致（JS 测试），Core 实际产生的每一种原因都在该文件里（C# 测试）。
- 要做完整的中英文界面，需要把全部界面文案抽成字典（目前未做）。

## 三端一致性：已知差异与建议（未修复，仅记录）

来源：三端一致性测试报告 §2。下列项目**没有改代码**，每项给出现象和建议；是否处理由产品决定。药品「有效期」字段不在范围内，也未实现。

| 编号 | 现象（简） | 建议 |
|---|---|---|
| I-05 | CSV 导入时，手机端会 trim 备注（首尾空白、首尾换行），桌面/网站保留；三端对分类、用药人都 trim | 统一 trim 策略；建议备注一律不 trim（保真） |
| I-06 | 金额首尾「空白」的集合不同：`\ufeff12.5` 手机与网站 `money.js` 接受，桌面/网站 Core 拒绝；`\u00851.5` 反过来。都不涉及合法金额 | 把允许的首尾空白限定为 ASCII 空白 + 几个明确的 Unicode 空白，并加进 `money.json` 向量 |
| I-07 | CSV 引号：`ab"c`（引号在字段中间）桌面/网站整行跳过、手机原样接受；` "水"`（引号前有空格）桌面/网站按引号字段解析、手机保留引号。本应用导出的文件不会出现，仅手工编辑 CSV 时分歧 | 低优先；把这两类输入加入 `csv-text.json` 向量，让三端行为一致 |
| I-08 | JSON 备份没有版本校验：`version` 为 99、缺失、或是字符串 `"2"` 都能导入 | 版本高于当前时拒绝并提示「请升级应用」；缺失/非数字给出明确原因（需三端同时改）——**已修复**（见下节“导入安全批次”） |
| I-13 | 桌面/网站的 CSV 导入用确定性 id（内容哈希含行号），对**同一文件**重复「合并」不会重复；手机按内容去重 + 新 uuid。「先导 JSON、再导同一批数据的 CSV」在三端都会产生重复（CSV 不含 id）——设计限制 | 在界面或文档里说明；需要时再做按内容去重 |
| I-14 | 价格 0 在三端都合法（`0` / `0.00` → 0 分），例如赠品 | 如业务不允许零价，需三端同时改并加向量 |
| I-15 | UTF-16 编码的 CSV：桌面/网站（`StreamReader` 识别 BOM）可导入；手机（浏览器 `File.text()` 强制 UTF-8）报缺少必需列 | 在文档里说明「请用 UTF-8 保存 CSV」；或手机端自行识别 BOM |

已处理的相关项：I-02 / I-03（Core JSON 的数量与 `priceCents` 上限：专门测试 + `shared-vectors/limits.json` 在两个仓库都被加载并与 Core 常量对照）、I-09（导入错误给出具体的中英文原因）、I-10 / I-11（见桌面 README「扫码使用提示」）。

## 删除与数据保留（M-1）

- **程序做的**：数据库连接一律 `PRAGMA secure_delete=ON`（被删内容在页内擦零）；`DeleteAll`（一键删除）提交后立即 `wal_checkpoint(TRUNCATE)`；`MaintenanceService`（后台服务）每 `Storage:CheckpointMinutes`（默认 60）分钟做一次 checkpoint，每 `Storage:VacuumHours`（默认 24）小时做一次 VACUUM。测试 `SecureDeleteTests` 做了字节级残留检查（删除后在 `.db` 与 `-wal` 里都搜不到明文）。
- **程序不做的**：不删已存在的备份副本、不管 IIS 日志、不管磁盘层残留（SSD 磨损均衡、卷影/快照）。所以界面与隐私页**不再说“永久/无法恢复”**，而是如实写出 secure_delete / checkpoint / VACUUM 的含义，以及“已存在的备份和 IIS 日志不会自动删除，由管理员手动清理，不承诺自动清理，也不承诺具体保留期限”。**不要在界面 / 隐私页 / 文档里再加“最长保留 N 天”“自动清理”之类的承诺**（曾短暂写过 30 天并配了清理脚本，已按决定撤销、脚本已删除）；静态测试会拦截。
- **`.vacuumed` 标记文件**：上次 VACUUM 的时间记在 `<db>.vacuumed`（`App_Data\life.db.vacuumed`）的修改时间里，所以 IIS 回收 / 站点重启 / 进程崩溃不会让“24 小时”从头计时（否则频繁回收的站点永远不会 VACUUM）。删掉它只会导致下次启动立即 VACUUM 一次，无害；它只含时间，不含数据。回收应用池后第一次维护运行时才会看这个文件。
- 文案一致性：`wwwroot/app.js` 的 `WIPE_TEXT`、`index.html`、`privacy.html`、`privacy-en.html` 说同一件事；`PrivacyAndDeleteWordingTests` 静态检查：任何前端文件不得出现“永久”“无法恢复”“permanently”“irrecoverable”，也不得出现“30 天”“最长保留”“自动清理”“计划任务”“30 days”“automatically deleted”等保留期承诺；隐私页（中英）必须覆盖 12 小时会话、IIS 日志、健康敏感信息、secure_delete / checkpoint / VACUUM、“备份由管理员手动清理”，且本地 / 云端分节。

## 网页测试报告：信息级项目与残余风险（未改代码或仅记录）

编号说明：用户口头编号里 **L-8 = 分页、L-10 = 405/415**，与 `web-report.md` 正文（L-8 错误语义、L-10 分页）互换；两项都已实现（L-8：`/api/records/query` 的 `limit`/`offset`，默认 2000、上限 5000，`count/totalCents` 仍是全量合计，另有 `total/hasMore/returned`，客户端自动翻页；L-10：错误方法 405 + `Allow`，错误 Content-Type 415，400/404/405/413/415/500 空体补中英文 JSON）。

| 编号 | 说明 |
|---|---|
| L-2 | 导出与普通读共用每 IP 每分钟 300 次的 `api` 限流桶（导出最多 5 万条约 15 MB）。未单独限流，依赖 IIS / 防火墙；需要时给导出加独立桶（如 6/分）。 |
| L-3 | HTTP:80 → HTTPS 的 301 在 IIS 侧配置（DEPLOY.md 给了 URL Rewrite 规则），仓库 `web.config` 不含；上线后需运维用 `curl -I http://…` 验证。HSTS 只有 `max-age=31536000`，无 `includeSubDomains/preload`。 |
| L-5 | 证书 `*.kastop.com` 2026-11-29 11:28 UTC（北京时间 19:28）到期，需确认 win-acme 自动续期；服务端仅 TLS 1.2。 |
| L-9 | 仓库默认 `AllowedHosts: "*"`，生产必须在 `appsettings.Production.json` 设成 `life.kastop.com`（DEPLOY.md 已写，含验证命令）。 |
| I-1 | `/healthz` 只返回 `ok`，无构建号；线上版本靠静态资源哈希核对。 |
| I-2 | 会话 Cookie 无 `__Host-` 前缀（有 HttpOnly/Secure/SameSite=Strict/Path=/，无 Domain，固定 12 小时）。 |
| I-3 | 未登录非 GET 先过 CSRF 守卫得 403 而非 401，与前端“401 → 重新登录”不一致，更严但不一致。 |
| I-4 | 钓鱼中继：challenge 消息含域名但不绑定来源，依赖用户在钱包弹窗里看到 life.kastop.com。 |
| I-5 | 无“退出所有设备”入口（`SessionStore.RevokeAll` 存在但未接路由）；一键删除不会使现有会话失效（与隐私页一致）。 |
| I-6 | `/api/config`、`/healthz`、logout、未知 `/api` 路径、静态文件无应用层限流，依赖 IIS / 防火墙。 |
| I-7 | 写接口无幂等键，弱网重试会产生重复记录；导入按 id upsert 天然幂等。 |
| I-8 | 名称含 NUL / 零宽 / RTL-override 字符原样存储，渲染用 `textContent`，只有显示层反转风险；`%` 搜索按 LIKE 通配，只影响自己的数据。 |
| I-9 | CSP 里 `style-src-attr 'unsafe-inline'` 仅为 html5-qrcode 的内联样式属性；静态 HTML 的 Content-Type 无 charset（页内 `<meta charset>` 兜底）。 |
| I-10 | IIS 请求过滤直接拦截的路径（`/App_Data/*`、`/bin/`、`/web.config`）返回无头空 404；无 `robots.txt` / `security.txt`（建议提供安全联系渠道）。 |
| I-11 | CSV 公式注入防护：`CsvService.GuardText/UnguardText`（单引号前缀），Excel 中会看到前导 `'`。 |
| I-12 | 应用没有审计表，删除事件不留痕，无法事后审计“谁在何时删了数据”。 |

**残余风险：分布式攻击者的 challenge 占位。** 每 IP 每分钟最多 10 个 challenge、全局待用上限 20000；上限满时现在是**淘汰最旧项**（M-2 修复，不再让全站新登录 429），所以不再有“占满即全站登录失败”，但分布式攻击者（≥2000 个 IP）仍能让**较早发出、尚未用完的 challenge 被挤掉**，表现为部分用户签名后验证失败、需重新点登录（重试即可）。要彻底解决需要 challenge 绑定来源（IP / 会话）或验证码，成本较高，目前接受该风险。

**偶发测试失败 `ImportRejectionTests(qtyBig)` 的调查结论**：不是负载，也不是测试间共享限流，而是一个**生产缺陷**——`KaspaMessageSigner.DecodeSignature` 遇到以 `0x` 开头的 130 字符签名就去掉前缀，而随机生成的 base64 签名约每 2000 次有 1 次恰好以 `0x` 开头，被误剥后验证失败 → 401。现已改为只有十六进制解析成功才剥前缀，否则按 base64 处理（`SignatureDecodeTests`）。同一份签名代码最初来自 xiangqi-dotnet，那几个项目里很可能存在同样的缺陷（未改动，建议另行处理）。附带：测试清理里原来用全局 `SqliteConnection.ClearAllPools`，会影响并行用例，已改成按库清理（`Database.ClearPoolFor`）。

## 导入安全批次（空覆盖 / 版本号 / 小数分 / 配额英文）

- **空文件覆盖导入被拒绝**（Core `EmptyReplaceException`；服务端 422 + `error`/`errorEn`，`rejected: []`；本地 LocalStore 同样拒绝；桌面不弹确认、直接给状态栏提示）。合法但 0 条记录的文件会清空数据，所以拒绝；要清空请用「一键删除全部数据」。合并导入空文件仍是无副作用的成功。若文件有不合格行，仍走原来带行号的 422 预检。
- **备份 `version`**：必须是 JSON 数字且为整数；1、2 兼容；更高版本提示「请先升级应用」；缺失/字符串/小数/小于 1 一律拒绝。网站（Core + life-local.js）、桌面（同一份 Core）、手机（backup.ts）一致。
- **`priceCents` 小数**（12.5、"12.5"）：该行整行无效，不取整、也不退回 `price`；`1250.0` 视为整数。商品记忆的小数 `lastPriceCents` 忽略（不取整）。
- **配额超限**：`QuotaExceededException` 带英文，接口返回 `errorEn`；其余原先只有中文的 400/401/404 也补了 `errorEn`。
- 新增的 4 对中英文原因都在 `shared-vectors/reasons.json`（网站与桌面字节一致），`life-i18n.js` 的 `REASONS` 与之逐条一致（js-tests 强制）。

## 已知限制

- 挑战在内存，多实例部署需改为共享存储（目前单实例 IIS，无此问题）。
- 限流按 IP（反向代理 / CDN 后需要配置转发头，见 DEPLOY.md）。
- 任何持有合法 Kaspa 密钥的人都可创建账户，单账户记录数有上限（默认 50000）作为约束。
- 相机扫码需要 HTTPS（或 localhost）。
- 签名 / 地址代码复用自 xiangqi-dotnet，已用官方向量和自生成密钥测试，但**未与真实 KasWare 钱包做端到端验证**。
- 数据**未做端到端加密**，服务器端可读取明文。
- 已存在的备份和 IIS 日志由管理员手动清理，程序和文档都不承诺自动清理或具体保留期限（隐私页如实说明）。

## 二期：端到端加密（E2E）

目标：服务器只存密文，管理员无法读取内容。

- 由钱包对固定消息（带版本号与域名）做确定性签名，HKDF 派生数据密钥；浏览器用 WebCrypto AES-GCM 加密记录字段（名称、备注、用药人、剂量、批次等）。
- 服务器只保留不需要明文的字段（日期、金额用于统计的取舍需要评估——若要彻底隐藏，则统计改为客户端计算）。
- 代价：服务端无法搜索 / 统计 / 导出明文，需要把这些逻辑搬到前端；密钥丢失 = 数据不可恢复，需要导出 / 备份与恢复流程。
- 前置：确认 KasWare 签名是否确定性（Schnorr BIP340 带随机辅助数据时不确定，需要改用固定派生方案）。
