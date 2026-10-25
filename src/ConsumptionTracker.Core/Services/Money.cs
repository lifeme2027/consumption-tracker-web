using System.Globalization;

namespace ConsumptionTracker.Core.Services;

/// <summary>
/// 金额工具：全部按「分」整数计算，避免浮点误差。
/// 三端（手机/桌面/网站）统一规则，测试向量见 shared-vectors/money.json、shared-vectors/quantity.json：
/// <list type="bullet">
/// <item>金额字符串→分：十进制字符串精确解析，不经过二进制浮点；超过两位小数按「四舍五入半进位 (half-up)」到分。1.005→101，2.675→268。</item>
/// <item>语法：可选前导 ¥/￥，ASCII 数字 + 可选「.」加 1 位以上数字；不接受负号、指数、空白内部字符、「5.」「.5」。</item>
/// <item>逗号：只接受严格千分位（首组 1-3 位，其后每组恰好 3 位），且「单个逗号分组」必须带小数点（1,234.50 可，1,234 有歧义拒绝；1,234,567 可）。12,5、1,5 一律拒绝并提示「请用小数点」。</item>
/// <item>价格上限 10 亿元；数量 &gt;0、最多 6 位小数、不超过 1,000,000。</item>
/// </list>
/// </summary>
public static class Money
{
    public const long MaxPriceCents = 100_000_000_000L; // 10 亿元
    public const decimal MaxQuantity = 1_000_000m;
    public const int MaxQuantityDecimals = 6;

    public const string PriceFormatHint = "价格无效（需为不小于 0 的数字，小数请用小数点，如 12.50）";
    public const string QuantityFormatHint = "数量无效（需大于 0，最多 6 位小数，不超过 1000000）";
    public const string PriceFormatHintEn = "Invalid price (a number not less than 0; use a decimal point, e.g. 12.50)";
    public const string QuantityFormatHintEn = "Invalid quantity (greater than 0, at most 6 decimal places, not more than 1000000)";

    /// <summary>导入用：解释价格文本为什么不合格（合格返回 null）。给出具体原因而不是笼统的「无效」。</summary>
    public static RuleProblem? PriceProblem(string? text)
    {
        if (TryParseYuan(text, out _)) return null;
        var s = (text ?? "").Trim();
        if (s.Length == 0) return new("价格为空", "Price is empty");
        if (s[0] == '¥' || s[0] == '￥') s = s[1..].TrimStart();
        if (s.StartsWith('-')) return new("价格不能为负数", "Price cannot be negative");
        var plain = s.Replace(",", "");
        var dot = plain.IndexOf('.');
        var whole = (dot < 0 ? plain : plain[..dot]).TrimStart('0');
        var syntaxOk = AllDigits(whole) && (dot < 0 || AllDigits(plain[(dot + 1)..]));
        if (syntaxOk && whole.Length > 0 && (whole.Length >= 10 || long.Parse(whole, CultureInfo.InvariantCulture) * 100 > MaxPriceCents))
            return new("价格过大（最多 10 亿元）", "Price too large (max 1,000,000,000 yuan)");
        return new(PriceFormatHint, PriceFormatHintEn);
    }

    /// <summary>导入用：解释数量文本为什么不合格（合格返回 null）。</summary>
    public static RuleProblem? QuantityProblem(string? text)
    {
        if (TryParseQuantity(text, out _)) return null;
        var s = (text ?? "").Trim();
        if (s.Length == 0) return new("数量为空", "Quantity is empty");
        if (s.StartsWith('-')) return new("数量必须大于 0", "Quantity must be greater than 0");
        var dot = s.IndexOf('.');
        var intPart = dot < 0 ? s : s[..dot];
        var frac = dot < 0 ? "" : s[(dot + 1)..];
        if (intPart.Length > 0 && AllDigits(intPart) && AllDigits(frac) && !(dot >= 0 && frac.Length == 0))
        {
            if (frac.Length > MaxQuantityDecimals) return new($"数量最多 {MaxQuantityDecimals} 位小数", $"Quantity allows at most {MaxQuantityDecimals} decimal places");
            if (intPart.TrimStart('0').Length > 7 || decimal.Parse(s, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture) > MaxQuantity)
                return new("数量过大（最多 1000000）", "Quantity too large (max 1,000,000)");
            return new("数量必须大于 0", "Quantity must be greater than 0");
        }
        return new(QuantityFormatHint, QuantityFormatHintEn);
    }

    /// <summary>decimal 元 → 分（decimal 本身是十进制精确的，半进位）。仅用于已是 decimal 的 JSON 数值。</summary>
    public static long ToCents(decimal yuan) => (long)Math.Round(yuan * 100m, MidpointRounding.AwayFromZero);

    public static decimal ToYuan(long cents) => cents / 100m;

    /// <summary>单价(分) × 数量 = 金额(分)，四舍五入半进位。例：777 分 × 2.5 = 1943 分。</summary>
    public static long AmountCents(long priceCents, decimal quantity) =>
        (long)Math.Round(priceCents * quantity, MidpointRounding.AwayFromZero);

    public static string FormatYuan(long cents)
    {
        var sign = cents < 0 ? "-" : "";
        var abs = Math.Abs(cents);
        return $"{sign}¥{abs / 100}.{abs % 100:00}";
    }

    /// <summary>数量显示文本：保留全部有效小数位（去掉末尾 0），不丢精度。</summary>
    public static string FormatQuantity(decimal quantity) =>
        quantity.ToString("0.############################", CultureInfo.InvariantCulture);

    /// <summary>
    /// 解析用户输入的元金额为分（规则见类注释）。负数/空/非法/有歧义返回 false。
    /// </summary>
    public static bool TryParseYuan(string? text, out long cents)
    {
        cents = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;
        var s = text.Trim();
        if (s[0] == '¥' || s[0] == '￥') s = s[1..].TrimStart();
        if (s.Length == 0) return false;

        var dot = s.IndexOf('.');
        var intPart = dot < 0 ? s : s[..dot];
        var frac = dot < 0 ? "" : s[(dot + 1)..];
        if (dot >= 0 && frac.Length == 0) return false;
        if (!AllDigits(frac)) return false;

        if (intPart.Contains(','))
        {
            if (!StrictThousands(intPart, hasDecimalPoint: dot >= 0)) return false;
            intPart = intPart.Replace(",", "");
        }
        if (intPart.Length == 0 || !AllDigits(intPart)) return false;

        intPart = intPart.TrimStart('0');
        if (intPart.Length > 10) return false; // 防溢出；真正上限在下面比较
        var whole = intPart.Length == 0 ? 0L : long.Parse(intPart, CultureInfo.InvariantCulture);
        var f2 = frac.Length >= 2 ? frac[..2] : frac.PadRight(2, '0');
        var value = whole * 100 + int.Parse(f2, CultureInfo.InvariantCulture);
        if (frac.Length > 2 && frac[2] >= '5') value++; // half-up：第三位 >=5 即进位（精确十进制判断，非浮点）
        if (value > MaxPriceCents) return false;
        cents = value;
        return true;
    }

    /// <summary>解析数量：大于 0 的十进制，最多 6 位小数，不超过 1,000,000；不接受逗号。</summary>
    public static bool TryParseQuantity(string? text, out decimal quantity)
    {
        quantity = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;
        var s = text.Trim();
        var dot = s.IndexOf('.');
        var intPart = dot < 0 ? s : s[..dot];
        var frac = dot < 0 ? "" : s[(dot + 1)..];
        if (intPart.Length == 0 || !AllDigits(intPart) || !AllDigits(frac)) return false;
        if (dot >= 0 && frac.Length == 0) return false;
        if (frac.Length > MaxQuantityDecimals || intPart.TrimStart('0').Length > 7) return false;
        var v = decimal.Parse(s, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
        if (v <= 0 || v > MaxQuantity) return false;
        quantity = v;
        return true;
    }

    private static bool AllDigits(string s)
    {
        foreach (var c in s) if (c < '0' || c > '9') return false;
        return true;
    }

    /// <summary>严格千分位：首组 1-3 位数字，其后每组「逗号 + 恰好 3 位」；单个分组且无小数点时有歧义（1,234 可能是 1.234）→ 拒绝。</summary>
    private static bool StrictThousands(string intPart, bool hasDecimalPoint)
    {
        var groups = intPart.Split(',');
        if (groups.Length < 2) return false;
        if (groups[0].Length is < 1 or > 3 || !AllDigits(groups[0])) return false;
        for (var i = 1; i < groups.Length; i++)
            if (groups[i].Length != 3 || !AllDigits(groups[i])) return false;
        if (groups.Length == 2 && !hasDecimalPoint) return false;
        return true;
    }
}
