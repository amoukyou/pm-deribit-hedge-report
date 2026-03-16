# 开发日志

## 2026-03-16 ~ 2026-03-17

### 项目结构
```
PM-Deribit对冲套利研究/
├── index.html          # 首页（章节导航）
├── ch1.html            # 第一章：问题分类与策略推导
├── ch2.html            # 第二章：风险识别与样本筛选
├── ch3.html            # 第三章：利润来源分析
├── ch4.html            # 第四章：监控仪表盘（需本地后端）
├── server.js           # Node.js 后端（端口 3456）
├── fetch_data.py       # 市场元数据抓取脚本
├── data.json           # 市场元数据缓存（token IDs、行权价等）
├── monitor.db          # SQLite 实时监控数据库（自动生成）
├── README.md           # 项目说明
└── DEV_LOG.md          # 本文件
```

### 启动方式
```bash
cd ~/Desktop/PM-Deribit对冲套利研究

# 1. 首次运行：抓取市场元数据
python3 fetch_data.py

# 2. 启动后端（会自动每30秒刷新数据）
node server.js

# 3. 打开仪表盘
open http://localhost:3456/ch4.html

# 报告页面（纯静态，不需要后端）
open http://localhost:3456/index.html
```

### 技术栈
- 前端：纯 HTML/CSS/JS + Chart.js 4.4.7 + chartjs-plugin-annotation
- 后端：Node.js 25（内置 SQLite）
- API：Polymarket Gamma API + CLOB API、Deribit Public API、OKX API、Binance eAPI、CBOE API
- 无需 npm install，全部使用原生模块

### 数据流
1. `fetch_data.py` → 抓取 PM 市场元数据（token IDs、行权价、到期时间）→ 写入 `data.json`
2. `server.js` 启动时读取 `data.json`，每 30 秒并发拉取：
   - PM CLOB order book（每个市场的 Yes/No best ask）
   - Deribit ticker（每个行权价的 call/put bid/ask）
3. 计算 q-p 后写入 SQLite `monitor.db`
4. 前端 `/api/monitor` 从 SQLite 读取，毫秒级响应

### 第四章仪表盘功能
- 194 行实时监控（97 市场 × Buy Yes + Buy No）
- 筛选：Above/Range、Buy Yes/No
- 排序：q-p 升降序、时间差、PM ask
- 点击行展开详情：
  - PM 端：票价、数量、总成本
  - Deribit 端：每条腿合约名、买/卖、BTC 价格、USD 价格
  - 组合汇总：PM 成本 vs Deribit 净收入 → 预计到期损益
  - 3 张损益图（动态缩放、盈亏平衡蓝点标注、tooltip 红绿色）
- 盘口缺失时显示"无法执行"
- 展开详情时暂停自动刷新

### 待解决
- Range 类型（#9/#11）的 Deribit 4 腿组合 q 计算还没实现
- 很多深度 OTM/ITM 的 Deribit 期权没有挂单（bid=0）
- 当前所有有数据的 q-p 都是负的（PM 比 Deribit 便宜）
- ETH 等其他币种还未加入
