
## 七、超大内存分配策略

### 7.1 要点

AllocSet 的 maxBlockSize (8MB) 并不是单次分配的上限。对于超过 `allocChunkLimit`（默认 8KB）的请求，AllocSet 使用专用块（dedicated block）策略，直接调用 `malloc()` 分配一块恰好满足请求大小的内存。


真正的分配上限由两个宏决定：

```c
/* src/include/utils/memutils.h:40-46 */
#define MaxAllocSize      ((Size) 0x3fffffff)  /* 约 1GB - 1，通过 palloc 调用 */
#define MaxAllocHugeSize  (SIZE_MAX / 2)        /* 通过 MemoryContextAllocHuge 调用 */
```

`MaxAllocHugeSize` 取 `SIZE_MAX/2` 的原因：源码注释说明，代码中允许对分配大小做 `size * 2` 运算而不溢出。

### 7.2 分层设计

```
用户请求大小          分配策略                    限制来源
─────────────       ──────────                 ──────────
≤ 8KB (allocChunkLimit)
  └→ 从 freelist 或常规 block 分配    maxBlockSize 仅限常规 block
> 8KB 且 ≤ ~1GB
  └→ 专用块 dedicated block (malloc)   MaxAllocSize (palloc 限制)
> ~1GB 且 ≤ SIZE_MAX/2
  └→ 专用块 dedicated block (malloc)   MaxAllocHugeSize (AllocHuge 限制)
```


<img width="1200" height="1141" alt="Image" src="https://github.com/user-attachments/assets/8a88336c-a0e5-485b-b3c9-4523667dad0b" />

### 7.3 内存布局对比

**常规 Block**：

```
┌─────────────────────────────────────────────────────┐
│  AllocBlockData  │ Chunk1 │ Chunk2 │  ...  │  空闲  │
└─────────────────────────────────────────────────────┘
│◀──────────── maxBlockSize (≤ 8MB) ──────────────▶│
freeptr 指向空闲空间起始，endptr 指向 block 末尾
```

**专用 Block**：

```
┌──────────────────────────────────────────────────────┐
│  AllocBlockData  │  AllocChunkData  │    数据区域     │
└──────────────────────────────────────────────────────┘
│◀──── blksize = chunk_size + 头部开销 ──▶│
freeptr == endptr（无剩余空间）
```

**专用 Block 分配流程**


```c
/* src/backend/utils/mmgr/aset.c:720-790 */
static void *
AllocSetAlloc(MemoryContext context, Size size)
{
    AllocSet set = (AllocSet) context;
    AllocBlock block;
    AllocChunk chunk;
    Size chunk_size;
    Size blksize;

    /* 关键判断：超过 allocChunkLimit → 专用块路径 */
    if (size > set->allocChunkLimit)
    {
        chunk_size = MAXALIGN(size);
        blksize = chunk_size + ALLOC_BLOCKHDRSZ + ALLOC_CHUNKHDRSZ;
        block = (AllocBlock) malloc(blksize);    /* 直接 malloc，无大小限制 */
        if (block == NULL)
            return NULL;

        context->mem_allocated += blksize;

        block->aset = set;
        block->freeptr = block->endptr = ((char *) block) + blksize;
        /* freeptr == endptr 表示此 block 没有剩余可用空间 */

        chunk = (AllocChunk) (((char *) block) + ALLOC_BLOCKHDRSZ);
        chunk->aset = set;
        chunk->size = chunk_size;

        /* 将新块插入到活动分配块之后 */
        if (set->blocks != NULL)
        {
            block->prev = set->blocks;
            block->next = set->blocks->next;
            if (block->next)
                block->next->prev = block;
            set->blocks->next = block;
        }
        else
        {
            block->prev = NULL;
            block->next = NULL;
            set->blocks = block;
        }

        return AllocChunkGetPointer(chunk);
    }
    /* ... 普通小 chunk 的分配逻辑 ... */
}
```

关键区别：
- 常规 block 的 `freeptr < endptr`（有剩余空间供后续分配）
- 专用 block 的 `freeptr == endptr`（恰好容纳一个 chunk，无剩余空间）


 **普通分配（≤ 1GB）**

```
palloc(size)                              mcxt.c:1068
  └→ 检查 size ≤ MaxAllocSize (1GB-1)     mcxt.c:1077
    └→ context->methods->alloc()
      └→ AllocSetAlloc()                   aset.c:720
        ├─ size ≤ allocChunkLimit(8KB)
        │   └→ freelist 查找 / 常规 block 分配
        └─ size > allocChunkLimit(8KB)
            └→ malloc(精确大小) → 专用块    aset.c:740
```

 **超大分配（> 1GB，≤ SIZE_MAX/2）**

```
MemoryContextAllocHuge(context, size)      mcxt.c:1224
  └→ 检查 size ≤ MaxAllocHugeSize          mcxt.c:1231
    └→ context->methods->alloc()
      └→ AllocSetAlloc()                   aset.c:720
        └→ 必然 > allocChunkLimit
            └→ malloc(精确大小) → 专用块    aset.c:740
```


### 7.4 maxBlockSize 的精确作用域

`maxBlockSize` **只限制常规 block 的增长上限，不限制专用块**：

| 分配类型              | malloc 大小由什么决定                   | 是否受 maxBlockSize 限制 |
| ----------------- | -------------------------------- | ------------------- |
| 常规 block（多 chunk） | nextBlockSize 倍增，上限 maxBlockSize | **是**               |
| 专用 block（单 chunk） | 用户请求 size + 头部开销                 | **否**               |

`maxBlockSize` 在源码中仅出现在两个位置：
1. 常规 block 的倍增上限（`aset.c:904-909`）
2. 计算 allocChunkLimit 的辅助（`aset.c:529-532`）

### 7.5 专用块的即时回收与 realloc

**释放**：专用块在 `pfree()` 时立即 `free()` 归还 OS，不等 context reset。


```c
/* src/backend/utils/mmgr/aset.c:1009-1041 */
static void
AllocSetFree(MemoryContext context, void *pointer)
{
    AllocSet set = (AllocSet) context;
    AllocChunk chunk = AllocPointerGetChunk(pointer);

    if (chunk->size > set->allocChunkLimit)
    {
        /* 大 chunk → 必定是专用块，直接 free() 归还给 OS */
        AllocBlock block = (AllocBlock) (((char *) chunk) - ALLOC_BLOCKHDRSZ);

        /* 验证 block 有效性 */
        if (block->aset != set ||
            block->freeptr != block->endptr ||
            block->freeptr != ((char *) block) +
            (chunk->size + ALLOC_BLOCKHDRSZ + ALLOC_CHUNKHDRSZ))
            elog(ERROR, "could not find block containing chunk %p", chunk);

        /* 从 block 链表中断开 */
        if (block->prev)
            block->prev->next = block->next;
        else
            set->blocks = block->next;
        if (block->next)
            block->next->prev = block->prev;

        context->mem_allocated -= block->endptr - ((char *) block);
        free(block);    /* 立即归还给操作系统 */
    }
    else
    {
        /* 小 chunk → 放入 freelist 等待复用 */
        int fidx = AllocSetFreeIndex(chunk->size);
        chunk->aset = (void *) set->freelist[fidx];
        set->freelist[fidx] = chunk;
    }
}
```

大块内存如果像小 chunk 一样放入 freelist 等待 Reset 时才回收，会造成内存浪费。所以专用块在 `pfree()` 时立即调用 `free()` 归还操作系统。


**重分配**：专用块直接调用 `realloc()`。关键设计：一旦成为专用块，即使后续 shrink 到小于 allocChunkLimit，仍然保持专用块状态（`chksize = Max(size, allocChunkLimit + 1)`），避免状态混淆。


```c
/* src/backend/utils/mmgr/aset.c:1094-1160 */
static void *
AllocSetRealloc(MemoryContext context, void *pointer, Size size)
{
    AllocSet set = (AllocSet) context;
    AllocChunk chunk = AllocPointerGetChunk(pointer);
    Size oldsize = chunk->size;

    if (oldsize > set->allocChunkLimit)
    {
        /* 专用块 → 直接 realloc() */
        AllocBlock block = (AllocBlock) (((char *) chunk) - ALLOC_BLOCKHDRSZ);
        Size chksize;
        Size blksize;

        /* 即使新请求 < allocChunkLimit，也保持专用块状态 */
        chksize = Max(size, set->allocChunkLimit + 1);
        chksize = MAXALIGN(chksize);
        blksize = chksize + ALLOC_BLOCKHDRSZ + ALLOC_CHUNKHDRSZ;

        block = (AllocBlock) realloc(block, blksize);
        /* ... 更新元数据 ... */
    }
    else
    {
        /* 小 chunk → 暴力方式：新分配 + memcpy + 释放旧 */
    }
}
```

一旦成为专用块，即使后续 shrink 到小于 allocChunkLimit，仍然保持专用块状态（`chksize = Max(size, allocChunkLimit + 1)`）。这避免了状态混淆。


### 7.6 实际应用场景

| 场景 | 典型大小 | 分配方式 |
|------|----------|----------|
| 普通查询元组 | 几十字节 ~ 几KB | freelist / 常规 block |
| 大对象 (TOAST) | 几十KB ~ 几MB | 专用块 |
| 排序 work_mem 中的 tape buffer | 几十KB ~ 几MB | 专用块 |
| 大型哈希表批量扩展 | 几十MB | 专用块 |
| 超大分析查询中间结果 | 几百MB | 专用块 |
| SharedInvalCatalogCacheCallback | >1GB | MemoryContextAllocHuge |

---

## 八、Memory Context 与 work_mem 的关系

### 8.1 概述

| 维度 | Memory Context | work_mem / maintenance_work_mem |
|------|----------------|-------------------------------|
| **本质** | 内存分配的基础设施（分配机制） | 内存使用的限额参数（使用策略） |
| **回答的问题** | HOW — 如何分配和释放内存 | HOW MUCH — 允许使用多少内存 |
| **管理层级** | 底层（palloc/pfree 的载体） | 上层（业务逻辑中的预算控制） |
| **强制方式** | AllocSet 内部 block/chunk 管理 | 应用层手动记账 + 溢出到磁盘 |

Memory Context 是"水管"，work_mem 是"水表"。Memory Context 提供所有内存分配的管道（palloc → AllocSetAlloc → malloc），work_mem 等参数在业务逻辑层面通过手动计数（availMem / spaceUsed）决定何时将操作从内存切换到磁盘。

### 8.2 work_mem 关键参数

```c
/* src/backend/utils/misc/guc.c:2400-2411 */
/* work_mem */
{"work_mem", PGC_USERSET, RESOURCES_MEM,
    gettext_noop("Sets the maximum memory to be used for query workspaces."),
    gettext_noop("This much memory can be used by each internal "
                 "sort operation and hash table before switching to "
                 "temporary disk files."),
    GUC_UNIT_KB | GUC_EXPLAIN
},
&work_mem,
4096, 64, MAX_KILOBYTES,   /* 默认 4MB, 最小 64KB */
```

**使用 work_mem 等私有内存的操作类型**

| 操作类型                  | 使用参数                             | 溢写策略               |
| --------------------- | -------------------------------- | ------------------ |
| ORDER BY / SORT       | `work_mem`                       | tuplesort → 临时文件   |
| Hash Join 构建          | `work_mem × hash_mem_multiplier` | 增加 batch 数，溢写到临时文件 |
| Agg (sort-based)      | `work_mem`                       | tuplesort 溢写       |
| Window Function       | `work_mem`                       | tuplestore 溢写      |
| Bitmap Index Scan     | `work_mem`                       | TID bitmap 压缩/丢失   |
| Materialize           | `work_mem`                       | tuplestore 溢写      |
| CREATE INDEX (B-tree) | `maintenance_work_mem`           | tuplesort 溢写       |
| VACUUM (dead tuples)  | `maintenance_work_mem`           | 分段处理               |
| GIN index build       | `maintenance_work_mem`           | 快速插入暂存             |

### 8.3 交互机制：tuplesort 案例

这是最典型的交互案例。tuplesort 同时使用 Memory Context 进行分配，并手动追踪 work_mem 预算。

**第一步**：创建专用 Memory Context

```c
/* src/backend/utils/sort/tuplesort.c:720-800 */
static Tuplesortstate *
tuplesort_begin_common(int workMem, SortCoordinate coordinate,
                       bool randomAccess)
{
    /* 1. 创建元数据上下文（跨批次持久化） */
    maincontext = AllocSetContextCreate(CurrentMemoryContext,
                                        "TupleSort main",
                                        ALLOCSET_DEFAULT_SIZES);

    /* 2. 创建排序数据上下文（每次 Reset） */
    sortcontext = AllocSetContextCreate(maincontext,
                                        "TupleSort sort",
                                        ALLOCSET_DEFAULT_SIZES);

    /* 3. 设置 work_mem 预算 */
    state->allowedMem = Max(workMem, 64) * (int64) 1024;
    state->sortcontext = sortcontext;
    state->maincontext = maincontext;
```

**第二步：在 batch 初始化中设定可用内存**


```c
/* src/backend/utils/sort/tuplesort.c:832-856 */
static void
tuplesort_begin_batch(Tuplesortstate *state)
{
    /* 3. 创建 tuple 专用子上下文 */
    state->tuplecontext = AllocSetContextCreate(state->sortcontext,
                                                "Caller tuples",
                                                ALLOCSET_DEFAULT_SIZES);

    state->availMem = state->allowedMem;  /* 重置可用内存计数 */
```

**第三步**：手动记账宏

```c
/* src/backend/utils/sort/tuplesort.c:545-547 */
#define LACKMEM(state)  ((state)->availMem < 0 && !(state)->slabAllocatorUsed)
#define USEMEM(state,amt) ((state)->availMem -= (amt))
#define FREEMEM(state,amt) ((state)->availMem += (amt))
```

**第四步**：插入元组时的预算检查

当 `LACKMEM(state)` 返回 true 时，tuplesort 将当前内存中的元组排序后写入临时文件（tape），然后释放排序上下文的内存。

```
tuplesort_puttupleslot()
  ├── MemoryContextSwitchTo(sortcontext)  ← 切换到排序专用上下文
  ├── copytup() → palloc(tuple)          ← 通过 Memory Context 分配
  ├── USEMEM(state, tupleSize)            ← 手动扣减 availMem
  └── if (LACKMEM(state))                 ← availMem < 0?
      ├── qsort 当前 memtuples
      ├── writetup() → 写入临时文件
      ├── MemoryContextReset(sortcontext)  ← 释放所有排序内存!
      └── availMem = allowedMem            ← 重置预算
```

### 8.4 Hash Join 中的内存限制

**hash 内存上限计算** ：

```c
/* src/backend/executor/nodeHash.c:3400-3412 */
size_t
get_hash_memory_limit(void)
{
    double mem_limit;
    mem_limit = (double) work_mem * hash_mem_multiplier * 1024.0;
    mem_limit = Min(mem_limit, (double) SIZE_MAX);
    return (size_t) mem_limit;
}
```

**Hash 表创建时的限制传递** ：

```c
/* src/backend/executor/nodeHash.c:463-471 */
ExecChooseHashTableSize(rows, outerNode->plan_width,
                        OidIsValid(node->skewTable),
                        ...,
                        &space_allowed,  /* 输出: 允许的字节数 */
                        &nbuckets, &nbatch, &num_skew_mcvs);
```

然后 `space_allowed` 被赋值给 `hashtable->spaceAllowed`，在插入元组时通过 `spaceUsed` 累加检查，超出时增加 batch 数将数据溢写到临时文件。

**Hash 的 Memory Context 创建** ：

```c
/* src/backend/executor/nodeHash.c:526-532 */
hashtable->hashCxt = AllocSetContextCreate(CurrentMemoryContext,
                                           "HashTableContext",
                                           ALLOCSET_DEFAULT_SIZES);

hashtable->batchCxt = AllocSetContextCreate(hashtable->hashCxt,
                                            "HashBatchContext",
                                            ALLOCSET_DEFAULT_SIZES);
```

### 8.5 CreateWorkExprContext 的特殊处理

```c
/* src/backend/executor/execUtils.c:315-331 */
ExprContext *
CreateWorkExprContext(EState *estate)
{
    Size minContextSize = ALLOCSET_DEFAULT_MINSIZE;
    Size initBlockSize = ALLOCSET_DEFAULT_INITSIZE;
    Size maxBlockSize = ALLOCSET_DEFAULT_MAXSIZE;  /* 8MB */

    /* 将 maxBlockSize 限制为 work_mem 的 1/16 */
    while (16 * maxBlockSize > work_mem * 1024L)
        maxBlockSize >>= 1;

    if (maxBlockSize < ALLOCSET_DEFAULT_INITSIZE)
        maxBlockSize = ALLOCSET_DEFAULT_INITSIZE;

    return CreateExprContextInternal(estate, minContextSize,
                                     initBlockSize, maxBlockSize);
}
```

如果 `work_mem = 4MB`，则 `maxBlockSize = 256KB`（8MB / 32 → 实际为 8MB >> 5 = 256KB）。AllocSet 单次 malloc 调用不超过 work_mem 的 1/16，避免一次大块分配就越过 work_mem 预算。


### 8.6 两者架构关系图


<img width="1200" height="845" alt="Image" src="https://github.com/user-attachments/assets/447fdc94-33e2-4425-88db-db337d088005" />

### 8.7 两者关系的精确定义

**Memory Context 不感知 work_mem**：Memory Context 系统本身没有任何代码检查 `work_mem` 变量。

**work_mem 不控制 Memory Context**：`work_mem` 不是 Memory Context 的硬性上限，只是业务逻辑中的软性预算。

**实际内存使用可能超过 work_mem**：
1. 记账不精确：availMem 统计可能不包含内部碎片和头部开销
2. AllocSet 预分配：一次 malloc 可能分配比请求更大的 block
3. 多个操作并行叠加：一个查询可以同时有多个 sort、hash 操作，每个独立使用 work_mem

---

## 九、MemoryContext Callbacks

### 9.1 概述

MemoryContext Callbacks 是 PostgreSQL 内存管理子系统中的**资源清理回调机制**。它允许在 MemoryContext 被 reset 或 delete 时，自动执行用户注册的清理函数，用于释放该 context 中通过非 palloc 方式分配的资源（如 malloc 内存、引用计数、外部库资源等）。

### 9.2 核心数据结构——MemoryContextCallback

```c
/* src/include/utils/palloc.h:45-52 */
typedef void (*MemoryContextCallbackFunction) (void *arg);

typedef struct MemoryContextCallback
{
    MemoryContextCallbackFunction func; /* 回调函数指针 */
    void       *arg;                   /* 传递给回调函数的用户数据 */
    struct MemoryContextCallback *next; /* 链表下一个节点（LIFO 顺序） */
} MemoryContextCallback;
```

| 字段     | 类型                              | 用途                                |
| ------ | ------------------------------- | --------------------------------- |
| `func` | `MemoryContextCallbackFunction` | 回调函数指针，签名为 `void func(void *arg)` |
| `arg`  | `void *`                        | 传递给回调函数的用户数据                      |
| `next` | `MemoryContextCallback *`       | 链表下一个节点（LIFO 顺序）                  |

**reset_cbs 字段**


```c
/* src/include/nodes/memnodes.h:92 */
typedef struct MemoryContextData
{
    /* ... 其他字段 ... */
    MemoryContextCallback *reset_cbs;  /* list of reset/delete callbacks */
} MemoryContextData;
```

`reset_cbs` 是 `MemoryContextData` 的最后一个字段，指向回调链表的**头部**（最新注册的回调）。



<img width="1200" height="761" alt="Image" src="https://github.com/user-attachments/assets/e2237a94-e697-4a99-a5cc-182c6069e61e" />

### 9.3 回调注册注册与触发机制

#### 9.3.1 **注册**：头插法（LIFO），最新注册的回调排在最前面。

```c
/* src/backend/utils/mmgr/mcxt.c:291-302 */
void
MemoryContextRegisterResetCallback(MemoryContext context,
                                   MemoryContextCallback *cb)
{
    AssertArg(MemoryContextIsValid(context));

    /* Push onto head so this will be called before older registrants. */
    cb->next = context->reset_cbs;
    context->reset_cbs = cb;
    /* Mark the context as non-reset (it probably is already). */
    context->isReset = false;
}
```

使用时注意：
- 调用者负责分配 `MemoryContextCallback` 结构体内存
- 通常建议分配在目标 context 中，使其随 context 自动释放
- 无注销 API——通过 `arg` 指向的状态控制回调是否执行实际工作
- 回调结构通常嵌入在更大的业务结构体中，避免额外的 `palloc` 调用


#### 9.3.2 **触发**：

回调通过 `MemoryContextCallResetCallbacks()` 在以下两个路径中被触发：


<img width="1200" height="1262" alt="Image" src="https://github.com/user-attachments/assets/0ebc4a31-773c-4ac1-8812-f1d23c2b7cd8" />

 ##### **路径 1: MemoryContextResetOnly**

```c
/* src/backend/utils/mmgr/mcxt.c:161-186 */
void
MemoryContextResetOnly(MemoryContext context)
{
    AssertArg(MemoryContextIsValid(context));
    if (!context->isReset)
    {
        MemoryContextCallResetCallbacks(context);  // ← 先调用回调
        context->methods->reset(context);           // ← 再释放内存
        context->isReset = true;
    }
}
```

触发链：`MemoryContextReset` → `MemoryContextResetOnly` → `MemoryContextCallResetCallbacks`

##### 路径 2: MemoryContextDelete

```c
/* src/backend/utils/mmgr/mcxt.c:217-255 */
void
MemoryContextDelete(MemoryContext context)
{
    if (context->firstchild != NULL)
        MemoryContextDeleteChildren(context);

    MemoryContextCallResetCallbacks(context);  // ← 先调用回调

    MemoryContextSetParent(context, NULL);     // ← 从父节点断链

    context->ident = NULL;
    context->methods->delete_context(context); // ← 最后销毁 context
}
```

触发链：`MemoryContextDelete` → `MemoryContextCallResetCallbacks`

**关键区别**:
- **Reset**: 保留 context 本身，仅释放内存，回调在 `methods->reset()` 之前执行
- **Delete**: 彻底销毁 context，回调在断链和销毁之前执行

##### MemoryContextCallResetCallbacks 实现

```c
/* src/backend/utils/mmgr/mcxt.c:308-323 */
static void
MemoryContextCallResetCallbacks(MemoryContext context)
{
    MemoryContextCallback *cb;

    while ((cb = context->reset_cbs) != NULL)
    {
        context->reset_cbs = cb->next;  // 先从链表弹出
        cb->func(cb->arg);              // 再调用回调
    }
}
```

**安全设计**:
1. 先弹出再调用——即使回调内部发生错误（ereport/longjmp），该回调也不会被再次执行
2. LIFO 顺序——最后注册的回调最先执行（栈式清理，符合资源获取的逆序释放）
3. 子 context 先于父 context——`MemoryContextDeleteChildren` 递归删除子 context 时，子 context 的回调先执行


### 9.4 嵌入式回调结构模式

所有使用案例都遵循相同模式：

```c
业务结构体 {
    ... 业务字段 ...
    MemoryContextCallback mcb;   // 嵌入回调结构
};

// 注册三步曲
obj->mcb.func = cleanup_function;
obj->mcb.arg  = (void *) obj;
MemoryContextRegisterResetCallback(ctx, &obj->mcb);
```


这种做法的好处：
1. 零额外分配——回调结构嵌入在业务结构中，无需单独 `palloc`
2. 自动释放——回调结构和业务数据在同一 context 中，reset 时一起释放
3. 强关联性——回调 arg 指向包含它的结构，能访问所有业务字段


**与 RAII 的对比**

MemoryContext Callback 相当于 C 语言中 RAII (Resource Acquisition Is Initialization) 模式的手动实现：

| 特性 | RAII (C++) | MemoryContext Callback (C) |
|------|------------|---------------------------|
| 注册时机 | 构造函数中自动 | 手动调用 `RegisterResetCallback` |
| 清理时机 | 析构函数自动 | context reset/delete 时自动 |
| 作用域 | 栈对象离开作用域 | context 被重置或删除 |
| 错误安全 | 异常安全 | 先弹出再调用，防止重复 |


### 9.5 实际使用案例

| 案例 | 文件 | 模式 | Why |
|------|------|------|-----|
| TupleDesc 引用计数 | `expandedrecord.c` | 递减 refcount，为 0 时释放 | Expanded Object 生命周期由 Context 管理，但 TupleDesc 是共享资源 |
| Domain 约束缓存 | `typcache.c` | 先置 NULL 再释放 | 约束缓存在多个上下文中共享，需要确保引用正确释放 |
| 正则表达式资源 | `spell.c` | 调用 `pg_regfree()` | 正则引擎用 malloc 分配内存，不能随 MemoryContext 自动释放 |
| PL/Python SRF | `plpy_exec.c` | `Py_XDECREF` + 清理 | Python 对象有独立引用计数，不受 MemoryContext 管理 |

#### 9.5.1  TupleDesc 引用计数管理 (expandedrecord.c)

**场景**: Expanded Record 管理 TupleDesc 的引用计数

**回调函数**: `ER_mc_callback` 

```c
/* src/backend/utils/adt/expandedrecord.c:902-917 */
static void
ER_mc_callback(void *arg)
{
    ExpandedRecordHeader *erh = (ExpandedRecordHeader *) arg;
    TupleDesc tupdesc = erh->er_tupdesc;

    if (tupdesc)
    {
        erh->er_tupdesc = NULL;
        if (tupdesc->tdrefcount > 0)
        {
            if (--tupdesc->tdrefcount == 0)
                FreeTupleDesc(tupdesc);
        }
    }
}
```

**注册方式** :

```c
/* src/backend/utils/adt/expandedrecord.c:162-166 */
erh->er_mcb.func = ER_mc_callback;
erh->er_mcb.arg = (void *) erh;
MemoryContextRegisterResetCallback(erh->hdr.eoh_context, &erh->er_mcb);
```

**模式特征**: 引用计数递减 + 条件释放。`er_mcb` 嵌入在 `ExpandedRecordHeader` 结构中。

**Why**: Expanded Object 的生命周期由 MemoryContext 管理，但 TupleDesc 是共享资源，需要显式管理引用计数。使用回调确保 context 销毁时自动释放 refcount，避免依赖 ResourceOwner。

---

####  9.5.2 Domain 约束缓存引用释放 (typcache.c)

**场景**: DomainConstraintRef 管理 DomainConstraintCache 的引用计数

**回调函数**: `dccref_deletion_callback` 

```c
/* src/backend/utils/cache/typcache.c:1245-1257 */
static void
dccref_deletion_callback(void *arg)
{
    DomainConstraintRef *ref = (DomainConstraintRef *) arg;
    DomainConstraintCache *dcc = ref->dcc;

    if (dcc)
    {
        ref->constraints = NIL;
        ref->dcc = NULL;
        decr_dcc_refcount(dcc);
    }
}
```

**注册方式** :

```c
/* src/backend/utils/cache/typcache.c:1311-1315 */
ref->callback.func = dccref_deletion_callback;
ref->callback.arg = (void *) ref;
MemoryContextRegisterResetCallback(refctx, &ref->callback);
```

**模式特征**: 先置 NULL 再释放，防止悬空指针。`callback` 嵌入在 `DomainConstraintRef` 结构中（定义在 `typcache.h:172`）。

**Why**: Domain 约束缓存在多个上下文中共享，refctx 的生命周期可能短于缓存本身，需要回调确保引用正确释放。

---

#### 9.5.3 正则表达式资源清理 (spell.c)

**场景**: Ispell 字典中正则表达式的清理

**回调函数**: `regex_affix_deletion_callback`

```c
/* src/backend/tsearch/spell.c:661-666 */
static void
regex_affix_deletion_callback(void *arg)
{
    aff_regex_struct *pregex = (aff_regex_struct *) arg;
    pg_regfree(&(pregex->regex));
}
```

**注册方式**:

```c
/* src/backend/tsearch/spell.c:766-769 */
pregex->mcallback.func = regex_affix_deletion_callback;
pregex->mcallback.arg = (void *) pregex;
MemoryContextRegisterResetCallback(CurrentMemoryContext, &pregex->mcallback);
```

**模式特征**: 外部库资源释放。`mcallback` 嵌入在 `aff_regex_struct` 中（定义在 `spell.h:92`）。

**Why**: 正则表达式引擎使用 `malloc` 而非 `palloc` 分配内存，不能随 MemoryContext 自动释放。回调在 context reset 时调用 `pg_regfree()` 释放这些外部资源。

---

#### 9.5.4 PL/Python SRF 迭代器清理 (plpy_exec.c)

**场景**: PL/Python 集合返回函数(SRF)的 Python 对象清理

**回调函数**: `plpython_srf_cleanup_callback` 

```c
/* src/pl/plpython/plpy_exec.c:656-667 */
static void
plpython_srf_cleanup_callback(void *arg)
{
    PLySRFState *srfstate = (PLySRFState *) arg;

    Py_XDECREF(srfstate->iter);       // 释放 Python 迭代器引用
    srfstate->iter = NULL;
    if (srfstate->savedargs)
        PLy_function_drop_args(srfstate->savedargs);
    srfstate->savedargs = NULL;
}
```

**注册方式** :

```c
/* src/pl/plpython/plpy_exec.c:84-87 */
srfstate->callback.func = plpython_srf_cleanup_callback;
srfstate->callback.arg = (void *) srfstate;
MemoryContextRegisterResetCallback(funcctx->multi_call_memory_ctx,
                                   &srfstate->callback);
```

**模式特征**: 跨语言运行时引用计数管理。`callback` 嵌入在 `PLySRFState` 结构中。

**Why**: Python 对象有独立的引用计数机制，不受 PostgreSQL MemoryContext 管理。当 SRF 执行完毕或中途出错时，需要通过回调正确释放 Python 引用，防止内存泄漏。


### 9.6 注意事项

1. **无注销机制**：如需取消，在回调函数中通过 `arg` 指向的状态标志判断
2. **回调中避免 ereport(ERROR)**：回调在 reset/delete 过程中执行，抛出 ERROR 会导致不完整状态
3. **分配位置**：回调结构应分配在目标 context 或其子 context 中
4. **isReset 标记**：注册回调会设置 `context->isReset = false`，确保 `MemoryContextResetOnly` 不跳过回调

---

## 十、共享缓冲区 vs 内存上下文

## 10.1. 两层内存架构概述

PostgreSQL 采用 **两层内存架构**：

| 层次 | 名称 | 共享性 | 生命周期 | 核心配置参数 |
|------|------|--------|----------|-------------|
| 第一层 | 共享缓冲区 (Shared Buffers) | 所有后端进程共享 | 持久存在（服务器运行期间） | `shared_buffers` |
| 第二层 | 内存上下文 (Memory Contexts) | 每个后端进程私有 | 随查询/事务/命令生命周期 | `work_mem`, `maintenance_work_mem` |

**核心区别**：共享缓冲区缓存的是 **磁盘数据页**（8KB 页面），内存上下文存储的是 **查询处理过程中的临时数据**。


<img width="1200" height="888" alt="Image" src="https://github.com/user-attachments/assets/2cabbdb4-5024-4606-a696-5c2a531b8f9d" />

## 10.2. 共享缓冲区 — 磁盘页面的缓存

### 10.2.1 存储内容

共享缓冲区存储的是 **磁盘页面的内存映射副本**，每个页面 8KB（`BLCKSZ`）。任何需要读写数据页的操作，都通过 `ReadBuffer()` 将页面加载到共享缓冲区。

| 内容 | 说明 | 典型 SQL 操作 |
|------|------|--------------|
| **表数据页** (Heap Pages) | 表的实际数据行 | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| **索引页** (Index Pages) | B-tree/Hash/GIN 等索引的内部节点和叶子页 | `WHERE` 条件、`JOIN`、索引扫描 |
| **TOAST 数据页** | 超大字段（TEXT、JSON、BYTEA 等）的溢出存储 | 访问大文本、JSONB、数组 |
| **FSM 页面** | 自由空间映射，跟踪每个数据页的可用空间 | `INSERT`（查找有足够空间的页） |
| **VM 页面** | 可见性映射，标记哪些页对所有人可见 | `VACUUM`、Index-Only Scan |

### 10.2.2 访问流程

```
SQL 查询需要访问数据页
  │
  ▼
ReadBuffer(relation, blockNum)
  │
  ├── 缓冲区中已有该页 (cache hit)
  │     └── Pin 住页面 → 获取 Content Lock → 读写 → 释放
  │
  └── 缓冲区中没有 (cache miss)
        ├── 选择一个 victim 页（Clock Sweep 算法）
        ├── victim 是脏页？→ WriteBack 到磁盘
        └── 从磁盘读取目标页到缓冲区
```

源码参考：
- `src/backend/storage/buffer/bufmgr.c:59` — `ReadBuffer()` 入口
- `src/include/storage/buf_internals.h:136` — `BufferDesc` 结构体（缓冲区描述符）
- `src/backend/access/heap/heapam.c:1634` — 堆表访问调用 `ReadBuffer()`

### 10.2.3 数据修改操作

`INSERT` / `UPDATE` / `DELETE` 的数据修改 **直接在共享缓冲区中进行**：

```
UPDATE orders SET status = 'shipped' WHERE id = 100;

1. ReadBuffer() → 将目标页加载到共享缓冲区
2. 获取 Exclusive Content Lock
3. 在缓冲区页面内修改元组（设置 xmin/xmax 等）
4. 标记缓冲区为脏页 (BM_DIRTY)
5. 释放 Content Lock，Unpin
6. 后续由 Checkpoint 或 BgWriter 将脏页写回磁盘
```

关键理解：数据修改是"先写内存，后写磁盘"——修改的是共享缓冲区中的页面，而不是直接写磁盘文件。

## 10.3. 内存上下文 — 查询处理的私有内存

### 10.3.1 层次结构

内存上下文采用 **父子层次结构**，子上下文随父上下文释放而释放，实现自动内存管理。

```
TopMemoryContext (进程生命周期，从不释放)
 │
 ├── CacheMemoryContext (进程生命周期)
 │     ├── relcache — 表结构缓存（列定义、索引、约束等）
 │     ├── catcache — 系统目录缓存（pg_class, pg_attribute 等）
 │     ├── plancache — 执行计划缓存
 │     └── typcache — 数据类型缓存
 │
 ├── MessageContext (每条命令结束重置)
 │     ├── 查询文本字符串
 │     ├── 解析树 (Parse Tree)
 │     └── 查询重写结果 (Rewritten Query)
 │
 ├── TopTransactionContext (顶层事务结束释放)
 │     └── CurTransactionContext (当前事务层)
 │           ├── 事务状态数据
 │           ├── 触发器执行上下文
 │           └── savepoint 数据
 │
 └── PortalContext (指向当前活跃 Portal)
       └── Portal->portalContext
             └── EState->es_query_cxt (执行器状态)
                   ├── 执行计划节点 (PlanState)
                   ├── TupleTableSlot (结果元组)
                   ├── ExprContext->ecxt_per_tuple_memory (每行重置)
                   └── 排序/哈希/物化子上下文 (受 work_mem 限制)
```

源码参考：
- `src/include/utils/memutils.h` — 全局内存上下文声明
- `src/backend/utils/mmgr/mcxt.c:48-57` — 全局上下文变量定义
- `src/backend/utils/mmgr/README` — 详细的层次结构文档

### 10.3.2 work_mem 控制的操作

`work_mem`（默认 4MB）限制 **每个单独的排序/哈希操作** 的内存使用上限。

| SQL 操作 | 内存用途 | 实现模块 | 超出 `work_mem` 时 |
|----------|----------|----------|-------------------|
| `ORDER BY` | 排序缓冲区 | `tuplesort` | 写入磁盘临时文件 |
| `DISTINCT` | 排序或哈希去重 | `tuplesort` / hash | 写入磁盘临时文件 |
| `Hash Join` | 构建端哈希表 | `nodeHash` | 分批 (batch) 处理 |
| `GROUP BY` (Hash Agg) | 聚合哈希表 | `nodeAgg` | 写入磁盘临时文件 |
| `GROUP BY` (Sort Agg) | 排序缓冲区 | `tuplesort` | 写入磁盘临时文件 |
| `CTE` | CTE 结果缓存 | `tuplestore` | 写入磁盘临时文件 |
| `Materialize` | 物化节点缓冲 | `tuplestore` | 写入磁盘临时文件 |
| 窗口函数 (`OVER`) | 窗口排序缓冲 | `tuplesort` | 写入磁盘临时文件 |
| `Merge Join` | 排序输入缓冲 | `tuplesort` | 写入磁盘临时文件 |

**关键要点**：一个查询可以 **同时使用多个** `work_mem`。

```sql
-- 这个查询可能同时使用 2 个 work_mem：
-- 1. Hash Join 的构建端哈希表
-- 2. ORDER BY 的排序缓冲
SELECT o.order_id, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
ORDER BY o.order_id;

-- 实际内存消耗 = 并发操作数 × work_mem
```

源码参考：
- `src/include/miscadmin.h:260` — `work_mem` 声明
- `src/backend/utils/sort/tuplesort.c:22-28` — work_mem 使用说明
- `src/backend/executor/nodeHash.c:3392-3412` — 哈希表内存限制计算

### 10.3.3 maintenance_work_mem 控制的操作

`maintenance_work_mem`（默认 64MB）用于 **维护类操作**，这类操作通常需要更大的内存来提高效率。

| 操作 | 内存用途 | 源码位置 |
|------|----------|----------|
| `VACUUM` / `VACUUM ANALYZE` | 收集死元组 ID 数组 | `backend/commands/vacuumlazy.c` |
| `CREATE INDEX` | 索引构建排序 | `backend/access/*/sort*.c` |
| `REINDEX` | 重建索引排序 | 同 CREATE INDEX |
| `ALTER TABLE` | 表重写临时数据 | `backend/commands/tablecmds.c` |
| `CLUSTER` | 聚簇排序 | `backend/commands/cluster.c` |

### 10.3.4 系统目录缓存 — 易混淆的重点

**系统目录缓存（relcache、catcache）是每个进程私有的，不在共享内存中！**

```c
// src/backend/utils/cache/relcache.c:410-411
// 每个后端进程在 CacheMemoryContext 中独立构建自己的缓存
oldcxt = MemoryContextSwitchTo(CacheMemoryContext);
```

为什么设计为私有？
- **避免锁竞争**：如果放在共享内存中，每次访问目录信息都需要加锁
- **事务一致性**：每个事务需要看到自己快照下的目录状态
- **跨进程一致性**：通过 **共享失效消息** (Shared Invalidation Messages) 机制实现

工作流程：
```
进程 A 执行 ALTER TABLE → 修改系统目录页（共享缓冲区中）
  → 发送共享失效消息

进程 B 下次访问该表 → 收到失效消息
  → 清除本地 relcache/catcache 中对应的缓存条目
  → 重新从系统目录页（共享缓冲区）读取最新信息
  → 重建本地缓存
```

缓存的目录信息包括：
- **relcache**：表的物理结构（列定义、索引列表、约束、触发器、分区信息等）
- **catcache**：`pg_class`, `pg_attribute`, `pg_proc`, `pg_type` 等系统目录行的本地副本
- **plancache**：`PREPARE` 语句和 PL/pgSQL 函数的执行计划
- **typcache**：数据类型信息（比较函数、哈希函数、排序规则等）

## 10.4. SQL 操作完整映射表

从日常 SQL 操作的角度，数据在两种内存中的分布：

| SQL 操作 | 共享缓冲区中的数据 | 内存上下文中的数据 | 配置参数 |
|----------|------------------|------------------|----------|
| `SELECT` 全表扫描 | 读取的堆页面 | WHERE 条件求值的临时数据 | `shared_buffers` |
| `SELECT` 索引扫描 | 读取的索引页 + 堆页面 | 索引条件求值 | `shared_buffers` |
| `ORDER BY` | 可能读取数据页 | **排序缓冲区** | `work_mem` |
| `GROUP BY` | 读取数据页 | **聚合哈希/排序表** | `work_mem` |
| `Hash Join` | 读取两表数据页 | **构建端哈希表** | `work_mem × hash_mem_multiplier` |
| `Nested Loop Join` | 读取外表 + 内表页面 | 无显著额外内存 | — |
| `Merge Join` | 读取两表页面 | 排序缓冲（如需排序） | `work_mem` |
| `INSERT` | 写入堆页面（标记脏页） | 构造新元组 | `shared_buffers` |
| `UPDATE` | 读+写堆页面（旧版本标记） | 构造新元组版本 | `shared_buffers` |
| `DELETE` | 标记堆页面中的元组 | 构造删除标记 | `shared_buffers` |
| `VACUUM` | 扫描+清理页面 | **死元组 ID 收集数组** | `maintenance_work_mem` |
| `CREATE INDEX` | 读取堆页面 + 写入新索引页 | **索引构建排序** | `maintenance_work_mem` |
| DDL (`CREATE TABLE`) | 更新系统目录页面 | relcache/catcache 条目 | `shared_buffers` |
| `PREPARE` / 执行计划 | — | **执行计划缓存** (plancache) | — |
| 临时表 | 特殊：使用 **本地缓冲区** (local buffers) | 查询处理临时数据 | `temp_buffers` |

### 特殊情况：临时表

临时表的数据页不使用共享缓冲区，而是使用 **本地缓冲区** (Local Buffers)，由 `temp_buffers` 参数控制。这是因为临时表的数据只对创建它的会话可见，不需要跨进程共享。

```c
// src/include/storage/bufmgr.h
#define BufferIsLocal(buffer) ((buffer) < 0)
// 负数 buffer ID 表示本地缓冲区
```

## 10.5. 实际配置建议

```postgresql
-- 共享缓冲区：系统内存的 25%（Linux），不超过 40%
shared_buffers = '4GB'              -- 16GB 内存服务器

-- 排序/哈希内存：需评估并发查询数
-- 估算: (总内存 - shared_buffers) / max_connections / 并发操作数
work_mem = '64MB'                   -- 根据实际并发量调整

-- 维护操作内存
maintenance_work_mem = '512MB'      -- 加速 VACUUM 和 CREATE INDEX

-- 哈希内存倍率 (PG 14+)
hash_mem_multiplier = 2.0           -- Hash Join 可用 work_mem × 2

-- 自动清理专用内存 (覆盖 maintenance_work_mem)
autovacuum_work_mem = '256MB'

-- 临时表本地缓冲区
temp_buffers = '8MB'                -- 使用临时表时适当增大
```

### 内存估算公式

```
单后端最大私有内存 ≈ work_mem × 并发排序/哈希数 + CacheMemoryContext 开销

总私有内存 ≈ max_connections × (work_mem × 平均并发操作数 + 基础开销 ~10MB)

总内存需求 ≈ shared_buffers + 总私有内存 + OS 页面缓存
```

**示例**（16GB 内存服务器）：
```
shared_buffers = 4GB
work_mem = 64MB
max_connections = 200
假设平均每个连接 2 个并发操作，基础开销 10MB

总私有内存 ≈ 200 × (64MB × 2 + 10MB) = 200 × 138MB ≈ 27.6GB  ← 远超内存！

实际做法：
  有效连接数通常远小于 max_connections（连接池）
  假设活跃连接 20: 20 × 138MB = 2.76GB
  总计: 4GB + 2.76GB + OS 缓存 ≈ 合理范围内
```


---


## 十一、设计哲学总结

### 为什么用 Memory Context 而不是直接 malloc/free？

1. **防止内存泄漏**：通过 reset 一整个 context 即可释放所有关联内存，无需逐个 free
2. **错误安全**：ERROR 发生时，只需 reset 对应生命周期的 context，不会遗漏
3. **生命周期管理**：不同数据有不同的生命周期（per-tuple, per-query, per-transaction），树形结构自然映射
4. **性能优化**：AllocSet 的空闲链表避免了频繁的 malloc/free 系统调用
5. **调试支持**：context 命名、统计、回调机制便于追踪内存使用

### 设计决策汇总

| 设计决策 | 解决的问题 | 实现方式 |
|----------|-----------|----------|
| Block 内多 Chunk | 减少 malloc 调用次数 | 单次 malloc 获取大块，内部分割 |
| 2 的幂对齐 freelist | O(1) 快速查找/复用 | `AllocSetFreeIndex` 位运算定位桶号 |
| keeper Block | 避免 Reset 频繁 malloc/free | 初始 Block 与上下文头共享 malloc |
| 大块独立分配 | 避免大块长期占用 freelist 空间 | 超过 allocChunkLimit 直接 malloc |
| Block 倍增策略 | 减少后续 malloc 开销 | `nextBlockSize <<= 1` 直到 `maxBlockSize` |
| 全局上下文缓存 | 避免频繁创建/销毁上下文 | `context_freelists[2]` 各缓存 100 个 |
| `aset` 双重用途 | 零额外开销实现 freelist | 已分配指向 set, 已释放指向 next chunk |
| 虚函数表 | 支持多种分配策略 | C 语言面向对象多态 |
| 回调机制 | 清理非 palloc 资源 | LIFO 链表，先弹出再调用 |

---

## 参考资料

- `src/backend/utils/mmgr/README` — Memory Context 系统设计概述
- `src/backend/utils/mmgr/mcxt.c` — 抽象管理层实现
- `src/backend/utils/mmgr/aset.c` — AllocSet 默认实现
- `src/backend/utils/mmgr/slab.c` — Slab 分配器
- `src/backend/utils/mmgr/generation.c` — Generation 分配器
- `src/include/nodes/memnodes.h` — MemoryContextData 结构定义
- `src/include/utils/memutils.h` — 公共 API 声明、参数宏、大小限制宏
- `src/include/utils/palloc.h` — palloc 系列接口、MemoryContextCallback 定义
- `src/backend/utils/sort/tuplesort.c` — tuplesort 的 work_mem 记账机制
- `src/backend/executor/nodeHash.c` — Hash Join 内存限制计算
- `src/backend/executor/execUtils.c:315-331` — CreateWorkExprContext
- `src/backend/utils/misc/guc.c` — work_mem GUC 定义
- `src/include/miscadmin.h` — work_mem 全局变量声明
- `src/include/storage/buf_internals.h` —`BufferDesc` 结构体定义 
- `src/backend/storage/buffer/bufmgr.c` — `ReadBuffer()` 实现                   
- `src/backend/storage/buffer/README`  — 共享缓冲区 Pin/Lock 规则  
- `src/backend/access/heap/heapam.c`   — 堆表访问（调用 `ReadBuffer`）     
- `src/backend/utils/sort/tuplesort.c` — 排序实现（`work_mem` 使用）   
- `src/backend/executor/nodeHash.c`    — Hash Join 实现（`work_mem` 使用）   
- `src/backend/utils/cache/relcache.c` — 表结构缓存（`CacheMemoryContext`）  
- `src/backend/utils/cache/catcache.c` — 系统目录缓存                    
- `src/backend/tcop/postgres.c`  — 查询处理主循环（`MessageContext`）  
- `src/backend/utils/misc/guc.c`  — 配置参数定义（`work_mem` 等）    
- `src/include/miscadmin.h:260-262` — `work_mem` / `maintenance_work_mem` 声明 

**PostgreSQL 版本**：14.4