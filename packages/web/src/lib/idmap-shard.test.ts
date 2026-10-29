import assert from "node:assert/strict";
import { test } from "node:test";
import { idmapShardId } from "@dsh-shelfry/schema";

test("idmapShardId：落在 [0, count) 范围内", () => {
  for (const id of ["a/b", "Aisland-SJL/dsh-worktable", "x/y".repeat(30)]) {
    const shard = idmapShardId(id, 64);
    assert.ok(Number.isInteger(shard) && shard >= 0 && shard < 64, `${id} → ${shard}`);
  }
});

test("idmapShardId：同一输入结果稳定（跨进程一致）", () => {
  assert.equal(idmapShardId("Aisland-SJL/dsh-worktable", 64), idmapShardId("Aisland-SJL/dsh-worktable", 64));
});

test("idmapShardId：大小写不敏感，同仓库必落同片", () => {
  assert.equal(idmapShardId("Aisland-SJL/dsh-worktable", 64), idmapShardId("aisland-sjl/dsh-worktable", 64));
});

test("idmapShardId：样本能铺满全部分片，不出现空片", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i += 1) seen.add(idmapShardId(`owner-${i}/repo-${i}`, 64));
  assert.equal(seen.size, 64);
});
