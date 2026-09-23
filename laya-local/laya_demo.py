"""Laya 本地部署冒烟测试 / 用法示例 — evolve-app/laya-local

运行（首次会自动从 Hugging Face 下载权重，国内建议先设镜像）:
    set HF_ENDPOINT=https://hf-mirror.com
    set HF_HUB_DISABLE_SYMLINKS=1
    .venv\\Scripts\\python laya_demo.py

注: Windows 未开启开发者模式时，首次下载必须设置 HF_HUB_DISABLE_SYMLINKS=1，
    否则 huggingface_hub 建符号链接会报 WinError 1314；权重缓存完成后可去掉。
"""
import json
import time

import laya
from laya import Router

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which department should handle this request?",
        "criteria": {
            "billing": "invoices, payments, refunds",
            "technical": "bugs, outages, system errors",
            "sales": "pricing, new contracts",
            "other": "everything else",
        },
    },
    "urgency": {
        "type": "score",
        "instructions": "How urgent is this request?",
        "criteria": ["not urgent", "soon", "critical deadline or blocking issue"],
    },
    "churn_risk": {"type": "noul", "instructions": "Does the user threaten to cancel or leave?"},
}


def main() -> None:
    print("[1/3] 加载英文检查点 convaiinnovations/laya (~808MB, 首次自动下载)...")
    agent = laya.load("convaiinnovations/laya")
    state_en = {
        "from": "user@acme.com",
        "subject": "Duplicate charge on invoice #4411",
        "body": "Hi, we were billed twice for March. Please refund the duplicate today or we will cancel our plan.",
    }
    t0 = time.time()
    res = agent.predict(state_en, QUESTIONS)
    print(f"    英文示例 ({time.time() - t0:.2f}s):")
    print("    ", json.dumps(res["answers"], ensure_ascii=False, indent=2))

    print("[2/3] 加载多语言检查点 (subfolder=multilingual, ~647MB)...")
    agent_ml = laya.load("convaiinnovations/laya", subfolder="multilingual")
    state_zh = {"body": "我两次被扣了款，请立刻退款，不然我就注销账户并向监管投诉。"}
    t0 = time.time()
    res_zh = agent_ml.predict(state_zh, QUESTIONS)
    print(f"    中文示例 ({time.time() - t0:.2f}s):")
    print("    ", json.dumps(res_zh["answers"], ensure_ascii=False, indent=2))

    print("[3/3] Router 路由模式（自动检测语言/脚本并分派）...")
    router = Router()  # 生产建议 Router(preload=True) 常驻内存
    t0 = time.time()
    res_r = router.predict(state_zh, QUESTIONS)
    print(f"    路由示例 ({time.time() - t0:.2f}s):")
    print("    ", json.dumps({"answers": res_r["answers"], "routing": res_r["routing"]}, ensure_ascii=False, indent=2))

    print("\nSMOKE OK — laya 本地部署可用")


if __name__ == "__main__":
    main()
