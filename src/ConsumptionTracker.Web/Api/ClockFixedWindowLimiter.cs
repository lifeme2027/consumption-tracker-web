using System.Threading.RateLimiting;

namespace ConsumptionTracker.Web.Api;

/// <summary>
/// 固定窗口限流（每个分区一个实例），与内置 FixedWindowRateLimiter 的区别：
/// 被拒时的 RetryAfter 是「距当前窗口结束还剩多久」，而不是整个窗口长度；
/// 时间取自注入的 TimeProvider（测试可控）。无排队，不自动补充。
/// </summary>
public sealed class ClockFixedWindowLimiter : RateLimiter
{
    private readonly int _limit;
    private readonly TimeSpan _window;
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private DateTimeOffset _start;
    private int _count;
    private long _acquired, _rejected;

    public ClockFixedWindowLimiter(int permitLimit, TimeSpan window, TimeProvider time)
    {
        _limit = permitLimit; _window = window; _time = time;
        _start = time.GetUtcNow();
    }

    public override TimeSpan? IdleDuration
    {
        get
        {
            lock (_gate)
            {
                var over = _time.GetUtcNow() - (_start + _window);
                return over > TimeSpan.Zero ? over : null;
            }
        }
    }

    public override RateLimiterStatistics? GetStatistics()
    {
        lock (_gate)
            return new RateLimiterStatistics { CurrentAvailablePermits = Math.Max(0, _limit - _count), CurrentQueuedCount = 0, TotalSuccessfulLeases = _acquired, TotalFailedLeases = _rejected };
    }

    protected override RateLimitLease AttemptAcquireCore(int permitCount)
    {
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            if (now - _start >= _window) { _start = now; _count = 0; }
            if (permitCount <= 0 || _count + permitCount <= _limit)
            {
                _count += Math.Max(0, permitCount); _acquired++;
                return Lease.Ok;
            }
            _rejected++;
            var wait = _start + _window - now;
            if (wait < TimeSpan.Zero) wait = TimeSpan.Zero;
            return new Lease(wait);
        }
    }

    protected override ValueTask<RateLimitLease> AcquireAsyncCore(int permitCount, CancellationToken cancellationToken) =>
        new(AttemptAcquireCore(permitCount));

    private sealed class Lease : RateLimitLease
    {
        public static readonly Lease Ok = new(null);
        private readonly TimeSpan? _retry;
        public Lease(TimeSpan? retry) => _retry = retry;
        public override bool IsAcquired => _retry == null;
        public override IEnumerable<string> MetadataNames { get { if (_retry != null) yield return MetadataName.RetryAfter.Name; } }
        public override bool TryGetMetadata(string metadataName, out object? metadata)
        {
            if (_retry != null && metadataName == MetadataName.RetryAfter.Name) { metadata = _retry.Value; return true; }
            metadata = null; return false;
        }
    }
}
