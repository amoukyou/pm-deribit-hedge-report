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
- 全绿条件推导：q − p > 0（Deribit 权利金 > PM 票价）
- 实际手续费分析：PM taker fee + Deribit 每腿费用
- 研究优先级漏斗：逐步推导找出套利机会

### 第二章：认识风险，筛出观察样本
- 核心风险：PM 结束时间（16:00 UTC）vs Deribit 到期时间（08:00 UTC）的时间差
- 两种处理方法：事前筛选 + 事后提前平仓
- 完整实盘数据表：45 个 BTC Above 问题 × Deribit 匹配期权（含超链接）
- 数据来源：Polymarket Gamma API + Deribit Public API

## 数据来源

- PM 市场数据：[Polymarket Gamma API](https://gamma-api.polymarket.com)
- Deribit 期权数据：[Deribit Public API](https://www.deribit.com/api/v2/public)
- PM Maker Rebate 规则：[Polymarket Docs](https://docs.polymarket.com/market-makers/maker-rebates)
