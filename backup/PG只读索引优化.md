现在是圣诞节，我的日常工作相对安静，所以让我们再次让它成为故事时间！另一个来自战壕的故事：一个表和一个索引会出错吗？

几周前，一位用户问我为什么其中一个查询的 “性能不一致”。 据用户说，“有时需要 3 分钟，有时需要 30 分钟，或者永远不会完成。看了一下查询后，我可以看出实际问题不是 30+ 分钟，而是 3 分钟 —— 当你有一个几亿行的表，而你的 select 生成刚刚超过 1000 行时，这是一个经典的 “短查询”，所以你应该能够在几毫秒内获得结果。

最初的查询是针对自联接的视图，起初，我怀疑视图本身有问题，但后来我从视图中提取出一个表的一个 SELECT语句，这确实非常慢：需要几分钟，而本来应该需要几秒钟。“不一致” 是由于高 I/O 造成的，并且取决于执行时共享缓冲区中的内容。 查询如下所示：

```sql
SELECT * FROM large_table
  WHERE col1='AAA'
  AND col2='BCD'
  AND created_at BETWEEN '01-01-2012' AND '12-31-2012'
  AND extract (hour FROM created_at)=16
  AND extract (minute FROM created_at)=15
```

查询中用到的是建有所有字段的一个索引：

```sql
CREATE INDEX large_table_index ON large_table (col1, col2, created_at);
```

查询计划看起来很完美：使用该索引的 INDEX SCAN；然而，查询非常慢，因为对于每个获取的记录，必须验证小时和分钟（您已经猜到表不仅大而且宽）。

根据执行计划，索引扫描时选择的行数约为 30M，随后的过滤将其减少到略高于 1K。我开始认为，尽管听起来很荒谬，但创建一个额外的部分索引或将 “小时” 和 “分钟” 部分包含在索引中可能是一个好主意。（不）幸运的是，这两种解决方案都不起作用，因为 extract 和其他替代方案不是不可变的，不能在索引中使用。我不知道该怎么办，但在某个时候，我跑了

```sql
SELECT count(*) FROM large_table
WHERE col1='AAA'
AND col2='BCD'
AND created_at BETWEEN '01-01-2012' AND '12-31-2012'
AND extract (hour FROM created_at)=16
AND extract (minute FROM created_at)=15
```

因为我需要这个计数，而且令我惊讶的是，它只用了几毫秒就跑完了！我立即运行 EXPLAIN ANALYZE ，发现在本例中，Postgres 选择了 INDEX ONLY SCAN！由于不需要返回所有记录，因此在索引块本身中执行过滤！

这很好，没有理由不能以相同的方式优化原始查询，但是我该如何向查询计划程序解释呢？我想起了我与用户的对话，他提到 “在大多数情况下，这个索引运行良好，并且任何间隔的结果都非常快速地返回。不要问我为什么决定重写如下所示的查询，但它起到了作用！我想，在这样的时刻，我确实 “像 Postgres 一样思考”。

```sql
SELECT * FROM large_table
WHERE (col1, col2, created_at) IN (
   SELECY col1, col2, created_at 
   FROM large_table
     WHERE col1='AAA'
     AND col2='BCD'
     AND created_at BETWEEN '01-01-2012' AND '12-31-2012'
     AND extract (hour FROM created_at)=16
     AND extract (minute FROM created_at)=15)
```

我希望你喜欢阅读这个圣诞故事，就像我喜欢分享它一样！



翻译自：https://hdombrovskaya.wordpress.com/2024/12/29/can-we-use-this-index-please-why-not/



#### 总结：

1.记录一下上面的改写方式，后面有可能会用到。

2.PG自带的extract是只有一个是stable的，其他的都是immutable的，实际上可以创建包含后面条件的索引
![image](https://github.com/user-attachments/assets/7a6ea76b-a149-4e2b-970d-5b8b838237c7)
