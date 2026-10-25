#!/usr/bin/env bash
# 本地端到端冒烟：Kestrel + curl（仅 Development + Life__Auth__DevLogin=true 时可用）
# 用法: scripts/smoke.sh   （需要 dotnet 8；会自建临时数据目录，结束后清理）
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-5078}; BASE=http://127.0.0.1:$PORT
DATA=$(mktemp -d); JAR=$(mktemp); LOG=$(mktemp)
ADDR=${SMOKE_ADDR:-$(python3 scripts/gen_address.py)}
EXP=$(mktemp)
H=(-H 'X-Requested-With: life-web' -H 'Content-Type: application/json')
dotnet build src/ConsumptionTracker.Web -c Release -v q --nologo >/dev/null
start() {
  ASPNETCORE_ENVIRONMENT=${1} Life__Auth__DevLogin=${2} Life__Storage__DataDir=$DATA ASPNETCORE_URLS=$BASE \
    dotnet src/ConsumptionTracker.Web/bin/Release/net8.0/ConsumptionTrackerWeb.dll >>"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do curl -fs $BASE/healthz >/dev/null 2>&1 && return; sleep 0.2; done
  echo "server did not start"; cat "$LOG"; exit 1
}
stop() { kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true; }
trap 'stop; rm -rf "$DATA" "$JAR" "$LOG" "$EXP"' EXIT
ok() { echo "  ✔ $1"; }
fail() { echo "  ✘ $1"; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "[1] Production 环境：dev-login 必须不存在"
start Production true
[ "$(code -X POST "${H[@]}" -d "{\"address\":\"$ADDR\"}" $BASE/api/auth/dev-login)" = 404 ] && ok "Production 下 dev-login=404（即使配置了开关）" || fail "dev-login 在 Production 可用！"
[ "$(code $BASE/api/records/x)" = 401 ] && ok "未登录访问数据接口=401" || fail "未登录可访问"
stop

echo "[2] Development + 开关：注册 → 列表 → 删除 → 导出 → 重启后仍在"
start Development true
[ "$(code -c $JAR -X POST "${H[@]}" -d "{\"address\":\"$ADDR\"}" $BASE/api/auth/dev-login)" = 200 ] && ok "dev-login 成功" || fail "dev-login"
ID1=$(curl -s -b $JAR "${H[@]}" -d '{"barcode":"690123","name":"阿莫西林","priceCents":1250,"quantity":2,"category":"药品","date":"2026-10-20","patient":"妈妈","dosage":"0.5g×24片","batchName":"方1","note":"饭后"}' $BASE/api/records | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
ID2=$(curl -s -b $JAR "${H[@]}" -d '{"name":"午饭","priceCents":3000,"quantity":1,"category":"餐饮","date":"2026-10-20"}' $BASE/api/records | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
N=$(curl -s -b $JAR "${H[@]}" -d '{}' $BASE/api/records/query | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["count"],d["totalCents"])')
[ "$N" = "2 5500" ] && ok "列表 2 条，合计 5500 分" || fail "列表: $N"
[ "$(code -b $JAR -X DELETE "${H[@]}" $BASE/api/records/$ID2)" = 200 ] && ok "删除成功" || fail "删除"
curl -s -b $JAR $BASE/api/export.json -o $EXP
python3 - "$EXP" <<'P' && ok "导出 JSON：app=consumption-tracker version=2，含 price 与 priceCents"
import json,sys
d=json.load(open(sys.argv[1]));r=d["records"]
assert d["app"]=="consumption-tracker" and d["version"]==2 and len(r)==1 and r[0]["priceCents"]==1250 and abs(r[0]["price"]-12.5)<1e-9, d
P
:
curl -s -b $JAR $BASE/api/export.csv | head -c 3 | od -An -tx1 | tr -d " \n" | grep -q efbbbf && ok "CSV 以 UTF-8 BOM 开头" || fail "CSV BOM"
stop
echo "  … 重启服务（会话与数据均应保留）"
start Development true
N=$(curl -s -b $JAR "${H[@]}" -d '{}' $BASE/api/records/query | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["count"],d["records"][0]["name"],d["records"][0]["patient"])')
[ "$N" = "1 阿莫西林 妈妈" ] && ok "重启后数据与登录态仍在: $N" || fail "重启后: $N"
[ "$(code -b $JAR -X POST "${H[@]}" -d '{"confirm":"DELETE"}' $BASE/api/account/delete-data)" = 200 ] && ok "一键删除全部数据（带确认）" || fail "delete-data"
stop
if grep -q -E '阿莫西林|妈妈|午饭|饭后' "$LOG"; then fail "日志中出现记录内容"; else ok "服务日志不含记录内容"; fi
echo "SMOKE OK"
