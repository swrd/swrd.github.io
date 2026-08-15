## 1. The Essence of a Buffer Pin: Three Words — "Don't Touch It"

### 1.1 The Core Definition

The meaning of **Pin** is remarkably simple:

> As long as any process holds a pin on a buffer, that buffer will **never, under any circumstances** be evicted and replaced.

This is a **hard invariant** of PostgreSQL buffer management. There are no exceptions.

Here is the authoritative definition from the source code (`src/backend/storage/buffer/README:35`):

```
Pins: one must "hold a pin on" a buffer before being allowed to do anything
at all with it. An unpinned buffer is subject to being reclaimed and reused
for a different page at any instant, so touching it is unsafe.
```

In other words:

- Before you can do *anything* with a buffer, you must pin it first
- An unpinned buffer may be reclaimed and reused at any moment
- Touching an unpinned buffer is **unsafe**

### 1.2 refcount: How a Pin Is Implemented

In PostgreSQL, a pin is implemented as a **reference count (refcount)**.

Every buffer descriptor (`BufferDesc`) contains a 32-bit `state` field, whose **lowest 18 bits** hold the refcount:

```c
// src/include/storage/buf_internals.h:29-33
/*
 * Buffer state is a single 32-bit variable where following data is combined.
 *
 * - 18 bits refcount      <- Pin count
 * - 4 bits usage count    <- Frequency of use
 * - 10 bits of flags      <- State flags
 */
#define BUF_REFCOUNT_ONE 1
#define BUF_REFCOUNT_MASK ((1U << 18) - 1)  // max value 262,143
```

**Key numbers**:

- Width: 18 bits
- Maximum: 2^18 - 1 = **262,143**
- Meaning: more than 260,000 processes can pin the same buffer simultaneously

As shown in `src/include/storage/buf_internals.h`, the `state` field inside `BufferDesc` is a 32-bit atomic variable that stores both refcount and usage_count:


<img width="1098" height="691" alt="Image" src="https://github.com/user-attachments/assets/867bb929-385e-44a5-a2c0-3f09aa470eb3" />

---

## 2. Pin, Lock, and Usage Count: The Division of Labor

People often confuse Pin, Lock, and Usage Count. One diagram is worth a thousand words:

<img width="1049" height="486" alt="Image" src="https://github.com/user-attachments/assets/dc32f4fe-ee44-4c5a-be74-e53f292b3bf2" />

### 2.1 Side-by-Side Comparison

| Property | **Pin (refcount)** | **Lock (content_lock)** | **Usage Count** |
|:---|:---|:---|:---|
| **Purpose** | Prevents buffer eviction | Protects data contents during concurrent access | Influences eviction priority |
| **Analogy** | Library card | Reading-room door lock | Popularity |
| **Hold duration** | Can be long | Must be short | N/A (managed automatically) |
| **Hard invariant** | ✅ Yes | ✅ Yes | ❌ No (soft signal) |
| **Value range** | 0 ~ 262,143 | Shared / Exclusive / None | 0 ~ 5 |

### 2.2 The Dependency: Pin Before Lock

This is the iron rule of PostgreSQL (`README:35`):

> **"One must pin a buffer before trying to lock it."**

Why? Consider this:

1. You acquire the content lock on a buffer
2. Meanwhile, another process evicts that buffer and reuses it for a different page
3. You are still reading the old data? **Disaster!**

That is why you must pin first (to guarantee the buffer won't be replaced), then lock (to guarantee the contents won't be modified concurrently).

<img width="1060" height="703" alt="Image" src="https://github.com/user-attachments/assets/f68d3c95-1160-42bb-8cec-7a4bea749811" />

### 2.3 The Five Access Rules

The `README` defines 5 buffer access rules:

| Rule | Requires | Operation |
|:---:|:---|:---|
| **#1** | Pin + (shared or exclusive) Lock | Scan a page, check tuple visibility |
| **#2** | Pin only | Access tuple data whose visibility is already determined |
| **#3** | Pin + exclusive Lock | Insert a tuple or modify xmin/xmax |
| **#4** | Pin + shared Lock | Update commit status bits (hint bits) |
| **#5** | Pin + exclusive Lock + refcount=1 | Physically remove tuples (Cleanup Lock) |

Note rule #5: the **Cleanup Lock** requires not only an exclusive lock but also `refcount=1`, meaning the current process is the *only* pin holder. This is what VACUUM needs when physically removing dead tuples.

---

## 3. An Elegant Design: Two-Level Reference Counting

### 3.1 The Problem: Contention Under High Concurrency

What would happen if every Pin/Unpin modified the shared refcount in shared memory directly?

```
Process A: Pin(buf1) → refcount++   -- requires an atomic operation
Process B: Pin(buf1) → refcount++   -- requires an atomic operation
Process C: Pin(buf1) → refcount++   -- requires an atomic operation
...
```

Under heavy concurrency, many processes competing over a single atomic variable would crush performance.

### 3.2 The Solution: Private Count + Shared Count

PostgreSQL's solution is remarkably elegant:

<img width="1060" height="800" alt="Image" src="https://github.com/user-attachments/assets/cd297861-ed57-444e-b8e4-28123898a7cc" />

**The core idea**:

1. **Private reference count** (PrivateRefCount): maintained by each process in its own local memory
2. **Shared reference count** (refcount): lives in the BufferDesc in shared memory

**How it works**:

| Operation | Private count | Shared count | Contention |
|:---|:---|:---|:---|
| First pin of a buffer | 0 → 1 | +1 | Atomic operation required |
| Pin the same buffer again | +1 | unchanged | **No contention!** |
| Unpin (not the last one) | -1 | unchanged | **No contention!** |
| Final unpin | 1 → 0 | -1 | Atomic operation required |

**The payoff**: for repeated pin/unpin of the same buffer within one process, only the first pin and the last unpin ever touch shared memory!

### 3.3 Storage Layout of the Private Count

The private reference count uses a hybrid "array + hash table" storage:

```c
// src/backend/storage/buffer/bufmgr.c:88, 197-201

#define REFCOUNT_ARRAY_ENTRIES 8  // size of the fast-path array

static struct PrivateRefCountEntry PrivateRefCountArray[REFCOUNT_ARRAY_ENTRIES];
static HTAB *PrivateRefCountHash = NULL;  // overflow hash table
```

| Component | Size | Lookup | Design intent |
|:---|:---|:---|:---|
| Fast-path array | 8 entries (64 bytes) | O(8) linear scan | Quick access to hot buffers |
| Overflow hash table | Dynamically grown, unbounded | O(1) hash lookup | Handles large numbers of pinned buffers |

**Why exactly 64 bytes?**

Because 64 bytes matches the **cache line size** of most CPUs, so the whole array can be loaded into the CPU cache in one go — extremely fast to access.

---

## 4. Implementation Details of the Pin Operation

### 4.1 The Call Chain

```
ReadBuffer()                           ← simplified entry (bufmgr.c:697)
    │
    └── ReadBufferExtended()           ← extended entry (bufmgr.c:744)
            │
            └── ReadBuffer_common()    ← core implementation (bufmgr.c:807)
                    │
                    └── BufferAlloc()  ← allocate/look up buffer (bufmgr.c:1107)
                            │
                            ├── PinBuffer()        ← on buffer hit (bufmgr.c:1692)
                            │
                            └── PinBuffer_Locked() ← on newly allocated buffer (bufmgr.c:1795)
```

### The Call Chain Explained

| Function | Location | Responsibility |
|------|------|------|
| `ReadBuffer` | bufmgr.c:697 | Simplified API, reads MAIN_FORKNUM |
| `ReadBufferExtended` | bufmgr.c:744 | Supports specifying fork and read mode |
| `ReadBuffer_common` | bufmgr.c:807 | Unified handling of local/shared buffers |
| `BufferAlloc` | bufmgr.c:1107 | Allocation and lookup of shared buffers |
| `PinBuffer` | bufmgr.c:1692 | Lock-free pin (CAS) |
| `PinBuffer_Locked` | bufmgr.c:1795 | Pin while holding the spinlock |

### 4.2 The Core Design of Pinning

PostgreSQL uses a **two-level reference counting** scheme to implement buffer pins:

<img width="1014" height="787" alt="Image" src="https://github.com/user-attachments/assets/5df82393-6a43-4c90-92c4-8ee91f844c66" />

#### Design Advantages

| Level | Storage | Purpose | Performance |
|------|----------|------|----------|
| **Private reference count** | Backend-local memory | Records how many times *this* process pinned the buffer | Lock-free access, extremely fast |
| **Shared reference count** | `BufferDesc->state` | Total pin count of the buffer across all processes | Atomic operations, contended |

**Design intent**: when the same process pins the same buffer repeatedly, only the private count is touched — no contention on the shared state. The shared refcount is updated only on the first pin and the final unpin.

### 4.3 Key Data Structures

#### 4.3.1 The Private Reference Count Entry

```c
// bufmgr.c:81-85
typedef struct PrivateRefCountEntry
{
    Buffer      buffer;     // buffer number (1-based)
    int32       refcount;   // pin count of this process
} PrivateRefCountEntry;
```

#### 4.3.2 Private Reference Count Storage

```c
// bufmgr.c:197-201

// Fast-path array: holds the 8 most-used buffers
static PrivateRefCountEntry PrivateRefCountArray[REFCOUNT_ARRAY_ENTRIES];

// Overflow hash table: used beyond 8 buffers
static HTAB *PrivateRefCountHash = NULL;

// Overflow counter
static int32 PrivateRefCountOverflowed = 0;

// Clock hand: selects which array entry to move to the hash table
static uint32 PrivateRefCountClock = 0;

// A reserved free entry
static PrivateRefCountEntry *ReservedRefCountEntry = NULL;
```

### 4.4 Complete Pin Flow Diagrams

<img width="942" height="901" alt="Image" src="https://github.com/user-attachments/assets/f7f12ece-399e-4c6c-bd8b-07ab1975e746" />

<img width="947" height="216" alt="Image" src="https://github.com/user-attachments/assets/a7b75854-bf5f-4d8e-9d46-e4fb15b36849" />


#### 4.4.1 PinBuffer() in Depth

**Source**: `bufmgr.c:1692-1771`

This is the pin path used when **not holding the spinlock**. It updates state with a lock-free CAS loop:

```c
static bool
PinBuffer(BufferDesc *buf, BufferAccessStrategy strategy)
{
    Buffer      b = BufferDescriptorGetBuffer(buf);
    bool        result;
    PrivateRefCountEntry *ref;

    // Step 1: look up the private reference count entry
    ref = GetPrivateRefCountEntry(b, true);

    if (ref == NULL)
    {
        // ═══════════════════════════════════════════════════
        // Case A: first pin of this buffer, must update the shared count
        // ═══════════════════════════════════════════════════
        uint32      buf_state;
        uint32      old_buf_state;

        // Step 2: reserve space for a private refcount entry
        ReservePrivateRefCountEntry();

        // Step 3: create a new private refcount entry
        ref = NewPrivateRefCountEntry(b);

        // Step 4: CAS loop to update the shared refcount
        old_buf_state = pg_atomic_read_u32(&buf->state);
        for (;;)
        {
            // If the buffer header is locked, wait for it
            if (old_buf_state & BM_LOCKED)
                old_buf_state = WaitBufHdrUnlocked(buf);

            buf_state = old_buf_state;

            // Increase the shared refcount
            buf_state += BUF_REFCOUNT_ONE;

            // Update usage_count (for the replacement algorithm)
            if (strategy == NULL)
            {
                // Default strategy: raise usage_count up to the max
                if (BUF_STATE_GET_USAGECOUNT(buf_state) < BM_MAX_USAGE_COUNT)
                    buf_state += BUF_USAGECOUNT_ONE;
            }
            else
            {
                // Ring buffer strategy: only set it to 1, avoid evicting others
                if (BUF_STATE_GET_USAGECOUNT(buf_state) == 0)
                    buf_state += BUF_USAGECOUNT_ONE;
            }

            // Atomic CAS update
            if (pg_atomic_compare_exchange_u32(&buf->state,
                                               &old_buf_state, buf_state))
            {
                result = (buf_state & BM_VALID) != 0;

                // Valgrind: mark buffer memory as accessible
                VALGRIND_MAKE_MEM_DEFINED(BufHdrGetBlock(buf), BLCKSZ);
                break;
            }
            // CAS failed; old_buf_state now holds the current value, retry
        }
    }
    else
    {
        // ═══════════════════════════════════════════════════
        // Case B: already pinned, no shared state change needed
        // ═══════════════════════════════════════════════════
        result = true;
    }

    // Step 5: increase the private refcount
    ref->refcount++;
    Assert(ref->refcount > 0);

    // Step 6: record in ResourceOwner (auto-release at transaction end)
    ResourceOwnerRememberBuffer(CurrentResourceOwner, b);

    return result;
}
```

##### Key Techniques

| Technique | Notes |
|------|------|
| **CAS loop** | `pg_atomic_compare_exchange_u32` implements optimistic locking, avoiding spinlock overhead |
| **Waiting for unlock** | If `BM_LOCKED` is set, call `WaitBufHdrUnlocked` |
| **usage_count** | Under the default strategy it grows up to 5, steering the Clock-Sweep replacement algorithm |
| **Ring strategy** | Used for bulk scans; usage_count is only set to 1 to reduce cache pollution |

#### 4.4.2 PinBuffer_Locked() in Depth

**Source**: `bufmgr.c:1795-1829`

This is the pin path used while **holding the spinlock**, for a freshly allocated victim buffer:

```c
static void
PinBuffer_Locked(BufferDesc *buf)
{
    Buffer      b;
    PrivateRefCountEntry *ref;
    uint32      buf_state;

    // Precondition: no pre-existing private refcount for this buffer
    Assert(GetPrivateRefCountEntry(BufferDescriptorGetBuffer(buf), false) == NULL);

    // Valgrind: mark buffer memory as accessible
    VALGRIND_MAKE_MEM_DEFINED(BufHdrGetBlock(buf), BLCKSZ);

    // ═══════════════════════════════════════════════════════════
    // Step 1: read state and bump the refcount
    // We hold the spinlock, so a plain modification is safe (no CAS)
    // ═══════════════════════════════════════════════════════════
    buf_state = pg_atomic_read_u32(&buf->state);
    Assert(buf_state & BM_LOCKED);  // confirm spinlock is held
    buf_state += BUF_REFCOUNT_ONE;

    // ═══════════════════════════════════════════════════════════
    // Step 2: release the spinlock (write new state, clear BM_LOCKED)
    // ═══════════════════════════════════════════════════════════
    UnlockBufHdr(buf, buf_state);

    // ═══════════════════════════════════════════════════════════
    // Step 3: create the private refcount entry (spinlock released)
    // ═══════════════════════════════════════════════════════════
    b = BufferDescriptorGetBuffer(buf);
    ref = NewPrivateRefCountEntry(b);
    ref->refcount++;

    // ═══════════════════════════════════════════════════════════
    // Step 4: record in ResourceOwner
    // ═══════════════════════════════════════════════════════════
    ResourceOwnerRememberBuffer(CurrentResourceOwner, b);
}
```

##### Differences from PinBuffer

| Property | PinBuffer | PinBuffer_Locked |
|------|-----------|------------------|
| **When called** | Buffer already in cache | Freshly allocated victim buffer |
| **Lock state** | Not holding spinlock | Holding spinlock |
| **Update method** | CAS loop | Direct write |
| **usage_count** | May be updated | Not updated |
| **Pre-existing refcount** | Allowed | Not allowed |

### 4.5 Managing the Private Reference Count

#### 4.5.1 Storage Strategy

A hybrid **array + hash table** storage optimizes for the common case:

<img width="1015" height="818" alt="Image" src="https://github.com/user-attachments/assets/ed5b6828-1359-4428-b5a4-a8612cdc187d" />

<img width="1017" height="244" alt="Image" src="https://github.com/user-attachments/assets/576e5242-2b27-47ee-af7c-f502202d4fb6" />

#### 4.5.2 Core Functions

##### ReservePrivateRefCountEntry() - `bufmgr.c:214-275`

Reserves a free refcount entry:

```c
static void ReservePrivateRefCountEntry(void)
{
    // Already reserved? Return directly
    if (ReservedRefCountEntry != NULL)
        return;

    // First, look for a free slot in the array
    for (i = 0; i < REFCOUNT_ARRAY_ENTRIES; i++)
    {
        if (PrivateRefCountArray[i].buffer == InvalidBuffer)
        {
            ReservedRefCountEntry = &PrivateRefCountArray[i];
            return;
        }
    }

    // Array is full: use the clock algorithm to pick a victim to move to the hash table
    ReservedRefCountEntry =
        &PrivateRefCountArray[PrivateRefCountClock++ % REFCOUNT_ARRAY_ENTRIES];

    // Move the victim into the hash table
    hashent = hash_search(PrivateRefCountHash,
                          &(ReservedRefCountEntry->buffer),
                          HASH_ENTER, &found);
    hashent->refcount = ReservedRefCountEntry->refcount;

    // Clear the array slot
    ReservedRefCountEntry->buffer = InvalidBuffer;
    ReservedRefCountEntry->refcount = 0;

    PrivateRefCountOverflowed++;
}
```

##### GetPrivateRefCountEntry() - `bufmgr.c:306-379`

Looks up the refcount entry for a given buffer:

```c
static PrivateRefCountEntry *
GetPrivateRefCountEntry(Buffer buffer, bool do_move)
{
    // 1. Search the array first (O(8))
    for (i = 0; i < REFCOUNT_ARRAY_ENTRIES; i++)
    {
        if (PrivateRefCountArray[i].buffer == buffer)
            return &PrivateRefCountArray[i];
    }

    // 2. If nothing ever overflowed, it cannot be in the hash table
    if (PrivateRefCountOverflowed == 0)
        return NULL;

    // 3. Look in the hash table
    res = hash_search(PrivateRefCountHash, &buffer, HASH_FIND, NULL);

    if (res == NULL)
        return NULL;

    // 4. If do_move=true, move the entry back into the array to speed up
    //    subsequent accesses
    if (do_move)
    {
        ReservePrivateRefCountEntry();
        free = ReservedRefCountEntry;
        free->buffer = buffer;
        free->refcount = res->refcount;

        // Remove from the hash table
        hash_search(PrivateRefCountHash, &buffer, HASH_REMOVE, &found);
        PrivateRefCountOverflowed--;

        return free;
    }

    return res;
}
```

#### 4.5.3 Pin Calls Inside BufferAlloc

**Source**: `bufmgr.c:1107-1405`

`BufferAlloc` is the sub-function of `ReadBuffer_common` that allocates or finds a buffer in the shared pool:

```c
static BufferDesc *
BufferAlloc(SMgrRelation smgr, char relpersistence, ForkNumber forkNum,
            BlockNumber blockNum, BufferAccessStrategy strategy, bool *foundPtr)
{
    // Build the BufferTag
    INIT_BUFFERTAG(newTag, smgr->smgr_rnode.node, forkNum, blockNum);
    newHash = BufTableHashCode(&newTag);
    newPartitionLock = BufMappingPartitionLock(newHash);

    // ═══════════════════════════════════════════════════════════════
    // Case 1: look up the buffer in the hash table
    // ═══════════════════════════════════════════════════════════════
    LWLockAcquire(newPartitionLock, LW_SHARED);
    buf_id = BufTableLookup(&newTag, newHash);

    if (buf_id >= 0)
    {
        // Buffer hit!
        buf = GetBufferDescriptor(buf_id);

        // Call PinBuffer (not holding the spinlock)
        valid = PinBuffer(buf, strategy);        // ← the pin

        LWLockRelease(newPartitionLock);
        *foundPtr = true;

        // Handle the BM_VALID check...
        return buf;
    }

    LWLockRelease(newPartitionLock);

    // ═══════════════════════════════════════════════════════════════
    // Case 2: buffer miss, need to allocate a new buffer
    // ═══════════════════════════════════════════════════════════════
    for (;;)
    {
        // Reserve space for a private refcount entry
        ReservePrivateRefCountEntry();

        // Get a victim buffer (returned holding the spinlock)
        buf = StrategyGetBuffer(strategy, &buf_state);

        // Call PinBuffer_Locked (holding the spinlock)
        PinBuffer_Locked(buf);                   // ← the pin

        // Handle dirty-page writeout, re-validation, etc...

        // On success, return the buffer
        // Otherwise UnpinBuffer and retry
    }
}
```

#### 4.5.4 UnpinBuffer in Depth

**Source**: `bufmgr.c:1840-1923`

The counterpart of pin — unpin:

```c
static void
UnpinBuffer(BufferDesc *buf, bool fixOwner)
{
    PrivateRefCountEntry *ref;
    Buffer b = BufferDescriptorGetBuffer(buf);

    // Get the private refcount entry
    ref = GetPrivateRefCountEntry(b, false);
    Assert(ref != NULL);

    // Remove from the ResourceOwner
    if (fixOwner)
        ResourceOwnerForgetBuffer(CurrentResourceOwner, b);

    // Decrease the private refcount
    Assert(ref->refcount > 0);
    ref->refcount--;

    if (ref->refcount == 0)
    {
        // ═══════════════════════════════════════════════════════════
        // Last private reference: must update the shared refcount
        // ═══════════════════════════════════════════════════════════

        // Valgrind: mark the buffer as inaccessible
        VALGRIND_MAKE_MEM_NOACCESS(BufHdrGetBlock(buf), BLCKSZ);

        // Confirm we do not hold the content lock
        Assert(!LWLockHeldByMe(BufferDescriptorGetContentLock(buf)));

        // CAS loop to decrease the shared refcount
        old_buf_state = pg_atomic_read_u32(&buf->state);
        for (;;)
        {
            if (old_buf_state & BM_LOCKED)
                old_buf_state = WaitBufHdrUnlocked(buf);

            buf_state = old_buf_state;
            buf_state -= BUF_REFCOUNT_ONE;  // decrease the refcount

            if (pg_atomic_compare_exchange_u32(&buf->state,
                                               &old_buf_state, buf_state))
            {
                // If there are waiters and refcount hit 0, wake them up
                if ((buf_state & BM_PIN_COUNT_WAITER) &&
                    BUF_STATE_GET_REFCOUNT(buf_state) == 0)
                    /* ... wake up waiters ... */
                break;
            }
        }

        // Release the private refcount entry
        ForgetPrivateRefCountEntry(ref);
    }
}
```

#### 4.5.5 ResourceOwner Integration

The pin operation integrates tightly with PostgreSQL's resource tracking system:

```c
// At the start of ReadBuffer_common
ResourceOwnerEnlargeBuffers(CurrentResourceOwner);  // bufmgr.c:820

// At the end of PinBuffer/PinBuffer_Locked
ResourceOwnerRememberBuffer(CurrentResourceOwner, b);  // bufmgr.c:1769, 1828

// In UnpinBuffer
ResourceOwnerForgetBuffer(CurrentResourceOwner, b);  // bufmgr.c:1850
```

**Why bother?**
1. **Automatic cleanup**: all pinned buffers are released when the transaction ends
2. **Leak detection**: detects buffers that remain pinned when they shouldn't
3. **Resource tracking**: easier debugging and monitoring

## 5. Summary

### Core Properties of the Pin Operation

| Property | Implementation | Benefit |
| ---------- | -------------------- | ------------------ |
| **Lock-free updates** | CAS atomic operations | Avoids spinlock overhead, better concurrency |
| **Two-level refcount** | Private + shared | Minimal contention; repeated pins within a process are nearly free |
| **Hybrid storage** | Array (≤8) + hash table | O(1) access in the common case, scales to many pins |
| **Resource tracking** | ResourceOwner | Automatic cleanup, prevents leaks |
| **Eviction-friendly** | usage_count | Feeds the Clock-Sweep algorithm |
| **Strategy-aware** | BufferAccessStrategy | Bulk operations limit cache pollution |

### Performance Considerations

- **Hot buffers**: repeated access within one process only touches the private count — zero contention
- **CAS retries**: under extreme contention the CAS loop may retry several times, but it is still cheaper than a spinlock
- **Memory layout**: PrivateRefCountArray is 64 bytes — exactly one CPU cache line

## References

- [interdb — The Internals of PostgreSQL, Chapter 8](https://www.interdb.jp/pg/pgsql08/index.html)
- PostgreSQL 14.4 source: `src/backend/storage/buffer/bufmgr.c`
- `src/backend/storage/buffer/README`

*This is the English edition of [深入理解PostgreSQL Buffer Pin机制](https://pg-internal.com/post/shen-ru-li-jie-PostgreSQL_Buffer_Pin-ji-zhi.html).*

##{"lang":"en","pair":"/post/shen-ru-li-jie-PostgreSQL_Buffer_Pin-ji-zhi.html"}