using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace ConsumptionTracker.Web.Auth;

public sealed record Challenge(string Nonce, string Address, string Message, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt, long Seq = 0);

/// <summary>
/// 登录挑战（内存）：随机 nonce + 时间戳 + 地址 + 站点名写进待签名文本。
/// 一次性（取走即删，无论成功失败都不可再用）、短有效期、带数量上限。
/// 进程重启会丢失未使用的挑战，用户重新点登录即可。
/// </summary>
public sealed class ChallengeStore
{
    private readonly ConcurrentDictionary<string, Challenge> _items = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;
    private readonly LifeOptions.AuthSection _opt;

    public ChallengeStore(TimeProvider time, LifeOptions options) { _time = time; _opt = options.Auth; }

    public int PendingCount => _items.Count;

    private readonly object _issueLock = new();
    private long _seq;

    /// <summary>
    /// 签发挑战。超过「每地址」或「全局」上限时，淘汰最旧的未使用挑战而不是拒绝新请求——
    /// 否则任何人只要对受害者地址连续申请 5 个挑战，就能把该地址的真实登录挤成 429（M-2）。
    /// 已过期的先清掉；淘汰按签发顺序（Seq）而不是时间戳，保证同一时刻签发的也有确定顺序。
    /// </summary>
    public Challenge Issue(string address)
    {
        lock (_issueLock)
        {
            var now = _time.GetUtcNow();
            Purge(now);

            while (_items.Count >= _opt.MaxPendingChallenges && EvictOldest(null)) { }
            while (_items.Values.Count(c => c.Address == address) >= _opt.MaxPendingChallengesPerAddress && EvictOldest(address)) { }

            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var expires = now.AddSeconds(_opt.ChallengeSeconds);
            var message = BuildMessage(_opt.Domain, address, nonce, now, expires);
            var c = new Challenge(nonce, address, message, now, expires, ++_seq);
            _items[nonce] = c;
            return c;
        }
    }

    private bool EvictOldest(string? address)
    {
        Challenge? oldest = null;
        foreach (var c in _items.Values)
            if ((address == null || c.Address == address) && (oldest == null || c.Seq < oldest.Seq)) oldest = c;
        return oldest != null && _items.TryRemove(oldest.Nonce, out _);
    }

    /// <summary>取走并删除挑战（一次性）。不存在/已过期/地址不符返回 null。</summary>
    public Challenge? Consume(string? nonce, string address)
    {
        if (string.IsNullOrEmpty(nonce) || nonce.Length > 64) return null;
        if (!_items.TryRemove(nonce, out var c)) return null;
        if (c.ExpiresAt <= _time.GetUtcNow()) return null;
        if (!string.Equals(c.Address, address, StringComparison.Ordinal)) return null;
        return c;
    }

    private void Purge(DateTimeOffset now)
    {
        foreach (var (k, v) in _items)
            if (v.ExpiresAt <= now) _items.TryRemove(k, out _);
    }

    public static string BuildMessage(string domain, string address, string nonce, DateTimeOffset issued, DateTimeOffset expires)
    {
        var sb = new StringBuilder();
        sb.Append(domain).Append(" 登录验证\n");
        sb.Append("地址: ").Append(address).Append('\n');
        sb.Append("Nonce: ").Append(nonce).Append('\n');
        sb.Append("签发时间: ").Append(issued.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")).Append('\n');
        sb.Append("有效期至: ").Append(expires.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")).Append('\n');
        sb.Append("此签名仅用于登录，不会产生任何链上交易，也不会授权转账。");
        return sb.ToString();
    }
}
