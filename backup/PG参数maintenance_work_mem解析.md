## PG maintenance_work_mem介绍

PG 垃圾回收有关的内存参数是maintenance_work_mem或autovacuum_work_mem，如果没有设置autovacuum_work_mem，则使用maintenance_work_mem的设置。

这个参数设置的是内存大小有什么用呢？

PG进行vacuum时会将dead tuple的tid存放到maintenance_work_mem中，当maintenance_work_mem中存不下所有dead tuple的tid时，则会进行index中对应dead tuple记录的清理，索引清理完成后，会继续从上次扫描表记录的位置开始继续扫描。

maintenance_work_mem中记录的dead tuple的tid大小是6个字节，有的编译器可能对齐到8个字节，一般情况下是6个字节，结构体是：

```c
typedef struct ItemPointerData
{
	BlockIdData ip_blkid;
	OffsetNumber ip_posid;
}
```

maintenance_work_mem大小的分配和表大小有关，并不是每次执行vaccum都会分配maintenance_work_mem大小的内存，可以参考下面compute_max_dead_tuples函数部分。

通常生产环境中分配的maintenance_work_mem为1GB，1GB可以存放的tid数有1.7亿：

```sql
postgres=# select 1024*1024*1024/6;
 ?column?  
-----------
 178956970
(1 row)
```

autovacuum_vacuum_scale_factor   默认值是0.2，1GB对应的表记录是 8.9亿：

```sql
postgres=# select 1024*1024*1024/6/0.2; 
      ?column?      
--------------------
 894784850.00000000
(1 row)
```

> 实际上生产中对于频繁修改的表该参数都会调小，所以1GB可以对应的表记录是远大于8.9亿的，对于生产大部分场景来说1GB是足够的

## maintenance_work_mem 内存限制分析

下面主要分析PG 17版本之前，vaccum可用maintenance_work_mem内存大小存在的限制：

lazy_space_alloc负责对应lazy vacuum的空间分配：

```c
static void
lazy_space_alloc(LVRelState *vacrel, int nworkers, BlockNumber nblocks)
{
	LVDeadTuples *dead_tuples;
	long		maxtuples;

	...

	maxtuples = compute_max_dead_tuples(nblocks, vacrel->nindexes > 0);

	dead_tuples = (LVDeadTuples *) palloc(SizeOfDeadTuples(maxtuples));
	dead_tuples->num_tuples = 0;
	dead_tuples->max_tuples = (int) maxtuples;

	vacrel->dead_tuples = dead_tuples;
}
```

lazy_space_alloc调用了compute_max_dead_tuples，compute_max_dead_tuples中计算可以进行vacuum的最大行数：

```c
/*
 * Return the maximum number of dead tuples we can record.
 */
static long
compute_max_dead_tuples(BlockNumber relblocks, bool hasindex)
{
	long		maxtuples;
	int			vac_work_mem = IsAutoVacuumWorkerProcess() &&
	autovacuum_work_mem != -1 ?
	autovacuum_work_mem : maintenance_work_mem;

	if (hasindex)
	{
		maxtuples = MAXDEADTUPLES(vac_work_mem * 1024L);
		maxtuples = Min(maxtuples, INT_MAX);
		maxtuples = Min(maxtuples, MAXDEADTUPLES(MaxAllocSize));

		/* curious coding here to ensure the multiplication can't overflow */
		if ((BlockNumber) (maxtuples / LAZY_ALLOC_TUPLES) > relblocks)
			maxtuples = relblocks * LAZY_ALLOC_TUPLES;

		/* stay sane if small maintenance_work_mem */
		maxtuples = Max(maxtuples, MaxHeapTuplesPerPage);
	}
	else
		maxtuples = MaxHeapTuplesPerPage;

	return maxtuples;
}
```

首先列出其中的几个宏定义及结构体：

```c
/* The dead tuple space consists of LVDeadTuples and dead tuple TIDs */
#define SizeOfDeadTuples(cnt) \
	add_size(offsetof(LVDeadTuples, itemptrs), \
			 mul_size(sizeof(ItemPointerData), cnt))
#define MAXDEADTUPLES(max_size) \
		(((max_size) - offsetof(LVDeadTuples, itemptrs)) / sizeof(ItemPointerData))

#define offsetof(type, field)	((long) &((type *)0)->field)

/* It's possible we could use a different value for this in frontend code */
#define MaxAllocSize	((Size) 0x3fffffff) /* 1 gigabyte - 1 */

/*
 * Guesstimation of number of dead tuples per page.  This is used to
 * provide an upper limit to memory allocated when vacuuming small
 * tables.
 */
#define LAZY_ALLOC_TUPLES		MaxHeapTuplesPerPage

#define MaxHeapTuplesPerPage	\
	((int) ((BLCKSZ - SizeOfPageHeaderData) / \
			(MAXALIGN(SizeofHeapTupleHeader) + sizeof(ItemIdData))))


typedef struct LVDeadTuples
{
	int			max_tuples;		/* # slots allocated in array */
	int			num_tuples;		/* current # of entries */
	/* List of TIDs of tuples we intend to delete */
	/* NB: this list is ordered by TID address */
	ItemPointerData itemptrs[FLEXIBLE_ARRAY_MEMBER];	/* array of
														 * ItemPointerData */
} LVDeadTuples;
```

上面`compute_max_dead_tuples`函数计算最大dead tupe数量分为两种情况，有索引和无索引两种：

- 有索引时：`maxtuples`多次取值，分析一下其中的取值部分`Min(maxtuples, MAXDEADTUPLES(MaxAllocSize))`
  - `MaxAllocSize`宏定义值为 `1 gigabyte - 1`,`MAXDEADTUPLES(MaxAllocSize)`计算后的值为178956969，该值比INT_MAX要小，后面还有根据表中实际块数`relblocks`重新计算`maxtuples`
  - `LAZY_ALLOC_TUPLES`的值为`MaxHeapTuplesPerPage`，`MaxHeapTuplesPerPage`是表示PG中每页最多可以存放的行数数量，该宏可以直接计算也可以通过`gdb`调试来确认，该值是291，291是针对无列的表来说可以存放的最大行数，对于有列的表由于内存对齐的原因最大可以存放的行数是226

- 无索引时：最大行数是 `MaxHeapTuplesPerPage`，`maxtuples`是291

根据上面的代码可以判断出vacuum时内存的分配是根据表大小动态分配的，并不是每次vacuum都需要分配maintenance_work_mem大小。而根据 `palloc(SizeOfDeadTuples(maxtuples))`可以计算出最多分配的内存是不超过1GB的，所以可以得出在执行vacuum操作时，maintenance_work_mem分配超过1GB的空间是没用的，当然也不会造成浪费。

针对使用maintenance_work_mem的其他场景，比如创建索引则不受限制：

```c
static Tuplesortstate *
tuplesort_begin_common(int workMem, SortCoordinate coordinate,
					   bool randomAccess)
{
	Tuplesortstate *state;
	MemoryContext maincontext;
	MemoryContext sortcontext;
	MemoryContext oldcontext;

	...

	/*
	 * workMem is forced to be at least 64KB, the current minimum valid value
	 * for the work_mem GUC.  This is a defense against parallel sort callers
	 * that divide out memory among many workers in a way that leaves each
	 * with very little memory.
	 */
	state->allowedMem = Max(workMem, 64) * (int64) 1024;
	state->sortcontext = sortcontext;
	state->maincontext = maincontext;

	/*
	 * Initial size of array must be more than ALLOCSET_SEPARATE_THRESHOLD;
	 * see comments in grow_memtuples().
	 */
	state->memtupsize = INITIAL_MEMTUPSIZE;
	state->memtuples = NULL;

	/*
	 * After all of the other non-parallel-related state, we setup all of the
	 * state needed for each batch.
	 */
	tuplesort_begin_batch(state);

	/*
	 * Initialize parallel-related state based on coordination information
	 * from caller
	 */
	if (!coordinate)
	{
		/* Serial sort */
		state->shared = NULL;
		state->worker = -1;
		state->nParticipants = -1;
	}
	else if (coordinate->isWorker)
	{
		/* Parallel worker produces exactly one final run from all input */
		state->shared = coordinate->sharedsort;
		state->worker = worker_get_identifier(state);
		state->nParticipants = -1;
	}
	else
	{
		/* Parallel leader state only used for final merge */
		state->shared = coordinate->sharedsort;
		state->worker = -1;
		state->nParticipants = coordinate->nParticipants;
		Assert(state->nParticipants >= 1);
	}

	MemoryContextSwitchTo(oldcontext);

	return state;
}
```

- tuplesort_begin_common在创建索引和排序时都会用到，此处的参数workMem在创建索引时则是maintenance_work_mem，在排序时则是work_mem，可以看到是没有1GB的限制的。

17版本后的更新：

```c
/*
 * Allocate dead_items and dead_items_info (either using palloc, or in dynamic
 * shared memory). Sets both in vacrel for caller.
 *
 * Also handles parallel initialization as part of allocating dead_items in
 * DSM when required.
 */
static void
dead_items_alloc(LVRelState *vacrel, int nworkers)
{
	VacDeadItemsInfo *dead_items_info;
	int			vac_work_mem = AmAutoVacuumWorkerProcess() &&
		autovacuum_work_mem != -1 ?
		autovacuum_work_mem : maintenance_work_mem;

	...

	/*
	 * Serial VACUUM case. Allocate both dead_items and dead_items_info
	 * locally.
	 */

	dead_items_info = (VacDeadItemsInfo *) palloc(sizeof(VacDeadItemsInfo));
	dead_items_info->max_bytes = vac_work_mem * 1024L;
	dead_items_info->num_items = 0;
	vacrel->dead_items_info = dead_items_info;

	vacrel->dead_items = TidStoreCreateLocal(dead_items_info->max_bytes, true);
}
```

> 17版本后存放dead items内存限制大小不超过vac_work_mem * 1024L，TidStoreCreateLocal中又对内存分配做了部分限制，但并没有1GB的限制。



## 总结

1. maintenance_work_mem是动态分配的，根据表大小来控制使用的数量，并不是每次使用都分配maintenance_work_mem大小的空间
2. maintenance_work_mem中存放的是dead tuple的6字节大小的tid记录
3. maintenance_work_mem的大小被内核限制了vacuum可以处理的最大dead tuple数量，maintenance_work_mem被限制了最多可以使用的内存是1GB，分配更大值并不能提升vacuum的效率
4. 此处是maintenance_work_mem针对vacuum操作存在限制，其他有关maintenance_work_mem的操作并未做限制
5. PG 17版本后，则不存在maintenance_work_mem 1GB的限制
6. `MaxAllocSize` 之所以限制为1GB，是为了32位机器上不会溢出
7. 可以通过`pg_stat_progress_vacuum`视图中的`index_vacuum_count`字段判断索引扫描的次数，如果该值大于1，而且maintenance_work_mem不够1GB，可以调整到1GB，另外也可以针对热点表调小autovacuum_vacuum_scale_factor



参考：

PG 14.4/vacuumlazy.c/lazy_space_alloc

PG 14.4/vacuumlazy.c/compute_max_dead_tuples

PG 17.0/vacuumlazy.c/dead_items_alloc

https://github.com/digoal/blog/blob/master/201902/20190226_01.md

https://www.postgresql.org/message-id/flat/20050526182024.20204.qmail%40web51006.mail.yahoo.com