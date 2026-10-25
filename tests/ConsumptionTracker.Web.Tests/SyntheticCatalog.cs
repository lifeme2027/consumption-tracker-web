using Microsoft.Data.Sqlite;

namespace ConsumptionTracker.Web.Tests;

/// <summary>合成商品库（纯测试数据，与任何真实商品无关）：约定的 catalog/meta 结构，几千行。</summary>
public static class SyntheticCatalog
{
    public const string HitCode = "9900000000017";          // 合成：有参考售价
    public const string NoPriceCode = "9900000000024";       // 合成：参考售价为 NULL
    public const string LongCategoryCode = "9900000000031";  // 合成：分类 > 30 字
    public const string MissCode = "9900000999999";          // 不在库中

    public static string Create(string dir, int rows = 3000)
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "catalog.db");
        if (File.Exists(path)) File.Delete(path);
        var cs = new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString();
        using var c = new SqliteConnection(cs);
        c.Open();
        Exec(c, "CREATE TABLE catalog(barcode TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT, category TEXT, unit TEXT, sale_price_cents INTEGER NULL, cost_price_cents INTEGER NULL, origin TEXT) WITHOUT ROWID");
        Exec(c, "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
        using var tx = c.BeginTransaction();
        void Add(string code, string name, string spec, string cat, string unit, long? sale, long? cost, string origin)
        {
            using var cmd = c.CreateCommand(); cmd.Transaction = tx;
            cmd.CommandText = "INSERT INTO catalog VALUES($a,$b,$c,$d,$e,$f,$g,$h)";
            cmd.Parameters.AddWithValue("$a", code); cmd.Parameters.AddWithValue("$b", name); cmd.Parameters.AddWithValue("$c", spec);
            cmd.Parameters.AddWithValue("$d", cat); cmd.Parameters.AddWithValue("$e", unit);
            cmd.Parameters.AddWithValue("$f", (object?)sale ?? DBNull.Value); cmd.Parameters.AddWithValue("$g", (object?)cost ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$h", origin);
            cmd.ExecuteNonQuery();
        }
        for (var i = 0; i < rows; i++)
            Add("98" + i.ToString("D11"), "合成商品" + i, "规格" + (i % 9) + "x", "合成分类" + (i % 12), "件", 100 + i, 50 + i, "合成产地");
        Add(HitCode, "合成测试饮料", "500ml", "合成饮料", "瓶", 350, 200, "合成产地");
        Add(NoPriceCode, "合成无价商品", "", "合成杂货", "个", null, null, "");
        Add(LongCategoryCode, "合成长分类商品", "", new string('类', 45), "个", 1999, 1000, "");
        using (var m = c.CreateCommand()) { m.Transaction = tx; m.CommandText = "INSERT INTO meta VALUES('row_count',$n),('built_at','2026-10-25T00:00:00Z'),('source_file','synthetic')"; m.Parameters.AddWithValue("$n", (rows + 3).ToString()); m.ExecuteNonQuery(); }
        tx.Commit();
        return path;
    }

    private static void Exec(SqliteConnection c, string sql) { using var cmd = c.CreateCommand(); cmd.CommandText = sql; cmd.ExecuteNonQuery(); }
}
