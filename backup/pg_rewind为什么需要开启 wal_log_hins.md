## 一、`wal_log_hints`参数作用

### （一）Hint bits机制概述

在PostgreSQL中，Hint bits是一种用于优化性能的重要机制，它存储在元组（tuple）头部。具体而言，Hint bits位于元组的`infomask`里，仅占2个BIT位，主要用于缓存事务状态信息。当系统检查元组可见性时，会在元组头部设置这些hint bits，这样在后续操作中，就可以避免查询pg_xact，从而显著提高系统性能。需要强调的是，设置hint bits不会影响数据的正确性，纯粹是一种性能优化手段。

```
/* heapam_visibility.c
 *	  Tuple visibility rules for tuples stored in heap.
 *
 * NOTE: all the HeapTupleSatisfies routines will update the tuple's
 * "hint" status bits if we see that the inserting or deleting transaction
 * has now committed or aborted (and it is safe to set the hint bits).
 * If the hint bits are changed, MarkBufferDirtyHint is called on
 * the passed-in buffer.  The caller must hold not only a pin, but at least
 * shared buffer content lock on the buffer containing the tuple.
*/
```

### （二）Hint bits的具体定义

Hint bits通过元组头部的`infomask`中的特定位来表示tuple的事务状态，具体定义如下：

```
src/include/access/htup_details.h  
#define HEAP_XMIN_COMMITTED             0x0100  /* t_xmin committed 256 */  
#define HEAP_XMIN_INVALID               0x0200  /* t_xmin invalid/aborted 512  */  
#define HEAP_XMAX_COMMITTED             0x0400  /* t_xmax committed 1024  */  
#define HEAP_XMAX_INVALID               0x0800  /* t_xmax invalid/aborted 2048 */  
```

其中，`t_xmin`和`t_xmax`分别代表插入和删除该元组的事务ID。当对应的位被设置时，就表明相应事务的状态（已提交或已中止）。

### （三）事务状态查询机制

Hint bits中仅记录提交成功或失败的事务。对于正在进行的事务，系统可以通过查询`pg_xact`或使用快照来判断其状态。在PostgreSQL的`pg_xact`中，定义了四种事务状态：

```
src/include/access/clog.h
#define TRANSACTION_STATUS_IN_PROGRESS		0x00
#define TRANSACTION_STATUS_COMMITTED		0x01
#define TRANSACTION_STATUS_ABORTED			0x02
#define TRANSACTION_STATUS_SUB_COMMITTED	0x03
```

## 二、`pg_rewind`流程详解

### （一）基本思路概述

`pg_rewind`的主要目标是将源集群的所有文件系统级别的更改复制到目标集群，以确保两个集群的数据一致性。其基本执行流程如下：

### （二）详细步骤解析

1. 扫描目标集群WAL并记录变更数据块
   - 从源集群和目标集群时间线分叉点之前的最后一个共同检查点开始，系统会仔细扫描目标集群的WAL记录。
   - 在扫描过程中，一旦发现某个数据块被修改，就会将其相关信息记录到`file_entry_t`结构体中的`pagemap`里。这个`pagemap`就像是一个“地图”，标记了所有需要关注的数据块变化情况。
2. 复制变更的数据块
   - 根据第一步记录的`pagemap`信息，系统会将所有变更的数据块从源集群精确地复制到目标集群。这一步确保了目标集群的数据在物理层面与源集群保持一致。
3. 复制其他必要文件
   - 除了数据块，系统还会复制其他所有相关文件，包括新的表文件、WAL日志文件、`pg_xact`文件以及各种配置文件。
   - 然而，有一些特定的目录和文件会被忽略，不进行复制。这些包括`pg_dynshmem/`、`pg_notify/`、`pg_replslot/`、`pg_serial/`、`pg_snapshots/`、`pg_stat_tmp/`目录，以及`backup_label`、`tablespace_map`、`pg_internal.init`、`postmaster.opts`和`postmaster.pid`文件，还有任何以`pgsql_tmp`开头的文件或目录。这是为了避免复制不必要的或可能干扰数据一致性的文件。
4. 创建`backup_label`文件
   - 在完成上述复制操作后，系统会创建一个新的`backup_label`文件。这个文件的作用至关重要，它为从故障转移时创建的检查点开始进行WAL重放提供了必要的信息，确保后续的数据恢复过程能够正确进行。
5. 启动目标集群并应用WAL日志
   - 最后，系统会启动目标集群，并应用从分叉点之前最后一个共同检查点开始的所有WAL日志记录，直到两个集群的数据完全一致。这一步是整个`pg_rewind`流程的关键环节，通过重放WAL日志，目标集群能够准确地更新到与源集群相同的状态。

### （三）特殊情况处理

如果两个集群已经在同一个时间线上，那么就不需要进行`rewind`操作。只有在两个集群的时间线发生分叉时，`pg_rewind`才会发挥作用，通过找到两个集群的共同祖先时间线，并确定分叉点，然后按照上述流程进行数据同步。

## 三、为什么需要开启`wal_log_hints`

### （一）`pg_rewind`对WAL日志的要求

在使用`pg_rewind`时，系统要求目标服务器启用校验和（data checksums）或者设置`wal_log_hints = on`。如果这两个条件都不满足，系统会报错：

```
/src/bin/pg_rewind/pg_rewind.c
     /*
	 * Target cluster need to use checksums or hint bit wal-logging, this to
	 * prevent from data corruption that could occur because of hint bits.
	 */
	if (ControlFile_target.data_checksum_version != PG_DATA_CHECKSUM_VERSION &&
		!ControlFile_target.wal_log_hints)
	{
		pg_fatal("target server needs to use either data checksums or \"wal_log_hints = on\"");
	}
```

### （二）`wal_log_hints`的工作原理

开启`wal_log_hints`后，系统会在执行checkpoint后第一次修改hint bits时执行全页镜像（fpi）操作，将整个页面写入WAL日志。在其他情况下，hint bits的修改不会记录到WAL日志中。从代码注释来看，`wal_log_hints`所指的非关键性修改主要就是hint bits操作，但目前在实际应用中仅发现对hint bits有这种特殊处理。

```
/src/backend/utils/misc/guc.c	
	{
		{"wal_log_hints", PGC_POSTMASTER, WAL_SETTINGS,
			gettext_noop("Writes full pages to WAL when first modified after a checkpoint, even for a non-critical modification."),
			NULL
		},
		&wal_log_hints,
		false,
		NULL, NULL, NULL
	},
```

### （三）`pg_rewind`依赖WAL日志记录hint bits的原因

`pg_rewind`通过检查WAL日志来确定哪些数据块发生了变化，然后只复制这些发生变化的块。如果hint bits的修改没有记录到WAL中，`pg_rewind`就无法检测到这些修改。这可能会导致在重写过程中丢失这些修改，进而引发数据不一致或损坏的问题。因为`pg_rewind`需要确保复制后的页面在物理上完全一致，包括所有的元数据。忽略hint bits的变化可能会破坏页面内容的完整性。

虽然hint bits本身不是业务数据，但它们是数据页完整性的重要组成部分。`pg_rewind`关注这些修改的原因主要有以下几点：

1. **影响页面物理状态和校验和**：Hint bits的变化可能会影响页面的物理状态，进而影响页面的校验和计算。如果校验和不匹配，可能会导致数据验证失败，影响系统的可靠性。
2. **避免数据不一致或损坏**：如前所述，忽略hint bits的变化可能导致数据不一致或损坏，这在生产环境中是不可接受的。
3. **故障恢复场景的关键要求**：在故障恢复场景中，确保完整的页面一致性是至关重要的。只有保证所有页面的一致性，才能确保系统在故障后能够正确恢复并正常运行。

## 四、为什么hint bits执行一次仍可满足`pg_rewind`

### （一）`pg_rewind`的核心目标

`pg_rewind`的主要目的是识别哪些页面在源集群和目标集群之间发生了变化。当一个页面的hint bits被修改时，通过记录第一次修改，`pg_rewind`已经能够确定这个页面需要从源集群复制到目标集群。

### （二）性能优化的考量

1. **减少WAL体积**：如果记录每一个hint bit修改，WAL日志会变得非常大。这不仅会增加磁盘I/O的开销，还可能导致WAL日志文件快速膨胀，占用大量的存储空间。通过只在checkpoint后第一次修改时写入整页，可以有效减少WAL日志的体积，提高系统的性能和可维护性。
2. **Hint bits的可重建性**：Hint bits本质上是缓存信息，可以在需要时重新计算。这意味着即使不记录所有的hint bit修改，系统在需要时仍然可以通过查询事务状态等信息来重新生成hint bits的值，不会影响数据的正确性和一致性。
3. **第一次修改足够标识页面变更**：对于`pg_rewind`来说，知道页面被修改过就足够了，不需要详细了解具体修改了哪些hint bits。因为`pg_rewind`的主要任务是确保页面的一致性，而不是精确跟踪hint bits的变化细节。

## 五、总结

PostgreSQL中的hint bits是一种用于优化事务可见性检查的重要机制，默认情况下不会记录到WAL中。而`wal_log_hints`参数改变了这一行为，确保hint bits的修改也被记录到WAL中，这对于`pg_rewind`等需要精确跟踪页面变化的工具至关重要。虽然开启`wal_log_hints`会增加WAL的体积，但通过只在checkpoint后第一次修改时写入整页，PostgreSQL在性能和数据一致性之间找到了一个平衡点。同时，我们也应该认识到hint bits在数据页完整性方面的重要性，以及在故障恢复场景中的关键作用。

## 六、参考资料

- https://www.postgresql.org/docs/14/app-pgrewind.html
- http://mysql.taobao.org/monthly/2018/05/05/
- pg14.4/pg_rewind.c:692-700
- pg14.4/guc.c:1298 - 1306
- pg14.4/heapam_visibility.c:3-11