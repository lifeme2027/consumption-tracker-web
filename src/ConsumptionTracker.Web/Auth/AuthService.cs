using ConsumptionTracker.Web.Kaspa;

namespace ConsumptionTracker.Web.Auth;

public sealed record ChallengeResult(bool Ok, Challenge? Challenge, string? Error, int Status = 400);
public sealed record LoginResult(bool Ok, string? Token, string? Address, DateTimeOffset ExpiresAt, string? Error, int Status = 400);

/// <summary>挑战-签名-会话 登录流程。没有任何只凭地址即可登录的路径（DevLogin 仅供 Development 开关使用）。</summary>
public sealed class AuthService
{
    private readonly ChallengeStore _challenges;
    private readonly SessionStore _sessions;
    private readonly LifeOptions _options;

    public AuthService(ChallengeStore challenges, SessionStore sessions, LifeOptions options)
    {
        _challenges = challenges; _sessions = sessions; _options = options;
    }

    public ChallengeResult IssueChallenge(string? address)
    {
        if (!KaspaAddress.TryNormalize(address, _options.Kaspa.Network, out var addr, out var err))
            return new(false, null, err);
        var c = _challenges.Issue(addr);
        return c == null ? new(false, null, "请求过于频繁，请稍后再试", 429) : new(true, c, null);
    }

    public LoginResult Verify(string? address, string? nonce, string? signature)
    {
        if (!KaspaAddress.TryNormalize(address, _options.Kaspa.Network, out var addr, out var err))
            return Fail(err);
        // 一次性：取走即删，之后无论签名对错该 nonce 都作废（重放必失败）
        var ch = _challenges.Consume(nonce, addr);
        if (ch == null) return Fail("挑战无效或已过期，请重新登录", 401);
        // 永远用服务端保存的消息验签，不接受客户端提交的消息文本
        var check = KaspaMessageSigner.Verify(addr, ch.Message, signature, _options.Kaspa.Network);
        if (!check.Valid) return Fail("签名校验失败", 401);
        return Issue(addr);
    }

    /// <summary>仅供 Development 开关使用：跳过签名，直接按地址发会话。生产环境端点不注册。</summary>
    public LoginResult DevLogin(string? address)
    {
        if (!KaspaAddress.TryNormalize(address, _options.Kaspa.Network, out var addr, out var err)) return Fail(err);
        return Issue(addr);
    }

    private LoginResult Issue(string addr)
    {
        var (token, exp) = _sessions.Create(addr);
        return new(true, token, addr, exp, null);
    }

    public string? Authenticate(string? token) => _sessions.Validate(token);
    public void Logout(string? token) => _sessions.Revoke(token);

    private static LoginResult Fail(string? e, int status = 400) => new(false, null, null, default, e, status);
}
