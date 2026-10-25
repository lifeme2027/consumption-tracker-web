using Microsoft.Data.Sqlite;

namespace ConsumptionTracker.Web.Catalog;

/// <summary>商品库查询结果。未配置 / 文件不存在 / 库无法读取 → Available=false（不抛错）。</summary>
public sealed record CatalogResult(bool Available, bool Found, string Name, string Category, string Unit, string Spec, long? SalePriceCents)
{
    public static readonly CatalogResult Unavailable = new(false, false, "", "", "", "", null);
    public static readonly CatalogResult Miss = new(true, false, "", "", "", "", null);
}

/// <summary>
/// 只读商品库（SQLite，表 catalog(barcode PK, name, spec, category, unit, sale_price_cents, cost_price_cents, origin)）。
/// 隐私约束（有测试守护）：本类不依赖任何日志接口、不把条码拼进任何字符串/异常消息；所有失败一律吞掉并返回 Unavailable。
/// 只以 Mode=ReadOnly 打开、参数化查询、每次查询用完即关（Pooling=false），因此管理员可直接替换 catalog.db 而不必先停站点。
/// 绝不返回进价（cost_price_cents）与产地。
/// </summary>
public sealed class CatalogLookup
{
    private readonly string? _path;
    public CatalogLookup(string? configuredPath, string contentRoot)
    {
        var p = configuredPath?.Trim();
        _path = string.IsNullOrEmpty(p) ? null : (Path.IsPathRooted(p) ? p : Path.Combine(contentRoot, p));
    }

    public bool Configured => _path != null;

    public CatalogResult Lookup(string barcode)
    {
        if (_path == null) return CatalogResult.Unavailable;
        try
        {
            if (!File.Exists(_path)) return CatalogResult.Unavailable;
            var cs = new SqliteConnectionStringBuilder { DataSource = _path, Mode = SqliteOpenMode.ReadOnly, Pooling = false, DefaultTimeout = 2 }.ToString();
            using var conn = new SqliteConnection(cs);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT name, category, unit, spec, sale_price_cents FROM catalog WHERE barcode = $b LIMIT 1";
            cmd.Parameters.AddWithValue("$b", barcode);
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return CatalogResult.Miss;
            string S(int i) => r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture) ?? "";
            var name = S(0).Trim();
            if (name.Length == 0) return CatalogResult.Miss;   // name 为空视为没有可用信息
            long? price = null;
            if (!r.IsDBNull(4)) { try { var v = r.GetInt64(4); if (v >= 0) price = v; } catch { /* 非整数价格忽略 */ } }
            return new CatalogResult(true, true, name, S(1).Trim(), S(2).Trim(), S(3).Trim(), price);
        }
        catch
        {
            // 库被占用 / 结构不对 / 文件损坏：对调用方等同于“商品库不可用”。不记录任何内容（尤其是条码）。
            return CatalogResult.Unavailable;
        }
    }
}
