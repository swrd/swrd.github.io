
## 一、Buffer Pin 的本质：三个字——"不准动"

### 1.1 核心定义

**Pin**（钉住）的含义非常简单：

> 只要有进程对某个 Buffer 持有 Pin，这个 Buffer 就**绝对不会**被淘汰替换。

这是 PostgreSQL 缓冲区管理的**硬性约束**，没有任何例外。

来看源码中的权威定义（`src/backend/storage/buffer/README:35`）：

```
Pins: one must "hold a pin on" a buffer before being allowed to do anything
at all with it. An unpinned buffer is subject to being reclaimed and reused
for a different page at any instant, so touching it is unsafe.
```

翻译过来就是：
- 想对 Buffer 做任何操作，必须先 Pin 住它
- 没有 Pin 的 Buffer 随时可能被回收替换
- 访问未 Pin 的 Buffer 是**不安全**的

### 1.2 refcount：Pin 的技术实现

在 PostgreSQL 中，Pin 是通过 **引用计数（refcount）** 实现的。

每个 Buffer 描述符（`BufferDesc`）中有一个 32 位的 `state` 字段，其中**低 18 位**就是 refcount：

```c
// src/include/storage/buf_internals.h:29-33
/*
 * Buffer state is a single 32-bit variable where following data is combined.
 *
 * - 18 bits refcount      <- Pin 计数
 * - 4 bits usage count    <- 使用频率
 * - 10 bits of flags      <- 状态标志
 */
#define BUF_REFCOUNT_ONE 1
#define BUF_REFCOUNT_MASK ((1U << 18) - 1)  // 最大值 262,143
```

**关键数值**：
- 位宽：18 位
- 最大值：2^18 - 1 = **262,143**
- 含义：最多支持 26 万多个进程同时 Pin 同一个 Buffer

从 `src/include/storage/buf_internals.h` 可以看到，`BufferDesc` 中的 `state` 字段是一个 32 位原子变量，同时存储了 refcount 和 usage_count：


<img width="1098" height="691" alt="Image" src="https://github.com/user-attachments/assets/867bb929-385e-44a5-a2c0-3f09aa470eb3" />

---

## 二、Pin、Lock、Usage Count：三剑客的分工

很多人容易混淆 Pin、Lock 和 Usage Count。让我用一张图说清楚：

<img width="1049" height="486" alt="Image" src="https://github.com/user-attachments/assets/dc32f4fe-ee44-4c5a-be74-e53f292b3bf2" />

### 2.1 三者对比

| 特性 | **Pin (refcount)** | **Lock (content_lock)** | **Usage Count** |
|:---|:---|:---|:---|
| **核心作用** | 防止 Buffer 被淘汰 | 保护数据内容的并发访问 | 影响淘汰优先级 |
| **类比** | 借阅证 | 阅览室门锁 | 热门程度 |
| **持有时间** | 可以较长 | 必须短暂 | N/A（自动管理） |
| **硬性约束** | ✅ 是 | ✅ 是 | ❌ 否（软约束） |
| **值范围** | 0 ~ 262,143 | 共享/排他/无 | 0 ~ 5 |

### 2.2 依赖关系：必须先 Pin 后 Lock

这是 PostgreSQL 的铁律（`README:35`）：

> **"One must pin a buffer before trying to lock it."**

为什么？想想看：

1. 你先获取了 Buffer 的内容锁
2. 但这时另一个进程把这个 Buffer 淘汰了，换成了另一个页面
3. 你还在读写原来的数据？**灾难**！

所以必须先 Pin（保证 Buffer 不被替换），再 Lock（保证内容不被并发修改）。

<img width="1060" height="703" alt="Image" src="https://github.com/user-attachments/assets/f68d3c95-1160-42bb-8cec-7a4bea749811" />

### 2.3 五条访问规则

`README` 文档定义了 5 条 Buffer 访问规则：

| 规则 | 需要 | 操作 |
|:---:|:---|:---|
| **#1** | Pin + (共享或排他)Lock | 扫描页面、检查元组可见性 |
| **#2** | 仅 Pin | 访问已确定可见的元组数据 |
| **#3** | Pin + 排他 Lock | 添加元组或修改 xmin/xmax |
| **#4** | Pin + 共享 Lock | 更新提交状态位（hint bits） |
| **#5** | Pin + 排他 Lock + refcount=1 | 物理删除元组（Cleanup Lock） |

注意规则 #5：**Cleanup Lock** 不仅需要排他锁，还要求 `refcount=1`，即当前进程是唯一持有 Pin 的人。这是 VACUUM 物理删除元组时的要求。

---

## 三、精妙设计：两层引用计数

### 3.1 问题：高并发下的性能瓶颈

如果每次 Pin/Unpin 都直接修改共享内存中的 refcount，会怎样？

```
进程A: Pin(buf1) → refcount++   -- 需要原子操作
进程B: Pin(buf1) → refcount++   -- 需要原子操作
进程C: Pin(buf1) → refcount++   -- 需要原子操作
...
```

在高并发场景下，大量进程竞争同一个原子变量，性能会急剧下降。

### 3.2 解决方案：私有计数 + 共享计数

PostgreSQL 的解决方案非常精妙：

<img width="1060" height="800" alt="Image" src="https://github.com/user-attachments/assets/cd297861-ed57-444e-b8e4-28123898a7cc" />

**核心思想**：

1. **私有引用计数**（PrivateRefCount）：每个进程在自己的本地内存中维护
2. **共享引用计数**（refcount）：在共享内存的 BufferDesc 中

**工作流程**：

| 操作 | 私有计数 | 共享计数 | 竞争情况 |
|:---|:---|:---|:---|
| 首次 Pin 某 Buffer | 0 → 1 | +1 | 需要原子操作 |
| 再次 Pin 同一 Buffer | +1 | 不变 | **无竞争！** |
| Unpin（非最后一次） | -1 | 不变 | **无竞争！** |
| 最后一次 Unpin | 1 → 0 | -1 | 需要原子操作 |

**性能收益**：同一进程对同一 Buffer 的重复 Pin/Unpin，只有第一次和最后一次需要访问共享内存！

### 3.3 私有计数的存储结构

私有引用计数采用"数组 + 哈希表"的混合存储：

```c
// src/backend/storage/buffer/bufmgr.c:88, 197-201

#define REFCOUNT_ARRAY_ENTRIES 8  // 快速数组大小

static struct PrivateRefCountEntry PrivateRefCountArray[REFCOUNT_ARRAY_ENTRIES];
static HTAB *PrivateRefCountHash = NULL;  // 溢出哈希表
```

| 组件 | 大小 | 查找方式 | 设计意图 |
|:---|:---|:---|:---|
| 快速数组 | 8 个条目（64 字节） | O(8) 顺序扫描 | 热点 Buffer 快速访问 |
| 溢出哈希表 | 动态扩展，无上限 | O(1) 哈希查找 | 处理大量并发 Pin |

**为什么是 64 字节？**

因为 64 字节正好等于大多数 CPU 的**缓存行大小**（Cache Line），可以一次性加载到 CPU 缓存中，实现极快的访问。

---

## 四、Pin 操作的实现细节

### 4.1 函数调用链

```
ReadBuffer()                           ← 简化入口 (bufmgr.c:697)
    │
    └── ReadBufferExtended()           ← 扩展入口 (bufmgr.c:744)
            │
            └── ReadBuffer_common()    ← 核心实现 (bufmgr.c:807)
                    │
                    └── BufferAlloc()  ← 分配/查找Buffer (bufmgr.c:1107)
                            │
                            ├── PinBuffer()        ← Buffer命中时 (bufmgr.c:1692)
                            │
                            └── PinBuffer_Locked() ← 新分配Buffer时 (bufmgr.c:1795)
```

### 调用链详解

| 函数 | 位置 | 职责 |
|------|------|------|
| `ReadBuffer` | bufmgr.c:697 | 简化接口，读取MAIN_FORKNUM |
| `ReadBufferExtended` | bufmgr.c:744 | 支持指定fork和读取模式 |
| `ReadBuffer_common` | bufmgr.c:807 | 统一处理本地/共享buffer |
| `BufferAlloc` | bufmgr.c:1107 | 共享buffer的分配与查找 |
| `PinBuffer` | bufmgr.c:1692 | 无锁pin操作（CAS） |
| `PinBuffer_Locked` | bufmgr.c:1795 | 持有spinlock时的pin |

### 4.2 Pin机制的核心设计

PostgreSQL采用**两层引用计数**机制来实现Buffer Pin：

<img width="1014" height="787" alt="Image" src="https://github.com/user-attachments/assets/5df82393-6a43-4c90-92c4-8ee91f844c66" />

#### 设计优势

| 层级 | 存储位置 | 作用 | 性能特点 |
|------|----------|------|----------|
| **私有引用计数** | Backend本地内存 | 记录当前进程对buffer的pin次数 | 无锁访问，极快 |
| **共享引用计数** | `BufferDesc->state` | 记录所有进程对buffer的总pin数 | 原子操作，有竞争 |

**设计意图**：同一进程多次pin同一buffer时，只需修改私有计数，避免频繁竞争共享状态。仅在首次pin和最后unpin时才更新共享引用计数。

### 4.3 核心数据结构

#### 4.3.1 私有引用计数条目

```c
// bufmgr.c:81-85
typedef struct PrivateRefCountEntry
{
    Buffer      buffer;     // Buffer编号（1-based）
    int32       refcount;   // 本进程的pin次数
} PrivateRefCountEntry;
```

#### 4.3.2 私有引用计数存储

```c
// bufmgr.c:197-201

// 快速数组：存放最常用的8个buffer
static PrivateRefCountEntry PrivateRefCountArray[REFCOUNT_ARRAY_ENTRIES];

// 溢出哈希表：超过8个时使用
static HTAB *PrivateRefCountHash = NULL;

// 溢出计数
static int32 PrivateRefCountOverflowed = 0;

// 时钟指针：用于选择要移入哈希表的数组项
static uint32 PrivateRefCountClock = 0;

// 预留的空闲条目
static PrivateRefCountEntry *ReservedRefCountEntry = NULL;
```

### 4.4 Pin操作完整流程图

<img width="942" height="901" alt="Image" src="https://github.com/user-attachments/assets/f7f12ece-399e-4c6c-bd8b-07ab1975e746" />

<img width="947" height="216" alt="Image" src="https://github.com/user-attachments/assets/a7b75854-bf5f-4d8e-9d46-e4fb15b36849" />


#### 4.4.1 PinBuffer() 详解

**源码位置**: `bufmgr.c:1692-1771`

这是**不持有spinlock**时的pin操作，使用CAS原子操作实现无锁更新：

```c
static bool
PinBuffer(BufferDesc *buf, BufferAccessStrategy strategy)
{
    Buffer      b = BufferDescriptorGetBuffer(buf);
    bool        result;
    PrivateRefCountEntry *ref;

    // 步骤1: 查找私有引用计数条目
    ref = GetPrivateRefCountEntry(b, true);

    if (ref == NULL)
    {
        // ═══════════════════════════════════════════════════
        // 情况A: 首次pin此buffer，需要更新共享引用计数
        // ═══════════════════════════════════════════════════
        uint32      buf_state;
        uint32      old_buf_state;

        // 步骤2: 预留私有引用计数空间
        ReservePrivateRefCountEntry();

        // 步骤3: 创建新的私有引用计数条目
        ref = NewPrivateRefCountEntry(b);

        // 步骤4: CAS循环更新共享引用计数
        old_buf_state = pg_atomic_read_u32(&buf->state);
        for (;;)
        {
            // 如果buffer被锁定，等待解锁
            if (old_buf_state & BM_LOCKED)
                old_buf_state = WaitBufHdrUnlocked(buf);

            buf_state = old_buf_state;

            // 增加共享引用计数
            buf_state += BUF_REFCOUNT_ONE;

            // 更新usage_count（用于替换算法）
            if (strategy == NULL)
            {
                // 默认策略：增加usage_count直到最大值
                if (BUF_STATE_GET_USAGECOUNT(buf_state) < BM_MAX_USAGE_COUNT)
                    buf_state += BUF_USAGECOUNT_ONE;
            }
            else
            {
                // Ring buffer策略：只设置为1，避免驱逐其他buffer
                if (BUF_STATE_GET_USAGECOUNT(buf_state) == 0)
                    buf_state += BUF_USAGECOUNT_ONE;
            }

            // CAS原子更新
            if (pg_atomic_compare_exchange_u32(&buf->state,
                                               &old_buf_state, buf_state))
            {
                result = (buf_state & BM_VALID) != 0;

                // Valgrind: 标记buffer内存为可访问
                VALGRIND_MAKE_MEM_DEFINED(BufHdrGetBlock(buf), BLCKSZ);
                break;
            }
            // CAS失败，old_buf_state已被更新为当前值，继续循环
        }
    }
    else
    {
        // ═══════════════════════════════════════════════════
        // 情况B: 已经pin过，无需修改共享状态
        // ═══════════════════════════════════════════════════
        result = true;
    }

    // 步骤5: 增加私有引用计数
    ref->refcount++;
    Assert(ref->refcount > 0);

    // 步骤6: 记录到ResourceOwner（用于事务结束时自动释放）
    ResourceOwnerRememberBuffer(CurrentResourceOwner, b);

    return result;
}
```

##### 关键技术点

| 技术 | 说明 |
|------|------|
| **CAS循环** | 使用`pg_atomic_compare_exchange_u32`实现乐观锁，避免spinlock开销 |
| **等待解锁** | 若`BM_LOCKED`标志置位，调用`WaitBufHdrUnlocked`等待 |
| **usage_count** | 默认策略下递增至最大值5，影响Clock-Sweep替换算法 |
| **Ring策略** | 批量扫描时使用，usage_count只设为1，减少对缓存的影响 |

#### 4.4.2 PinBuffer_Locked() 详解

**源码位置**: `bufmgr.c:1795-1829`

这是**持有spinlock**时的pin操作，用于新分配的victim buffer：

```c
static void
PinBuffer_Locked(BufferDesc *buf)
{
    Buffer      b;
    PrivateRefCountEntry *ref;
    uint32      buf_state;

    // 前置条件检查：不应有预存的私有引用
    Assert(GetPrivateRefCountEntry(BufferDescriptorGetBuffer(buf), false) == NULL);

    // Valgrind: 标记buffer内存为可访问
    VALGRIND_MAKE_MEM_DEFINED(BufHdrGetBlock(buf), BLCKSZ);

    // ═══════════════════════════════════════════════════════════
    // 步骤1: 读取state并增加引用计数
    // 因为持有spinlock，可以直接修改（无需CAS）
    // ═══════════════════════════════════════════════════════════
    buf_state = pg_atomic_read_u32(&buf->state);
    Assert(buf_state & BM_LOCKED);  // 确认持有spinlock
    buf_state += BUF_REFCOUNT_ONE;

    // ═══════════════════════════════════════════════════════════
    // 步骤2: 释放spinlock（写入新状态并清除BM_LOCKED）
    // ═══════════════════════════════════════════════════════════
    UnlockBufHdr(buf, buf_state);

    // ═══════════════════════════════════════════════════════════
    // 步骤3: 创建私有引用计数条目（spinlock已释放）
    // ═══════════════════════════════════════════════════════════
    b = BufferDescriptorGetBuffer(buf);
    ref = NewPrivateRefCountEntry(b);
    ref->refcount++;

    // ═══════════════════════════════════════════════════════════
    // 步骤4: 记录到ResourceOwner
    // ═══════════════════════════════════════════════════════════
    ResourceOwnerRememberBuffer(CurrentResourceOwner, b);
}
```

##### 与PinBuffer的区别

| 特性 | PinBuffer | PinBuffer_Locked |
|------|-----------|------------------|
| **调用场景** | Buffer已在缓存中 | 新分配的victim buffer |
| **锁状态** | 不持有spinlock | 持有spinlock |
| **更新方式** | CAS循环 | 直接写入 |
| **usage_count** | 可能更新 | 不更新 |
| **预存引用检查** | 允许有预存引用 | 不允许 |

### 4.5 私有引用计数管理

#### 4.5.1 存储策略

采用**数组+哈希表**的混合存储，优化常见场景：

<img width="1015" height="818" alt="Image" src="https://github.com/user-attachments/assets/ed5b6828-1359-4428-b5a4-a8612cdc187d" />

<img width="1017" height="244" alt="Image" src="https://github.com/user-attachments/assets/576e5242-2b27-47ee-af7c-f502202d4fb6" />

#### 4.5.2 核心函数

##### ReservePrivateRefCountEntry() - `bufmgr.c:214-275`

预留一个空闲的引用计数条目：

```c
static void ReservePrivateRefCountEntry(void)
{
    // 如果已有预留，直接返回
    if (ReservedRefCountEntry != NULL)
        return;

    // 首先在数组中查找空闲槽位
    for (i = 0; i < REFCOUNT_ARRAY_ENTRIES; i++)
    {
        if (PrivateRefCountArray[i].buffer == InvalidBuffer)
        {
            ReservedRefCountEntry = &PrivateRefCountArray[i];
            return;
        }
    }

    // 数组已满，使用时钟算法选择victim移入哈希表
    ReservedRefCountEntry =
        &PrivateRefCountArray[PrivateRefCountClock++ % REFCOUNT_ARRAY_ENTRIES];

    // 将victim移入哈希表
    hashent = hash_search(PrivateRefCountHash,
                          &(ReservedRefCountEntry->buffer),
                          HASH_ENTER, &found);
    hashent->refcount = ReservedRefCountEntry->refcount;

    // 清空数组槽位
    ReservedRefCountEntry->buffer = InvalidBuffer;
    ReservedRefCountEntry->refcount = 0;

    PrivateRefCountOverflowed++;
}
```

##### GetPrivateRefCountEntry() - `bufmgr.c:306-379`

查找指定buffer的引用计数条目：

```c
static PrivateRefCountEntry *
GetPrivateRefCountEntry(Buffer buffer, bool do_move)
{
    // 1. 先在数组中查找（O(8)）
    for (i = 0; i < REFCOUNT_ARRAY_ENTRIES; i++)
    {
        if (PrivateRefCountArray[i].buffer == buffer)
            return &PrivateRefCountArray[i];
    }

    // 2. 如果没有溢出，直接返回NULL
    if (PrivateRefCountOverflowed == 0)
        return NULL;

    // 3. 在哈希表中查找
    res = hash_search(PrivateRefCountHash, &buffer, HASH_FIND, NULL);

    if (res == NULL)
        return NULL;

    // 4. 如果do_move=true，将条目移回数组以加速后续访问
    if (do_move)
    {
        ReservePrivateRefCountEntry();
        free = ReservedRefCountEntry;
        free->buffer = buffer;
        free->refcount = res->refcount;

        // 从哈希表删除
        hash_search(PrivateRefCountHash, &buffer, HASH_REMOVE, &found);
        PrivateRefCountOverflowed--;

        return free;
    }

    return res;
}
```

#### 4.5.3 BufferAlloc中的Pin调用

**源码位置**: `bufmgr.c:1107-1405`

`BufferAlloc`是`ReadBuffer_common`的子函数，负责在共享buffer池中分配或查找buffer：

```c
static BufferDesc *
BufferAlloc(SMgrRelation smgr, char relpersistence, ForkNumber forkNum,
            BlockNumber blockNum, BufferAccessStrategy strategy, bool *foundPtr)
{
    // 创建BufferTag
    INIT_BUFFERTAG(newTag, smgr->smgr_rnode.node, forkNum, blockNum);
    newHash = BufTableHashCode(&newTag);
    newPartitionLock = BufMappingPartitionLock(newHash);

    // ═══════════════════════════════════════════════════════════════
    // 场景1: 在哈希表中查找buffer
    // ═══════════════════════════════════════════════════════════════
    LWLockAcquire(newPartitionLock, LW_SHARED);
    buf_id = BufTableLookup(&newTag, newHash);

    if (buf_id >= 0)
    {
        // Buffer命中！
        buf = GetBufferDescriptor(buf_id);

        // 调用 PinBuffer (不持有spinlock)
        valid = PinBuffer(buf, strategy);        // ← Pin操作

        LWLockRelease(newPartitionLock);
        *foundPtr = true;

        // 处理BM_VALID检查...
        return buf;
    }

    LWLockRelease(newPartitionLock);

    // ═══════════════════════════════════════════════════════════════
    // 场景2: Buffer未命中，需要分配新buffer
    // ═══════════════════════════════════════════════════════════════
    for (;;)
    {
        // 预留私有引用计数空间
        ReservePrivateRefCountEntry();

        // 获取victim buffer（带spinlock返回）
        buf = StrategyGetBuffer(strategy, &buf_state);

        // 调用 PinBuffer_Locked (持有spinlock)
        PinBuffer_Locked(buf);                   // ← Pin操作

        // 处理脏页刷新、重新验证等...

        // 如果成功，返回buffer
        // 否则UnpinBuffer并继续循环
    }
}
```

#### 4.5.4. UnpinBuffer详解

**源码位置**: `bufmgr.c:1840-1923`

与Pin相对的Unpin操作：

```c
static void
UnpinBuffer(BufferDesc *buf, bool fixOwner)
{
    PrivateRefCountEntry *ref;
    Buffer b = BufferDescriptorGetBuffer(buf);

    // 获取私有引用计数条目
    ref = GetPrivateRefCountEntry(b, false);
    Assert(ref != NULL);

    // 从ResourceOwner移除
    if (fixOwner)
        ResourceOwnerForgetBuffer(CurrentResourceOwner, b);

    // 减少私有引用计数
    Assert(ref->refcount > 0);
    ref->refcount--;

    if (ref->refcount == 0)
    {
        // ═══════════════════════════════════════════════════════════
        // 最后一个私有引用，需要更新共享引用计数
        // ═══════════════════════════════════════════════════════════

        // Valgrind: 标记buffer为不可访问
        VALGRIND_MAKE_MEM_NOACCESS(BufHdrGetBlock(buf), BLCKSZ);

        // 确认没有持有content lock
        Assert(!LWLockHeldByMe(BufferDescriptorGetContentLock(buf)));

        // CAS循环减少共享引用计数
        old_buf_state = pg_atomic_read_u32(&buf->state);
        for (;;)
        {
            if (old_buf_state & BM_LOCKED)
                old_buf_state = WaitBufHdrUnlocked(buf);

            buf_state = old_buf_state;
            buf_state -= BUF_REFCOUNT_ONE;  // 减少引用计数

            if (pg_atomic_compare_exchange_u32(&buf->state,
                                               &old_buf_state, buf_state))
            {
                // 如果有等待者且引用计数为0，唤醒它们
                if ((buf_state & BM_PIN_COUNT_WAITER) &&
                    BUF_STATE_GET_REFCOUNT(buf_state) == 0)
                    /* ... wake up waiters ... */
                break;
            }
        }

        // 释放私有引用计数条目
        ForgetPrivateRefCountEntry(ref);
    }
}
```

#### 4.5.5. ResourceOwner集成

Pin操作与PostgreSQL的资源管理系统紧密集成：

```c
// 在ReadBuffer_common开始时
ResourceOwnerEnlargeBuffers(CurrentResourceOwner);  // bufmgr.c:820

// 在PinBuffer/PinBuffer_Locked结束时
ResourceOwnerRememberBuffer(CurrentResourceOwner, b);  // bufmgr.c:1769, 1828

// 在UnpinBuffer时
ResourceOwnerForgetBuffer(CurrentResourceOwner, b);  // bufmgr.c:1850
```

**设计目的**：
1. **自动清理**：事务结束时自动释放所有pinned buffers
2. **泄漏检测**：检查是否有buffer在不应该的时候仍被pin住
3. **资源追踪**：便于调试和监控

## 五. 总结

### Pin操作的核心特性

| 特性         | 实现方式                 | 优势                 |
| ---------- | -------------------- | ------------------ |
| **无锁更新**   | CAS原子操作              | 避免spinlock开销，提高并发性 |
| **两层引用计数** | 私有+共享                | 减少竞争，同进程重复pin几乎无开销 |
| **混合存储**   | 数组(≤8)+哈希表           | 常见场景O(1)访问，支持大量pin |
| **资源追踪**   | ResourceOwner        | 自动清理，防止泄漏          |
| **替换友好**   | usage_count          | 支持Clock-Sweep算法    |
| **策略感知**   | BufferAccessStrategy | 批量操作减少缓存污染         |

### 性能考量

- **热点buffer**：同进程重复访问只修改私有计数，无竞争
- **CAS失败重试**：高并发时可能多次重试，但比spinlock更高效
- **内存布局**：PrivateRefCountArray大小64字节，适配CPU缓存行



## 参考资料：
- [interdb](https://www.interdb.jp/pg/pgsql08/index.html)
- PostgreSQL 14.4 源码:  src\backend\storage\buffer\bufmgr.c
- `src/backend/storage/buffer/README`


