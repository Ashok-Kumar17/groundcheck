# Groundcheck

**Fact-checks AI-written text on your own device and shows the exact source sentence behind every verdict.**

**Demo video (45 s):** https://drive.google.com/file/d/16fXy1ohpfu5yLmmzqRn9dWy9_1PqKg6L/view

**Live demo:** https://ashok-kumar17.github.io/groundcheck/ (Chrome or Edge with WebGPU; there's also a *Replay a recorded run* button for machines without it)

Paste a paragraph from ChatGPT, Gemini or any other assistant. A small language model running **in your browser on your GPU** (WebLLM + WebGPU, Qwen2.5 1.5B) splits it into claims. It looks each claim up in [Edgepedia](https://www.edgepedia.org) through its public API and marks it **supported**, **contradicted** or **couldn't verify**, with the real source sentence highlighted and linked.

## Result

40 hand-labelled claims (`js/evalset.js`): 20 true, each stated in its Edgepedia article, and 20 with one planted error (wrong year, ordinal, person, place or role).

|                                   | Same model asked directly | Groundcheck |
|-----------------------------------|:---:|:---:|
| False claims shown as **supported** | **65%** | **5%** |
| False claims caught outright      | 15% | 45% |
| True claims confirmed             | 85% | 90% |

A wrong green tick is the costly error, so the system prefers an honest "couldn't verify". The one false claim that still passes is a role swap ("Aldrin stayed in orbit while Armstrong and Collins landed"): every name is present in the source, and only the roles are wrong. Catching that needs relation-level checking, which is the next step.

## How it works

```
text ─► sentences ─► [LLM, on device] short claims ─► [code] entity names
     ─► [Edgepedia /resolve + /search] articles ─► [Edgepedia /articles?q=] best paragraphs, re-ranked locally
     ─► [LLM, on device] quote one sentence + "claim says / source says" pairs
     ─► [code] guards ─► verdict
```

**Design decisions, each one forced by a failure seen in testing**

1. **The model doesn't get the final word.** Asked "is this supported?", a 1.5B model says yes to 65% of false claims. Here the model only extracts a quote and detail pairs. Code decides.
2. **Evidence is re-located in the real source.** Small models sometimes copy the claim's wrong value into their own "quote". Groundcheck finds the actual source sentence the quote points at and runs every check against that, so invented evidence can't support anything.
3. **Discriminating details must be in the cited sentence.** Numbers, ordinals and opposites (north/south, first/last) must appear in the cited sentence itself. If they appear only somewhere else in a long article, they don't count. A claim saying "1975" followed by a source sentence saying "1969" is flagged as a contradiction in code.
4. **Robust on cheap hardware.** On an 8 GB shared-memory laptop GPU, grammar-constrained decoding made the GPU drop out. Groundcheck instead uses free-form JSON with a tolerant parser and shape normalisers, plus chunked prefill to stay under Windows' GPU watchdog.
5. **Private.** The document never leaves the device. Edgepedia receives only entity names and a few keywords per claim, and the *Under the hood* tab counts every byte sent.

## Run locally

Any static server: `python -m http.server`, then open `http://localhost:8000`. `tools/harness.mjs` runs the identical pipeline in Node against a llama.cpp server (`node tools/harness.mjs eval`) to reproduce the benchmark.

## Credits

Article text from Edgepedia (EdgeChat), Edgepedia Community License 1.0. Each card links to and credits its article. Models: Qwen2.5 via [WebLLM](https://github.com/mlc-ai/web-llm).

Built by Ashok Kumar Meena, IIT Madras.
