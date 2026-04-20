
> 之前分析了pg的共享缓存管理原理，这次分析一下私有内存的管理：memory context。文中代码均基于pg 14.4分析。

---

## 一、概述与架构总览

### 1.1 核心问题

为什么内存的申请/释放可以通过 Memory Context？Memory Context 和内存管理之间是什么关系？

### 1.2 回答

Memory Context 是 PostgreSQL 在 C 标准库 `malloc/free` 之上构建的一层抽象内存管理框架。它不替代 `malloc/free`，而是通过树形上下文结构、虚函数表和反向指针，将零散的 `malloc/free` 调用组织为按作用域批量管理的模式，解决手动内存管理的泄漏问题。

### 1.3 四层架构


<img width="1200" height="849" alt="Image" src="https://github.com/user-attachments/assets/5e629228-741e-44b0-a513-9cc04622a227" />

| 层次 | 职责 | 关键文件 |
|------|------|----------|
| **用户 API 层** | 提供类 malloc/free 接口 | `palloc.h` |
| **抽象管理层** | 上下文树管理、分配路由 | `mcxt.c`, `memnodes.h` |
| **具体实现层** | 实际内存分配策略 | `aset.c`, `slab.c`, `generation.c` |
| **OS 内存层** | 最终的 malloc/free 调用 | C 标准库 |

### 1.4 Memory Context 与 malloc/free 的关系

```
Memory Context ≠ 替代 malloc/free
Memory Context = 在 malloc/free 之上构建的管理框架

┌─────────────────────────────────┐
│  用户代码: palloc / pfree        │ ← 不直接接触 malloc/free
├─────────────────────────────────┤
│  Memory Context 抽象层           │ ← 上下文管理、路由
├─────────────────────────────────┤
│  AllocSet / Slab / Generation   │ ← 池化、空闲链表优化
├─────────────────────────────────┤
│  malloc / free / realloc        │ ← 最终的 OS 内存操作
└─────────────────────────────────┘
```

Memory Context 最终还是要调用 `malloc/free`，但它在上面加了三层管理：

1. **池化**：AllocSet 从 OS 申请大块内存，内部切分为小 chunk 供 palloc 使用
2. **作用域**：树形 context 将分配与生命周期绑定，reset 即释放
3. **路由**：虚函数表支持不同分配策略，无需修改上层代码

---

## 二、核心数据结构

### 2.1 MemoryContextData — 抽象基类


```c
/* src/include/nodes/memnodes.h:78-93 */
typedef struct MemoryContextData
{
    NodeTag     type;               /* 节点类型标识 T_AllocSetContext 等 */
    bool        isReset;            /* 自上次 Reset 后是否无分配 */
    bool        allowInCritSection; /* 是否允许在临界区中 palloc */
    Size        mem_allocated;      /* 跟踪此上下文分配的总内存 */
    const MemoryContextMethods *methods; /* 虚函数表 */
    MemoryContext parent;           /* 父上下文 */
    MemoryContext firstchild;       /* 第一个子上下文 */
    MemoryContext prevchild;        /* 前一个兄弟上下文 */
    MemoryContext nextchild;        /* 后一个兄弟上下文 */
    const char  *name;             /* 上下文名称 (调试用) */
    const char  *ident;            /* 上下文标识 (调试用) */
    MemoryContextCallback *reset_cbs; /* Reset/Delete 回调链表 */
} MemoryContextData;
```

`MemoryContextData` 通过 `parent`、`firstchild`、`prevchild`、`nextchild` 四个指针字段，构建出一棵双向链表子节点树。

**关键字段说明**：


<img width="1200" height="627" alt="Image" src="https://github.com/user-attachments/assets/d6ca8bd2-12f7-425f-96ef-08808ff2d825" />

| 字段 | 作用 | 设计意图 |
|------|------|----------|
| `methods` | 指向虚函数表 | C 语言多态，`palloc/pfree` 通过此表分发到具体实现 |
| `parent / firstchild / prevchild / nextchild` | 构成上下文父子树 | `MemoryContextDelete` 递归删除子上下文；`MemoryContextReset` 重置当前及所有子上下文 |
| `isReset` | 快速判断是否为空 | 避免不必要的 `AllocSetReset` 遍历开销 |
| `mem_allocated` | 跟踪 malloc 总量 | 用于 `MemoryContextStats` 统计和内存审计 |
| `reset_cbs` | 回调链表 | context reset/delete 时自动清理非 palloc 资源 |

**子上下文的双向链表结构**：

```
parent
  ├── firstchild ──→ Child A
  │                    ├── prevchild: NULL (首个子节点)
  │                    └── nextchild ──→ Child B
  │                                       ├── prevchild ──→ Child A
  │                                       └── nextchild: NULL (末尾)
```

**关键操作**：

**1. 添加子节点**（`MemoryContextCreate`, `mcxt.c:814-853`）：
- 新子节点插入到 `parent->firstchild` 位置（头部插入）
- 新节点的 `nextchild` 指向原第一个子节点
- 原第一个子节点的 `prevchild` 指向新节点

```
/* src/backend/utils/mmgr/mcxt.c:838-844 */
node->nextchild = parent->firstchild;
if (parent->firstchild != NULL)
    parent->firstchild->prevchild = node;
parent->firstchild = node;
```

**2. 摘除子节点**（`MemoryContextSetParent`, `mcxt.c:361-404`）：
- 更新前后兄弟的 `prevchild`/`nextchild` 指针
- 如果是第一个子节点，更新父节点的 `firstchild`

```
/* src/backend/utils/mmgr/mcxt.c:375-384 */
if (context->prevchild != NULL)
    context->prevchild->nextchild = context->nextchild;
else
    parent->firstchild = context->nextchild;
if (context->nextchild != NULL)
    context->nextchild->prevchild = context->prevchild;
```

 **`mem_allocated` 字段**

跟踪当前上下文从 `malloc()` 获取的总内存量。在分配/释放块时更新：

```
/* src/backend/utils/mmgr/aset.c:744 */
context->mem_allocated += blksize;   /* 分配块时增加 */
/* src/backend/utils/mmgr/aset.c:603 */
context->mem_allocated -= block->endptr - ((char *)block);  /* 释放块时减少 */
```


### 2.2 虚函数表 — 接口与实现分离

Memory Context 用 C 语言实现了类似 C++ 虚函数的面向对象设计：

```c
/* src/include/nodes/memnodes.h:58-75 */
typedef struct MemoryContextMethods
{
    void       *(*alloc) (MemoryContext context, Size size);
    void        (*free_p) (MemoryContext context, void *pointer);
    void       *(*realloc) (MemoryContext context, void *pointer, Size size);
    void        (*reset) (MemoryContext context);
    void        (*delete_context) (MemoryContext context);
    Size        (*get_chunk_space) (MemoryContext context, void *pointer);
    bool        (*is_empty) (MemoryContext context);
    void        (*stats) (MemoryContext context, ...);
} MemoryContextMethods;
```

`MemoryContextData` 是抽象基类，`AllocSetContext`、`SlabContext`、`GenerationContext` 是具体子类。每个具体上下文类型提供自己的函数指针表。

**调用路由**：当调用 `palloc(size)` 时：

```
palloc(size)                                          -- mcxt.c:1067
  └─> context = CurrentMemoryContext
  └─> ret = context->methods->alloc(context, size)    -- 虚函数调用!
       └─> AllocSetAlloc(context, size)               -- 具体实现
            └─> 从 block 池中分配 / malloc()
```

### 2.3 反向指针 — pfree/repalloc 的秘密

`pfree(ptr)` 只接收一个指针，它怎么知道内存属于哪个上下文？答案是每个已分配的 chunk 在用户数据之前紧邻存储了一个指向所属 MemoryContext 的指针。

```c
/* src/include/utils/memutils.h:113-134 */
static inline MemoryContext
GetMemoryChunkContext(void *pointer)
{
    MemoryContext context;
    Assert(pointer != NULL);
    Assert(pointer == (void *) MAXALIGN(pointer));

    /* 关键：向前偏移 sizeof(void*) 字节，取出 context 指针 */
    context = *(MemoryContext *) (((char *) pointer) - sizeof(void *));
    AssertArg(MemoryContextIsValid(context));
    return context;
}
```


<img width="1200" height="554" alt="Image" src="https://github.com/user-attachments/assets/a6f6babe-36ac-452e-a230-c87530c301ed" />

`pfree` 的完整流程：

```c
/* src/backend/utils/mmgr/mcxt.c:1175-1181 */
void pfree(void *pointer)
{
    MemoryContext context = GetMemoryChunkContext(pointer);  /* 反向找到 context */
    context->methods->free_p(context, pointer);              /* 虚函数调用 */
}
```

### 2.4 类型关系与三种分配器

`MemoryContextData` 是抽象基类，通过结构体嵌入模拟继承。每种具体实现的第一个字段都是 `header: MemoryContextData`：

```c
/* src/backend/utils/mmgr/aset.c:121 */
typedef struct AllocSetContext
{
    MemoryContextData header;   /* ← 嵌入的"基类" */
    AllocBlock    blocks;       /* 类型特有字段 */
    AllocChunk    freelist[11];
    /* ... */
} AllocSetContext;
```

通过 C 语言的指针兼容性，`AllocSetContext*` 可以安全地转换为 `MemoryContext`（即 `MemoryContextData*`）。

**虚函数表（多态）**

`MemoryContextMethods` 是一个函数指针表，实现了 C 语言的运行时多态：

```c
/* src/include/nodes/memnodes.h:58-75 */
typedef struct MemoryContextMethods
{
    void    *(*alloc)(MemoryContext context, Size size);
    void     (*free_p)(MemoryContext context, void *pointer);
    void    *(*realloc)(MemoryContext context, void *pointer, Size size);
    void     (*reset)(MemoryContext context);
    void     (*delete_context)(MemoryContext context);
    Size     (*get_chunk_space)(MemoryContext context, void *pointer);
    bool     (*is_empty)(MemoryContext context);
    void     (*stats)(MemoryContext context, ...);
} MemoryContextMethods;
```

每种分配器提供自己的 `Methods` 静态实例：
- `AllocSetMethods`（`aset.c:285`）
- `SlabMethods`（`slab.c:147`）
- `GenerationMethods`（`generation.c:168`）

**类型验证**：

```c
/* src/include/nodes/memnodes.h:104-108 */
#define MemoryContextIsValid(context) \
    ((context) != NULL && \
     (IsA((context), AllocSetContext) || \
      IsA((context), SlabContext) || \
      IsA((context), GenerationContext)))
```

**三种分配器对比**：

| 特性 | AllocSet (aset.c) | Slab (slab.c) | Generation (generation.c) |
|------|-------------------|---------------|---------------------------|
| **适用场景** | 通用场景 | 等大小对象大量分配 | FIFO/代际分配 |
| **块大小** | 倍增（8K→16K→...→maxBlockSize） | 固定 | 固定 |
| **空闲管理** | 2 的幂 freelists | 块内空闲链表 + 全局分组 | 不复用，整块释放 |
| **碎片控制** | 可能浪费最多 50% | 零浪费 | 不复用 chunk |
| **pfree 行为** | 小 chunk 入空闲链表，大 chunk 调 free() | 归还 slab | 可能归还 OS |
| **内存归还 OS** | 仅在 Reset/Delete 时 | pfree 即可归还 | pfree 即可归还 |
| **典型用途** | 大多数上下文 | ReorderBuffer | ReorderBuffer |


<!-- Failed to upload "type-relationship.png" -->

---

## 三、上下文树层次与生命周期

### 3.1 标准上下文层次

PostgreSQL 在运行时维护一棵内存上下文树。`TopMemoryContext` 是根节点，所有其他上下文都是其直接或间接子节点。


<img width="1200" height="588" alt="Image" src="https://github.com/user-attachments/assets/e3b4cad2-00ae-47bd-b17c-abd3695b5d32" />

| 上下文 | 生命周期 | 用途 |
|--------|----------|------|
| `TopMemoryContext` | 进程级别，永不释放 | 全局永久数据 |
| `ErrorContext` | 进程级别，永不重置 | 保证 OOM 时也有内存可用，允许在临界区分配 |
| `CacheMemoryContext` | 进程级别 | relcache/catcache 等系统缓存 |
| `MessageContext` | 每条客户端消息后 Reset | 查询文本、解析/计划树 |
| `TopTransactionContext` | 顶层事务结束后 Reset | 跨子事务的状态 |
| `CurTransactionContext` | 当前事务结束后 Reset | 事务内数据 |
| `PortalContext` | Portal 销毁时释放 | Portal 执行期数据 |
| `SubTransactionContext` | SAVEPOINT 级别 | 子事务回滚时释放 |

**源文件引用**：
- 上下文声明：`src/include/utils/memutils.h:55-64`
- 初始化逻辑：`src/backend/utils/mmgr/mcxt.c:98-135`

### 3.2 树形结构操作

**添加子节点**（`MemoryContextCreate`, `mcxt.c:814-853`）：头部插入

```c
/* src/backend/utils/mmgr/mcxt.c:838-844 */
node->nextchild = parent->firstchild;
if (parent->firstchild != NULL)
    parent->firstchild->prevchild = node;
parent->firstchild = node;
```

**摘除子节点**（`MemoryContextSetParent`, `mcxt.c:361-404`）：

```c
/* src/backend/utils/mmgr/mcxt.c:375-384 */
if (context->prevchild != NULL)
    context->prevchild->nextchild = context->nextchild;
else
    parent->firstchild = context->nextchild;
if (context->nextchild != NULL)
    context->nextchild->prevchild = context->prevchild;
```

### 3.3 生命周期管理机制


<!-- Failed to upload "memory-context-tree-lifecycle.png" -->

| 操作 | 行为 | 源码位置 |
|------|------|----------|
| `MemoryContextReset(ctx)` | 删除所有子 context + 释放 ctx 本身内存 | `mcxt.c:142-154` |
| `MemoryContextDelete(ctx)` | 从父节点摘除 + 递归删除子节点 + 释放 | `mcxt.c:217-255` |
| `MemoryContextDeleteChildren(ctx)` | 仅删除子节点，保留自身 | `mcxt.c:262-273` |
```
MemoryContextReset(context)         — 重置上下文（释放内存，保留上下文本身）
  ├── MemoryContextDeleteChildren()  — 先删除所有子上下文
  └── context->methods->reset()      — 调用具体分配器的 reset

MemoryContextDelete(context)         — 删除上下文（释放内存 + 删除上下文）
  ├── MemoryContextDeleteChildren()  — 删除所有子上下文
  ├── MemoryContextSetParent(NULL)   — 从父上下文链表中摘除
  └── context->methods->delete()     — 调用具体分配器的 delete
```

**为什么需要树形结构？**

1. 生命周期嵌套：事务 > 语句 > 扫描 > 元组，树形结构正好对应这种层级
2. 防止泄漏：删除父节点时自动删除所有子节点，不会遗漏
3. 错误安全：发生 ERROR 时，只需 reset 对应的生命周期上下文，就能清理所有相关内存


**典型调用链**：`exec_simple_query → PortalDrop → MemoryContextReset(MessageContext)`

---

## 四、AllocSet 内部实现详解

AllocSet 是 PostgreSQL 的默认分配器，绝大多数内存上下文使用此实现。

`MemoryContextData` 最重要的作用是管理各个内存上下文之间的关联关系，清除一个内存上下文时会遍历所有子节点并释放。

`AllocSetContext` 是 `MemoryContextData` 的具体实现，负责内存的分配和释放。

一个 `AllocSetContext` 拥有多个 `AllocBlockData`（双向链表），每个 `AllocBlockData` 内部包含多个 `AllocChunkData`（连续排列），空闲的 `AllocChunkData` 通过 `freelist` 数组按大小分桶链式管理。

| 结构 | 角色 | 定义位置 |
|------|------|----------|
| `AllocSetContext` | 内存上下文管理器 | `aset.c:121-135` |
| `AllocBlockData` | 从 malloc 获取的内存块 | `aset.c:151-158` |
| `AllocChunkData` | 单次 palloc 分配的内存块前缀 | `aset.c:172-194` |


<img width="1200" height="925" alt="Image" src="https://github.com/user-attachments/assets/f4987ce3-0b41-4039-a5f8-5e4054a70860" />

### 4.1 AllocSetContext

```c
/* src/backend/utils/mmgr/aset.c:121-135 */
typedef struct AllocSetContext
{
    MemoryContextData header;   /* 标准内存上下文头部 */
    AllocBlock   blocks;       /* Block 双向链表头（始终指向活跃 Block） */
    AllocChunk   freelist[ALLOCSET_NUM_FREELISTS]; /* 11 个空闲 chunk 链表 */
    Size         initBlockSize; /* 初始 Block 大小 */
    Size         maxBlockSize;  /* 最大 Block 大小 */
    Size         nextBlockSize; /* 下一个要分配的 Block 大小 */
    Size         allocChunkLimit; /* chunk 尺寸上限 */
    AllocBlock   keeper;       /* keeper Block (Reset 时不释放) */
    int          freeListIndex; /* 全局上下文缓存池索引, -1 表示不缓存 */
} AllocSetContext;
```

`header` 是 `MemoryContextData` 类型，定义在 `src/include/nodes/memnodes.h:78-93`。AllocSetContext 必须以此字段开头，这是多态实现的基础——所有内存上下文类型都共享相同的头部布局。

### 4.2 AllocBlockData — malloc 内存块

```c
/* src/backend/utils/mmgr/aset.c:151-158 */
typedef struct AllocBlockData
{
    AllocSet    aset;       /* 所属的 AllocSet */
    AllocBlock  prev;       /* 双向链表：前一个 block */
    AllocBlock  next;       /* 双向链表：后一个 block */
    char       *freeptr;    /* Block 内空闲空间起始位置 */
    char       *endptr;     /* Block 内空间结束位置 */
} AllocBlockData;
```

Block 是从 `malloc()` 获取的连续内存。一个 Block 可以容纳多个 Chunk。`freeptr` 向 `endptr` 方向增长，新 Chunk 从 `freeptr` 处切割。

**Block 内部布局**：

```
┌─────────────────┬──────────┬──────────┬──────────┬─────┬──────────────┐
│ AllocBlockData  │ ChunkHdr │ Data     │ ChunkHdr │Data │  空闲空间    │
│ (ALLOC_BLOCKHDRSZ)│(HDRSZ) │          │(HDRSZ)   │     │              │
└─────────────────┴──────────┴──────────┴──────────┴─────┴──────────────┘
                   ↑                                          ↑
                 第一个 Chunk                              freeptr     endptr
```

**两种 Block 类型**：

| 类型 | 特征 | 分配时机 | 释放时机 |
|------|------|----------|----------|
| **多 chunk Block** | `freeptr < endptr`，包含多个 chunk | 正常分配，大小按倍增策略 | `AllocSetReset` 时 |
| **单 chunk Block** | `freeptr == endptr`，仅一个 chunk | 请求超过 `allocChunkLimit` | `pfree` 时立即 `free()` |

- 每个块通过 `malloc()` 分配
- 块大小按**倍增策略**增长：`initBlockSize → 2x → 4x → ... → maxBlockSize`，达到最大块大小后，后续分配都按照最大块大小来分配
- **keeper 块**（`keeper` 字段）：初始块，与 `AllocSetContext` 头部共享同一个 `malloc` 分配，`reset` 时保留不释放
- 块内连续存放多个 chunk
- 因为 `blocks` 使用的是链表头插法，所以始终指向当前 AllocSet 中 `AllocBlockData` 组成的**双向链表头部**，**头部始终是当前活跃 Block**，链表通过每个 Block 的 `prev` / `next` 指针连接

##### 块尺寸增长参数

| 字段 | 含义 | 默认值 (ALLOCSET_DEFAULT_SIZES) |
|------|------|------|
| `initBlockSize` | 首个 Block 大小 | 8KB |
| `maxBlockSize` | Block 尺寸上限 | 8MB |
| `nextBlockSize` | 下次分配的 Block 大小 | 从 initBlockSize 开始倍增 |

增长策略（`aset.c:906-909`）：
```
nextBlockSize = initBlockSize     → 8KB
nextBlockSize <<= 1               → 16KB
nextBlockSize <<= 1               → 32KB
... 直到达到 maxBlockSize → 8MB (封顶)
```


### 4.3 AllocChunkData — 分配块前缀

```c
/* src/backend/utils/mmgr/aset.c:172-194 */
typedef struct AllocChunkData
{
    Size  size;         /* chunk 实际大小（对齐后） */
    /* padding (alignment) */
    void *aset;         /* 双重用途：已分配→指向 AllocSet；空闲→指向下一个空闲 chunk */
} AllocChunkData;
```

`aset` 字段的双重身份——侵入式链表：

| 状态 | `aset` 值 | 用途 |
|------|-----------|------|
| 已分配 | `(void *) set` | `pfree` 时通过 `GetMemoryChunkContext` 找到所属上下文 |
| 空闲（在 freelist 中） | `(void *) next_chunk` | 充当侵入式链表的 next 指针，零额外开销 |

这种设计让 chunk 在"已分配"和"空闲"之间切换时无需额外存储：`pfree` 时只需 `chunk->aset = freelist[fidx]`，`palloc` 时只需 `chunk->aset = set`。

关键宏（`aset.c:216-219`）：

```c
#define AllocPointerGetChunk(ptr)  ((AllocChunk)(((char *)(ptr)) - ALLOC_CHUNKHDRSZ))
#define AllocChunkGetPointer(chk)  ((AllocPointer)(((char *)(chk)) + ALLOC_CHUNKHDRSZ))
```

```c
#define ALLOC_CHUNKHDRSZ  sizeof(struct AllocChunkData)
```

```c
Static AssertStmt(ALLOC_CHUNKHDRSZ == MAXALIGN(ALLOC_CHUNKHDRSZ),
                 "sizeof(AllocChunkData) is not maxaligned");
Static AssertStmt(offsetof(AllocChunkData, aset) + sizeof(MemoryContext) ==
                 ALLOC_CHUNKHDRSZ,
                 "padding calculation in AllocChunkData is wrong");
```
`AllocChunkData` 的大小被设计为 `MAXALIGN` 对齐的，确保 payload 起始地址也是对齐的。源码中有静态断言保证了 `aset` 字段紧邻 payload，`GetMemoryChunkContext()` 可以通过 `pointer - sizeof(void*)` 直接获取上下文指针。

### 4.4 核心参数定义


```c
/* src/backend/utils/mmgr/aset.c:79-84 */
#define ALLOC_MINBITS            3       /* 最小 chunk 大小为 8 字节 */
#define ALLOCSET_NUM_FREELISTS   11      /* freelist 数组大小 */
#define ALLOC_CHUNK_LIMIT  (1 << (ALLOCSET_NUM_FREELISTS-1+ALLOC_MINBITS))
                                        /* 最大 chunk 限制 = 8192 字节 */
#define ALLOC_CHUNK_FRACTION      4     /* chunk 最大不超过 maxBlockSize 的 1/4 */
```

**块尺寸增长参数**：

| 字段 | 含义 | 默认值 |
|------|------|--------|
| `initBlockSize` | 首个 Block 大小 | 8KB |
| `maxBlockSize` | Block 尺寸上限 | 8MB |
| `nextBlockSize` | 下次分配的 Block 大小 | 从 initBlockSize 开始倍增 |

增长策略：

```c
/* src/backend/utils/mmgr/aset.c:906-909 */
nextBlockSize = initBlockSize     → 8KB
nextBlockSize <<= 1               → 16KB
nextBlockSize <<= 1               → 32KB
... 直到达到 maxBlockSize → 8MB (封顶)
```

### 4.5 Freelist — 11 桶空闲链表

AllocSet 性能优化的核心。11 个桶位按 2 的幂次划分空闲 chunk：

| 索引 (fidx) | Chunk 大小 | 计算公式 | 适用请求范围 |
|:-----------:|:----------:|:--------:|:----------:|
| 0 | 8 B | `1 << (0+3)` | 1 ~ 8 B |
| 1 | 16 B | `1 << (1+3)` | 9 ~ 16 B |
| 2 | 32 B | `1 << (2+3)` | 17 ~ 32 B |
| 3 | 64 B | `1 << (3+3)` | 33 ~ 64 B |
| 4 | 128 B | `1 << (4+3)` | 65 ~ 128 B |
| 5 | 256 B | `1 << (5+3)` | 129 ~ 256 B |
| 6 | 512 B | `1 << (6+3)` | 257 ~ 512 B |
| 7 | 1024 B | `1 << (7+3)` | 513 ~ 1024 B |
| 8 | 2048 B | `1 << (8+3)` | 1025 ~ 2048 B |
| 9 | 4096 B | `1 << (9+3)` | 2049 ~ 4096 B |
| 10 | 8192 B | `1 << (10+3)` | 4097 ~ 8192 B |

- `pfree()` 时，chunk 按大小放入对应的 freelist
- `palloc()` 时，先从 freelist 查找可复用的 chunk
- freelist 通过 `chunk->aset` 字段链接（一个字段两种用途）

**分桶算法**：
```c
/* src/backend/utils/mmgr/aset.c:308-354 */
static inline int AllocSetFreeIndex(Size size)
{
    if (size > (1 << ALLOC_MINBITS))  // > 8
        idx = 31 - __builtin_clz((uint32) size - 1) - ALLOC_MINBITS + 1;
        // 等价于 ceil(log2(size >> 3))
    else
        idx = 0;
    return idx;
}
```


> **超过 8192 B 的请求**：不使用 freelist，直接通过 `malloc()` 分配独立 block。


<img width="1200" height="1054" alt="Image" src="https://github.com/user-attachments/assets/bda0e936-0002-40f1-b91b-023d729b6065" />

**LIFO 策略**：释放时头插法推入链表头，分配时从链表头弹出。最近释放的 chunk 更可能仍在 CPU cache 中，提高缓存命中率。

**性能设计**：

- **幂次大小策略**：保证可回收性——无论请求模式如何，浪费空间保持恒定（最坏约 50%）
- **大小分类阈值**：`≤ 8KB` → freelist 复用；`> 8KB` → malloc 独立 block
- 所有 freelist 中的 chunk 都是 2 的幂次大小（`aset.c:57-60`），提高复用率

### 4.6 Keeper Block 机制

keeper 的目的：避免 Reset 时反复 malloc/free。

初始创建时（`aset.c:487-500`），`AllocSetContext` 头部和第一个 `AllocBlockData` 共享**同一块 malloc 内存**：

```
malloc(firstBlockSize) 返回的内存:
┌──────────────────────┬───────────────┬─────────────────────────┐
│  AllocSetContext     │ AllocBlockData│ 可用于分配 Chunk 的空间  │
│  (上下文头部)          │ (keeper Block)│                         │
└──────────────────────┴───────────────┴─────────────────────────┘
```

- `keeper` 指向这个初始 Block
- `AllocSetReset` 时只重置 keeper 的 `freeptr`，其他 Block 被 `free()`
- 因此 Reset 后不需要重新 malloc 上下文头部和初始 Block

内存布局：keeper 与 header 共享一次 malloc

`AllocSetContextCreateInternal`的核心代码：

```c
/* src/backend/utils/mmgr/aset.c:457-500 */
/* 计算首次分配大小：context header + block header + chunk header */
firstBlockSize = MAXALIGN(sizeof(AllocSetContext)) +
    ALLOC_BLOCKHDRSZ + ALLOC_CHUNKHDRSZ;
if (minContextSize != 0)
    firstBlockSize = Max(firstBlockSize, minContextSize);
else
    firstBlockSize = Max(firstBlockSize, initBlockSize);

/* 一次 malloc 分配整个区域 */
set = (AllocSet) malloc(firstBlockSize);

/* keeper block 紧跟在 context header 之后 */
block = (AllocBlock) (((char *) set) + MAXALIGN(sizeof(AllocSetContext)));
block->aset = set;
block->freeptr = ((char *) block) + ALLOC_BLOCKHDRSZ;
block->endptr = ((char *) set) + firstBlockSize;

/* 标记为 keeper */
set->keeper = block;

/* 初始化 chunk freelist 为空 */
MemSetAligned(set->freelist, 0, sizeof(set->freelist));
```



<img width="1200" height="498" alt="Image" src="https://github.com/user-attachments/assets/6137006f-a158-46bf-8106-c67508579828" />

**关键点**：
- 上下文头 (`AllocSetContext`) 和 keeper block (`AllocBlockData`) 在同一次 `malloc` 中分配
- `set->keeper` 指向紧跟在 header 后面的 block
- chunk freelist 初始化全部为 `NULL

**keeper 的本质特征**

| 特性 | 说明 | 源码依据 |
|------|------|----------|
| **共生死** | 与 context header 共用同一次 malloc，无法独立释放 | `aset.c:469` |
| **Reset 不释放** | `AllocSetReset` 释放所有其他 block，但保留 keeper | `aset.c:585-598` |
| **Delete 时决定命运** | 可放入 context freelist 复用，或随 header 一起 free | `aset.c:627-705` |

**为什么需要 keeper？** 源码注释（`aset.c:551-557`）明确说明：

> In this way, we don't thrash malloc() when a context is repeatedly reset after small allocations, which is typical behavior for per-tuple contexts.

典型场景是 per-tuple context：每个元组处理完毕后 Reset，下一个元组到来时重新分配。如果没有 keeper，每次 Reset 都要 `free()` + `malloc()`，造成严重的系统调用开销。

### 4.7 `allocChunkLimit` 的计算

`allocChunkLimit` 决定了请求是作为 chunk 从 freelist/Block 中分配，还是单独 malloc 一个专用 Block。

```c
/* src/backend/utils/mmgr/aset.c:529-532 */
set->allocChunkLimit = ALLOC_CHUNK_LIMIT;  // 8KB
while ((set->allocChunkLimit + ALLOC_CHUNKHDRSZ) >
       (maxBlockSize - ALLOC_BLOCKHDRSZ) / ALLOC_CHUNK_FRACTION)
    set->allocChunkLimit >>= 1;
```

- 默认情况下等于 `ALLOC_CHUNK_LIMIT = 8KB`
- 若 `maxBlockSize` 较小（如 ALLOCSET_SMALL 的 8KB），则按比例降低，确保最大 chunk 不超过 Block 的 1/4
- 随 maxBlockSize 变小，allocChunkLimit 也逐渐变小，以降低内存碎片

### 4.8 三者关系总览

```
AllocSetContext
├── header.methods ──→ AllocSetMethods (虚函数表)
├── blocks ──────────────────────────────────────┐
├── freelist[0..10] → chunk → chunk → ... → NULL (每个桶的空闲链表)
├── keeper ──────┐                               │
│                │                               ↓
│                └──→ [keeper Block] ⇄ [Block1] ⇄ [Block2] ⇄ ...
│                         │ aset        │ aset        │ aset
│                         ↓             ↓             ↓
│                     指回 AllocSetContext (所有 Block 的 aset 都指向同一 set)
│                         │
│                         ↓ Block 内部连续排列:
│                    ┌─────────┬──────────┬──────────┬─────────┐
│                    │BlockHdr │Chunk1    │Chunk2    │ 空闲    │
│                    │         │Hdr|Data  │Hdr|Data  │         │
│                    └─────────┴──────────┴──────────┴─────────┘
│                                        freeptr↑      endptr↑
└── 初始 malloc 内存 ──────────────────────┘
    (AllocSetContext + keeper Block 在同一 malloc 块中)
```


<!-- Failed to upload "diagram-structure.png" -->

Block 是物理容器（malloc 单元），Chunk 是逻辑分配单元（用户可见），Freelist 是 Chunk 的回收站（按 2 的幂次分桶缓存）。

| 关系 | 说明 |
|------|------|
| Block 包含 Chunk | Block 是 malloc 返回的连续内存，内部分割为多个 Chunk |
| Freelist 缓存 Chunk | pfree 后 Chunk 通过侵入式链表挂在 freelist[fidx] 上 |
| Freelist 不直接关联 Block | freelist 只管 chunk 的链式串联，不记录 chunk 来自哪个 block |
| Block 残余空间 → Freelist | Block 不够分配时，残余空间碎片化为 free chunk 进入 freelist |
| 大块 Chunk = 专用 Block | size > allocChunkLimit 时，一个 Block 只含一个 Chunk，pfree 时整块释放 |

---

## 五、分配与释放流程


<img width="1200" height="992" alt="Image" src="https://github.com/user-attachments/assets/c1bf906c-0ddf-44b0-a1fd-f981e5ad25d0" />

### 5.1 palloc 流程

```c
/* src/backend/utils/mmgr/mcxt.c:1067-1096 */
void *
palloc(Size size)
{
    void       *ret;
    MemoryContext context = CurrentMemoryContext;  /* 直接取全局变量 */

    AssertArg(MemoryContextIsValid(context));
    AssertNotInCriticalSection(context);

    if (!AllocSizeIsValid(size))
        elog(ERROR, "invalid memory alloc request size %zu", size);

    context->isReset = false;                     /* 标记上下文非空 */

    ret = context->methods->alloc(context, size); /* 委托给具体实现 */
    /* ... 错误处理 ... */
    return ret;
}
```

等价关系：`palloc(size)` ≡ `MemoryContextAlloc(CurrentMemoryContext, size)`

调用链：

```
palloc(size)
  └─> context->methods->alloc(context, size)   // 虚函数调用
        └─> AllocSetAlloc / SlabAlloc / GenerationAlloc  // 具体实现
```

### 5.2 pfree 流程

`pfree` 通过 chunk 头部的**反向指针**找到所属 context，再调用其 `free_p` 方法：

```c
/* src/backend/utils/mmgr/mcxt.c:1175-1181 */
void pfree(void *pointer)
{
    MemoryContext context = GetMemoryChunkContext(pointer);
    context->methods->free_p(context, pointer);
}
```

`AllocSetFree`（`aset.c:992-1060`）的处理逻辑：

| Chunk 类型 | 操作 | 涉及的结构 |
|-----------|------|-----------|
| 大块（> allocChunkLimit） | `free(block)` 归还系统 | Block 链表（摘除节点） |
| 普通块 | 头插法放入 `freelist[fidx]` | Freelist |

```c
/* src/backend/utils/mmgr/aset.c:1044-1058 */
int fidx = AllocSetFreeIndex(chunk->size);
chunk->aset = (void *) set->freelist[fidx];  /* 利用 aset 作 next 指针 */
set->freelist[fidx] = chunk;                  /* 头插法入链 */
```

**注意**：普通 `pfree` **不会**修改 Block 的 `freeptr`。Chunk 原地保留在 Block 中，只是通过 `aset` 字段链入 Freelist。Block 本身不会缩小。

`GetMemoryChunkContext` 的实现：

```c
/* src/include/utils/memutils.h:112-135 */
static inline MemoryContext
GetMemoryChunkContext(void *pointer)
{
    MemoryContext context;
    Assert(pointer != NULL);
    Assert(pointer == (void *) MAXALIGN(pointer));

    /* 每个 chunk 前方 sizeof(void*) 字节存放所属 context 指针 */
    context = *(MemoryContext *) (((char *) pointer) - sizeof(void *));
    AssertArg(MemoryContextIsValid(context));
    return context;
}
```

调用链：

```
pfree(pointer)
  └─> GetMemoryChunkContext(pointer)    // 从 chunk 头部取 context 指针
        └─> context->methods->free_p(context, pointer)  // 释放单个 chunk
```

### 5.3 AllocSetAlloc 的三条路径

`AllocSetAlloc`（`aset.c:720-986`）根据请求大小走不同的路径：

**路径 1：大块分配（size > allocChunkLimit，即 > 8KB）**（`aset.c:736-790`）

```
size > allocChunkLimit
  → chunk_size = MAXALIGN(size)
  → blksize = chunk_size + ALLOC_BLOCKHDRSZ + ALLOC_CHUNKHDRSZ
  → block = malloc(blksize)           // 独立 Block
  → block->freeptr = block->endptr    // 整个 Block 只有一个 Chunk
  → chunk = block + ALLOC_BLOCKHDRSZ
  → chunk->aset = set
  → return chunk 的 payload
```

特点：一个 Block 只包含一个 Chunk，`freeptr == endptr`。`pfree` 时整个 Block 直接 `free()` 归还系统，**不进入 Freelist**。

**路径 2：Freelist 复用（size ≤ allocChunkLimit 且 freelist[fidx] != NULL）**

```c
/* src/backend/utils/mmgr/aset.c:798-827 */
fidx = AllocSetFreeIndex(size);
chunk = set->freelist[fidx];
if (chunk != NULL)
{
    Assert(chunk->size >= size);
    set->freelist[fidx] = (AllocChunk) chunk->aset;  // 从链表头部摘除
    chunk->aset = (void *) set;                       // 标记为已分配
    return AllocChunkGetPointer(chunk);
}
```

特点：完全不涉及 Block，也不调用 `malloc`。这是最高效的路径。

**路径 3：Block 切割（size ≤ allocChunkLimit 且 freelist 为空）**（`aset.c:839-985`）

分三步：
1. **检查当前 Block**：`availspace = block->endptr - block->freeptr`，不够则将残余空间碎片化为 free chunks 放入 freelist 
```c
/* src/backend/utils/mmgr/aset.c:839-893 */
block = set->blocks                   // 当前活跃 Block
availspace = block->endptr - block->freeptr

if (availspace < chunk_size + ALLOC_CHUNKHDRSZ)
  → 将残余空间碎片化为 free chunks 放入 freelist  // aset.c:857-888
  → 标记需要新 Block
```
2. **分配新 Block**（如需要）：`blksize = nextBlockSize`（倍增策略），`malloc(blksize)`，插入链表头部 
```c
/* src/backend/utils/mmgr/aset.c:898-952 */
blksize = nextBlockSize               // 倍增策略: init → 2×init → 4×init ... → maxBlockSize
block = malloc(blksize)
set->blocks = block                   // 插入链表头部
```
3. **切割 Chunk**：在 Block 的 `freeptr` 处分配，`freeptr` 前移

```c
/* src/backend/utils/mmgr/aset.c:957-966 */
chunk = (AllocChunk) block->freeptr
block->freeptr += (chunk_size + ALLOC_CHUNKHDRSZ)
chunk->aset = (void *) set
chunk->size = chunk_size
return chunk 的 payload
```


### 5.4 碎片化回收：Block 残余空间 → Freelist

当前 Block 剩余空间不够分配新 Chunk 时 ，残余空间**不会被浪费**：

```c
/* src/backend/utils/mmgr/aset.c:857-888 */
while (availspace >= ((1 << ALLOC_MINBITS) + ALLOC_CHUNKHDRSZ))
{
    Size availchunk = availspace - ALLOC_CHUNKHDRSZ;
    int  a_fidx = AllocSetFreeIndex(availchunk);

    /* 对齐到 2 的幂次 */
    if (availchunk != ((Size) 1 << (a_fidx + ALLOC_MINBITS)))
    {
        a_fidx--;
        availchunk = ((Size) 1 << (a_fidx + ALLOC_MINBITS));
    }

    chunk = (AllocChunk) (block->freeptr);
    chunk->size = availchunk;
    chunk->aset = (void *) set->freelist[a_fidx];  // 链入 freelist
    set->freelist[a_fidx] = chunk;

    block->freeptr += (availchunk + ALLOC_CHUNKHDRSZ);
    availspace -= (availchunk + ALLOC_CHUNKHDRSZ);
}
```

**效果**：Block 中无法容纳完整新 Chunk 的残余空间，被切割成多个小 free chunk，放入 Freelist 等待后续分配使用。

**这个机制对 keeper 也适用**：keeper block 作为 blocks 链表中的第一个 block，分配到空间不足时，残余空间同样会被碎片化到 chunk freelist 中。

### 5.5 MemoryContextReset 流程

**保留上下文结构，释放所有已分配 chunk 并删除所有子上下文**：

```c
/* src/backend/utils/mmgr/mcxt.c:142-154 */
void
MemoryContextReset(MemoryContext context)
{
    AssertArg(MemoryContextIsValid(context));

    /* 1. 删除所有子上下文 */
    if (context->firstchild != NULL)
        MemoryContextDeleteChildren(context);

    /* 2. 释放本上下文内所有 chunk */
    if (!context->isReset)
        MemoryContextResetOnly(context);
}
```

调用链：
```
MemoryContextReset(context)                     -- mcxt.c:142-154
  ├─ MemoryContextDeleteChildren(context)       -- 递归删除所有子 context
  │    └─ MemoryContextDelete(firstchild)
  │         ├─ MemoryContextDeleteChildren(child)
  │         ├─ MemoryContextCallResetCallbacks
  │         ├─ MemoryContextSetParent(child, NULL) -- 从树中摘除
  │         └─ methods->delete_context(child)
  ├─ MemoryContextCallResetCallbacks(ctx)       -- 调用注册的清理回调
  └─ methods->reset(ctx)                       -- 路由到 AllocSetReset
       ├─ 清空所有 freelist
       ├─ 遍历 block 链表, free() 所有非 keeper block
       ├─ 重置 keeper block 的 freeptr
       └─ nextBlockSize = initBlockSize (重置增长序列)
```

### 5.6 MemoryContextDelete 流程

**删除上下文本身，包括从父上下文的子链中摘除**：

```c
/* src/backend/utils/mmgr/mcxt.c:217-255 */
void
MemoryContextDelete(MemoryContext context)
{
    AssertArg(MemoryContextIsValid(context));
    Assert(context != TopMemoryContext);
    Assert(context != CurrentMemoryContext);

    /* 1. 先删除子上下文 */
    if (context->firstchild != NULL)
        MemoryContextDeleteChildren(context);

    /* 2. 调用回调 */
    MemoryContextCallResetCallbacks(context);

    /* 3. 从父上下文摘除（关键步骤，防止悬空指针） */
    MemoryContextSetParent(context, NULL);

    context->ident = NULL;

    /* 4. 销毁上下文自身 */
    context->methods->delete_context(context);
}
```

调用链：
```
MemoryContextDelete(context)                    -- mcxt.c:217-255
  ├─ MemoryContextDeleteChildren(context)       -- 先删除子上下文
  ├─ MemoryContextCallResetCallbacks(context)   -- 调用回调
  ├─ MemoryContextSetParent(context, NULL)      -- 从父上下文摘除
  └─ methods->delete_context(context)           -- 彻底销毁
       └─ AllocSetDelete (可能放入 context freelist 缓存)
```

### 5.7 Reset vs Delete 对比

| 特性 | MemoryContextReset | MemoryContextDelete |
|------|-------------------|---------------------|
| 上下文自身 | **保留**，可继续使用 | **销毁**，不可再用 |
| 子上下文 | 全部删除 | 全部删除 |
| 从父上下文摘除 | 否 | 是 |
| 典型使用场景 | 查询间重置 MessageContext | 销毁 PortalContext |
| 等价操作 | 清空房间，保留房屋 | 拆除整栋房屋 |

### 5.8 palloc/pfree 与 MemoryContextReset/MemoryContextDelete 的关系

在 PostgreSQL 内存管理系统中，`palloc`/`pfree` 和 `MemoryContextReset`/`MemoryContextDelete` 是**两个不同层次**的内存管理接口，它们协同工作而非相互替代：

| 层次             | API                                          | 操作对象  | 类比                |
| -------------- | -------------------------------------------- | ----- | ----------------- |
| **Chunk 级别**   | `palloc` / `pfree` / `repalloc`              | 单个内存块 | `malloc` / `free` |
| **Context 级别** | `MemoryContextReset` / `MemoryContextDelete` | 整个上下文 | 进程退出自动回收          |



<img width="1200" height="1036" alt="Image" src="https://github.com/user-attachments/assets/ec88dc2e-029f-412e-9056-f56865a160c8" />

### 5.9 设计哲学：粗粒度回收为主

PostgreSQL 的内存管理核心思想：不需要逐个 pfree，依赖上下文的 Reset/Delete 统一回收。

```
                   ┌──────────────────────────────┐
                   │     MemoryContext (上下文)    │
                   │                              │
  palloc ──────>   │   chunk1  chunk2  chunk3     │
                   │   chunk4  chunk5  ...        │
                   │                              │
  Reset/Delete ─>  │   所有 chunk 一次性释放         │
                   └──────────────────────────────┘
```

**这意味着**：
- 大多数代码只调用 `palloc`，从不调用 `pfree`
- `pfree` 主要用于释放已知的大块内存（如大 tuple），以降低峰值内存占用
- 当上下文被 Reset 或 Delete 时，所有通过 `palloc` 分配的内存都会被自动回收
- 这种设计防止了内存泄漏

### 5.10 实际使用模式

**模式 1：查询执行（不需要 pfree）**

```c
/* 每条查询消息处理前 */
MemoryContextReset(MessageContext);

/* 查询处理过程中大量 palloc */
ptr1 = palloc(size1);    /* 在 MessageContext 中分配 */
ptr2 = palloc(size2);
/* ... 使用 ptr1, ptr2 ... */
/* 不需要 pfree! */

/* 下一条消息到来时, MessageContext 被 Reset, 所有分配自动回收 */
MemoryContextReset(MessageContext);
```

**模式 2：大对象及时释放（需要 pfree）**

```c
/* 处理大 tuple 时及时释放 */
for (i = 0; i < ntuples; i++)
{
    char *bigdata = palloc(large_size);
    process_tuple(bigdata);
    pfree(bigdata);   /* 及时释放, 避免峰值过高 */
}
/* 后续 MemoryContextReset 会回收剩余零碎分配 */
```

**模式 3：临时上下文**

```c
/* 创建临时上下文用于复杂计算 */
MemoryContext tmpctx = AllocSetContextCreate(CurrentMemoryContext,
                                             "temporary",
                                             ALLOCSET_DEFAULT_SIZES);
MemoryContext oldctx = MemoryContextSwitchTo(tmpctx);

/* 所有分配都在 tmpctx 中 */
char *buf = palloc(1024);
/* ... */

/* 一次性销毁 */
MemoryContextSwitchTo(oldctx);
MemoryContextDelete(tmpctx);  /* tmpctx 及其所有分配全部消失 */
```

### 5.11 调用链总结

```          
palloc(size)
└── MemoryContextAlloc(context, size)         // mcxt.c:862
    └── AllocSetAlloc(context, size)          // aset.c:720
        ├── size > allocChunkLimit
        │   └── malloc(blksize) → 返回独立 block 中的 chunk
        ├── freelist[fidx] != NULL
        │   └── 弹出 freelist 头部 chunk → 返回
        └── freelist[fidx] == NULL
            ├── 当前 block 空间足够 → 从 block 切分 chunk
            └── 当前 block 空间不足 → malloc 新 block → 切分 chunk
   
pfree(pointer)
└── AllocSetFree(context, pointer)            // aset.c:992
    ├── chunk->size > allocChunkLimit
    │   └── 从 block 链表摘除 → free(block)
    └── chunk->size <= allocChunkLimit
        └── 头插法放入 freelist[AllocSetFreeIndex(chunk->size)]

MemoryContextReset(context)
└── MemoryContextDeleteChildren(context)
    └── MemoryContextResetOnly(context)
        └── AllocSetReset(context)              // aset.c:558
            ├── 清空所有 freelist
            └── 遍历 blocks: keeper 保留, 其他 free()

MemoryContextDelete(context)
└── MemoryContextDeleteChildren(context)
    └── MemoryContextSetParent(context, NULL)
        └── AllocSetDelete(context)             // aset.c:627
            ├── freeListIndex >= 0 → Reset 后放入 context_freelists
            └── freeListIndex == -1 → 直接 free()

```

---

## 六、Context Freelist 缓存机制

### 6.1 概述

AllocSet 维护全局静态数组 `context_freelists[2]`，缓存已删除的 AllocSetContext，下次创建同类型时直接复用，避免反复 `malloc/free` 开销。复用 `header.nextchild` 字段作为链表指针，不额外分配内存。

### 6.2 核心数据结构

```c
/* src/backend/utils/mmgr/aset.c:246-261 */

#define MAX_FREE_CONTEXTS 100

typedef struct AllocSetFreeList
{
    int         num_free;       /* 当前链表长度 */
    AllocSetContext *first_free; /* LIFO 链表头指针 */
} AllocSetFreeList;

/* context_freelists[0] is for default params, [1] for small params */
static AllocSetFreeList context_freelists[2] =
{
    { 0, NULL },    /* slot 0: ALLOCSET_DEFAULT_SIZES */
    { 0, NULL }     /* slot 1: ALLOCSET_SMALL_SIZES   */
};
```

- **`context_freelists[0]`**：缓存 `ALLOCSET_DEFAULT_SIZES` 参数的 context（`initBlockSize = 8KB`）
- **`context_freelists[1]`**：缓存 `ALLOCSET_SMALL_SIZES` 参数的 context（`initBlockSize = 1KB`）
- **最大容量**：每个 slot 最多缓存 `MAX_FREE_CONTEXTS = 100` 个 context


**链表节点：AllocSetContext**


freelist 中的 context 通过 `header.nextchild` 字段链接成单链表：

```c
/* src/include/nodes/memnodes.h:78-93 */
typedef struct MemoryContextData
{
    NodeTag     type;               /* 标识节点类型 */
    bool        isReset;            /* T = no space alloced since last reset */
    bool        allowInCritSection; /* allow palloc in critical section */
    Size        mem_allocated;      /* track memory allocated for this context */
    const MemoryContextMethods *methods;  /* 虚函数表 */
    MemoryContext parent;           /* 父上下文 */
    MemoryContext firstchild;       /* 第一个子上下文 */
    MemoryContext prevchild;        /* 前一个兄弟 */
    MemoryContext nextchild;        /* 后一个兄弟 */
    const char *name;               /* 上下文名称（调试用） */
    const char *ident;              /* 上下文 ID（调试用） */
    MemoryContextCallback *reset_cbs; /* reset/delete 回调 */
} MemoryContextData;

/* src/backend/utils/mmgr/aset.c:121-135 */
typedef struct AllocSetContext
{
    MemoryContextData header;   /* 包含 nextchild 字段 */
    AllocBlock  blocks;
    AllocChunk  freelist[ALLOCSET_NUM_FREELISTS];
    Size        initBlockSize;
    Size        maxBlockSize;
    Size        nextBlockSize;
    Size        allocChunkLimit;
    AllocBlock  keeper;         /* 保留块，reset 后不释放 */
    int         freeListIndex;  /* 所属 freelist 索引，-1 表示不缓存 */
} AllocSetContext;
```

context 进入 freelist 后，它已经从父 context 的子节点链表中摘除，`header.nextchild` 字段处于闲置状态。复用该字段作为 freelist 链接指针，不需要额外的内存。

关键字段 `freeListIndex`：
- `0` → 匹配 DEFAULT 参数，可放入 `context_freelists[0]`
- `1` → 匹配 SMALL 参数，可放入 `context_freelists[1]`
- `-1` → 自定义参数，不参与 freelist 缓存


<img width="1200" height="845" alt="Image" src="https://github.com/user-attachments/assets/f8140846-f5d4-4e5b-bc18-326b493d7ed1" />

### 6.3 匹配规则

```c
/* src/backend/utils/mmgr/aset.c:417-424 */

if (minContextSize == ALLOCSET_DEFAULT_MINSIZE &&
    initBlockSize == ALLOCSET_DEFAULT_INITSIZE)
    freeListIndex = 0;
else if (minContextSize == ALLOCSET_SMALL_MINSIZE &&
         initBlockSize == ALLOCSET_SMALL_INITSIZE)
    freeListIndex = 1;
else
    freeListIndex = -1;
```

匹配规则的设计考量：
- **不比较 `maxBlockSize`**：maxBlockSize 不影响初始 keeper block 的大小，缓存后可以安全更新
- **只匹配两种预设参数组合**：自定义参数的 context（`freeListIndex = -1`）直接 `free()`，不缓存

| 预设宏 | minContextSize | initBlockSize | maxBlockSize | freeListIndex |
|--------|---------------|---------------|--------------|---------------|
| `ALLOCSET_DEFAULT_SIZES` | 0 | 8KB | 8MB | 0 |
| `ALLOCSET_SMALL_SIZES` | 0 | 1KB | 8KB | 1 |
| `ALLOCSET_START_SMALL_SIZES` | 0 | 1KB | 8MB | 1 (与 SMALL 共用) |
| 自定义值 | — | — | — | -1 (不缓存) |

**宏定义** 

```c
/* src/include/utils/memutils.h:192-213 */

/* Default freelist 对应的参数 */
#define ALLOCSET_DEFAULT_MINSIZE   0
#define ALLOCSET_DEFAULT_INITSIZE  (8 * 1024)
#define ALLOCSET_DEFAULT_MAXSIZE   (8 * 1024 * 1024)  // 8MB

#define ALLOCSET_DEFAULT_SIZES \
    ALLOCSET_DEFAULT_MINSIZE, ALLOCSET_DEFAULT_INITSIZE, ALLOCSET_DEFAULT_MAXSIZE

/* Small freelist 对应的参数 */
#define ALLOCSET_SMALL_MINSIZE     0
#define ALLOCSET_SMALL_INITSIZE    (1 * 1024)
#define ALLOCSET_SMALL_MAXSIZE     (8 * 1024)          // 8KB

#define ALLOCSET_SMALL_SIZES \
    ALLOCSET_SMALL_MINSIZE, ALLOCSET_SMALL_INITSIZE, ALLOCSET_SMALL_MAXSIZE

/* 特殊情况：起步小但能长到 8MB */
#define ALLOCSET_START_SMALL_SIZES \
    ALLOCSET_SMALL_MINSIZE, ALLOCSET_SMALL_INITSIZE, ALLOCSET_DEFAULT_MAXSIZE
```

### 6.4 创建路径：从 Freelist 复用

**源函数**：`AllocSetContextCreateInternal()`（`aset.c:378-544`）

```   
AllocSetContextCreateInternal(parent, name, minContextSize, initBlockSize, maxBlockSize)
│
├── 1. 计算匹配的 freeListIndex (0, 1, 或 -1)
│
├── 2. if (freeListIndex >= 0 && freelist->first_free != NULL)
│   │
│   ├── 从 freelist 链表头取下 context (LIFO)
│   ├── 更新 maxBlockSize（唯一可能变化的参数）
│   ├── 调用 MemoryContextCreate() 重新初始化 header
│   ├── 设置 mem_allocated = keeper block 大小
│   └── return (MemoryContext) set;  // 直接返回，无需 malloc
│
└── 3. else (无可用缓存 或 不匹配)
    │
    ├── 计算首个 block 大小 firstBlockSize
    ├── malloc(firstBlockSize)  // 一次性分配 context + keeper block
    ├── 初始化 block header
    ├── 设置 keeper block
    ├── 初始化 freelist[0..10] = NULL
    ├── 计算 allocChunkLimit
    ├── MemoryContextCreate()
    └── return (MemoryContext) set;
```

**复用时的关键观察**：
- 复用时 keeper block **已经完好**，无需重新 malloc
- `mem_allocated` 直接从 keeper 的 `endptr` 计算
- chunk freelist 此时为空（Reset 时已清零）

#### 复用时的关键操作

**源文件**：`aset.c:429-455`

```c
if (freeListIndex >= 0)
{
    AllocSetFreeList *freelist = &context_freelists[freeListIndex];

    if (freelist->first_free != NULL)
    {
        /* 从链表头移除 (LIFO) */
        set = freelist->first_free;
        freelist->first_free = (AllocSet) set->header.nextchild;
        freelist->num_free--;

        /* 更新 maxBlockSize（其他参数不变） */
        set->maxBlockSize = maxBlockSize;

        /* 重新初始化 header（安装正确的 name 和 parent） */
        MemoryContextCreate((MemoryContext) set,
                            T_AllocSetContext,
                            &AllocSetMethods,
                            parent, name);

        ((MemoryContext) set)->mem_allocated =
            set->keeper->endptr - ((char *) set);

        return (MemoryContext) set;
    }
}
```

复用时的要点：
- LIFO 顺序：最后放入的 context 最先被取出，缓存局部性好
- 只更新 `maxBlockSize`：其他参数（`initBlockSize`、`freeListIndex`、keeper block）在 reset 后不变
- 不需要 `malloc()`：直接复用已有内存

### 6.5 删除路径：放入 Freelist 缓存

**源函数**：`AllocSetDelete()`（`aset.c:626-705`）

```    
AllocSetDelete(context)
│
├── 1. if (freeListIndex >= 0)  ← 是缓存候选？
│   │
│   ├── 2. if (!context->isReset)
│   │   └── MemoryContextResetOnly(context)  // 清理所有非 keeper block
│   │
│   ├── 3. if (freelist->num_free >= MAX_FREE_CONTEXTS)
│   │   │
│   │   └── 溢出处理：一次性清空整个 freelist，free() 所有旧 context
│   │       ├── while (freelist->first_free != NULL)
│   │       │   ├── 取出 oldset
│   │       │   └── free(oldset)  // 直接释放到 OS
│   │       └── num_free = 0
│   │
│   ├── 4. set->header.nextchild = freelist->first_free
│   │   freelist->first_free = set
│   │   num_free++
│   │
│   └── return;  // 不执行后续的 free()
│
└── 5. else (freeListIndex == -1)
    ├── 释放所有非 keeper block
    └── free(set)  // 直接释放整个 context
```

 **溢出策略详解**

**源文件**：`aset.c:660-673`

```c
if (freelist->num_free >= MAX_FREE_CONTEXTS)
{
    while (freelist->first_free != NULL)
    {
        AllocSetContext *oldset = freelist->first_free;

        freelist->first_free = (AllocSetContext *) oldset->header.nextchild;
        freelist->num_free--;

        /* All that remains is to free the header/initial block */
        free(oldset);
    }
    Assert(freelist->num_free == 0);
}
```

**策略特点**：
1. 不是逐个淘汰，而是一次性清空整个 freelist
2. 清空后，只保留当前被删除的 context 作为新的唯一节点
3. 设计假设（源码注释 `aset.c:237-241`）：大量分配 context 的查询通常按相反顺序释放，LIFO 顺序使最近释放的 context 在下次优先复用


### 6.6 生命周期流程


<img width="1200" height="977" alt="Image" src="https://github.com/user-attachments/assets/4cbd6504-88aa-4f3d-a714-e8e9a93943f0" />

| 阶段 | chunk freelist | keeper | context freelist |
|------|---------------|--------|-----------------|
| 创建 | 空 | 与 header 共享 malloc | — |
| 使用中 | 缓存 pfree 的 chunk | 参与分配 | — |
| Reset | 清零 | 保留（重置 freeptr） | — |
| Delete | 已在 Reset 中清零 | 随 header 一起保留 | 携带 keeper 整体缓存 |
| 再次创建 | 空 | 直接复用 | 取出复用 |

keeper 是 context-level freelist 能工作的前提。keeper 与 header 共享同一次 malloc，整个上下文在 Delete 后作为一个完整单元被缓存，下次 Create 时不需要系统级内存分配。

### 6.7 两类 Freelist 对比

| 维度 | Chunk-level freelist | Context-level freelist |
|------|---------------------|----------------------|
| **定义位置** | `set->freelist[11]` | `context_freelists[2]` |
| **管理粒度** | 单个内存 chunk (8B~8KB) | 整个 AllocSet 上下文 |
| **触发时机** | `pfree` 放入，`palloc` 取用 | `AllocSetDelete` 放入，`AllocSetContextCreate` 取用 |
| **最大数量** | 无限制（取决于 block 数） | 每个 slot 最多 100 个 |
| **链接方式** | `chunk->aset` 充当 next 指针 | `header.nextchild` 充当 next 指针 |
| **设计目的** | 减少高频 palloc/pfree 的 malloc 开销 | 减少低频 Create/Delete 的 malloc 开销 |

### 6.8 三层优化总结

**为什么需要 Context Freelist？**

PostgreSQL 在查询处理中频繁创建和销毁内存上下文：

- **每条查询**：创建 `MessageContext`、`PortalContext` 等
- **每个元组**：可能创建临时上下文
- **每个子事务**：创建 `TransactionContext` 子上下文
- **每次表达式计算**：可能需要临时上下文

每次 `malloc()` + `free()` 涉及系统调用和内存管理器开销，在高并发场景下累积显著。

| 层次         | 机制               | 优化目标            | 避免的操作                                |
| ---------- | ---------------- | --------------- | ------------------------------------ |
| **L1: 高频** | chunk freelist   | palloc/pfree 循环 | 避免每次分配调用 malloc                      |
| **L2: 中频** | keeper block     | Reset/重复使用      | 避免 Reset 后重新 malloc 初始 block         |
| **L3: 低频** | context freelist | Create/Delete   | 避免 Create 时 malloc header + 初始 block |
|            |                  |                 |                                      |

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