# PM × Deribit 对冲研究报告

研究 Polymarket 加密二元市场 + Deribit 期权对冲套利的可行性。

## 在线查看（静态报告）

https://amoukyou.github.io/pm-deribit-hedge-report/

> 第一至三章为纯静态页面，可直接在线查看。第四章（监控仪表盘）需要本地运行后端。

## 本地运行（含监控仪表盘）

```bash
cd ~/Desktop/PM-Deribit对冲套利研究

# 1. 首次：抓取市场元数据
python3 fetch_data.py

# 2. 启动后端（自动每30秒刷新实时数据）
node server.js

# 3. 打开仪表盘
open http://localhost:3456/ch4.html
```

要求：Node.js 25+（内置 SQLite），Python 3，无需 npm install。

## 报告结构

### 首页
- 研究动机与背景

### 第一章：问题分类与策略推导
- PM 加密市场 4 类问题 → 16 种策略（#1–#16）
- 优先策略：#1、#3、#9、#11（适配度高 + 无库存可做）
- 4 种策略的理论损益图（红绿分区）
- 全绿条件：从 PM 的 K 推导 Deribit 行权价 K1'/K2'，确定张数，验证 q > p
- 手续费：PM 非线性 taker fee + Deribit min(0.03% underlying, 12.5% 权利金)
- 补充收入：PM Maker Rebates + Liquidity Rewards

### 第二章：认识风险，筛出观察样本
- 核心风险：PM 16:00 UTC vs Deribit 08:00 UTC，固定差 8h
- 多交易所对比：Deribit/OKX/Binance 8h，IBIT 4h（暂不考虑）
- 完整实盘数据：97 个 BTC 问题 × Deribit 匹配期权（含超链接）
- 平仓顺序：两边流动性有限，尚无定论

### 第三章：我打算赚谁的钱
- 三类利润来源：定价差、噪音回归、平台补贴
- 从利润来源推导监控字段

### 第四章：监控仪表盘（需本地后端）
- 194 行实时监控（97 市场 × Buy Yes + Buy No）
- 实时拉取 PM CLOB best ask + Deribit option bid/ask
- 每行计算 q-p（Deribit 权利金 - PM 票价）
- 点击展开：每条腿价格、PM/Deribit 成本明细、预计到期损益、3 张损益图
- 盘口缺失时标注"无法执行"

## 技术栈

- 前端：HTML/CSS/JS + Chart.js + chartjs-plugin-annotation
- 后端：Node.js 25（原生 SQLite）
- 数据：PM Gamma API + CLOB API、Deribit Public API

## 数据来源

- [Polymarket Gamma API](https://gamma-api.polymarket.com)
- [Polymarket CLOB API](https://clob.polymarket.com)
- [Deribit Public API](https://www.deribit.com/api/v2/public)
- [OKX API](https://www.okx.com/api/v5/public/instruments)
- [Binance eAPI](https://eapi.binance.com/eapi/v1/exchangeInfo)
- [CBOE IBIT Options](https://cdn.cboe.com/api/global/delayed_quotes/options/IBIT.json)
- [PM Maker Rebates](https://docs.polymarket.com/market-makers/maker-rebates)
- [PM Liquidity Rewards](https://docs.polymarket.com/market-makers/liquidity-rewards)
- [Deribit Fees](https://support.deribit.com/hc/en-us/articles/25944746248989-Fees)
