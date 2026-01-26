
## 1. 概述

`usagecount`（使用计数）是 PostgreSQL 缓冲区管理中实现**时钟扫描（Clock Sweep）算法**的核心数据结构。它是一种近似 LRU（Least Recently Used）的缓冲区替换策略，在保持较低开销的同时，提供了良好的缓存命中率。
### 设计意图

- **缓存热度评估**: 通过跟踪缓冲页被访问的频率，评估其"热度"
- **高效替换策略**: 避免频繁使用的页面被意外替换出缓冲池
- **性能平衡**: 在 LRU 准确性和实现效率之间取得平衡

根据源代码注释（`buf_internals.h:70-76`）：

> The maximum allowed value of usage_count represents a tradeoff between accuracy and speed of the clock-sweep buffer management algorithm. A large value (comparable to NBuffers) would approximate LRU semantics. But it can take as many as BM_MAX_USAGE_COUNT+1 complete cycles of clock sweeps to find a free buffer, so in practice we don't want the value to be very large.

- **值越大** → 越接近真正的 LRU 算法，但查找空闲缓冲区越慢
- **值越小** → 查找速度快，但替换策略不够精确

PostgreSQL 选择 `BM_MAX_USAGE_COUNT = 5` 作为最佳平衡点。

## 2. 数据结构

### 2.1 状态变量布局

PostgreSQL 将缓冲区的引用计数、使用计数和标志位合并到一个 32 位原子变量 `state` 中：

```c
/* 源文件：src/include/storage/buf_internals.h:29-46 */

/*
 * Buffer state is a single 32-bit variable where following data is combined.
 *
 * - 18 bits refcount
 * - 4 bits usage count
 * - 10 bits of flags
 */
#define BUF_REFCOUNT_ONE 1
#define BUF_REFCOUNT_MASK ((1U << 18) - 1)
#define BUF_USAGECOUNT_MASK 0x003C0000U
#define BUF_USAGECOUNT_ONE (1U << 18)
#define BUF_USAGECOUNT_SHIFT 18
#define BUF_FLAG_MASK 0xFFC00000U
```

| 宏名称                    | 值                | 说明                       |
| ---------------------- | ---------------- | ------------------------ |
| `BUF_REFCOUNT_ONE`     | 1                | refcount增加的步长            |
| `BUF_REFCOUNT_MASK`    | ((1U << 18) - 1) | refcount 掩码 = 0x0003FFFF |
| `BUF_USAGECOUNT_MASK`  | 0x003C0000U      | 掩码：提取 usage_count 字段     |
| `BUF_USAGECOUNT_ONE`   | (1U << 18)       | 增加 1 的步长值 = 0x00040000   |
| `BM_MAX_USAGE_COUNT`   | 5                | usage_count 的最大值         |
| `BUF_USAGECOUNT_SHIFT` | 18               | 右移位数以获取实际计数值             |
| `BUF_FLAG_MASK`        | 0xFFC00000U      | 标志位掩码                    |

### 2.2 位布局图

<img width="1200" height="420" alt="Image" src="https://github.com/user-attachments/assets/22756927-37c8-4079-be19-a51eaa27ff41" />

### 2.3 提取宏定义

```c
/* 源文件：src/include/storage/buf_internals.h:48-50 */

/* Get refcount and usagecount from buffer state */
#define BUF_STATE_GET_REFCOUNT(state) ((state) & BUF_REFCOUNT_MASK)
#define BUF_STATE_GET_USAGECOUNT(state) (((state) & BUF_USAGECOUNT_MASK) >> BUF_USAGECOUNT_SHIFT)
```


### 2.4 usagecount 最大值

```c
/* 源文件：src/include/storage/buf_internals.h:70-77 */

/*
 * The maximum allowed value of usage_count represents a tradeoff between
 * accuracy and speed of the clock-sweep buffer management algorithm.  A
 * large value (comparable to NBuffers) would approximate LRU semantics.
 * But it can take as many as BM_MAX_USAGE_COUNT+1 complete cycles of
 * clock sweeps to find a free buffer, so in practice we don't want the
 * value to be very large.
 */
#define BM_MAX_USAGE_COUNT	5
```

### 2.5 BufferDesc 结构

```c
/* 源文件：src/include/storage/buf_internals.h:182-193 */

typedef struct BufferDesc
{
    BufferTag       tag;              /* 缓冲区包含的页面 ID */
    int             buf_id;           /* 缓冲区索引号 (从 0 开始) */
    pg_atomic_uint32 state;           /* 包含 flags、refcount 和 usagecount */
    int             wait_backend_pid; /* 等待 pin count 的后端 PID */
    int             freeNext;         /* freelist 链表中的链接 */
    LWLock          content_lock;     /* 访问缓冲区内容的锁 */
} BufferDesc;
```

## 3. 时钟扫描算法

### 3.1 算法原理

时钟扫描算法是一种模拟二次机会（Second Chance）算法的页面替换策略：

1. **时钟指针**：`nextVictimBuffer` 作为时钟指针，循环遍历所有缓冲区
2. **使用计数递减**：每当时钟指针经过一个缓冲区，如果 `usagecount > 0` 且 `refcount == 0`，则递减 `usagecount`
3. **缓冲区选择**：当 `usagecount == 0` 且 `refcount == 0` 时，该缓冲区被选为替换目标

### 3.2 算法流程图

<img width="1200" height="1457" alt="Image" src="https://github.com/user-attachments/assets/cc2cbc75-d6b0-4cd8-9039-97933f19f9a1" />

根据 `src/backend/storage/buffer/README:171-197`：

> Each buffer header contains a usage counter, which is incremented (up to a small limit value) whenever the buffer is pinned.

**算法步骤**：

1. 获取 `buffer_strategy_lock`
2. 如果空闲列表非空，取头部缓冲区；若 usage_count > 0 则跳过
3. 若空闲列表为空，使用 `nextVictimBuffer` 指向的缓冲区，并推进指针
4. 若缓冲区被 pin 或 usage_count > 0，递减 usage_count，回到步骤 3
5. 使用该缓冲区

### 3.3 核心数据结构 BufferStrategyControl

```c
/* 源文件：src/backend/storage/buffer/freelist.c:29-61 */

typedef struct
{
    slock_t         buffer_strategy_lock;     /* 自旋锁保护 */

    /* 时钟指针：下一个要考虑的缓冲区索引 */
    pg_atomic_uint32 nextVictimBuffer;

    int             firstFreeBuffer;  /* 空闲缓冲区链表头 */
    int             lastFreeBuffer;   /* 空闲缓冲区链表尾 */

    /* 统计信息 */
    uint32          completePasses;   /* 完整扫描的周期数 */
    pg_atomic_uint32 numBufferAllocs; /* 上次重置后分配的缓冲区数 */

    int             bgwprocno;        /* 后台写进程号 */
} BufferStrategyControl;
```

### 3.4 ClockSweepTick 实现

```c
/* 源文件：src/backend/storage/buffer/freelist.c:112-169 */

static inline uint32
ClockSweepTick(void)
{
    uint32 victim;

    /*
     * 原子性地将时钟指针向前移动一位
     * 如果多个进程同时执行，可能导致缓冲区返回顺序略有偏差
     */
    victim = pg_atomic_fetch_add_u32(&StrategyControl->nextVictimBuffer, 1);

    if (victim >= NBuffers)
    {
        uint32 originalVictim = victim;
        victim = victim % NBuffers;  /* 环绕处理 */

        /* 如果是导致环绕的进程，递增 completePasses */
        if (victim == 0)
        {
            // ... 获取自旋锁并递增 completePasses ...
            StrategyControl->completePasses++;
        }
    }
    return victim;
}
```

### 3.5 StrategyGetBuffer 核心逻辑

```c
/* 源文件：src/backend/storage/buffer/freelist.c:315-358 */

/* 空闲链表为空时，执行时钟扫描算法 */
trycounter = NBuffers;
for (;;)
{
    buf = GetBufferDescriptor(ClockSweepTick());

    /*
     * 如果缓冲区被 pin 或 usagecount 非零，无法使用
     * 递减 usagecount（如果未被 pin）并继续扫描
     */
    local_buf_state = LockBufHdr(buf);

    if (BUF_STATE_GET_REFCOUNT(local_buf_state) == 0)
    {
        if (BUF_STATE_GET_USAGECOUNT(local_buf_state) != 0)
        {
            /* 递减 usagecount，给予"第二次机会" */
            local_buf_state -= BUF_USAGECOUNT_ONE;
            trycounter = NBuffers;  /* 重置计数器 */
        }
        else
        {
            /* 找到可用缓冲区 */
            if (strategy != NULL)
                AddBufferToRing(strategy, buf);
            *buf_state = local_buf_state;
            return buf;
        }
    }
    else if (--trycounter == 0)
    {
        /* 所有缓冲区都被 pin，报错 */
        UnlockBufHdr(buf, local_buf_state);
        elog(ERROR, "no unpinned buffers available");
    }
    UnlockBufHdr(buf, local_buf_state);
}
```

## 4. UsageCount 生命周期

### 4.1 生命周期图解

<img width="1200" height="507" alt="Image" src="https://github.com/user-attachments/assets/f353cd8c-4f69-4293-b756-f1943dedfac2" />

### 4.2 操作时机

| 操作         | 时机              | 函数                    | 行号                 |
| ---------- | --------------- | --------------------- | ------------------ |
| **初始化为 1** | 缓冲区被分配给新页面      | `BufferAlloc()`       | bufmgr.c:1428      |
| **递增**     | 首次 Pin 缓冲区时     | `PinBuffer()`         | bufmgr.c:1719-1733 |
| **递减**     | Clock Sweep 扫描时 | `StrategyGetBuffer()` | freelist.c:329-331 |
| **重置**     | 缓冲区被重新分配        | `BufferAlloc()`       | bufmgr.c:1408-1430 |

### 4.3 增加 UsageCount - PinBuffer()


```c
/* 源文件: src/backend/storage/buffer/bufmgr.c:1692-1771 */
static bool
PinBuffer(BufferDesc *buf, BufferAccessStrategy strategy)
{
    // ... 省略前序代码 ...

    old_buf_state = pg_atomic_read_u32(&buf->state);
    for (;;)
    {
        if (old_buf_state & BM_LOCKED)
            old_buf_state = WaitBufHdrUnlocked(buf);

        buf_state = old_buf_state;

        /* 增加 refcount */
        buf_state += BUF_REFCOUNT_ONE;

        if (strategy == NULL)
        {
            /* 默认情况：除非已达最大值，否则增加 usagecount */
            if (BUF_STATE_GET_USAGECOUNT(buf_state) < BM_MAX_USAGE_COUNT)
                buf_state += BUF_USAGECOUNT_ONE;
        }
        else
        {
            /*
             * 环形缓冲区不应淘汰其他缓冲区。
             * 因此我们不让 usagecount 超过 1。
             */
            if (BUF_STATE_GET_USAGECOUNT(buf_state) == 0)
                buf_state += BUF_USAGECOUNT_ONE;
        }

        if (pg_atomic_compare_exchange_u32(&buf->state, &old_buf_state,
                                           buf_state))
        {
            result = (buf_state & BM_VALID) != 0;
            VALGRIND_MAKE_MEM_DEFINED(BufHdrGetBlock(buf), BLCKSZ);
            break;
        }
    }
    // ... 省略后续代码 ...
}
```

**关键点**:
- 使用 CAS（Compare-And-Swap）循环确保原子性
- 正常策略下：usage_count < 5 时递增
- 环形缓冲区策略：usage_count 最大为 1

### 4.4 重置 UsageCount

```c
/* 源文件: src/backend/storage/buffer/bufmgr.c:1422-1428 */
/*
 * 我们也重置 usage_count，因为旧内容的任何最近使用
 * 都不再相关。（usage_count 从 1 开始，以便缓冲区
 * 可以在一次时钟扫描传递中存活。）
 */
buf_state &= ~(BM_VALID | BM_DIRTY | BM_JUST_DIRTIED |
               BM_CHECKPOINT_NEEDED | BM_IO_ERROR | BM_PERMANENT |
               BUF_USAGECOUNT_MASK);
if (relpersistence == RELPERSISTENCE_PERMANENT || forkNum == INIT_FORKNUM)
    buf_state |= BM_TAG_VALID | BM_PERMANENT | BUF_USAGECOUNT_ONE;
else
    buf_state |= BM_TAG_VALID | BUF_USAGECOUNT_ONE;
```

**设计意图**:
- 新加载的页面初始 usage_count = 1
- 允许页面在缓冲区中至少存活一次完整的时钟扫描

### 4.5 UnpinBuffer 不修改 UsageCount

```c
/* 源文件：src/backend/storage/buffer/bufmgr.c:1840-1890 */
static void
UnpinBuffer(BufferDesc *buf, bool fixOwner)
{
    // ... 省略前序代码 ...

    old_buf_state = pg_atomic_read_u32(&buf->state);
    for (;;)
    {
        if (old_buf_state & BM_LOCKED)
            old_buf_state = WaitBufHdrUnlocked(buf);

        buf_state = old_buf_state;

        /* 仅减少 refcount，不影响 usagecount */
        buf_state -= BUF_REFCOUNT_ONE;

        if (pg_atomic_compare_exchange_u32(&buf->state, &old_buf_state,
                                           buf_state))
            break;
    }
    // ... 省略后续代码 ...
}
```

### 4.6 环形缓冲区策略

使用环形缓冲区（如顺序扫描、VACUUM）时，usagecount 限制为最大 1：

```c
/* 源文件：src/backend/storage/buffer/bufmgr.c:1726-1733 */

else
{
    /*
     * Ring buffers shouldn't evict others from pool.  Thus we
     * don't make usagecount more than 1.
     */
    if (BUF_STATE_GET_USAGECOUNT(buf_state) == 0)
        buf_state += BUF_USAGECOUNT_ONE;
}
```

### 4.7 本地缓冲区（临时表）

本地缓冲区也使用相同的 usagecount 机制：

```c
/* 源文件：src/backend/storage/buffer/localbuf.c:141-148 */

/* this part is equivalent to PinBuffer for a shared buffer */
if (LocalRefCount[b] == 0)
{
    if (BUF_STATE_GET_USAGECOUNT(buf_state) < BM_MAX_USAGE_COUNT)
    {
        buf_state += BUF_USAGECOUNT_ONE;
        pg_atomic_unlocked_write_u32(&bufHdr->state, buf_state);
    }
}
```


## 5. 环形缓冲区与 usagecount

### 5.1 环形缓冲区的设计目的

环形缓冲区是为了处理以下场景设计的，对于顺序扫描（如 VACUUM、COPY），PostgreSQL 使用缓冲区环形策略：

| 策略类型          | 环大小                | 适用场景                            | UsageCount 行为 |
| ------------- | ------------------ | ------------------------------- | ------------- |
| BAS_BULKREAD  | 256KB (32 buffers) | 顺序扫描                            | 限制为 1         |
| BAS_BULKWRITE | 16MB               | COPY IN, CREATE TABLE AS SELECT | 限制为 1         |
| BAS_VACUUM    | 256KB              | VACUUM 操作                       | 限制为 1         |

这些操作会访问大量页面但只访问一次，如果使用普通策略会"冲刷"整个缓冲池，所以分配了专门的缓存区和限制了usage_count数。

**设计意图**: 防止大扫描"污染"缓冲池，同时保持少量缓存以支持同步扫描。

### 5.2 环形缓冲区的 usagecount 检查

```c
/* 源文件：src/backend/storage/buffer/freelist.c:634-651 */

/*
 * If usage_count is 0 or 1 then the buffer is fair game (we expect 1,
 * since our own previous usage of the ring element would have left it
 * there, but it might've been decremented by clock sweep since then). A
 * higher usage_count indicates someone else has touched the buffer, so we
 * shouldn't re-use it.
 */
buf = GetBufferDescriptor(bufnum - 1);
local_buf_state = LockBufHdr(buf);
if (BUF_STATE_GET_REFCOUNT(local_buf_state) == 0
    && BUF_STATE_GET_USAGECOUNT(local_buf_state) <= 1)
{
    strategy->current_was_in_ring = true;
    *buf_state = local_buf_state;
    return buf;
}
```

**设计意图**：
- Ring 策略限制 usage_count 最大为 1
- 如果其他进程访问了 ring 中的缓冲区，usage_count 会 > 1
- 此时 ring 策略将跳过该缓冲区，避免影响其他进程的缓存

## 6. 后台写进程与 usagecount

后台写进程（Background Writer）使用 usagecount 来判断缓冲区是否可能被很快回收：

```
/* 源文件：src/backend/storage/buffer/README:252-257 */

The background writer is designed to write out pages that are likely to be
recycled soon, thereby offloading the writing work from active backends.
To do this, it scans forward circularly from the current position of
nextVictimBuffer (which it does not change!), looking for buffers that are
dirty and not pinned nor marked with a positive usage count.
```

后台写进程会写出那些：
- **脏页**（dirty）
- **未被 pin**（refcount == 0）
- **usagecount == 0** 的缓冲区

```c
/* 源文件：src/backend/storage/buffer/bufmgr.c:2536-2548 */
buf_state = LockBufHdr(bufHdr);

if (BUF_STATE_GET_REFCOUNT(buf_state) == 0 &&
    BUF_STATE_GET_USAGECOUNT(buf_state) == 0)
{
    result |= BUF_REUSABLE;  // 标记为可替换
}
else if (skip_recently_used)
{
    /* Caller told us not to write recently-used buffers */
    UnlockBufHdr(bufHdr, buf_state);
    return result;
}
```


## 7. 调用链分析

### 7.1 usagecount 增加调用链

```
ReadBuffer / ReadBufferExtended
    └─> ReadBuffer_common
        └─> BufferAlloc
            └─> PinBuffer                    [bufmgr.c:1692-1771]
                └─> buf_state += BUF_USAGECOUNT_ONE  [首次 pin 时增加]

或者

LocalBufferAlloc                            [localbuf.c:108-161]
    └─> buf_state += BUF_USAGECOUNT_ONE     [首次本地 pin 时增加]
```

### 7.2 usagecount 减少调用链

```
StrategyGetBuffer                           [freelist.c:200-358]
    └─> ClockSweepTick                      [获取下一个候选缓冲区]
    └─> local_buf_state -= BUF_USAGECOUNT_ONE  [时钟扫描递减]

或者

LocalBufferAlloc                            [localbuf.c:174-206]
    └─> buf_state -= BUF_USAGECOUNT_ONE     [本地时钟扫描递减]
```

源文件位置总结

| 源文件 | 路径 | 功能 |
|--------|------|------|
| **buf_internals.h** | `include/storage/buf_internals.h` | BufferDesc 结构、常量定义、宏 |
| **bufmgr.c** | `backend/storage/buffer/bufmgr.c` | PinBuffer、BufferAlloc、SyncOneBuffer |
| **freelist.c** | `backend/storage/buffer/freelist.c` | StrategyGetBuffer、ClockSweepTick、Ring 管理 |
| **localbuf.c** | `backend/storage/buffer/localbuf.c` | 本地缓冲区的 usage_count 处理 |
| **README** | `backend/storage/buffer/README` | 缓冲区管理算法文档 |


## 8. 性能考量

### 8.1 为什么选择 5 作为最大值？

| usagecount 最大值 | 近似算法 | 最坏情况扫描周期 |
|------------------|---------|----------------|
| 1 | FIFO | 2 周期 |
| 5 | 近似 LRU | 6 周期 |
| NBuffers | 精确 LRU | NBuffers+1 周期 |

选择 5 的原因：
- 提供足够的"第二次机会"来保护热数据
- 限制最坏情况下的扫描开销
- 经验值，在大多数工作负载下表现良好


### 8.2 原子操作优化

将 usagecount 与 refcount、flags 合并的好处：

1. **单次 CAS 更新**：pin 操作可以同时更新 refcount 和 usagecount
2. **减少内存访问**：32 位状态变量可以在单个缓存行内处理
3. **无锁读取**：状态检查不需要获取自旋锁

```c
/* 源文件：src/backend/storage/buffer/bufmgr.c:1735-1737 */

if (pg_atomic_compare_exchange_u32(&buf->state, &old_buf_state,
                                   buf_state))
{
    result = (buf_state & BM_VALID) != 0;
    break;
}
```

### 8.3 缓存行对齐


```c
/* 源文件：src/include/storage/buf_internals.h:195-221 */
/*
 * Concurrent access to buffer headers has proven to be more efficient if
 * they're cache line aligned. So we force the start of the BufferDescriptors
 * array to be on a cache line boundary and force the elements to be cache
 * line sized.
 *
 * XXX: As this is primarily matters in highly concurrent workloads which
 * probably all are 64bit these days, and the space wastage would be a bit
 * more noticeable on 32bit systems, we don't force the stride to be cache
 * line sized on those. If somebody does actual performance testing, we can
 * reevaluate.
 *
 * Note that local buffer descriptors aren't forced to be aligned - as there's
 * no concurrent access to those it's unlikely to be beneficial.
 *
 * We use a 64-byte cache line size here, because that's the most common
 * size. Making it bigger would be a waste of memory. Even if running on a
 * platform with either 32 or 128 byte line sizes, it's good to align to
 * boundaries and avoid false sharing.
 */
#define BUFFERDESC_PAD_TO_SIZE  (SIZEOF_VOID_P == 8 ? 64 : 1)

typedef union BufferDescPadded
{
    BufferDesc  bufferdesc;
    char        pad[BUFFERDESC_PAD_TO_SIZE];
} BufferDescPadded;
```

确保每个 BufferDesc 占用独立的缓存行（64 字节），避免伪共享（false sharing）。
## 9. 查看 usagecount

### 9.1 pg_buffercache 扩展

PostgreSQL 提供了 `pg_buffercache` 扩展来查看缓冲区状态：

```sql
-- 安装扩展
CREATE EXTENSION pg_buffercache;

-- 查看所有缓冲区的 usagecount 分布
SELECT usagecount, count(*)
FROM pg_buffercache
GROUP BY usagecount
ORDER BY usagecount;

-- 查看特定表的缓冲区使用情况
SELECT c.relname, b.usagecount, count(*)
FROM pg_buffercache b
JOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
WHERE c.relname = 'your_table_name'
GROUP BY c.relname, b.usagecount
ORDER BY b.usagecount;
```

### 9.2 扩展实现

```c
/* 源文件：contrib/pg_buffercache/pg_buffercache_pages.c:161 */

fctx->record[i].usagecount = BUF_STATE_GET_USAGECOUNT(buf_state);
```

## 10. 总结

PostgreSQL 的 usagecount 机制是缓冲区管理的核心组件，它通过以下方式实现高效的缓冲区替换：

1. **近似 LRU 的简化实现**：使用 4 位存储 usage_count，最大值为 5，避免了传统 LRU 算法的复杂链表维护开销，同时保留了足够的使用频率区分能力。

2. **原子操作的高效并发**：将 usage_count 与 refcount、flags 打包在单个 32 位原子变量中，通过 CAS (Compare-And-Swap) 循环实现无锁并发访问，大幅提升多核环境下的性能。

3. **批量操作的缓存隔离**：Ring 策略通过限制 usage_count ≤ 1，确保 VACUUM、顺序扫描等批量操作不会"污染"整个缓冲池，这是数据库系统中非常精妙的性能优化技巧。

## 参考资料

- PostgreSQL 14.4 源代码
- `src/include/storage/buf_internals.h` - 数据结构定义
- `src/backend/storage/buffer/freelist.c` - 时钟扫描算法实现
- `src/backend/storage/buffer/bufmgr.c` - 缓冲区管理核心逻辑
- `src/backend/storage/buffer/README` - 缓冲区管理文档
