# 定向失败集（hard-multihop-*）

这三份文件是**历史失败题回归探针**：它们是从各基准的一次实测运行里挑出的、
系统当时答错的题目，用同一套 grader 单独复跑，用来回答一个问题——
**"这次改动是真的修好了东西，还是只是换了一批运气？"**

## 为什么需要它

聚合指标（n=100 的答案包含率）在单次运行间有 ±0.03–0.07 的波动，
而过去十几轮的改动幅度也在这个量级。把失败题单独成集后，
同一批题在同样时间内能给出更灵敏、更容易归因的信号
（例：某轮"加宽上下文"在这个探针上从 21/60 掉到 5/60，聚合指标却看不出来）。

| 文件 | 题量 | 来源 |
| :--- | ---: | :--- |
| `hard-multihop-hotpot.json` | 20 | HotpotQA n=100 一次实测中 `full_evidence>0 且 containment=0` 的题 |
| `hard-multihop-musique.json` | 24 | MuSiQue n=100 同上 |
| `hard-multihop-2wiki.json` | 29 | 2WikiMultiHopQA n=100 同上（2026-09-22 并入最近一次 n=100 的全部严格失败题） |

### 下限怎么标定（2026-09-22 起）

下限=**同一构建多次实测的较低值**，不再是单次观测。原因：严格包含率在这批题上本身不稳定
（其中有相当比例的题是"答对了但措辞不同"或"拒答但顺带提到 gold"，见
`docs/sota-evaluation-comprehensive-2026-09-20.md` §30.2），16 题的探针单题翻转即 ±0.06。
2026-09-22 实测：2Wiki 探针在同一构建上跑出 12/16、12/16、11/16、10/16，
而旧下限 13/16 来自一次"假阳性恰好全中"的运行——门禁因此会随机红。

| 探针 | 同一构建重复实测 | 采用下限 |
| :--- | :--- | ---: |
| hotpot（20） | 12、13、13 | 12 |
| musique（24） | 10、11、12、12 | 10 |
| 2wiki（29，已扩容） | 12/29、10/29 | 10 |

**判读纪律**：探针只是**粗粒度**回归探测器（拦"某个类别被整片打坏"，如历史上的 21/60→5/60）；
它低于下限 1-2 题时先按"噪声"处理并复跑，但**能力结论必须看 n=100 的聚合 + LLM 复评**。

`floors.json` 记录**最终配置（deepseek-chat 主模型 + 保底 N=12 + 修复后的桥接链）**
下的通过数，作为门禁下限。

## 用法

```bash
# 与 sota-gate.sh 配合（推荐）
bash tests/evaluation/intl-benchmark/sota-gate.sh quick

# 或手工单跑
EVAL_SET_PATH=tests/evaluation/intl-benchmark/regression/hard-multihop-musique.json \
  QA_WORKERS=3 python3 tests/evaluation/intl-benchmark/benchmark_suite.py musique --mode full
```

注意：探针样本小（16–24 题），单题翻转即 ±0.04；
门禁因此只在**低于下限**时报警，且允许 1 题容差（见 `sota-gate.sh`）。
判读结论时应结合三套 n=100 的聚合指标一起看。
