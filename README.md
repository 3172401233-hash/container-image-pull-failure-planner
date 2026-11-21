# container-image-pull-failure-planner

节点事件里只有一行 `ErrImagePull`，背后可能是仓库返回 429、凭证过期、tag 已变化，或者节点缓存里只有另一个 digest。本库把这些信号（节点、镜像引用、缓存、额度、凭证状态、Pod deadline）作为输入，为每个候选节点给出明确建议：**重试拉取、等待、切换镜像源、或换节点**。

要求 Node.js >= 24.16.0，无第三方依赖。

## 快速开始

```js
import { plan } from './src/planner.js';

const result = plan({
  image: 'registry.example.com/app:v1.2.3',
  nodes: [
    { name: 'node-a', cache: [{ repo: 'app', digest: 'sha256:…', fetchedAt: 1_800_000_000_000 }], inflightPulls: 0 },
    { name: 'node-b', cache: [], inflightPulls: 3, maxConcurrentPulls: 2 },
  ],
  credentials: [{ id: 'robot$ci', registry: 'registry.example.com', status: 'expired', refreshAt: 1_800_000_030_000 }],
  quota: { 'registry.example.com': { remaining: 0, resetAt: 1_800_000_060_000 } },
  mirrors: [{ registry: 'mirror.example.com', image: 'mirror.example.com/cache/app:v1.2.3' }],
  deadline: 1_800_000_300_000, // Pod 的 deadline（epoch ms）
});

console.log(result.recommendation); // 全局最优建议
console.log(result.decisions);      // 每个节点各自的建议
```

### 输入

| 字段 | 说明 |
| --- | --- |
| `image` | 镜像引用。带 `@sha256:…` 的是**固定 digest**，只带 `:tag`（或缺省 `latest`）的是**浮动 tag** |
| `nodes[].cache[]` | 节点本地缓存：`{ repo, digest, fetchedAt }` |
| `nodes[].inflightPulls` / `maxConcurrentPulls` | 节点当前拉取并发与上限 |
| `credentials[]` | `{ id, registry, status: 'valid' \| 'expired' \| 'invalid', refreshAt? }`，`refreshAt` 是凭证轮换完成时间 |
| `quota` | `{ [registry]: { remaining, resetAt } }`，仓库级拉取额度（429 时 `remaining` 为 0） |
| `mirrors[]` | 备选镜像源，需有独立健康的凭证与额度才会被选中 |
| `deadline` | Pod deadline；任何“等待 + 预计拉取耗时”超出它的方案都会被降级 |
| `resolvedDigest` | （可选）tag 当前在仓库解析到的 digest，用于检测 tag 漂移 |

### 输出

每个节点的决策：`{ node, action, state, reason, delayMs, … }`，`action ∈ schedule | pull | wait | switch-source | reschedule | use-stale-cache | fail`。顶层另含：

- `recommendation`：按 `schedule > pull > use-stale-cache > switch-source > reschedule > wait > fail` 选出的最优决策；
- `credentialCircuit`：凭证熔断器状态（见下）。

## 固定 digest 与浮动 tag 的区别

两者走完全不同的判断路径，这是本库的核心约束：

- **固定 digest** 是内容寻址的，字节永远不变。缓存中存在同一 digest 即直接 `schedule`；缓存中只有**另一个** digest 属于硬冲突（`conflictWith`），缓存完全不可用，只能拉取；任何情况下都**不允许**回退到旧 digest。
- **浮动 tag** 随时可能被仓库重新指向。缓存仅在 `tagTtlMs`（默认 5 分钟）内新鲜时才直接命中；过期或 `resolvedDigest` 与缓存不符（tag moved）时需要重新拉取验证。只有当 deadline 太紧、无法等待额度或凭证时，才允许 `use-stale-cache` 兜底——这条路径对固定 digest 永不开放。

## 凭证熔断器

同一个失效凭证**不能**被每个节点各自重试一遍——那只会放大 401/403 风暴并可能触发仓库封禁。规划器按 registry 只解析一次凭证：状态为 `expired`/`invalid` 时熔断器置为 `open`，本次规划中所有节点都不会得到 `pull`/`retry` 动作，而是统一得到：

1. `switch-source`（存在凭证健康、额度充足的 mirror 时）；否则
2. `wait`（`WAIT_CREDENTIAL`，等待 `refreshAt` 轮换完成，且轮换 + 拉取能在 deadline 前完成）；否则
3. `fail`。

## 状态机

每个节点的决策从 `PENDING` 出发，迁移到唯一终态或等待态：

```
                        ┌──────────────┐
                        │   PENDING    │
                        └──────┬───────┘
        ┌──────────┬──────────┼──────────┬────────────┬─────────────┐
        ▼          ▼          ▼          ▼            ▼             ▼
   CACHE_HIT     PULL    WAIT_QUOTA  WAIT_CRED.   SWITCH_SOURCE   FAILED
   (终态)      ┌───┘          │          │            │
               ▼              ▼          ▼            ▼
           CACHE_HIT       PULL /    PULL /        PULL /
                           SWITCH_   SWITCH_       FAILED
                           SOURCE    SOURCE
        另：WAIT_SLOT（节点并发槽满）、RESCHEDULE（换到有缓存的节点）、
        USE_STALE_CACHE（仅浮动 tag 的兜底）也从 PENDING 出发，
        条件满足后迁移到 PULL / CACHE_HIT，或终止于 FAILED。
```

| 状态 | 含义 | 允许的后续迁移 |
| --- | --- | --- |
| `PENDING` | 初始态，等待判定 | 所有非初始态 |
| `CACHE_HIT` | 缓存可直接使用（digest 命中，或 tag 缓存新鲜且未漂移） | 终态 |
| `PULL` | 立即从仓库拉取（消耗 1 单位共享额度） | `CACHE_HIT`（成功后入缓存）、`FAILED` |
| `WAIT_QUOTA` | 仓库 429 / 额度耗尽，等待 `resetAt` | `PULL`、`SWITCH_SOURCE`、`RESCHEDULE`、`USE_STALE_CACHE`、`FAILED` |
| `WAIT_CREDENTIAL` | 凭证熔断，等待轮换（全集群只等一次） | `PULL`、`SWITCH_SOURCE`、`FAILED` |
| `WAIT_SLOT` | 节点拉取并发槽满 | `PULL`、`RESCHEDULE`、`FAILED` |
| `SWITCH_SOURCE` | 切换到凭证健康、额度充足的 mirror | `PULL`、`FAILED` |
| `RESCHEDULE` | 换到已缓存该镜像的节点 | `CACHE_HIT`、`PULL`、`FAILED` |
| `USE_STALE_CACHE` | deadline 太紧，浮动 tag 退用旧 digest | `PULL`（事后重新验证） |
| `FAILED` | 所有路径都不满足 deadline | 终态 |

状态与迁移表由 `src/machine.js` 中的 `TRANSITIONS` 显式定义，规划器每次产生决策都会经过 `assertTransition` 校验，非法迁移直接抛错。

## 多节点竞争

仓库额度是**跨节点共享**的。规划器把所有需要拉取的节点放进同一个容量池：按节点当前负载排序后，只有前 `quota.remaining` 个节点得到 `pull`，其余节点按优先级降级为 `reschedule`（若已有节点缓存命中）→ `wait`（等待额度重置）→ `switch-source` / `use-stale-cache` → `fail`。

## 测试

```sh
npm test   # node --test
```

`test/planner.test.js` 覆盖：缓存命中（digest 与浮动 tag）、多节点竞争共享额度、鉴权失败熔断（含 mirror 切换与轮换等待）、摘要冲突（固定 digest 硬冲突 vs 浮动 tag 漂移/兜底）。
