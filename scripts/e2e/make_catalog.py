#!/usr/bin/env python3
"""生成合成商品库 catalog.db（纯测试数据，与任何真实商品无关），结构与 CatalogConverter 的约定一致。
用法: make_catalog.py <输出路径> [行数=3000]
固定的合成条码：9900000000017（有参考售价 3.50）、9900000000024（参考售价为空）、9900000000031（分类 45 字，用来测截断）。"""
import os, sqlite3, sys

out = sys.argv[1]
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
if os.path.exists(out):
    os.remove(out)
c = sqlite3.connect(out)
c.execute("CREATE TABLE catalog(barcode TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT, category TEXT, unit TEXT, sale_price_cents INTEGER NULL, cost_price_cents INTEGER NULL, origin TEXT) WITHOUT ROWID")
c.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
data = [("98%011d" % i, "合成商品%d" % i, "规格%dx" % (i % 9), "合成分类%d" % (i % 12), "件", 100 + i, 50 + i, "合成产地") for i in range(rows)]
data += [
    ("9900000000017", "合成测试饮料", "500ml", "合成饮料", "瓶", 350, 200, "合成产地"),
    ("9900000000024", "合成无价商品", "", "合成杂货", "个", None, None, ""),
    ("9900000000031", "合成长分类商品", "", "类" * 45, "个", 1999, 1000, ""),
]
c.executemany("INSERT INTO catalog VALUES(?,?,?,?,?,?,?,?)", data)
c.executemany("INSERT INTO meta VALUES(?,?)", [("row_count", str(len(data))), ("built_at", "2026-10-25T00:00:00Z"), ("source_file", "synthetic")])
c.commit(); c.close()
