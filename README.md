# Groundcheck

**Fact-checks AI-written text on your own device and shows the exact source sentence behind every verdict.**

Live: https://ashok-kumar17.github.io/groundcheck/

Paste a paragraph from ChatGPT, Gemini or any other assistant. A small language model running **in your browser on your GPU** (WebLLM + WebGPU) splits the paragraph into claims. It looks each claim up in [Edgepedia](https://www.edgepedia.org) through its public API and marks it **supported**, **contradicted** or **couldn't verify**, with the source sentence highlighted and linked.

## Why

AI writing is fluent and confident, and it is often wrong in small ways: a year, an ordinal, a swapped name. "Sounds like AI" detectors don't tell you whether a sentence is true. Groundcheck does, and it shows you the evidence.

## How it works

```
text ─► sentences ─► [LLM, on device] atomic claims + entity names
     ─► [Edgepedia /resolve] names → articles  (one batched call)
     ─► [Edgepedia /articles?q=] best paragraphs, re-ranked locally
     ─► [LLM, on device] quote one sentence + list "claim says / source says" (JSON-schema constrained)
     ─► [code] guards ─► verdict
```

**Design decisions**

- **The model doesn't judge.** Asked "is this supported?", a 1.5B model says yes to almost anything. Here the model only extracts: one quote, plus what the claim says and what the source says for each detail. Plain code compares the two.
- **No quote, no verdict.** If the quoted sentence isn't in the retrieved text, the model invented its evidence, and the claim becomes *couldn't verify*.
- **The details must match.** A "supported" verdict stands only if every number, ordinal and proper name in the claim also appears in the evidence.
- **Private.** The document never leaves the device. Edgepedia only receives entity names and a few keywords per claim. The *Under the hood* tab counts every byte sent.
- **Honest failure.** A wrong green tick is the costly error, so ambiguous cases fall to *couldn't verify*.

## Benchmark

`js/evalset.js` holds 40 hand-labelled claims: 20 true (each stated in its Edgepedia article) and 20 with one planted error. The **Benchmark** tab runs them on your own GPU and compares Groundcheck with the same model asked directly.

## Run locally

Any static server works: `python -m http.server`, then open `http://localhost:8000` in Chrome or Edge. `tools/harness.mjs` runs the same pipeline in Node against a llama.cpp server, for prompt iteration.

## Credits

Article text from Edgepedia (EdgeChat), Edgepedia Community License 1.0. Each card links to and credits its article. Models: Qwen2.5 / Llama 3.2 via [WebLLM](https://github.com/mlc-ai/web-llm).

Built by Ashok Kumar Meena, IIT Madras.
