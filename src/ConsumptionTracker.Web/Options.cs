namespace ConsumptionTracker.Web;

/// <summary>配置节 "Life"。生产覆盖请写在 appsettings.Production.json 或环境变量 Life__*。</summary>
public sealed class LifeOptions
{
    public const string Section = "Life";

    public KaspaSection Kaspa { get; set; } = new();
    public AuthSection Auth { get; set; } = new();
    public StorageSection Storage { get; set; } = new();
    public CookieSection Cookie { get; set; } = new();
    public LimitsSection Limits { get; set; } = new();
    public QuerySection Query { get; set; } = new();

    public sealed class KaspaSection
    {
        /// <summary>mainnet（kaspa:）。仅用于地址前缀校验。</summary>
        public string Network { get; set; } = "mainnet";
    }

    public sealed class AuthSection
    {
        /// <summary>写进签名消息的站点名，让用户在钱包弹窗里看清是给哪个站点签名。</summary>
        public string Domain { get; set; } = "life.kastop.com";
        public int ChallengeSeconds { get; set; } = 300;
        public int SessionHours { get; set; } = 12;
        public int MaxPendingChallengesPerAddress { get; set; } = 5;
        public int MaxPendingChallenges { get; set; } = 20000;
        public int MaxSessionsPerAddress { get; set; } = 10;
        /// <summary>仅 Development 环境且此项为 true 时才注册 /api/auth/dev-login；生产默认并强制关闭。</summary>
        public bool DevLogin { get; set; }
    }

    public sealed class StorageSection
    {
        /// <summary>SQLite 所在目录；相对路径相对于站点根目录。</summary>
        public string DataDir { get; set; } = "App_Data";
        public string DatabaseFile { get; set; } = "life.db";
        public int MaxRecordsPerUser { get; set; } = 50000;
        /// <summary>定期 WAL 检查点（TRUNCATE）的间隔（分钟）。0 = 关闭。</summary>
        public int CheckpointMinutes { get; set; } = 60;
        /// <summary>定期 VACUUM 的间隔（小时）。0 = 关闭。</summary>
        public int VacuumHours { get; set; } = 24;
    }

    public sealed class CookieSection
    {
        public string Name { get; set; } = "ct_session";
        /// <summary>生产必须为 true（仅 HTTPS 发送）。Development 下自动放宽。</summary>
        public bool RequireSecure { get; set; } = true;
    }

    /// <summary>记录查询分页：不带 limit 时用默认页大小；limit 上限防止一次吐出全部数据。</summary>
    public sealed class QuerySection
    {
        public int DefaultPageSize { get; set; } = 2000;
        public int MaxPageSize { get; set; } = 5000;
    }

    public sealed class LimitsSection
    {
        public int ChallengePerMinute { get; set; } = 10;
        public int VerifyPerMinute { get; set; } = 20;
        public int ApiPerMinute { get; set; } = 300;
        public int DefaultBodyBytes { get; set; } = 64 * 1024;
        public int ImportBodyBytes { get; set; } = 5 * 1024 * 1024;
    }
}
