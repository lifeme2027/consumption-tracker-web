using System.Globalization;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;
using Microsoft.Data.Sqlite;

namespace ConsumptionTracker.Web.Storage;

/// <summary>
/// 某个 Kaspa 地址名下的记录仓储。隔离靠构造：地址写进每条 SQL（WHERE address = $a）和主键 (address, id)，
/// 所以拿别人的 id 去 Get/Update/Delete 只会「找不到」，不存在越权路径。
/// </summary>
public sealed class UserRepository : IRecordRepository
{
    private readonly Database _db;
    private readonly int _maxRecords;
    public string Address { get; }

    internal UserRepository(Database db, string address, int maxRecords)
    {
        _db = db;
        Address = address;
        _maxRecords = maxRecords;
    }

    /// <summary>一次数据库操作的上下文：自动给每条命令绑定 $a（当前地址）。</summary>
    private sealed class Ctx : IDisposable
    {
        public readonly SqliteConnection Conn;
        private readonly string _address;
        public Ctx(Database db, string address) { Conn = db.Open(); _address = address; }
        public void Dispose() => Conn.Dispose();

        private SqliteCommand Cmd(string sql, (string, object)[] ps, SqliteTransaction? tx)
        {
            var cmd = Conn.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = sql;
            cmd.Parameters.AddWithValue("$a", _address);
            foreach (var (k, v) in ps) cmd.Parameters.AddWithValue(k, v);
            return cmd;
        }

        public int Exec(string sql, SqliteTransaction? tx, params (string, object)[] ps)
        {
            using var c = Cmd(sql, ps, tx);
            return c.ExecuteNonQuery();
        }

        public T? Scalar<T>(string sql, SqliteTransaction? tx, params (string, object)[] ps)
        {
            using var c = Cmd(sql, ps, tx);
            var o = c.ExecuteScalar();
            if (o == null || o is DBNull) return default;
            return (T)Convert.ChangeType(o, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T), CultureInfo.InvariantCulture);
        }

        public List<T> Read<T>(string sql, Func<SqliteDataReader, T> map, SqliteTransaction? tx, params (string, object)[] ps)
        {
            using var c = Cmd(sql, ps, tx);
            using var r = c.ExecuteReader();
            var list = new List<T>();
            while (r.Read()) list.Add(map(r));
            return list;
        }
    }

    private Ctx Open() => new(_db, Address);

    // ---------- records ----------

    public RecordItem Add(RecordItem record)
    {
        using var x = Open();
        using var tx = x.Conn.BeginTransaction();
        if (Count(x, tx) >= _maxRecords) throw new InvalidOperationException($"记录数已达上限（{_maxRecords} 条）");
        var batch = ResolveBatch(x, tx, record.BatchName);
        var clean = Clean(record with { Id = Guid.NewGuid().ToString(), BatchId = batch.id, BatchName = batch.name });
        Upsert(x, tx, clean);
        RememberProduct(x, tx, clean);
        tx.Commit();
        return clean;
    }

    public RecordItem? Update(RecordItem record)
    {
        using var x = Open();
        using var tx = x.Conn.BeginTransaction();
        var old = GetCore(x, tx, record.Id);
        if (old == null) return null; // 不存在或不属于当前地址
        var batch = ResolveBatch(x, tx, record.BatchName);
        var clean = Clean(record with { BatchId = batch.id, BatchName = batch.name, CreatedAt = old.CreatedAt });
        Upsert(x, tx, clean);
        RememberProduct(x, tx, clean);
        tx.Commit();
        return clean;
    }

    public int Delete(IEnumerable<string> ids)
    {
        var n = 0;
        using var x = Open();
        using var tx = x.Conn.BeginTransaction();
        foreach (var id in ids.Distinct())
            n += x.Exec("DELETE FROM records WHERE address = $a AND id = $id", tx, ("$id", id));
        tx.Commit();
        return n;
    }

    public RecordItem? Get(string id)
    {
        using var x = Open();
        return GetCore(x, null, id);
    }

    public int Count()
    {
        using var x = Open();
        return Count(x, null);
    }

    public List<RecordItem> Query(RecordQuery? query = null)
    {
        query ??= new RecordQuery();
        var where = new List<string> { "address = $a" };
        var ps = new List<(string, object)>();
        if (!string.IsNullOrEmpty(query.From)) { where.Add("date >= $from"); ps.Add(("$from", query.From)); }
        if (!string.IsNullOrEmpty(query.To)) { where.Add("date <= $to"); ps.Add(("$to", query.To)); }
        if (!string.IsNullOrEmpty(query.Category)) { where.Add("category = $cat"); ps.Add(("$cat", query.Category)); }
        if (query.BatchId == RecordQuery.NoBatch) where.Add("batch_id = ''");
        else if (!string.IsNullOrEmpty(query.BatchId)) { where.Add("batch_id = $bid"); ps.Add(("$bid", query.BatchId)); }
        var sql = "SELECT * FROM records WHERE " + string.Join(" AND ", where) + " ORDER BY date DESC, created_at DESC, id";
        using var x = Open();
        var rows = x.Read(sql, MapRecord, null, ps.ToArray());
        // 关键词与 Core 共用同一实现，保证列表与统计一致
        return string.IsNullOrWhiteSpace(query.Keyword) ? rows : rows.Where(query.Matches).ToList();
    }

    public List<string> ListCategories()
    {
        using var x = Open();
        return x.Read("SELECT DISTINCT category FROM records WHERE address = $a ORDER BY category", r => r.GetString(0), null);
    }

    // ---------- batches ----------

    public List<BatchInfo> ListBatches()
    {
        using var x = Open();
        var list = x.Read(
            "SELECT batch_id, MAX(batch_name), COUNT(*) FROM records WHERE address = $a AND batch_id <> '' GROUP BY batch_id",
            r => new BatchInfo(r.GetString(0), r.GetString(1), r.GetInt32(2)), null);
        return list.OrderBy(b => b.BatchName, StringComparer.CurrentCulture).ToList();
    }

    public int AssignBatch(IEnumerable<string> ids, string name)
    {
        var n = 0;
        using var x = Open();
        using var tx = x.Conn.BeginTransaction();
        var (batchId, batchName) = ResolveBatch(x, tx, name);
        foreach (var id in ids.Distinct())
            n += x.Exec("UPDATE records SET batch_id = $b, batch_name = $n WHERE address = $a AND id = $id", tx,
                ("$b", batchId), ("$n", batchName), ("$id", id));
        tx.Commit();
        return n;
    }

    public int RenameBatch(string batchId, string name)
    {
        var n = (name ?? "").Trim();
        if (n == "" || batchId == "" || n.Length > RecordLimits.MaxBatchName) return 0;
        using var x = Open();
        return x.Exec("UPDATE records SET batch_name = $n WHERE address = $a AND batch_id = $b", null, ("$n", n), ("$b", batchId));
    }

    private static (string id, string name) ResolveBatch(Ctx x, SqliteTransaction tx, string? name)
    {
        var n = (name ?? "").Trim();
        if (n == "") return ("", "");
        if (n.Length > RecordLimits.MaxBatchName) throw new ArgumentException("批次名过长");
        var existing = x.Scalar<string>("SELECT batch_id FROM records WHERE address = $a AND batch_name = $n AND batch_id <> '' LIMIT 1", tx, ("$n", n));
        return (existing ?? Guid.NewGuid().ToString(), n);
    }

    // ---------- products ----------

    public Product? FindProduct(string barcode)
    {
        var b = (barcode ?? "").Trim();
        if (b == "") return null;
        using var x = Open();
        return x.Read("SELECT barcode, name, category, last_price_cents, updated_at FROM products WHERE address = $a AND barcode = $b",
            MapProduct, null, ("$b", b)).FirstOrDefault();
    }

    public List<Product> ListProducts()
    {
        using var x = Open();
        return x.Read("SELECT barcode, name, category, last_price_cents, updated_at FROM products WHERE address = $a ORDER BY barcode",
            MapProduct, null);
    }

    private static void RememberProduct(Ctx x, SqliteTransaction tx, RecordItem r)
    {
        if (r.Barcode == "") return;
        UpsertProduct(x, tx, new Product
        {
            Barcode = r.Barcode, Name = r.Name, Category = r.Category,
            LastPriceCents = r.PriceCents, UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
    }

    private static void UpsertProduct(Ctx x, SqliteTransaction tx, Product p) =>
        x.Exec("""
            INSERT INTO products (address, barcode, name, category, last_price_cents, updated_at)
            VALUES ($a, $b, $n, $c, $p, $u)
            ON CONFLICT(address, barcode) DO UPDATE SET name = $n, category = $c, last_price_cents = $p, updated_at = $u
            """, tx,
            ("$b", p.Barcode), ("$n", p.Name), ("$c", p.Category), ("$p", (object?)p.LastPriceCents ?? DBNull.Value), ("$u", p.UpdatedAt));

    // ---------- import / wipe ----------

    public ImportSummary Import(IEnumerable<RecordItem> records, IEnumerable<Product> products, ImportMode mode)
    {
        var recordList = records.ToList();
        // 覆盖导入：先对全部记录做完整预检；有任何一条不合格就整体中止，不清空任何现有数据
        if (mode == ImportMode.Replace)
        {
            var issues = ImportRejectedException.Precheck(recordList);
            if (issues.Count > 0) throw new ImportRejectedException(issues, recordList.Count);
        }
        var added = 0; var updated = 0; var skipped = 0;
        using var x = Open();
        using var tx = x.Conn.BeginTransaction();
        if (mode == ImportMode.Replace)
        {
            x.Exec("DELETE FROM records WHERE address = $a", tx);
            x.Exec("DELETE FROM products WHERE address = $a", tx);
        }
        var count = Count(x, tx);
        var accepted = new List<RecordItem>();
        foreach (var raw in recordList)
        {
            var r = RecordValidator.Sanitize(raw);
            if (r == null || RecordLimits.Check(r) != null) { skipped++; continue; }   // 仅合并模式可达：覆盖模式已预检
            var exists = x.Scalar<long>("SELECT COUNT(*) FROM records WHERE address = $a AND id = $id", tx, ("$id", r.Id)) > 0;
            if (!exists && ++count > _maxRecords) throw new InvalidOperationException($"导入后记录数将超过上限（{_maxRecords} 条），已取消");
            Upsert(x, tx, r);
            accepted.Add(r);
            if (exists) updated++; else added++;
        }
        foreach (var p in products)
        {
            var barcode = (p.Barcode ?? "").Trim();
            if (barcode == "" || barcode.Length > RecordLimits.MaxBarcode || (p.Name ?? "").Length > RecordLimits.MaxName
                || (p.Category ?? "").Length > RecordLimits.MaxCategory) continue;
            var cur = x.Read("SELECT updated_at FROM products WHERE address = $a AND barcode = $b", r => r.GetInt64(0), tx, ("$b", barcode));
            if (cur.Count == 0 || p.UpdatedAt >= cur[0])
                UpsertProduct(x, tx, p with { Barcode = barcode, Name = p.Name ?? "", Category = p.Category ?? "" });
        }
        // 没有商品记忆的编码（如 CSV 导入）根据其最新一条记录补出记忆
        foreach (var g in accepted.Where(r => r.Barcode != "").GroupBy(r => r.Barcode))
        {
            if (x.Scalar<long>("SELECT COUNT(*) FROM products WHERE address = $a AND barcode = $b", tx, ("$b", g.Key)) > 0) continue;
            var last = g.OrderByDescending(r => r.Date, StringComparer.Ordinal).ThenByDescending(r => r.CreatedAt).First();
            UpsertProduct(x, tx, new Product
            {
                Barcode = g.Key, Name = last.Name, Category = last.Category,
                LastPriceCents = last.PriceCents, UpdatedAt = last.CreatedAt,
            });
        }
        tx.Commit();
        return new ImportSummary(added, updated, skipped);
    }

    /// <summary>一键删除：仅清空当前地址的全部记录与商品记忆。返回删除的记录数。</summary>
    public int DeleteAll()
    {
        using var x = Open();
        using var tx = x.Conn.BeginTransaction();
        var n = x.Exec("DELETE FROM records WHERE address = $a", tx);
        x.Exec("DELETE FROM products WHERE address = $a", tx);
        tx.Commit();
        return n;
    }

    // ---------- helpers ----------

    private static RecordItem Clean(RecordItem r)
    {
        var clean = RecordValidator.Sanitize(r)
                    ?? throw new ArgumentException(string.Join("；", RecordValidator.Validate(r)));
        var limit = RecordLimits.Check(clean);
        if (limit != null) throw new ArgumentException(limit);
        return clean;
    }

    private static int Count(Ctx x, SqliteTransaction? tx) =>
        (int)x.Scalar<long>("SELECT COUNT(*) FROM records WHERE address = $a", tx);

    private static RecordItem? GetCore(Ctx x, SqliteTransaction? tx, string id) =>
        x.Read("SELECT * FROM records WHERE address = $a AND id = $id", MapRecord, tx, ("$id", id ?? "")).FirstOrDefault();

    private static void Upsert(Ctx x, SqliteTransaction tx, RecordItem r) =>
        x.Exec("""
            INSERT OR REPLACE INTO records
              (address, id, barcode, name, price_cents, quantity, category, note, batch_id, batch_name, patient, dosage, date, created_at)
            VALUES ($a, $id, $barcode, $name, $price, $qty, $cat, $note, $bid, $bname, $patient, $dosage, $date, $created)
            """, tx,
            ("$id", r.Id), ("$barcode", r.Barcode), ("$name", r.Name), ("$price", r.PriceCents),
            ("$qty", r.Quantity.ToString(CultureInfo.InvariantCulture)), ("$cat", r.Category), ("$note", r.Note),
            ("$bid", r.BatchId), ("$bname", r.BatchName), ("$patient", r.Patient), ("$dosage", r.Dosage),
            ("$date", r.Date), ("$created", r.CreatedAt));

    private static string Str(SqliteDataReader r, string col) => r.GetString(r.GetOrdinal(col));

    private static RecordItem MapRecord(SqliteDataReader r) => new()
    {
        Id = Str(r, "id"), Barcode = Str(r, "barcode"), Name = Str(r, "name"),
        PriceCents = r.GetInt64(r.GetOrdinal("price_cents")),
        Quantity = decimal.Parse(Str(r, "quantity"), CultureInfo.InvariantCulture),
        Category = Str(r, "category"), Note = Str(r, "note"),
        BatchId = Str(r, "batch_id"), BatchName = Str(r, "batch_name"),
        Patient = Str(r, "patient"), Dosage = Str(r, "dosage"),
        Date = Str(r, "date"), CreatedAt = r.GetInt64(r.GetOrdinal("created_at")),
    };

    private static Product MapProduct(SqliteDataReader r) => new()
    {
        Barcode = r.GetString(0), Name = r.GetString(1), Category = r.GetString(2),
        LastPriceCents = r.IsDBNull(3) ? null : r.GetInt64(3), UpdatedAt = r.GetInt64(4),
    };
}
