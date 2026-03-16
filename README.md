# PM × Deribit 对冲研究报告

研究 Polymarket 加密二元市场 + Deribit 期权对冲套利的可行性。

## 在线查看

https://amoukyou.github.io/pm-deribit-hedge-report/

## 报告结构

### 首页
- 研究动机与背景

### 第一章：问题分类与策略推导
- PM 加密市场 4 类问题（Up/Down、Above/Below、Price Range、Hit Price）
- 4 类 × Yes/No × Buy/Sell = 16 种策略（编号 #1–#16），含近似期权组合和建议对冲方式
- 研究优先顺序：筛出 #1、#3、#9、#11（适配度高 + 无库存可做）
- 4 种优先策略的理论损益图（标准期权损益图风格，红绿分区）
- 全绿条件推导：从 PM 的 K 推导 Deribit 行权价 K1'/K2'，确定张数，验证 q > p
- 手续费分析：PM 非线性 taker fee + Deribit min(0.03% underlying, 12.5% 权利金)
- 手续费规律：票价接近 $0/$1 时两边手续费同时最低
- 补充收入：PM Maker Rebates + Liquidity Rewards（独立于 taker fee）
- 研究优先级漏斗：逐步推导找出套利机会

### 第二章：认识风险，筛出观察样本
- 核心风险：PM 16:00 UTC 结束 vs Deribit 08:00 UTC 到期，固定差 8 小时
- 多交易所时间匹配：Deribit/OKX/Binance 均 08:00 UTC，IBIT 20:00 UTC（差 4h 但暂不考虑）
- 两种处理方法：事前挑时间接近的 + 事后主动提前平仓
- 完整实盘数据表：45 个 Above + 11 个 Range = 56 个 BTC 问题 × Deribit 匹配期权（含超链接）
- 平仓顺序问题：两边流动性均有限，哪边先平尚无定论

### 第三章：我打算赚谁的钱
- 核心问题：如果这套研究成立，利润从哪里来
- 三类潜在利润来源：① PM 与期权市场的定价差 ② 噪音订单带来的价差回归 ③ PM 平台补贴激励
- 三类来源可能叠加，不是互斥的
- 从利润来源推导监控字段：定价差→比价、噪音→盘口跳动、补贴→活动覆盖
- 利润来源与观察字段对应表

## 数据来源

- PM 市场数据：[Polymarket Gamma API](https://gamma-api.polymarket.com)
- Deribit 期权数据：[Deribit Public API](https://www.deribit.com/api/v2/public)
- OKX 期权数据：[OKX Public API](https://www.okx.com/api/v5/public/instruments)
- Binance 期权数据：[Binance eAPI](https://eapi.binance.com/eapi/v1/exchangeInfo)
- IBIT 期权数据：[CBOE API](https://cdn.cboe.com/api/global/delayed_quotes/options/IBIT.json)
- PM 手续费规则：[Polymarket Maker Rebates](https://docs.polymarket.com/market-makers/maker-rebates)
- PM 流动性奖励：[Polymarket Liquidity Rewards](https://docs.polymarket.com/market-makers/liquidity-rewards)
- Deribit 手续费规则：[Deribit Fees](https://support.deribit.com/hc/en-us/articles/25944746248989-Fees)
