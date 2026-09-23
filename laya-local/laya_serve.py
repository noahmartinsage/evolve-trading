"""Laya 本地决策服务 — 供 evolve-app 的 Node 编排层调用

安装依赖:
    .venv\\Scripts\\python -m pip install fastapi uvicorn

运行（默认端口 8792，可用环境变量 LAYA_PORT 覆盖）:
    set HF_ENDPOINT=https://hf-mirror.com
    .venv\\Scripts\\python laya_serve.py

调用示例:
    POST http://127.0.0.1:8792/decide
    {
      "state": {"body": "我两次被扣了款，请立刻退款"},
      "questions": { "urgency": { "type": "score", "instructions": "多紧急", "criteria": ["不紧急", "较急", "阻塞/时限"] } }
    }
    可选字段 "model": "english" | "multilingual" | "typed-decisions" 强制指定检查点。

注意: 这是"文本决策"服务（分类/打分/概率），不是行情预测，不产生任何交易信号。
"""
import os
import time
from typing import Any, Dict, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from laya import Router

app = FastAPI(title="laya-local", version="1.0.0")

# 生产建议: Router(preload=True) 启动时把检查点常驻内存（约 2.3GB），
# 避免每次语言切换时 7~10 秒的冷加载。
ROUTER = {"instance": None}


class DecideBody(BaseModel):
    state: Any
    questions: Dict[str, Any]
    model: Optional[str] = None  # "english" | "multilingual" | "typed-decisions"


@app.on_event("startup")
def startup() -> None:
    ROUTER["instance"] = Router()  # lazy 加载；高吞吐场景改为 Router(preload=True)


@app.get("/healthz")
def healthz() -> Dict[str, Any]:
    return {"status": "ok", "model": "laya", "loaded": ROUTER["instance"] is not None}


@app.post("/decide")
def decide(body: DecideBody) -> Dict[str, Any]:
    router = ROUTER["instance"]
    t0 = time.time()
    if body.model:
        res = router.predict(body.state, body.questions, model=body.model)
    else:
        res = router.predict(body.state, body.questions)
    return {"latency_s": round(time.time() - t0, 4), **res}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LAYA_PORT", "8792")))
