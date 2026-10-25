using System.Net;
using ConsumptionTracker.Web.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;

namespace ConsumptionTracker.Web.Tests;

/// <summary>M-1：删除即真删——secure_delete 擦零、DeleteAll 后 TRUNCATE 检查点、定期 VACUUM。</summary>
public class SecureDeleteTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "life-sd-" + Guid.NewGuid().ToString("N"));
    public SecureDeleteTests() => Directory.CreateDirectory(_dir);
    public void Dispose()
    {
        Database.ClearPoolFor(Path.Combine(_dir, "a.db")); Database.ClearPoolFor(Path.Combine(_dir, "m.db"));
        try { Directory.Delete(_dir, true); } catch { }
    }

    private static byte[] ReadShared(string path)
    {
        if (!File.Exists(path)) return Array.Empty<byte>();
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var ms = new MemoryStream(); fs.CopyTo(ms); return ms.ToArray();
    }

    private static bool Contains(byte[] hay, string needle) =>
        hay.AsSpan().IndexOf(System.Text.Encoding.UTF8.GetBytes(needle)) >= 0;

    [Fact]
    public void OpenedConnections_Have_SecureDelete_On()
    {
        var db = new Database(Path.Combine(_dir, "a.db"));
        using var c = db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA secure_delete";
        Assert.Equal(1L, Convert.ToInt64(cmd.ExecuteScalar()));
    }

    [Fact]
    public async Task DeleteAll_LeavesNoTraceOfDeletedData_InDbOrWal_ButKeepsOthers()
    {
        using var app = new TestApp();
        var markerA = "ZZMA" + Guid.NewGuid().ToString("N")[..12];
        var markerB = "ZZMB" + Guid.NewGuid().ToString("N")[..12];
        var a = await app.LoginAsync(new TestWallet());
        var b = await app.LoginAsync(new TestWallet());
        for (var i = 0; i < 20; i++)
        {
            Assert.NotEmpty(await a.AddAsync(Http.Rec(markerA + i, note: markerA + "n", patient: markerA + "p")));
            Assert.NotEmpty(await b.AddAsync(Http.Rec(markerB + i)));
        }
        var dbFile = Path.Combine(app.DataDir, "life.db");
        // 删除前确认标记确实在盘上（WAL 或主库），否则这个测试什么也证明不了
        Assert.True(Contains(ReadShared(dbFile), markerA) || Contains(ReadShared(dbFile + "-wal"), markerA));

        Assert.Equal(HttpStatusCode.OK, (await a.Post("/api/account/delete-data", new { confirm = "DELETE" })).StatusCode);

        var main = ReadShared(dbFile); var wal = ReadShared(dbFile + "-wal");
        Assert.False(Contains(main, markerA), "已删除的数据仍残留在 life.db");
        Assert.False(Contains(wal, markerA), "已删除的数据仍残留在 life.db-wal");
        Assert.True(Contains(main, markerB) || Contains(wal, markerB), "其他用户的数据不应受影响");
        var q = await (await b.Post("/api/records/query", new { })).J();
        Assert.Equal(20, q.GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task DeleteAll_TruncatesWal()
    {
        using var app = new TestApp();
        var a = await app.LoginAsync(new TestWallet());
        for (var i = 0; i < 30; i++) await a.AddAsync(Http.Rec("x" + i));
        var wal = Path.Combine(app.DataDir, "life.db-wal");
        Assert.True(File.Exists(wal) && new FileInfo(wal).Length > 0);
        await a.Post("/api/account/delete-data", new { confirm = "DELETE" });
        Assert.Equal(0, File.Exists(wal) ? new FileInfo(wal).Length : 0);
    }

    [Fact]
    public void Maintain_Checkpoint_And_Vacuum_ShrinkFile_AndEmptyWal()
    {
        var path = Path.Combine(_dir, "m.db");
        var db = new Database(path);
        using (var c = db.Open())
        {
            using var t = c.CreateCommand();
            t.CommandText = "CREATE TABLE junk(v TEXT)";
            t.ExecuteNonQuery();
            using var tx = c.BeginTransaction();
            using var ins = c.CreateCommand(); ins.Transaction = tx;
            ins.CommandText = "INSERT INTO junk VALUES ($v)"; var p = ins.Parameters.Add("$v", SqliteType.Text);
            for (var i = 0; i < 4000; i++) { p.Value = new string('q', 500) + i; ins.ExecuteNonQuery(); }
            tx.Commit();
        }
        db.Checkpoint();
        var big = new FileInfo(path).Length;
        using (var c = db.Open()) { using var d = c.CreateCommand(); d.CommandText = "DELETE FROM junk"; d.ExecuteNonQuery(); }
        db.Checkpoint();
        Assert.Equal(big, new FileInfo(path).Length);            // 只有检查点：文件不缩小（空闲页）
        db.Vacuum();
        Assert.True(new FileInfo(path).Length < big / 4, "VACUUM 后文件应明显缩小");
        var wal = path + "-wal";
        Assert.Equal(0, File.Exists(wal) ? new FileInfo(wal).Length : 0);
    }

    [Fact]
    public void MaintenanceOptions_Defaults_AreOn()
    {
        var o = new LifeOptions().Storage;
        Assert.True(o.CheckpointMinutes > 0);
        Assert.True(o.VacuumHours > 0);
    }

    [Fact]
    public async Task MaintenanceService_RunsOnce_AtStartup_WithoutError()
    {
        using var app = new TestApp();
        var a = await app.LoginAsync(new TestWallet());
        Assert.True(app.Logs.Lines.All(l => !l.Contains("Maintenance failed")));
        var svc = app.Services.GetRequiredService<MaintenanceService>();
        svc.RunOnce(vacuum: true); // 手动跑一轮不应抛
        Assert.NotNull(a);
    }
}
