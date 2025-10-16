译自：https://xata.io/blog/going-down-the-rabbit-hole-of-postgres-18-features

> 部分内容略作修改

上周，PostgreSQL 18 已被标记为稳定版本。其亮点包括一些基础特性，如异步 I/O 基础设施和对 OAuth 2.0 的支持；性能优化，如 B 树跳跃扫描；以及备受期待的功能，如原生 UUIDv7 支持。但在此次发布中，有超过 3000 次提交，除了这些亮点之外，还有许多其他你可能想了解的变更。我们着手尽可能多地梳理这些变更，最终在这篇长博客文章（近 5000 词）中涵盖了大约 30 个特性。如果你实在没时间读完所有内容，我完全理解，所以这里尝试提供一个 TL;DR（太长不看版）摘要：

*   异步 I/O 是一项具有巨大潜力的根本性变更，但目前仅在某些场景下使用，因此其全部优势可能还不会在你的用例中显现。
*   默认行为有一些变化（例如，生成列的 `VIRTUAL` 选项），但总体而言，这应该是一次轻松的升级，对你的应用程序代码没有（或仅有最小）影响。
*   在以下每个类别中都有大量改进：
    *   开发者便利性 (uuidv7, RETURNING old/new, 虚拟生成列, 时态数据库)。
    *   常规运维 (更快的升级, oauth, vacuum, 扩展管理)。
    *   特定场景的性能优化 (btree 索引, 规划器改进)。
    *   可观测性/监控 (每进程统计信息, EXPLAIN 改进)。

不过，如果你有时间，我确实推荐阅读全文，因为里面有很多有趣的细节。我们包含了代码示例和提交消息片段。

## 异步 I/O

在此版本之前，Postgres 使用同步 I/O（想想 `read()` 和 `write()` 系统调用），并依赖操作系统来隐藏同步 I/O 的成本。它使用了 `posix_fadvise`，这是一个向操作系统“提示”应用程序计划如何访问文件的系统调用。

通过引入异步 I/O (AIO)，Postgres 获得了两个主要好处（根据 [AIO readme](https://git.postgresql.org/gitweb/?p=postgresql.git;a=blob;f=src/backend/storage/aio/README;h=9c4b1a2d7b4b0b0c0c0c0c0c0c0c0c0c0c0c0c0c0;hb=refs/heads/master) 总结）：
1.  更直接和更早地控制并行发送 I/O 请求的时机，以最小化等待 I/O 的时间。
2.  支持直接 I/O (Direct IO)，它可以使用 DMA 在存储和 Postgres 缓冲池之间复制数据，从而无需占用 CPU。

这些最终会带来更好的性能和更低的资源利用率。预计它对支持高度并行性的网络附加存储尤其有益。

虽然引入了 AIO 框架，但它尚未在所有地方使用，因此目前需要管理好期望。Tomas Vondra 的[这篇博客文章](https://www.postgresql.org/about/news/postgresql-17-enhancements-to-asynchronous-io-2781/)包含了我所见过的最好的性能概述。

![Charts showing the performance of various io_method settings in Postgres 18](https://xata.io/_next/image?url=https%3A%2F%2Fxata.io%2Fapi%2Fmedia%2Ffile%2Fiomethod.png&w=3840&q=100)


*(图片来源: Tomas Vondra 的博客文章)*

简而言之：
*   顺序扫描显示 2 倍或 3 倍的提升
*   索引扫描没有显示提升
*   位图扫描显示了一些提升，但在使用低 `io_workers` 时也出现了性能消退

此外，AIO 应该已经减少了后台维护任务的开销。

## OAuth 2.0

OAuth 支持意味着现在有了一种良好且标准的方法来避免使用那些共享的长期密码。您可以使用 SSO 以交互方式访问 Postgres，并且应用程序可以使用 OAuth 工作流向 Postgres 进行身份验证。

实际上，对于交互式登录，Postgres 连接字符串应该如下所示：

```bash
$ psql 'host=example.org oauth_issuer=https://... oauth_client_id=...'
Visit <https://oauth.example.org/login> and enter the code: FPQ2-M4BG
```

应用程序可以通过连接字符串使用令牌，如下所示：

```bash
host=example.com oauth_issuer=https://... oauth_client_id=... oauth_token=...
```

这种方法可以作为静态密码的替代方案。

## 面向开发者的改进

如果你从开发者的角度使用 PostgreSQL，这可能是你最感兴趣的部分。

### UUID v7

如何生成主键 (PK) 一直是开发者们热议的话题，现在有了一个简单的解决方案。在 Postgres 18 之前，你可以使用原生的 UUID 类型和 UUID v4，但这会带来性能损失，因为 UUIDv4 不是单调递增的，这会影响索引局部性并且压缩效果不好。UUIDv7 解决了这些问题，它是可排序的并将当前时间嵌入开头。

由于 UUIDv7 规范在实现上允许一定的自由度，以下是 Postgres 的具体细节（取自[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=78c5e141e9c139fc2ff36a220334e4aa25e1b0eb)）：

> 在我们的实现中，12 位的亚毫秒时间戳分数部分紧接在时间戳之后存储，在 RFC 中称为 "rand_a" 的空间中。这确保了毫秒内的额外单调性。rand_a 位也起到计数器的作用。我们选择一个亚毫秒时间戳，以便即使在系统时钟倒退或非常高频率生成 UUID 时，同一后端内生成的 UUID 也能单调递增。因此，生成的 UUID 的单调性在同一后端内得到保证。

简单用法如下所示：

```sql
select uuidv7();

                uuidv7
--------------------------------------
 01997f39-9e31-7988-a86a-622879771a69
(1 row)
```

该函数允许传入一个 `interval` 类型的参数，你可以用它来获取一个时间戳在过去或未来的 UUIDv7。例如，这将给出一个时间戳为昨天的 UUIDv7：

```sql
select uuidv7(INTERVAL '-1 day');

                uuidv7
--------------------------------------
 01997a17-44c8-7bb3-a447-0d224f3de52f
(1 row)
```

你可以通过提取嵌入的时间戳来验证：

```
SELECT uuid_extract_timestamp('01997a17-44c8-7bb3-a447-0d224f3de52f');

   uuid_extract_timestamp
----------------------------
 2025-09-24 04:59:29.352+00
(1 row)
```

### RETURNING 现在可以指定 OLD/NEW

这实际上可能是我作为开发者最喜欢的功能，因为我知道它将减少多少代码和复杂性。该特性使 `RETURNING` 子句能够通过使用特殊的别名 `old` 和 `new` 来显式返回旧值和/或新值。这些别名会自动添加到查询中，除非查询已经定义了它们。

以下是一个快速的 `UPDATE` 示例：

```sql
UPDATE foo SET name=upper(name) 
	RETURNING old.name as old_name, new.name as new_name;
	
 old_name | new_name
----------+----------
 foo      | FOO
(1 row)
```

虽然像上面这样的 `UPDATE` 是最清晰的用例，但这也可以与例如 `INSERT ... ON CONFLICT ... DO UPDATE` 一起使用。

### 虚拟生成列，在读取时计算

Postgres 18 添加了一种新的生成列变体：`VIRTUAL`。它们在读取时计算，类似于视图，而不像存储的生成列 (STORED)，后者在写入时计算，类似于物化视图。

以下是一个简单的例子：

```sql
CREATE TABLE users (
    id serial PRIMARY KEY,
    first_name text NOT NULL,
    last_name text NOT NULL,
    full_name text 
      GENERATED ALWAYS AS (first_name || ' ' || last_name) VIRTUAL
);
```

需要注意的一点是：`VIRTUAL` 现在是默认值，因此如果你从旧版本的 Postgres 恢复schema，你的生成列将基本上从虚拟列切换到存储列。

将 `VIRTUAL` 设为默认值的动机在[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=83ea6c54025bea67bcd4949a6d58d3fc11c3e21b)中有描述：

> `VIRTUAL` 是默认值而不是 `STORED`，以匹配各种其他 SQL 产品。（SQL 标准对此没有做出任何规范，但它也不知道 `VIRTUAL` 或 `STORED` 是什么）（此外，虚拟视图是默认值，而不是物化视图。）

commit message中还要注意的另一点是：它们在读取时计算，但在存储方面并非零成本：

> 虚拟生成列在元组中存储为 null 值。（此补丁的早期版本曾试图完全不存储它们。但是，如果你有一个元组，其中中间的一个列完全缺失，很多东西就会崩溃或混乱。这是一个折衷方案，与强制使用存储生成列相比，它更节省空间。如果我们将来找到改进的方法，`pg_upgrade` 的一点小技巧或许可以让我们升级到更新的方案。）

### 逻辑复制中包含生成列

谈到生成列，Postgres 18 增加了将它们包含在逻辑复制流中的能力。之前，我们假设跟随副本可以再次生成这些列，然而如今逻辑复制的用途远不止于 Postgres 到 Postgres 的复制。

这对于像 [pgstream](https://github.com/xataio/pgstream) 和 Debezium 这样的 CDC 工具来说是个好消息，它们现在可以获取生成列。

### 时态数据库改进

首先，快速定义时态数据库：它们是跟踪随时间变化的数据的数据库。时态数据库不仅存储信息的最新状态，还记录数据在其生命周期内随时间变化的历史。

Postgres 18 通过支持主键和唯一约束的 `WITHOUT OVERLAPS` 子句改进了时态数据库的用例。这通过强制执行关键的时态规则将 Postgres 推向更接近时态数据库的能力：对于相同的业务键，有效时间段不得重叠。

我们正在撰写一篇关于使用 PostgreSQL 作为时态数据库的深度博客文章，但现在先来看一个简单的例子：

```sql
-- loading this extension is required for the index to work
CREATE EXTENSION btree_gist;

CREATE TABLE bookings (
  room_id   int        NOT NULL,
  during    tstzrange  NOT NULL,
  -- Temporal PK: last column uses WITHOUT OVERLAPS
  PRIMARY KEY (room_id, during WITHOUT OVERLAPS)
);
```

上述主键保证了同一房间在任何时间点都不会被超额预订。

此外，外键约束现在可以通过 `PERIOD` 关键字引用时间段。这支持范围和多范围类型。时间外键检查范围包含性，而不是相等性。

### 使用 NOT VALID 创建 NOT NULL 约束

此变更将 `NOT NULL` 约束添加到了可以作为 `NOT VALID` 添加的约束列表中。这是什么意思？

假设你有一个当前包含 NULL 值的列。你不能简单地添加 `NOT NULL` 约束，因为它将是无效的（而且它会在 Postgres 验证所有值时锁定表）。如果你先回填数据以删除 `NULL`，则可能会遇到新插入添加更多 `NULL` 值的风险。

相反，`NOT VALID` 允许以下操作：

1. 将约束添加为 `NOT VALID`。这是一个快速操作，因为它不检查现有行。但从现在开始，插入必须为给定列指定非空值。
2. 回填数据以删除所有 NULL。
3. 验证约束。此操作无需锁定表的读写操作（从技术上讲，仍然有锁，但不会阻塞读取或写入）。

以下是一个示例会话：

```sql
CREATE TABLE foo(id int PRIMARY KEY, name text);
INSERT INTO foo(id) VALUES (1);
-- there is one row with name = NULL
ALTER TABLE foo ADD CONSTRAINT name_not_null NOT NULL name NOT VALID;

-- the following will fail
INSERT INTO foo(id) VALUES (2);

UPDATE foo SET name='';
ALTER TABLE foo VALIDATE CONSTRAINT name_not_null;
```

小插曲：[pgroll](https://github.com/xataio/pgroll) 是我们的一个开源项目，它可以帮助你进行各种无锁的模式变更，并使模式变更易于逆转。

### 分区表上的 NOT VALID 外键约束

模式变更操作的另一个好处与上述类似，分区表上的外键约束[可以声明](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=b663b9436e7509b5e73c8c372539f067cd6e66c1)为 `NOT VALID`。

例如，如果 `events` 是一个分区表，其数据引用 `accounts` 表，则以下操作有效：

```sql
ALTER TABLE events
  ADD CONSTRAINT events_account_fk
  FOREIGN KEY (account_id) REFERENCES accounts(id)
  NOT VALID;
```

并且可以逐个分区检查验证，如果你想进一步最小化锁定，这很方便。

### 新协议版本

Postgres 18 自 2003 年以来首次增加了 wire protocol 的版本！这也是次要版本号第一次增加。新版本是 3.2，[官方文档中](https://www.postgresql.org/docs/current/protocol-overview.html#PROTOCOL-VERSIONS)描述了版本升级的原因：

> 用于查询取消的密钥从 4 字节扩大为可变长度字段。更改了 `BackendKeyData` 消息以适应这一点，并重新定义了 `CancelRequest` 消息以具有可变长度的有效负载。

如果你好奇为什么是版本 3.2，而不是版本 3.1，答案在[同一页面](https://www.postgresql.org/docs/devel/protocol-flow.html#id-1.10.5.7.6)上：

> 保留。版本 3.1 未被任何 PostgreSQL 版本使用，但它被跳过了，因为旧版本流行的 pgbouncer 应用程序在协议协商中存在一个错误，导致它错误地声称支持版本 3.1。

目前，libpq 客户端库默认仍使用版本 3.0，直到上层（例如，驱动程序、连接池、代理）添加对新协议版本的支持。这一点，以及重大更改较小的事实，意味着我们不应该会看到新版本引起的兼容性问题。

## 运维改进

### 更快的大版本升级

首先，`pg_upgrade` 通常应该更快，特别是当你在同一集群上有许多数据库，或者更普遍地说，有大量对象（表、视图、序列等）时。这是因为它现在有了一个框架可以并行执行多个“作业”，并且能够更智能地避免不必要的工作和 fsync。

其次，`pg_upgrade` 现在还迁移先前版本的统计信息，这意味着规划器在升级后将拥有其需要的关键信息，从而以最佳方式完成工作。这降低了升级后性能下降的风险。

我觉得这特别酷的是，统计信息迁移实际上是由 `pg_dump` 完成的，它现在拥有 `--no-statistics` 和 `--statistics-only` 选项。因此，你也可以在其他情况下使用它，例如，通过逻辑复制进行蓝绿部署。

### 在 K8s 环境中更轻松地管理扩展

有一个新的 [`extension_control_path` ](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-EXTENSION-CONTROL-PATH)配置项，允许控制 Postgres 查找扩展的位置。这个添加是由 [CloudNativePG 项目](https://cloudnative-pg.io/)提出的，最终目标是为 Kubernetes  operator 声明式扩展管理更容易/可能。

在此之前，由于镜像是不可变的，唯一真正可行的解决方案是构建包含你需要的扩展子集的自定义镜像。现在将可以使用最小镜像，并改为挂载包含其他扩展的镜像卷。

### VACUUM 改进

Postgres 18 带来了几项与 vacuum 相关的改进。

[这](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=052026c9b903380b428a4c9ba2ec90726db81288)可以降低激进 vacuum 的成本。当 Postgres 意识到存在事务回绕风险时，需要激进的 vacuum，因此它知道需要更快地冻结旧元组（行）。

为了分摊激进 vacuum 的开销，Postgres 18 在常规 vacuum 期间会积极地扫描一些所有可见但并非全部冻结的页面。这意味着在常规 vacuum 期间要做更多的工作，但可以更好地避免最坏情况的发生。

Postgres 18 还[改变](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=06eae9e6218ab2acf64ea497bad0360e4c90e32d)了插入阈值的计算，使其不包含冻结的页面，这意味着在插入大量数据的表上通常执行vaccum会更频繁。

vacuum 的可观测性也得到提升，现在有一个名为 [`track_cost_delay_timing`](https://www.postgresql.org/docs/current/runtime-config-statistics.html#GUC-TRACK-COST-DELAY-TIMING) 的新设置，用于收集基于成本的 vacuum 延迟的时间统计信息。请注意，此参数默认是关闭的，因为它会反复查询操作系统当前时间，这可能在某些平台上造成很大的开销。幸运的是，Postgres 带有一个方便的工具 [`pg_test_timing`](https://www.postgresql.org/docs/current/pgtesttiming.html)，因此你可以知道在你的架构上启用是否是个好主意。

## 可观测性/监控改进

### EXPLAIN 改进

Postgres 18 对 `EXPLAIN` 语句进行了一些小的改进。

值得注意的是，`BUFFERS` 现在在运行 `EXPLAIN ANALYZE` 时是默认选项。[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=c2a4078ebad71999dd451ae7d4358be3c9290b07) 解释了更改默认值的理由：

> 在 `EXPLAIN` 中将 `BUFFERS` 选项与 `ANALYZE` 选项一起打开的话题在过去几年中已经出现了几次。在许多方面，这样做似乎是个好主意，因为它可能更清楚地让用户知道为什么给定的查询运行得比他们预期的慢。此外，根据我（David）的个人经验，我看到用户向邮件列表发布两个相同的计划，一个慢一个快，询问他们的查询为什么有时很慢。许多情况下，这是由于额外的读取操作造成的。默认开启 `BUFFERS` 可能有助于减少一些这类问题，如果没有，也会让用户在发布之前更清楚地了解情况，或者在额外的 I/O 工作是导致缓慢的原因时，节省一次往返邮件列表的时间。

除此之外，`EXPLAIN` 包含更多改进的信息：Material 节点的内存/磁盘使用情况、索引搜索计数、禁用节点数量等等。

### pg_stat_statements 中的更多语句

另一项有助于可观测性的改进：像 `CREATE TABLE AS` 和 `DECLARE CURSOR` 这样的语句现在为它们创建的内部查询分配查询 ID。这样做的好处是，这些查询现在将出现在例如 `pg_stat_statements` 中，因为查询 ID是必需的。

### 记录锁获取失败的日志

此变更引入了一个新的配置参数：[`log_lock_failure`](https://www.postgresql.org/docs/current/runtime-config-logging.html#GUC-LOG-LOCK-FAILURES)。如果启用（默认关闭），则当锁获取失败时会产生详细的日志消息。目前，它仅支持记录由 `SELECT ... NOWAIT` 引起的锁失败。

日志消息包括有关持有或等待无法获取的锁的所有进程的信息，帮助用户分析和诊断锁失败的原因。

### 每个进程的统计信息

此变更改进了统计基础设施，使其能够在进程生命周期内保持每个进程的统计信息可用。[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commitdiff;h=9aea73fc6)解释了它的工作原理：

> 这在 pgstats 中添加了一种新的可变编号统计种类，其中统计条目的对象 ID 键基于后端的进程号。这充当了可以同时存在的统计条目数量的上限。条目在后端进程认证成功后启动时创建，并在后端退出时移除，因此只要后端启动并运行，统计信息条目就会一直存在。

此新基础设施的[第一个用户](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=a051e71e28a1)是一个新函数：`pg_stat_get_backend_io()`，它收集特定后端/进程的 IO 统计信息。用法示例：

```sql
SELECT *
   FROM pg_stat_get_backend_io( pg_backend_pid() )
    WHERE backend_type = 'client backend'
      AND object = 'relation'
      AND context = 'normal';
-[ RECORD 1 ]--+---------------
backend_type   | client backend
object         | relation
context        | normal
reads          | 122
read_time      | 0
writes         | 0
write_time     | 0
writebacks     | 0
writeback_time | 0
extends        | 49
extend_time    | 0
op_bytes       | 8192
hits           | 11049
evictions      | 0
reuses         | 
fsyncs         | 0
fsync_time     | 0
stats_reset    | 
```

### 跟踪连接建立时间

Postgres 18 增加了记录建立连接和设置后端直到连接准备好执行其第一个查询所花费时间的选项。日志消息包括三个持续时间：

- 总设置持续时间（从 postmaster 接受传入连接开始，到连接准备好进行查询结束）
- fork 新后端所花费的时间
- 认证用户所花费的时间

要启用此功能，你需要将 `setup_durations` 添加到 [`log_connections`](https://www.postgresql.org/docs/current/runtime-config-logging.html#GUC-LOG-CONNECTIONS) 配置参数中。

## 性能改进和优化

### 索引优化：B-tree 跳跃扫描

假设你有一个多列索引，如 `(col1, col2, col3)`。在 Postgres 18 之前，只有当条件中指定了最左边的列时，这样的索引才会被有效使用。所以所有这些都会使用索引：

```sql
SELECT * FROM foo WHERE col1 = '...';
SELECT * FROM foo WHERE col1 = '...' AND col2 = '...';
SELECT * FROM foo WHERE col1 = '...' AND col2 = '...' AND col3 = '...';
```

而这些通常不会使用索引：

```sql
SELECT * FROM foo WHERE col2 = '...';
SELECT * FROM foo WHERE col2 = '...' AND col3 = '...';
```

这是因为多列索引按元组 `(col1, col2, col3)` 的顺序存储键，因此可以使用它的任何前缀。

Postgres 18 在最后两个例子中也能高效地使用索引。它的工作方式是在 `col1` 值之间跳转并读取索引每个“部分”的相关部分。如果 `col1` 是低基数的，则效果更好，因为这样可以跳过大部分内容。因此，在定义多列索引时，将基数较低的列放在前面是有意义的。

以下是来自[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=9d6b2bf6a5c8f2f0c0c0c0c0c0c0c0c0c0c0c0c0c)的一些相关段落：

> 使 nbtree 多列索引扫描时，使其在给定一个或多个前缀索引列上不带 “=” 条件的查询时，有机会跳过索引中不相关的部分。当 nbtree 接收到来自谓词 `WHERE b = 5` 的输入扫描键时，新的 nbtree 预处理步骤输出 `WHERE a = ANY(<每个可能的 'a' 值>) AND b = 5` 扫描键。也就是说，预处理为省略的前缀列 "a" 生成一个“跳过数组”（和一个输出扫描键），用于省略的前导列“a”，这使得在继续扫描时可以安全地将扫描键标记为 “b”。因此，扫描能够通过同时应用 "a" 和 "b" 键来重复重新定位自身。[...]
>  测试表明，对具有低基数跳过前缀列的索引进行跳跃扫描，可以比等效的完整索引扫描（或顺序扫描）快几个数量级。通常，扫描跳过的列的基数限制了可以跳过的叶子页数量。

### SQL 语言函数使用执行计划缓存

这有助于 SQL 函数中的查询更好地被内联。来自[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commitdiff;h=0dca5d68d)：

> 在 SQL 函数的历史实现中（如果它们没有被内联），我们在外部查询的第一次调用时为所有包含的查询构建计划，然后在外部查询的持续时间内重用这些计划，然后忘记一切。这并不理想，不仅因为计划无法根据函数参数的特定值进行定制。由于计划无法定制，导致无法针对特定参数值优化查询性能。同时，也无法在连续的外部查询之间共享工作，这限制了性能优化的空间。新实现认为现有的计划缓存（plancache）基础设施已经足够成熟，可以用于解决历史实现中的问题。通过使用计划缓存，可以实现以下改进：
>
> - 能够根据函数参数的具体值生成定制的计划，从而提高查询性能。
> - 可以在连续的外部查询之间共享计划，避免重复生成计划，提高效率。
>
> 除了性能方面的改进，新实现还修复了一个长期存在的 SQL 函数问题。在历史实现中，无法在函数中编写会影响后续语句的 DDL（数据定义语言）语句。虽然对于新式的 SQL 函数，由于解析分析的结果被固化在存储的查询树中（并且受到依赖关系记录的保护），这种情况仍然大多存在。但对于旧式的 SQL 函数，现在可以像 PL/pgSQL 函数一样正常工作，因为新实现会延迟每个查询的解析分析和计划，直到准备执行该查询时才进行。此外，一些需要重新计划的边缘情况现在也得到了更好的处理，例如新的行安全测试，现在可以检测到之前遗漏的 RLS（行级安全）上下文变化。

### 自连接消除

如果证明可以用扫描替换连接而不影响查询结果，则自连接消除 (SJE) 功能会在查询树中删除普通表与其自身的内部连接。

这种优化减少了某种形式的冗余，本质上可以提高规划器的估算精度，并减少后续层级的工作量。分区表尤其受益于此，因为它可以更早地识别出需要进行分区修剪的可能性。

### 使用 UNIQUE 索引检测冗余的 GROUP BY 列

此[规划器优化](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=bd10ec529796a13670645e6acd640c6f290df020)适用于使用多列 UNIQUE 索引 `GROUP BY` 情况。在这种特定情况下，Postgres 可以只使用一列，因为 `UNIQUE` 索引确保分组是等价的。

以下是一个受益于此优化的示例：

```sql
CREATE TABLE employees (
    emp_id    serial PRIMARY KEY,
    dept_id   int NOT NULL,
    email     text NOT NULL,
    UNIQUE (dept_id, email)
);

SELECT dept_id, email
   FROM employees
   GROUP BY dept_id, email;
```

Postgres 已经对主键这样做了，现在它将此优化扩展到任何多列 `UNIQUE` 键。请注意，`UNIQUE` 索引中的列需要标记为 `NOT NULL` 或者索引必须使用 `NULLS NOT DISTINCT`。

### 重新排序 DISTINCT 值以减少排序

当你对多个列使用 `DISTINCT` 时，`DISTINCT` 子句中这些列的顺序并不重要，因此[优化器](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=a8ccf4e93a7eeaae66007bbf78cf9183ceb1b371)可以以最符合其需求的方式重新排序。以下是一个说明示例：

```sql
CREATE TABLE sales (
  store_id  int,
  sale_date date,
  amount    numeric
);

-- Note: index orders rows by (store_id, sale_date)
CREATE INDEX ON sales (store_id, sale_date);

-- Query: DISTINCT keys appear as (sale_date, store_id) in this order
-- Semantically it’s the same set of pairs either way.
SELECT DISTINCT sale_date, store_id FROM sales;
```

此行为现在是默认的，但可以通过新的参数设置 `enable_distinct_reordering` 禁用。

### 尽可能将 'x IN (VALUES ...)' 转换为 'x = ANY ...'

此优化的要点是简化查询树，消除不必要连接的出现。以下是一个示例情况：

```sql
EXPLAIN (ANALYZE, COSTS OFF)
  SELECT o.*
    FROM orders o
    WHERE o.id IN (VALUES (101), (205), (99999), (123456));

                                      QUERY PLAN
---------------------------------------------------------------------------------------
 Index Scan using orders_pkey on orders o (actual time=0.010..0.010 rows=0.00 loops=1)
   Index Cond: (id = ANY ('{101,205,99999,123456}'::integer[]))
   Index Searches: 1
   Buffers: shared hit=8
 Planning:
   Buffers: shared hit=26 read=1
   I/O Timings: shared read=0.019
 Planning Time: 0.178 ms
 Execution Time: 0.027 ms
```

注意计划中提到 `ANY` 条件。所以等效的 SQL 是：

```sql
SELECT o.*
  FROM orders o
  WHERE o.id = ANY('{101,205,99999,123456}'::integer[]);
```

[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commitdiff;h=c0962a113)解释了为什么这样更快：

> 这个转换的作用是简化查询树，消除不必要的连接操作。VALUES描述的是一个关系表，而这样的列表的值是一行数据。由于优化器无法通过MCV（Most Common Values，最常见值）统计信息来估计基数（cardinality），所以可能会出现低估的问题。基数估计是数据库优化器用来评估查询成本和选择最优执行计划的重要依据，如果估计不准确，可能会导致选择不合适的执行计划，影响查询性能。基数评估机制可以和数组包含检查操作一起工作。如果数组足够小（少于100个元素），它会逐个元素地进行统计评估。这意味着在这种情况下，可以通过对数组中的每个元素进行单独的统计来更准确地估计基数，从而提高优化器的准确性。转换只适用于标量值的操作，而不是行操作。标量值是指单个的值，如整数、字符串等，而行操作涉及到整行数据。这说明这种转换有一定的适用范围，不能用于所有类型的操作。此外，目前只支持转换结果为常量数组的情况。否则，非哈希的SAOP（Scalar Array Op Expr，标量数组操作表达式）的评估可能会比对应的VALUES的哈希连接更慢。

### 大小写折叠

Postgres 18 添加了一个新的 [`casefold()`](https://www.postgresql.org/docs/18/functions-string.html#FUNCTIONS-STRING-OTHER) 函数，它类似于 `lower()` 但避免了不区分大小写匹配的边缘情况问题。对于支持该函数的排序规则，`casefold()` 可以处理包含两种以上大小写变体或多个字符大小写变体的字符。

以下是一些（取自[邮件列表](https://www.postgresql.org/message-id/flat/CAFBsxsEJOs%2Bf7C%2B%2B%3D%3D7OLp2bsgO4k%3D0O0Qqj4O8o0%2BkQ%40mail.gmail.com)）`casefolding` 比 `lowering` 处理得更好的边缘情况示例：

- 一些字符有超过两种大小写形式，例如 "Σ" (U+03A3)，它可以小写为 "σ" (U+03C3) 或 "ς" (U+03C2)。`casefold()` 函数将字符的所有大小写形式转换为 "σ"。
- 字符 "İ" (U+0130，带点的大写 I) 被小写为 "i"，这在没有预料到这种情况的语言环境中可能会出现问题。
- 如果向 Unicode 添加新的小写字符，`lower()` 的结果可能会改变。

> 大小写折叠和大小写转换虽然相似，但目的不同。大小写折叠是为了方便进行字符串的大小写不敏感匹配，而大小写转换是为了将字符串转换为特定的大小写形式（如全小写、全大写等）。例如，若要比较两个字符串是否相同而不考虑大小写，大小写折叠后的结果更适合直接进行比较；而若要将一个字符串统一为小写形式以便于后续处理，大小写转换则更适用。
>
> 通常情况下，大小写折叠就是简单地将字符串转换为小写。然而，根据不同的校对规则，可能会存在一些特殊情况。比如某些字符可能有超过两个小写变体，或者在折叠时会转换为大写。以德语中的“ß”为例，它在一些校对规则下折叠后会变成“ss”，而不是简单地转换为小写形式。

### 更快的 lower(), upper()

与上述相关，Postgres 18 为 `lower()` 和 `upper()` 提供了更快的实现。优化在于如何生成映射表，具有以下好处（取自[邮件列表](https://www.postgresql.org/message-id/7cac7e66-9a3b-4e3f-a997-42aa0c401f80%40gmail.com)）：

- 删除了在所有表中存储 Unicode 码点 (unsigned int)。
- 将主表从 3003 条记录减少到 1575 条（重复项已移除）。
- 在主表中用 `uin8_t` 替换指针（本质上是 `uint64_t`）。
- 减少了在表中查找记录的时间。
- 减少了最终目标文件的大小。

[commit message](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=27bdec06841d1bb004ca7627eac97808b08a7ac7)包含了对其他考虑过的方法的说明：

> 考虑了其他方法，例如将这些范围表示为另一种结构（而不是生成函数中的分支），或者不同的方法，如基数树或完美哈希。作者实现并测试了这些替代方案，最终选择了生成分支。

### 更快的范围 GiST 索引构建

GiST 支持“排序构建”模式：如果输入元组已经排序，它可以更快地构建树并具有更好的打包。但要有效地对范围进行排序，规划器/执行器需要一个特殊的 `sortsupport` 函数。这随着[此提交](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=6a3002712a0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c)而添加。

### 数组便利函数

Postgres 18 为数组带来了两个不错的[便利函数](https://www.postgresql.org/docs/current/functions-array.html#FUNCTIONS-ARRAY)：`array_reverse()` 和 `array_sort()`。

每个函数的快速示例：

```
SELECT array_reverse(ARRAY[1,2,3]);

 array_reverse 
---------------
 {3,2,1}
(1 row)

 SELECT array_sort(ARRAY[3,1,2]);
 
 array_sort 
------------
 {1,2,3}
(1 row)
```

### json_strip_nulls() 移除空数组元素

JSON 函数 [`json_strip_nulls()`](https://www.postgresql.org/docs/current/functions-json.html#FUNCTIONS-JSON-PROCESSING-TABLE) 获得了一个新参数：`strip_in_arrays`。它默认为 false。如果为 true，则删除空值数组元素以及空值对象字段。仅由单个 null 组成的 JSON 不受影响。

### 添加函数以获取数据库对象的 ACL

Postgres 18 引入了一个新函数 [`pg_get_acl()`](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-INFO-OBJECT)，用于检索和检查与数据库对象关联的权限。以下是一个示例：

```sql
postgres=# CREATE TABLE foo (id INT);
CREATE TABLE

postgres=# CREATE ROLE bar;
CREATE ROLE

postgres=# GRANT SELECT ON foo TO bar;
GRANT

postgres=# CREATE ROLE baz;
CREATE ROLE

postgres=# GRANT UPDATE ON foo TO baz;
GRANT

postgres=# SELECT unnest(pg_get_acl('pg_class'::regclass, 'foo'::regclass, 0));
           unnest           
----------------------------
 postgres=arwdDxtm/postgres
 bar=r/postgres
 baz=w/postgres
(3 rows)
```

在上面，你可以看到 `bar` 角色获得读取访问权限，`baz` 角色获得写入访问权限。
