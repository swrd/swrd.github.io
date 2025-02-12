
我已经看到标题中报告的错误多次了。如果你不熟悉 PostgreSQL 的内部结构，这条消息会令你困惑： `xmin` 和 `relfrozenxid` 是什么意思？为什么一个在另一个之前会成问题？因此，我认为写一篇文章关于这个问题以及错误的意义是值得的。我还会向你展示如何应对这种情况并修复错误。

## 什么是 `xmin` 和 `relfrozenxid` ？

### `xmin` 和 `xmax`

每个 PostgreSQL 表记录（“tuple”）都有系统列 `xmin` 和 `xmax` 。它们包含创建和无效（更新或删除）元组所表示的行版本事务的事务 ID。每个 SQL 语句都有一个快照，它决定了可以查看哪些事务 ID。如果一个语句可以看到tuple的 `xmin` ，并且 `xmax` 无效（值为 0），不可见或属于尚未提交的事务，那么该版本的行对该语句是可见的。（有关 `xmax` 的更多详细信息，请参阅[此文章](https://www.cybertec-postgresql.com/en/whats-in-an-xmax/)。)

### 事务 ID 回环和冻结

PostgreSQL 的多版本架构问题之一是事务 ID 由一个 4 字节无符号整数计数器生成。一旦计数器达到最大值，它将“回绕”到 3（0 到 2 的值有特殊含义）。因此，随着时间的推移，事务 ID 的含义会发生变化：原本属于已提交事务的事务 ID 现在可能属于未来的事务或已回滚的事务。这意味着可见的行可能会突然变得不可见，从而导致数据损坏。如果您想了解这一点是如何发生的，请阅读我关于[事务 ID 回绕的文章](https://www.cybertec-postgresql.com/en/transaction-id-wraparound-a-walk-on-the-wild-side/)。

为防止此类数据损坏发生， `VACUUM` （通常由 autovacuum 触发）冻结旧的可见表记录：它在行上设置一个标志，指示读取器应忽略 `xmin` 和 `xmax` 。该标志将行标记为无条件可见。一旦 PostgreSQL 已冻结数据库中所有旧的可视行，事务 ID 就可以安全地回绕。

### `relfrozenxid` 的含义

冻结旧行对于 PostgreSQL 数据库的健康至关重要。因此，系统会跟踪冻结的进度。系统表 `pg_class` 有一个列“ `relfrozenxid` ”。所有具有 `xmin` 或 `xmax` 等于或早于 `relfrozenxid` 的表记录都保证被冻结。PostgreSQL 使用该列来触发“反回绕”的autovacuum运行：如果表的 `relfrozenxid` 在过去超过 `autovacuum_freeze_max_age` 事务，autovacuum将启动一个反回绕的vacuum进程进行清理工作。这样的工作进程坚持访问可能包含尚未冻结记录的所有表页。在反回绕autovacuum运行完成后，PostgreSQL 可以推进表的 `relfrozenxid` 。

##  `xmin` 比 `relfrozenxid` 更老，有什么问题？

从上述内容可以清楚地看出，任何未冻结的tuple都不应包含比表的 `relfrozenxid` 更旧的 `xmin` 。如果我们发现这样的未冻结tuple，那就是数据损坏的情况。实际上，我们正在研究错误信息的 SQLSTATE 是 `XX001` 。所有以 `XX` 开头的错误信息都表明数据损坏。

请注意，错误发生在执行 `VACUUM` 期间。错误终止了操作，因此 `VACUUM` 无法完成对表的处理。特别是，它不会推进表的 `relfrozenxid` 。如果没有人检测并修复这个问题，系统最终会接近数据丢失。在这种情况下，PostgreSQL 将停止处理任何新的事务。如果发生这种情况，您的系统将面临停机，直到有人能够使用单用户模式修复问题。您不希望发生这种情况，因此应监控 PostgreSQL 日志文件以查找数据损坏错误！

## 什么会导致tuple中的 `xmin` 比 `relfrozenxid` 旧？

主要问题是为什么人们总是收到这个错误信息。当然，所有这些人都有硬件问题是有可能的，这是数据损坏最常见的原因。但我认为更有可能的是，PostgreSQL 中某个地方存在一个尚未发现的 bug。似乎如果 `VACUUM` 与其他某个进程同时运行，结果可能是一个比 `relfrozenxid` 更旧的 `xmin` 未冻结的tuple。

在这个阶段，我想向您寻求帮助。如果您能找到重现错误的方法，请报告您的发现。另外，如果您能想象出可能导致此类数据损坏的并发操作情况，那将很有帮助。这将有助于改进 PostgreSQL。一份好的错误报告是对项目的宝贵贡献！

## 如何通过修改 `relfrozenxid` 触发错误

为了弄清楚如果发生错误我们该如何处理，我们希望人为地引发错误。正如我上面写的，我想不出通过正常数据修改来触发问题的方法。但如果我们愿意手动修改系统表，那么引发问题就相当容易了。这是一个不推荐的操作，可能会破坏您的系统，所以我将创建一个新的数据库，我可以将其删除以消除数据损坏：

```sql
CREATE DATABASE scratch;
\connect scratch
You are now connected to database "scratch" as user "postgres".
CREATE TABLE boom (id integer);
INSERT INTO boom VALUES (1);
UPDATE pg_class
   SET relfrozenxid = pg_current_xact_id()::xid
   WHERE relname = 'boom';

SELECT * FROM boom;

 id 
════
  1
(1 row)

VACUUM boom;
ERROR:  found xmin 31676653 from before relfrozenxid 31676654
CONTEXT:  while scanning block 0 offset 1 of relation "public.boom"
```

请注意， `SELECT` 不会触发错误信息。只有 `VACUUM` 才会彻底检查数据，将条件报告为错误。

## 我该如何修复错误？

有几种方法可以解决这个问题：

### 导出导入来恢复表

可能解决该问题的最简单且最安全的方法是使用 `pg_dump` 导出表。请记住——查询表是不会触发该错误的。然后您可以删除表并恢复备份：

```bash
pg_dump -U postgres -F c -t boom -f dumpfile scratch
psql -U postgres -d scratch -c 'DROP TABLE boom'
pg_restore -U postgres -d scratch dumpfile
```

虽然这种方法很简单，但它有缺点：

- 如果表很大，导出和导入可能需要很长时间
- 如果存在引用该表的外键，您必须先删除并重新创建这些外键

这种方法的优点，除了其简单性之外，还在于导出和导入是唯一确保您已消除所有数据损坏的方法。因此，您应该尽可能使用这种方法。

### 更新 `pg_class` 系统目录中的 `relfrozenxid`

另一种选项是手动更新表 `pg_class` 的 `relfrozenxid` 条目。

```sql
UPDATE pg_class
   SET relfrozenxid = '31676653'
   WHERE relname = 'boom';
```

这项技术速度快，但也有缺点：修改系统表不推荐且危险。如果你为 `relfrozenxid` 选择了一个错误的值，你可能会遇到更糟糕的问题，比如

```bash
ERROR:  could not access status of transaction 43350785
DETAIL:  Could not open file "pg_xact/0029": No such file or directory.
```

### 使用 pg_surgery 处理损坏的表格条目

可能处理错误的最高雅方式是使用 pg_surgery 扩展。使用该扩展，一旦我们知道其物理地址（ `ctid` ），我们可以明确地冻结元组。

```sql
CREATE EXTENSION pg_surgery;

-- search only in block 0
SELECT ctid FROM boom
WHERE ctid > '(0,0)'
  AND ctid < '(0,32000)'
  AND xmin = '31676653';

 ctid  
═══════
 (0,1)
(1 row)

SELECT heap_force_freeze('boom', '{(0\,1)}');

 heap_force_freeze 
═══════════════════
 
(1 row)
```

使用 pg_surgery 也存在风险：它允许你冻结或删除任意表记录，这可能导致数据不一致。扩展名的名称应该给你一个提示：除非你知道自己在做什么，否则不要使用手术刀！

### 更新损坏的行

如果您在损坏的行上执行 `UPDATE` ，PostgreSQL 将创建一个新的、正确的行版本。

```sql
UPDATE boom SET id = id
WHERE id = 1;
```

之后，表可以无任何错误的执行vacuum，这将删除损坏的数据。注意：大批量的更新会导致大量膨胀。因此，只处理损坏的行。

## 结论

人们经常报告错误“从 relfrozenxid 之前找到 xmin...”，这让我认为 PostgreSQL 可能存在一个数据损坏的 bug。我们已经看到了这个错误的含义，并且我已经向你展示了三种处理问题的方法。这些方法都不是没有缺点，所以请仔细选择你的方法。