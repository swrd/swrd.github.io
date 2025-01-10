## 引入

表级别的storage parameter参数vacuum_truncate是在PG12后引入的，加入该参数用来控制是否回收表尾部的空闲空间，在之前的版本中默认是一直回收表尾部的空闲空间。在执行表的尾部空闲空间时，会对表添加 ACCESS EXCLUSIVE lock，这是最严格的锁，会堵塞对表的所有操作。

```
Add vacuum_truncate reloption.
vacuum_truncate controls whether vacuum tries to truncate off
any empty pages at the end of the table. Previously vacuum always
tried to do the truncation. However, the truncation could cause
some problems; for example, ACCESS EXCLUSIVE lock needs to
be taken on the table during the truncation and can cause
the query cancellation on the standby even if hot_standby_feedback
is true. Setting this reloption to false can be helpful to avoid
such problems.

Author: Tsunakawa Takayuki
Reviewed-By: Julien Rouhaud, Masahiko Sawada, Michael Paquier, Kirk Jamison and Fujii Masao
Discussion: https://postgr.es/m/CAHGQGwE5UqFqSq1=kV3QtTUtXphTdyHA-8rAj4A=Y+e4kyp3BQ@mail.gmail.com
```

执行truncate操作部分是在函数lazy_truncate_heap中执行的，大题流程如下：

- 首先调用ConditionalLockRelation对表尝试获取AccessExclusiveLock锁
- 如果拿不到锁，会重试100次，如果还没拿到就会退出，不再进行表尾部空闲块的truncate操作
- 在拿到独占锁之前，表的总page数量是有可能增加的，所以会对比页数是否增加，如果有增加则会退出执行truncate，因为增加的page中可能有新记录
- 如果页数没有增加，会对表尾部空闲页再重新扫一遍以确认是否页真为空，在确认期间是一直持有独占锁的

需要注意的是，表尾部空闲页的truncate，pg是通过扫描整个buffer pool来实现的，具体代码调用路径如下：

```
lazy_truncate_heap->RelationTruncate->smgrtruncate->DropRelFileNodeBuffers
```

所以，buffer pool越大，独占锁加的时间越久，对表的堵塞也就越久。这里和执行drop/truncate操作都是一样的。

```c
/*
 * lazy_truncate_heap - try to truncate off any empty pages at the end
 */
static void
lazy_truncate_heap(LVRelState *vacrel)
{
	BlockNumber old_rel_pages = vacrel->rel_pages;
	BlockNumber new_rel_pages;
	bool		lock_waiter_detected;
	int			lock_retry;

	/* Report that we are now truncating */
	pgstat_progress_update_param(PROGRESS_VACUUM_PHASE,
								 PROGRESS_VACUUM_PHASE_TRUNCATE);

	/*
	 * Loop until no more truncating can be done.
	 */
	do
	{
		PGRUsage	ru0;

		pg_rusage_init(&ru0);

		/*
		 * We need full exclusive lock on the relation in order to do
		 * truncation. If we can't get it, give up rather than waiting --- we
		 * don't want to block other backends, and we don't want to deadlock
		 * (which is quite possible considering we already hold a lower-grade
		 * lock).
		 */
		lock_waiter_detected = false;
		lock_retry = 0;
		while (true)
		{
			if (ConditionalLockRelation(vacrel->rel, AccessExclusiveLock))
				break;

			/*
			 * Check for interrupts while trying to (re-)acquire the exclusive
			 * lock.
			 */
			CHECK_FOR_INTERRUPTS();

			if (++lock_retry > (VACUUM_TRUNCATE_LOCK_TIMEOUT /
								VACUUM_TRUNCATE_LOCK_WAIT_INTERVAL))
			{
				/*
				 * We failed to establish the lock in the specified number of
				 * retries. This means we give up truncating.
				 */
				ereport(elevel,
						(errmsg("\"%s\": stopping truncate due to conflicting lock request",
								vacrel->relname)));
				return;
			}

			pg_usleep(VACUUM_TRUNCATE_LOCK_WAIT_INTERVAL * 1000L);
		}

		/*
		 * Now that we have exclusive lock, look to see if the rel has grown
		 * whilst we were vacuuming with non-exclusive lock.  If so, give up;
		 * the newly added pages presumably contain non-deletable tuples.
		 */
		new_rel_pages = RelationGetNumberOfBlocks(vacrel->rel);
		if (new_rel_pages != old_rel_pages)
		{
			/*
			 * Note: we intentionally don't update vacrel->rel_pages with the
			 * new rel size here.  If we did, it would amount to assuming that
			 * the new pages are empty, which is unlikely. Leaving the numbers
			 * alone amounts to assuming that the new pages have the same
			 * tuple density as existing ones, which is less unlikely.
			 */
			UnlockRelation(vacrel->rel, AccessExclusiveLock);
			return;
		}

		/*
		 * Scan backwards from the end to verify that the end pages actually
		 * contain no tuples.  This is *necessary*, not optional, because
		 * other backends could have added tuples to these pages whilst we
		 * were vacuuming.
		 */
		new_rel_pages = count_nondeletable_pages(vacrel, &lock_waiter_detected);
		vacrel->blkno = new_rel_pages;

		if (new_rel_pages >= old_rel_pages)
		{
			/* can't do anything after all */
			UnlockRelation(vacrel->rel, AccessExclusiveLock);
			return;
		}

		/*
		 * Okay to truncate.
		 */
		RelationTruncate(vacrel->rel, new_rel_pages);

		/*
		 * We can release the exclusive lock as soon as we have truncated.
		 * Other backends can't safely access the relation until they have
		 * processed the smgr invalidation that smgrtruncate sent out ... but
		 * that should happen as part of standard invalidation processing once
		 * they acquire lock on the relation.
		 */
		UnlockRelation(vacrel->rel, AccessExclusiveLock);

		/*
		 * Update statistics.  Here, it *is* correct to adjust rel_pages
		 * without also touching reltuples, since the tuple count wasn't
		 * changed by the truncation.
		 */
		vacrel->pages_removed += old_rel_pages - new_rel_pages;
		vacrel->rel_pages = new_rel_pages;

		ereport(elevel,
				(errmsg("table \"%s\": truncated %u to %u pages",
						vacrel->relname,
						old_rel_pages, new_rel_pages),
				 errdetail_internal("%s",
									pg_rusage_show(&ru0))));
		old_rel_pages = new_rel_pages;
	} while (new_rel_pages > vacrel->nonempty_pages && lock_waiter_detected);
}
```

对表尾部空闲页的truncate属于vacuum的倒数第二步，vaccum的操作步骤如下：

![image-20250109175206920](https://github.com/user-attachments/assets/25afe27f-ba02-44f7-abe3-441a54d45c6e)


相比于表数据的空闲页truncate，索引清理的操作在倒数第三步，索引中的空闲页并不会执行truncate操作，被回收到操作系统，而是放入到fsm中，等待下次数据写入或是索引分裂。



## 影响

由于执行vacuum的truncate操作时，会对表加独占锁，所以存在下面几种影响：

- 表尾部空闲空间越大，表堵塞越久，容易出现在大批量删除后；shared_buffer越大，表堵塞越久
- 由于该锁会同步到从库，所以也会影响从库的查询
- 对于存在频繁执行alter，create，drop操作的库，系统表也可能存在堵塞的情况
- 数据块回收后又被立即分配，数据块的分配又引入extend lock

上面的三种情况，第三种可能不容易遇见，不过遇到后可能不容易排查。



## 优化

由于目前官方并没有全局参数控制，如果要关闭只能一个一个表的执行alter进行关闭。

建议对于在主库频繁执行vacuum和从库经常查询的表上禁止vacuum的truncate操作，减少对主库和从库上操作的影响。



参考：

https://www.postgresql.org/message-id/flat/Z2DE4lDX4tHqNGZt%40dev.null

https://mp.weixin.qq.com/s/adkqKqNBP9b_yJhZu4i1Jw

https://www.cybertec-postgresql.com/en/drop-table-killing-shared_buffers/

https://blog.summercat.com/postgres-vacuum-taking-an-access-exclusive-lock.html

PG14.4:vacuumlazy.c:lazy_truncate_heap

