using Microsoft.Data.Sqlite;

namespace ConsumptionTracker.Web.Storage;

/// <summary>SQLite 数据库（App_Data）。每次操作新开连接（连接池），WAL 模式。</summary>
public sealed class Database
{
    public const int SchemaVersion = 1;

    private readonly string _connectionString;
    public string Path { get; }

    public Database(string databasePath)
    {
        Path = System.IO.Path.GetFullPath(databasePath);
        var dir = System.IO.Path.GetDirectoryName(Path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = true,
        }.ToString();
        Migrate();
    }

    public SqliteConnection Open()
    {
        var c = new SqliteConnection(_connectionString);
        c.Open();
        using var cmd = c.CreateCommand();
        // secure_delete：被删除的内容在页内就地擦零（含 WAL 中新写入的页），避免「删了但字节还留在文件里」。
        cmd.CommandText = "PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;";
        cmd.ExecuteNonQuery();
        return c;
    }

    /// <summary>
    /// 把 WAL 全部并回主库并截断 WAL 文件（TRUNCATE）。DeleteAll 之后与定期维护调用，
    /// 让已删除内容不会继续留在 -wal 里。若有并发读者占着 WAL，SQLite 会返回 busy，此时放弃本次、等下次。
    /// 返回 true 表示 WAL 已被截断。
    /// </summary>
    public bool Checkpoint()
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA wal_checkpoint(TRUNCATE);";
        using var r = cmd.ExecuteReader();
        return r.Read() && r.GetInt32(0) == 0;
    }

    /// <summary>VACUUM 重写整个库文件（回收空闲页、丢弃旧页内容），随后截断 WAL。</summary>
    public void Vacuum()
    {
        using (var c = Open())
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "VACUUM;";
            cmd.ExecuteNonQuery();
        }
        Checkpoint();
    }

    private void Migrate()
    {
        using var c = Open();
        using var ver = c.CreateCommand();
        ver.CommandText = "PRAGMA user_version";
        var version = Convert.ToInt64(ver.ExecuteScalar());
        if (version >= SchemaVersion) return;

        using var wal = c.CreateCommand();
        wal.CommandText = "PRAGMA journal_mode = WAL;";
        wal.ExecuteNonQuery();

        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = $"""
            CREATE TABLE IF NOT EXISTS records (
              address      TEXT NOT NULL,
              id           TEXT NOT NULL,
              barcode      TEXT NOT NULL DEFAULT '',
              name         TEXT NOT NULL,
              price_cents  INTEGER NOT NULL,
              quantity     TEXT NOT NULL,
              category     TEXT NOT NULL,
              note         TEXT NOT NULL DEFAULT '',
              batch_id     TEXT NOT NULL DEFAULT '',
              batch_name   TEXT NOT NULL DEFAULT '',
              patient      TEXT NOT NULL DEFAULT '',
              dosage       TEXT NOT NULL DEFAULT '',
              date         TEXT NOT NULL,
              created_at   INTEGER NOT NULL,
              PRIMARY KEY (address, id)
            );
            CREATE INDEX IF NOT EXISTS ix_records_addr_date ON records(address, date);
            CREATE INDEX IF NOT EXISTS ix_records_addr_batch ON records(address, batch_id);
            CREATE TABLE IF NOT EXISTS products (
              address          TEXT NOT NULL,
              barcode          TEXT NOT NULL,
              name             TEXT NOT NULL DEFAULT '',
              category         TEXT NOT NULL DEFAULT '',
              last_price_cents INTEGER,
              updated_at       INTEGER NOT NULL,
              PRIMARY KEY (address, barcode)
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              address    TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_sessions_addr ON sessions(address);
            PRAGMA user_version = {SchemaVersion};
            """;
        cmd.ExecuteNonQuery();
        tx.Commit();
    }
}
