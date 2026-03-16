# PM × Deribit 对冲研究报告

研究 Polymarket 加密二元市场做市 + Deribit 期权/永续合约对冲的可行性。目标是在零方向风险敞口下，赚取 PM Maker Rebate 及跨市场风险价差。

## 在线查看

https://amoukyou.github.io/pm-deribit-hedge-report/

## 核心结论

无库存起手时，优先研究：

1. **BTC** — 流动性最好
2. **Above / Below** — 与 Deribit 适配度最高
3. **1H / 4H / Daily** — 可对冲且 gamma 可控
4. **价格 40%–60%** — fee_equivalent 权重最大，分到最多 rebate
5. **Buy Yes / Buy No** — 无需库存，直接可执行

## 报告内容

- PM 加密市场 4 类问题分类（Up/Down、Above/Below、Price Range、Hit Price）
- 4 类 × Yes/No × Buy/Sell = 16 个玩法的适配度分析
- 无库存起手的研究优先顺序
- 交互式图表：单腿盈亏、PM vs Deribit 近似对比、组合后 PnL
- 研究优先级漏斗图

## 交互功能

- 拖动目标价位 (K)
- 拖动组合宽度 (ΔK)，观察 Deribit 斜坡如何逼近 PM 台阶
- 切换 Buy Yes / Buy No / 两者对比
- 切换 PM / Deribit / 组合视图
- 按问题类型和操作筛选 16 玩法表
