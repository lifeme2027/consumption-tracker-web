using ConsumptionTracker.Web.Kaspa;

namespace ConsumptionTracker.Web.Storage;

/// <summary>按地址取仓储的唯一入口。address 必须是已通过校验的规范地址。</summary>
public sealed class UserStore
{
    private readonly Database _db;
    private readonly LifeOptions _options;

    public UserStore(Database db, LifeOptions options) { _db = db; _options = options; }

    public UserRepository ForUser(string normalizedAddress)
    {
        if (!KaspaAddress.TryNormalize(normalizedAddress, _options.Kaspa.Network, out var n, out _) || n != normalizedAddress)
            throw new ArgumentException("非法地址");
        return new UserRepository(_db, n, _options.Storage.MaxRecordsPerUser);
    }
}
