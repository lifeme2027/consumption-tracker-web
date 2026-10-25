using System.Security.Cryptography;
using System.Text;
using ConsumptionTracker.Web.Storage;

namespace ConsumptionTracker.Web.Auth;

/// <summary>
/// 会话：随机 256 位 token，库里只存 SHA-256 哈希（库文件泄露也无法冒用）。固定过期、可撤销，重启 IIS 后仍有效。
/// </summary>
public sealed class SessionStore
{
    private readonly Database _db;
    private readonly TimeProvider _time;
    private readonly LifeOptions.AuthSection _opt;

    public SessionStore(Database db, TimeProvider time, LifeOptions options) { _db = db; _time = time; _opt = options.Auth; }

    public TimeSpan Lifetime => TimeSpan.FromHours(_opt.SessionHours);

    public (string Token, DateTimeOffset ExpiresAt) Create(string address)
    {
        var token = Base64Url(RandomNumberGenerator.GetBytes(32));
        var now = _time.GetUtcNow();
        var expires = now + Lifetime;
        using var c = _db.Open();
        using var tx = c.BeginTransaction();
        Run(c, tx, "DELETE FROM sessions WHERE expires_at <= $now", ("$now", now.ToUnixTimeSeconds()));
        // 每个地址最多保留 N 个会话，超出则删最旧的
        Run(c, tx, """
            DELETE FROM sessions WHERE address = $a AND token_hash IN (
              SELECT token_hash FROM sessions WHERE address = $a ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET $keep)
            """, ("$a", address), ("$keep", Math.Max(0, _opt.MaxSessionsPerAddress - 1)));
        Run(c, tx, "INSERT INTO sessions (token_hash, address, created_at, expires_at) VALUES ($h, $a, $c, $e)",
            ("$h", Hash(token)), ("$a", address), ("$c", now.ToUnixTimeSeconds()), ("$e", expires.ToUnixTimeSeconds()));
        tx.Commit();
        return (token, expires);
    }

    /// <summary>校验 token，返回其绑定的地址；无效/过期/伪造返回 null。</summary>
    public string? Validate(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length is < 20 or > 100) return null;
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT address FROM sessions WHERE token_hash = $h AND expires_at > $now";
        cmd.Parameters.AddWithValue("$h", Hash(token));
        cmd.Parameters.AddWithValue("$now", _time.GetUtcNow().ToUnixTimeSeconds());
        return cmd.ExecuteScalar() as string;
    }

    public void Revoke(string? token)
    {
        if (string.IsNullOrEmpty(token)) return;
        using var c = _db.Open();
        Run(c, null, "DELETE FROM sessions WHERE token_hash = $h", ("$h", Hash(token)));
    }

    public int RevokeAll(string address)
    {
        using var c = _db.Open();
        return Run(c, null, "DELETE FROM sessions WHERE address = $a", ("$a", address));
    }

    public static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static int Run(Microsoft.Data.Sqlite.SqliteConnection c, Microsoft.Data.Sqlite.SqliteTransaction? tx, string sql, params (string, object)[] ps)
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        foreach (var (k, v) in ps) cmd.Parameters.AddWithValue(k, v);
        return cmd.ExecuteNonQuery();
    }
}
