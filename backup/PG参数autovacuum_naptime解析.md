
## PG autovacuum_naptime 介绍

autovacuum_naptime 参数官方文档描述如下：

```yaml
Specifies the minimum delay between autovacuum runs on any given database. In each round the daemon examines the database and issues VACUUM and ANALYZE commands as needed for tables in that database. If this value is specified without units, it is taken as seconds. The default is one minute (1min). This parameter can only be set in the postgresql.conf file or on the server command line.
```

## autovacuum_naptime 源码分析

根据官方文档感觉了解总是不彻底，下面根据代码分析一下该参数。

涉及到的函数调用关系：

```sql
A[AutoVacLauncherMain] --> B(launcher_determine_sleep)
    B --> C[rebuild_database_list]
```

`AutoVacLauncherMain`是vacuum launcher主函数，循环调用`launcher_determine_sleep`函数判断延迟多久调用`vacuum worker`：

```c

/*
 * Main loop for the autovacuum launcher process.
 */
NON_EXEC_STATIC void
AutoVacLauncherMain(int argc, char *argv[])
{
	...
   
	/* loop until shutdown request */
	while (!ShutdownRequestPending)
	{
		struct timeval nap;
		TimestampTz current_time = 0;
		bool		can_launch;

		/*
		 * This loop is a bit different from the normal use of WaitLatch,
		 * because we'd like to sleep before the first launch of a child
		 * process.  So it's WaitLatch, then ResetLatch, then check for
		 * wakening conditions.
		 */

		launcher_determine_sleep(!dlist_is_empty(&AutoVacuumShmem->av_freeWorkers),
								 false, &nap);

		/*
		 * Wait until naptime expires or we get some type of signal (all the
		 * signal handlers will wake us by calling SetLatch).
		 */
		(void) WaitLatch(MyLatch,
						 WL_LATCH_SET | WL_TIMEOUT | WL_EXIT_ON_PM_DEATH,
						 (nap.tv_sec * 1000L) + (nap.tv_usec / 1000L),
						 WAIT_EVENT_AUTOVACUUM_MAIN);

		ResetLatch(MyLatch);

		HandleAutoVacLauncherInterrupts();
        ....
}
```

在`launcher_determine_sleep`函数中，当存在有空闲的vacuum worker时，则会延迟`autovacuum_naptime`后调用，如果没有空闲worker，则会根据获取的数据库列表的avl_dbase中的adl_score分数来降序执行，分数高的先执行。

```c

/*
 * Determine the time to sleep, based on the database list.
 *
 * The "canlaunch" parameter indicates whether we can start a worker right now,
 * for example due to the workers being all busy.  If this is false, we will
 * cause a long sleep, which will be interrupted when a worker exits.
 */
static void
launcher_determine_sleep(bool canlaunch, bool recursing, struct timeval *nap)
{
	/*
	 * We sleep until the next scheduled vacuum.  We trust that when the
	 * database list was built, care was taken so that no entries have times
	 * in the past; if the first entry has too close a next_worker value, or a
	 * time in the past, we will sleep a small nominal time.
	 */
	if (!canlaunch)
	{
		nap->tv_sec = autovacuum_naptime;
		nap->tv_usec = 0;
	}
	else if (!dlist_is_empty(&DatabaseList))
	{
		TimestampTz current_time = GetCurrentTimestamp();
		TimestampTz next_wakeup;
		avl_dbase  *avdb;
		long		secs;
		int			usecs;

		avdb = dlist_tail_element(avl_dbase, adl_node, &DatabaseList);

		next_wakeup = avdb->adl_next_worker;
		TimestampDifference(current_time, next_wakeup, &secs, &usecs);

		nap->tv_sec = secs;
		nap->tv_usec = usecs;
	}
	else
	{
		/* list is empty, sleep for whole autovacuum_naptime seconds  */
		nap->tv_sec = autovacuum_naptime;
		nap->tv_usec = 0;
	}

	/*
	 * If the result is exactly zero, it means a database had an entry with
	 * time in the past.  Rebuild the list so that the databases are evenly
	 * distributed again, and recalculate the time to sleep.  This can happen
	 * if there are more tables needing vacuum than workers, and they all take
	 * longer to vacuum than autovacuum_naptime.
	 *
	 * We only recurse once.  rebuild_database_list should always return times
	 * in the future, but it seems best not to trust too much on that.
	 */
	if (nap->tv_sec == 0 && nap->tv_usec == 0 && !recursing)
	{
		rebuild_database_list(InvalidOid);
		launcher_determine_sleep(canlaunch, true, nap);
		return;
	}

	/* The smallest time we'll allow the launcher to sleep. */
	if (nap->tv_sec <= 0 && nap->tv_usec <= MIN_AUTOVAC_SLEEPTIME * 1000)
	{
		nap->tv_sec = 0;
		nap->tv_usec = MIN_AUTOVAC_SLEEPTIME * 1000;
	}

	/*
	 * If the sleep time is too large, clamp it to an arbitrary maximum (plus
	 * any fractional seconds, for simplicity).  This avoids an essentially
	 * infinite sleep in strange cases like the system clock going backwards a
	 * few years.
	 */
	if (nap->tv_sec > MAX_AUTOVAC_SLEEPTIME)
		nap->tv_sec = MAX_AUTOVAC_SLEEPTIME;
}
```

rebuild_database_list函数：

```c
/*
 * Build an updated DatabaseList.  It must only contain databases that appear
 * in pgstats, and must be sorted by next_worker from highest to lowest,
 * distributed regularly across the next autovacuum_naptime interval.
 *
 * Receives the Oid of the database that made this list be generated (we call
 * this the "new" database, because when the database was already present on
 * the list, we expect that this function is not called at all).  The
 * preexisting list, if any, will be used to preserve the order of the
 * databases in the autovacuum_naptime period.  The new database is put at the
 * end of the interval.  The actual values are not saved, which should not be
 * much of a problem.
 */
static void
rebuild_database_list(Oid newdb)
{
	List	   *dblist;
	ListCell   *cell;
	MemoryContext newcxt;
	MemoryContext oldcxt;
	MemoryContext tmpcxt;
	HASHCTL		hctl;
	int			score;
	int			nelems;
	HTAB	   *dbhash;
	dlist_iter	iter;

	/* use fresh stats */
	autovac_refresh_stats();

	newcxt = AllocSetContextCreate(AutovacMemCxt,
								   "AV dblist",
								   ALLOCSET_DEFAULT_SIZES);
	tmpcxt = AllocSetContextCreate(newcxt,
								   "tmp AV dblist",
								   ALLOCSET_DEFAULT_SIZES);
	oldcxt = MemoryContextSwitchTo(tmpcxt);

	/*
	 * Implementing this is not as simple as it sounds, because we need to put
	 * the new database at the end of the list; next the databases that were
	 * already on the list, and finally (at the tail of the list) all the
	 * other databases that are not on the existing list.
	 *
	 * To do this, we build an empty hash table of scored databases.  We will
	 * start with the lowest score (zero) for the new database, then
	 * increasing scores for the databases in the existing list, in order, and
	 * lastly increasing scores for all databases gotten via
	 * get_database_list() that are not already on the hash.
	 *
	 * Then we will put all the hash elements into an array, sort the array by
	 * score, and finally put the array elements into the new doubly linked
	 * list.
	 */
	hctl.keysize = sizeof(Oid);
	hctl.entrysize = sizeof(avl_dbase);
	hctl.hcxt = tmpcxt;
	dbhash = hash_create("db hash", 20, &hctl,	/* magic number here FIXME */
						 HASH_ELEM | HASH_BLOBS | HASH_CONTEXT);

	/* start by inserting the new database */
	score = 0;
	if (OidIsValid(newdb))
	{
		avl_dbase  *db;
		PgStat_StatDBEntry *entry;

		/* only consider this database if it has a pgstat entry */
		entry = pgstat_fetch_stat_dbentry(newdb);
		if (entry != NULL)
		{
			/* we assume it isn't found because the hash was just created */
			db = hash_search(dbhash, &newdb, HASH_ENTER, NULL);

			/* hash_search already filled in the key */
			db->adl_score = score++;
			/* next_worker is filled in later */
		}
	}

	/* Now insert the databases from the existing list */
	dlist_foreach(iter, &DatabaseList)
	{
		avl_dbase  *avdb = dlist_container(avl_dbase, adl_node, iter.cur);
		avl_dbase  *db;
		bool		found;
		PgStat_StatDBEntry *entry;

		/*
		 * skip databases with no stat entries -- in particular, this gets rid
		 * of dropped databases
		 */
		entry = pgstat_fetch_stat_dbentry(avdb->adl_datid);
		if (entry == NULL)
			continue;

		db = hash_search(dbhash, &(avdb->adl_datid), HASH_ENTER, &found);

		if (!found)
		{
			/* hash_search already filled in the key */
			db->adl_score = score++;
			/* next_worker is filled in later */
		}
	}

	/* finally, insert all qualifying databases not previously inserted */
	dblist = get_database_list();
	foreach(cell, dblist)
	{
		avw_dbase  *avdb = lfirst(cell);
		avl_dbase  *db;
		bool		found;
		PgStat_StatDBEntry *entry;

		/* only consider databases with a pgstat entry */
		entry = pgstat_fetch_stat_dbentry(avdb->adw_datid);
		if (entry == NULL)
			continue;

		db = hash_search(dbhash, &(avdb->adw_datid), HASH_ENTER, &found);
		/* only update the score if the database was not already on the hash */
		if (!found)
		{
			/* hash_search already filled in the key */
			db->adl_score = score++;
			/* next_worker is filled in later */
		}
	}
	nelems = score;

	/* from here on, the allocated memory belongs to the new list */
	MemoryContextSwitchTo(newcxt);
	dlist_init(&DatabaseList);

	if (nelems > 0)
	{
		TimestampTz current_time;
		int			millis_increment;
		avl_dbase  *dbary;
		avl_dbase  *db;
		HASH_SEQ_STATUS seq;
		int			i;

		/* put all the hash elements into an array */
		dbary = palloc(nelems * sizeof(avl_dbase));

		i = 0;
		hash_seq_init(&seq, dbhash);
		while ((db = hash_seq_search(&seq)) != NULL)
			memcpy(&(dbary[i++]), db, sizeof(avl_dbase));

		/* sort the array */
		qsort(dbary, nelems, sizeof(avl_dbase), db_comparator);

		/*
		 * Determine the time interval between databases in the schedule. If
		 * we see that the configured naptime would take us to sleep times
		 * lower than our min sleep time (which launcher_determine_sleep is
		 * coded not to allow), silently use a larger naptime (but don't touch
		 * the GUC variable).
		 */
		millis_increment = 1000.0 * autovacuum_naptime / nelems;
		if (millis_increment <= MIN_AUTOVAC_SLEEPTIME)
			millis_increment = MIN_AUTOVAC_SLEEPTIME * 1.1;

		current_time = GetCurrentTimestamp();

		/*
		 * move the elements from the array into the dlist, setting the
		 * next_worker while walking the array
		 */
		for (i = 0; i < nelems; i++)
		{
			avl_dbase  *db = &(dbary[i]);

			current_time = TimestampTzPlusMilliseconds(current_time,
													   millis_increment);
			db->adl_next_worker = current_time;

			/* later elements should go closer to the head of the list */
			dlist_push_head(&DatabaseList, &db->adl_node);
		}
	}

	/* all done, clean up memory */
	if (DatabaseListCxt != NULL)
		MemoryContextDelete(DatabaseListCxt);
	MemoryContextDelete(tmpcxt);
	DatabaseListCxt = newcxt;
	MemoryContextSwitchTo(oldcxt);
}
```

由于可能存在新增的或是删除的数据库，所以需要重建数据库列表，获取到数据库个数N后，autovacuum_naptime/N 则为 vacuum worker延迟执行的时间，下面则为代码说明，nelems表示数据库的个数：

```c
millis_increment = 1000.0 * autovacuum_naptime / nelems;
if (millis_increment <= MIN_AUTOVAC_SLEEPTIME)
	millis_increment = MIN_AUTOVAC_SLEEPTIME * 1.1;
```

在重建数据库列表时，对于没有统计信息的数据库则会跳过，对于数据库对应的adl_score分数，则是根据加入列表中加入顺序累计递增的：

```c
// 第一阶段：新数据库（参数传入）
if (OidIsValid(newdb)) {
    db->adl_score = score++;  // 初始评分=0，逐步递增
}

// 第二阶段：现有数据库列表
dlist_foreach(iter, &DatabaseList) {
    if (!found) db->adl_score = score++;  // 延续递增
}

// 第三阶段：全量数据库遍历
dblist = get_database_list();
foreach(cell, dblist) {
    if (!found) db->adl_score = score++;  // 继续递增
}
```

递增分配 ：每个新插入哈希表的数据库获得递增的整数值

插入顺序 ：

- 新请求的数据库（ newdb ）优先获得低分
- 现有数据库列表中的数据库次之
- 全局数据库列表中的未调度数据库最后

排序规则 ：通过 db_comparator 按分数 降序 排列（高分在前）

这样安排可以保证每个数据库都可以执行到vacuum，新数据库不会抢占现有数据库的资源，长期未调度的数据库通过高分获得优先处理。

autovacuum_naptime 参数是1min，官方文档中并没有限制该参数的范围值，但是代码中限制了可用范围是100ms到300s之间。

```c
/* the minimum allowed time between two awakenings of the launcher */
#define MIN_AUTOVAC_SLEEPTIME 100.0 /* milliseconds */
#define MAX_AUTOVAC_SLEEPTIME 300	/* seconds */
```

## 总结

- autovacuum_naptime 的含义并不是间隔多久后执行vacuum/analyze达到条件表的频率，而是检查是否存在需要vacuum或analyze表的频率，如果没有则直接退出

- vacuum 定期调用间隔和当前有无空闲worker有关：

  - 有空闲worker，则在间隔autovacuum_naptime 后执行
  - 无空闲worker时，则会在间隔 `autovacuum_naptime /数据库个数` 后执行

- autovacuum_naptime 时间范围在代码中做了约束，可用的范围是100ms--300s

- vacuum的执行根据数据库的分数倒序执行，越久没执行的数据则会越先执行

- 对于数据库比较多的实例，可能会出现autovacuum launcher进程CPU飙升的情况，如果数据库实例并不活跃，没有多少需要执行vacuum或analyze的表可以将 autovacuum_naptime  调大一些

  

## 参考

PG 14.4/autovacuum.c/AutoVacLauncherMain

PG 14.4/autovacuum.c/launcher_determine_sleep

PG 14.4/autovacuum.c/rebuild_database_list

https://rhaas.blogspot.com/2019/02/tuning-autovacuumnaptime.html

https://github.com/digoal/blog/blob/master/201310/20131010_02.md