using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace ConsumptionTracker.Web.Auth;

public sealed record Challenge(string Nonce, string Address, string Message, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt);

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

    /// <summary>签发挑战；超限返回 null。</summary>
    public Challenge? Issue(string address)
    {
        var now = _time.GetUtcNow();
        Purge(now);
        if (_items.Count >= _opt.MaxPendingChallenges) return null;
        if (_items.Values.Count(c => c.Address == address) >= _opt.MaxPendingChallengesPerAddress) return null;

        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var expires = now.AddSeconds(_opt.ChallengeSeconds);
        var message = BuildMessage(_opt.Domain, address, nonce, now, expires);
        var c = new Challenge(nonce, address, message, now, expires);
        _items[nonce] = c;
        return c;
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
