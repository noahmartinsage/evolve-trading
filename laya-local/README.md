# laya-local — Laya 本地部署（evolve-app）

把 [Laya](https://github.com/NandhaKishorM/laya)（Apache-2.0 开源决策模型）部署为本机可调用的
**文本决策服务**。本地部署后**永久免费、无用量计费、可断网内网运行**。

## 它能做什么 / 不能做什么

| 能做（文本决策） | 不能做 |
|---|---|
| 对一段文本/JSON 做分类（choice）、打分（score）、是非判断（noul） | **预测行情/价格/涨跌** |
| 邮件/工单/事件分流、告警分级 | **读 K 线、时间序列、盘口数据** |
| 新闻标题打标签（如"监管/产品/市场"主题分类） | **生成任何交易信号或买卖建议** |
| 对提案器输入做 guardrail / 内容安全过滤 | **替代回测与风控闸门** |

> 定位：它只负责"读文本、答分类题"。**不要**用它判断"该不该买/卖"。
> 它属于文本辅助层，交易决策必须继续走 evolve-app 已有的回测 + 过拟合门禁 + 风控管线。

## 目录

```
laya-local/
  .venv/          Python 3.14 虚拟环境（已装 laya + fastapi/uvicorn）
  laya_demo.py    冒烟测试 + 用法示例（英文/中文/Router）
  laya_serve.py   本地 HTTP 服务（FastAPI，默认端口 8792）
  README.md       本文档
```

## 首次运行（下载权重）

权重来自 Hugging Face（英文检查点约 808MB，多语言约 647MB）。国内网络建议走镜像；
Windows 未开启开发者模式时还需禁用符号链接缓存（否则报 WinError 1314，本机已验证）：

```bat
set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_DISABLE_SYMLINKS=1
```

权重缓存完成后，这两个变量可去掉（缓存文件是普通复制，不再需要符号链接权限）。

## 冒烟测试

```bat
cd laya-local
.venv\Scripts\python laya_demo.py
```

预期：依次输出英文示例（ModernBERT-large）、中文示例（mmBERT-base 多语言）、Router 路由示例，
最后打印 `SMOKE OK`。首次运行会下载权重，之后走本地缓存。

## 服务模式

```bat
cd laya-local
set HF_ENDPOINT=https://hf-mirror.com
.venv\Scripts\python laya_serve.py     :: 监听 127.0.0.1:8792
```

Node 侧调用（fetch）：

```js
const res = await fetch("http://127.0.0.1:8792/decide", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    state: { body: "我两次被扣了款，请立刻退款" },
    questions: {
      urgency: { type: "score", instructions: "多紧急", criteria: ["不紧急", "较急", "阻塞/时限"] },
    },
  }),
});
const data = await res.json(); // data.answers / data.routing / data.latency_s
```

## 生产建议

- `laya_serve.py` 默认 `Router()`（lazy，每个请求按需加载，语言切换有 7~10 秒冷加载）。
  高吞吐改成 `Router(preload=True)`：三个检查点常驻内存约 2.3GB（本机 64GB 无压力），
  切换语言只花亚毫秒级检测。
- 单问题延迟：本机纯 CPU 官方区间 193~464ms；批量提问更快。GPU 加速需要 NVIDIA 卡（本机 AMD 卡用不上）。
- 集成接缝：evolve-app 的 `server/llmProviders.ts` + `server/modelRouter.ts` 是现成的模型抽象层，
  可把本服务作为一个 provider 注册进去；保持"提案器只提案不下单"边界不变。

## 更新 / 卸载

```bat
.venv\Scripts\python -m pip install -U laya      :: 更新
rmdir /s /q laya-local                            :: 卸载（删除整个目录即完全移除，不动系统 Python）
```
