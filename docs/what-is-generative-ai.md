<p align="right"><a href="../README.md">← Back to README</a> · <a href="README.md">All docs</a></p>

# What is generative AI?

"Generative AI" is the umbrella term for the AI tools that make things: text, code, pictures, music, video. It is the family that large language models and AI agents belong to. This guide explains it in two parts:

1. **[The simple version](#part-1-the-simple-version)**: no technical background needed. Five minutes.
2. **[The technical version](#part-2-the-technical-version)**: how generative models learn, the main kinds, how they produce output, and where tokens and cost come in.

Read Part 1 and stop there if that is all you need.

This is the first of three short guides. Read them in order, or jump to the one you need:

| Guide | The one-line answer |
|---|---|
| **What is generative AI?** (this page) | AI that *makes new things* instead of only sorting or predicting. |
| [What is an LLM?](what-is-an-llm.md) | The kind of generative AI that works with *language*: the engine inside Claude and Copilot. |
| [What is agentic AI?](what-is-agentic-ai.md) | An LLM that is allowed to *take actions*, step by step, to finish a job. |

---

## Part 1: The simple version

### The short answer

**Generative AI is AI that creates something new**: a paragraph, an email, a piece of code, a picture, a tune. You describe what you want, and it produces it.

That is different from the AI most people used before, which mostly *sorted* or *predicted*:

| Older AI: it decides | Generative AI: it creates |
|---|---|
| "Is this email spam? Yes or no." | "Write a polite reply to this email." |
| "Which photo has a cat in it?" | "Draw a cat wearing a raincoat." |
| "Will this customer cancel next month?" | "Write the message that might keep them." |

### How does it know what to make?

Think of an apprentice who has spent years studying a huge library: millions of books, articles, websites, programs and pictures. They never memorised it word for word, but they soaked up the *patterns*: how sentences usually flow, how a recipe is laid out, how a function is normally written, what a sunset looks like.

When you ask for something, the apprentice doesn't go and look it up. They produce something new that *fits the patterns* they learnt. That is why generative AI can write a poem that has never existed before, and also why it can confidently say something that sounds right but isn't.

### The everyday kinds

| Kind | What you give it | What you get back | Examples |
|---|---|---|---|
| **Text and code** | A question or an instruction | Writing, answers, code | Claude, ChatGPT, GitHub Copilot |
| **Images** | A description | A picture | Image generators in design tools |
| **Audio** | Text or a description | Speech, music, sound effects | Text-to-speech, music tools |
| **Video** | A description or a still image | A short clip | Video generators |

Many newer tools mix these: you can give a text model a screenshot and ask it questions, or ask an image tool to edit part of a photo.

### What it is good at, and what to watch for

**Good at:**

- first drafts, summaries, rewording and translating;
- explaining things in the style you ask for;
- writing and fixing routine code;
- brainstorming lots of options quickly.

**Watch for:**

- **Made-up facts.** It produces what *sounds* right. Check anything important. (People call this "hallucination".)
- **Out-of-date knowledge.** It only knows what was in its training library, up to a cut-off date, unless it is given a way to look things up.
- **It doesn't "understand" the way you do.** It is extremely good at patterns, which is useful, but it can miss the obvious.

### Where the cost comes from

Every time generative AI reads your request and writes its answer, it does a lot of computing. Text tools measure that work in **tokens** (small chunks of text), and that is what you pay for. A long request, a long answer, or a long conversation all cost more. [How tokens work](how-tokens-work.md) explains this in five minutes; tokenomics exists to show you where those tokens go.

That's all you need for the big picture. If you want the machinery, read on, or go straight to [What is an LLM?](what-is-an-llm.md).

---

## Part 2: The technical version

### 2.1 Generative versus discriminative models

Machine learning models are often split into two families:

| | Discriminative | Generative |
|---|---|---|
| **Learns** | The boundary between categories: `P(label \| input)` | What the data itself looks like: `P(data)`, or `P(data \| prompt)` |
| **Output** | A label, score or number | A new sample: text, image, audio |
| **Examples** | Spam filters, fraud scores, image classifiers | Language models, diffusion image models |

A generative model has learnt a **probability distribution** over its data. "Generating" means **sampling** from that distribution, usually conditioned on a prompt. Because it is sampling, the same prompt can give different outputs, and output that is *probable* is not guaranteed to be *true*.

### 2.2 How generative models learn

Modern generative AI is built on large neural networks trained in stages:

1. **Pre-training.** The model is trained on a very large, general dataset (web text, books, code, image-caption pairs) with a **self-supervised** objective: the training signal comes from the data itself, so no human labelling is needed. For text the task is "predict the next token"; for diffusion image models it is "remove the noise from this image".
2. **Fine-tuning.** The general model is trained further on smaller, curated data so it follows instructions, holds a conversation, writes code well, or uses tools.
3. **Alignment / preference training.** Humans (and increasingly other models) compare outputs, and the model is tuned towards the preferred ones: helpful, honest, safe. Techniques include RLHF (reinforcement learning from human feedback), constitutional approaches and direct preference optimisation.

A model trained broadly and then adapted to many tasks is often called a **foundation model**.

### 2.3 The main architectures

| Architecture | Core idea | Typically used for |
|---|---|---|
| **Autoregressive transformer** | Generate one token at a time, each conditioned on everything before it. | Text and code (LLMs); also some image and audio models. |
| **Diffusion model** | Start from random noise and repeatedly denoise it towards a sample that matches the prompt. | Images, video, audio. |
| **Variational autoencoder (VAE)** | Compress data into a small "latent" space and learn to decode from it. | Often a component inside diffusion systems (latent diffusion). |
| **Generative adversarial network (GAN)** | A generator and a discriminator trained against each other. | Earlier image generation; now largely overtaken by diffusion. |

**Multimodal** models take or produce more than one kind of data. A common pattern is an LLM that also accepts images: the image is turned into a sequence of embedding vectors ("image tokens") that sit in the context alongside the text.

### 2.4 How a sample is produced

For a text model, each step produces a probability for every token in the vocabulary. A **decoding strategy** turns those probabilities into a choice:

| Setting | Effect |
|---|---|
| **Greedy** | Always take the most likely token. Repeatable, but can be dull or loop. |
| **Temperature** | Below 1 sharpens the distribution (safer, more predictable); above 1 flattens it (more varied, more risk). |
| **Top-k / top-p (nucleus)** | Only sample from the *k* most likely tokens, or the smallest set whose probabilities add up to *p*. |
| **Stop sequences / max tokens** | Where generation ends. |

The output length is not known in advance, which is why output tokens are both the slow part and the expensive part (see [How tokens work, 2.4](how-tokens-work.md#24-output-tokens)).

### 2.5 Why it gets things wrong

- **Hallucination.** The model is optimised to produce *plausible* continuations. When the training data doesn't pin down the answer, a plausible-but-wrong answer is a natural result.
- **Knowledge cut-off.** Parameters are frozen at training time. Newer facts have to be supplied in the prompt (pasted in, or fetched by a tool: see **retrieval-augmented generation** in [What is an LLM?](what-is-an-llm.md#27-giving-a-model-knowledge-it-doesnt-have)).
- **Sensitivity to the prompt.** Small wording changes can shift the output, because they shift the conditional distribution.
- **Bias.** Patterns in the training data, including unwanted ones, are learnt along with the useful ones.

The practical answer is the same in each case: **measure the result, don't assume it.** That is the idea behind tokenomics' [tastetest](reference.md#tastetest), which compares two runs on your real tests, linter and type checker rather than on how the output looks.

### 2.6 Where tokens and cost come in

Generative models are expensive to run because every output step is a full pass through a network with billions of parameters. Providers price that compute per **token** for text models (and per image, second of audio or second of video for other media; images given to a text model are converted into tokens too).

For language models specifically, cost depends on:

- **input tokens**: everything the model reads, including the whole conversation so far;
- **output tokens**: everything it writes, priced several times higher;
- **cache reads and writes**: discounted re-reads of recent input;
- **which model**: bigger models cost more per token.

[How tokens work](how-tokens-work.md) covers each of these in depth.

### 2.7 Quick reference

| Term | One-line summary |
|---|---|
| Generative AI | Models that produce new content by sampling from a learnt distribution. |
| Discriminative model | A model that classifies or scores rather than creates. |
| Foundation model | A large model pre-trained broadly, then adapted to many tasks. |
| Pre-training | Self-supervised learning on a huge general dataset. |
| Fine-tuning | Further training on curated data for a specific behaviour. |
| Diffusion | Generating by repeatedly removing noise. |
| Autoregressive | Generating one token at a time, each based on all before it. |
| Multimodal | Works with more than one kind of data (text, images, audio). |
| Hallucination | Fluent, plausible output that is wrong. |
| Temperature | How adventurous sampling is. |

### Further reading

- Vaswani et al. (2017), *Attention Is All You Need*: the transformer architecture.
- Ho, Jain and Abbeel (2020), *Denoising Diffusion Probabilistic Models*: the basis of modern image diffusion.
- Bommasani et al. (2021), *On the Opportunities and Risks of Foundation Models*.

---

<p align="center"><a href="README.md">All docs</a> · <a href="what-is-an-llm.md">What is an LLM? →</a></p>
