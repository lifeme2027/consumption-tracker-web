namespace ConsumptionTracker.Web.Storage;

/// <summary>
/// 数据库定期维护：WAL 检查点（TRUNCATE）+ VACUUM。
/// 目的：已删除的数据不会长期留在 life.db-wal / 空闲页里。
/// IIS 空闲会回收进程，所以「上次 VACUUM 时间」记在数据库旁的 .vacuumed 标记文件里（看修改时间），
/// 启动时若已到期就补做一次，不依赖进程长期存活。
/// </summary>
public sealed class MaintenanceService : BackgroundService
{
    private readonly Database _db;
    private readonly LifeOptions.StorageSection _opt;
    private readonly TimeProvider _time;
    private readonly ILogger<MaintenanceService> _log;
    private string Marker => _db.Path + ".vacuumed";

    public MaintenanceService(Database db, LifeOptions options, TimeProvider time, ILogger<MaintenanceService> log)
    {
        _db = db; _opt = options.Storage; _time = time; _log = log;
    }

    public bool VacuumDue()
    {
        if (_opt.VacuumHours <= 0) return false;
        try
        {
            if (!File.Exists(Marker)) return true;
            return _time.GetUtcNow() - new DateTimeOffset(File.GetLastWriteTimeUtc(Marker), TimeSpan.Zero) >= TimeSpan.FromHours(_opt.VacuumHours);
        }
        catch { return true; }
    }

    /// <summary>跑一轮维护；任何失败只记日志（不含数据内容），不影响服务。</summary>
    public void RunOnce(bool vacuum)
    {
        try
        {
            if (vacuum)
            {
                _db.Vacuum();
                File.WriteAllText(Marker, _time.GetUtcNow().ToString("O"));
            }
            else _db.Checkpoint();
        }
        catch (Exception e)
        {
            _log.LogWarning("Maintenance failed ({Kind}): {Message}", vacuum ? "vacuum" : "checkpoint", e.Message);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (_opt.CheckpointMinutes <= 0 && _opt.VacuumHours <= 0) return;
        try
        {
            await Task.Yield(); // 不阻塞启动
            RunOnce(VacuumDue());
            var every = TimeSpan.FromMinutes(_opt.CheckpointMinutes > 0 ? _opt.CheckpointMinutes : 60);
            using var timer = new PeriodicTimer(every);
            while (await timer.WaitForNextTickAsync(stop))
                RunOnce(VacuumDue());
        }
        catch (OperationCanceledException) { }
    }
}
