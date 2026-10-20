<div align="center">

<img src="frontend/src/brand/logo.svg" alt="Imagora" width="72" height="72">

<h1>Imagora | 意象集</h1>

<p>
  <a href="https://github.com/zlZayn/imagora/actions/workflows/ci.yml"><img src="https://github.com/zlZayn/imagora/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href=".python-version"><img src="https://img.shields.io/badge/python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12"></a>
  <a href="frontend/package.json"><img src="https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=black" alt="React 19"></a>
</p>

<div align="center">
  <p>
    <a href="README.md">简体中文</a> · <strong><a href="README_en.md">English</a></strong>
  </p>
</div>

<p><b>An AI image generation workbench that runs on your own machine</b></p>

<p>Text-to-image and image-to-image in one place, workflows composed on an infinite canvas, prompt contracts imported in one click, parallel generation across multiple windows (each distinguished by its accent color).<br>
Batch mode and a command line are included. Prompts, reference images, tasks, outputs, and costs are all managed in one place.</p>

<p>It is not tied to a use case — product shots, character design, covers and posters, concept art, bulk asset generation: anything you can write as a prompt, it can do.</p>

</div>

> **Data boundary**　Requests go straight to the endpoint you configure; keys stay in your local `.env`; images and generation records land in local directories only, with no intermediary service.

## Interface at a glance

![Infinite canvas: image and prompt nodes, connections, results flowing back](assets/screenshots/canvas-overview.png)

| Classic form | Parallel multi-window |
| --- | --- |
| ![Classic form page](assets/screenshots/form-view.png) | ![Parallel multi-window menu](assets/screenshots/terminal-window.png) |

The interface has changed several times; the screenshots above are due for a reshoot.

<!-- Pending screenshot: appearance dialog open (accent presets + card transparency slider) -->
<!-- Suggested caption: the palette icon at the right of the top bar opens the appearance dialog -->
<!-- Pending screenshot: a full page with a wallpaper applied -->
<!-- Suggested caption: the wallpaper fills the page while cards and text stay readable -->

## Four main capabilities

### From one prompt to one image

Type a prompt, click "Generate". With no reference image it is text-to-image; with one or several it is image-to-image.
Every entry in the size dropdown is labelled with its price, quality is selectable and defaults to high, and the output location remembers the one you used last.
Reference images can be dragged in, pasted with `Ctrl+V`, or picked from a dialog — several at a time, and each one can be replaced or removed individually.
If no key is configured, the top of the page says so right away — you won't fill in a whole round only to find out it cannot run.

### Infinite canvas

Lay prompt cards and images out on one canvas; **a connection is a reference relationship** — connect an image to a prompt and that image becomes its reference.
Several images can be grouped first, and groups can be merged again, saving you from drawing every connection one by one.
There are three ways to run: a single card's own "Run", "Run all", or "Run selected" for a few selected cards.
A generated result automatically becomes a new image node right below that prompt, ready to be wired onward — no dragging images around.
Any single result from the classic form can also be imported into the current canvas with one click and refined further.

### Batch and reuse

For many images at once, the fastest route is to lay out multiple prompt cards on the canvas and submit them together; the server queues and runs them concurrently, and each result flows back to its own card.
Paste a whole block of model-written prompts into "Paste import" and it shows in real time how many cards were detected and what aspect ratio each one has; confirm and they are all created at once. Anything malformed is flagged line by line, so you never end up with half a broken card.
To run several unrelated jobs at the same time, open multiple windows: numbering is assigned by the server and never collides, and a new window automatically carries over the current window's size, quality, and output location (prompts are not carried over, so you don't think you are still editing the previous one).
The command line supports batch too: hand it a list of prompts and it runs them one by one; before running you can preview the estimated cost, and the preview costs nothing.

### Where the money goes, at a glance

The top of the generation history panel is the cost board: today's spend, total spend, success rate, failure count, average time per success, plus a breakdown by size.
**This panel lives on the canvas page's toolbar and is not on the classic form page** — the history and every number on the board are reached from there.
Two limits can be set: a daily budget and a per-run cap; 0 means unlimited (the default — no nagging). Every submission is priced first; if a limit is exceeded, a confirmation appears stating "spent today + estimated for this run", and nothing is submitted until you confirm. Simultaneous submissions from multiple windows are held back as well.
Failed records show why they failed in the panel (missing reference images are counted separately); to try again, fix the prompt on the canvas and run it again.

## Feature map

### While generating

| | |
| --- | --- |
| Size and aspect ratio | Pick an aspect ratio, then a 1K / 2K / 4K tier; the resolution is derived automatically |
| Output format | png / jpg / webp; if the filename has an extension, that wins |
| Generation time | Usually tens of seconds to a couple of minutes; English prompts tend to be more reliable |
| Recent prompts | Listed when the result area is empty; click one to put it back in the input box |

### Managing results

| | |
| --- | --- |
| Generation history | Search by prompt, quality, or filename; filter by success or failure; scrolling to the bottom keeps loading |
| Full-size preview | Double-click an image for a full-screen view; wheel to zoom, drag to pan, one click back to actual size or fit-to-window |
| Output location | Type a path or pick a folder; after generation, open it in Explorer with one click |
| Log | Only final results and action feedback; local paths that appear can be clicked to copy |
| Workflows | Save and restore the canvas by name, asking first if the name is taken; workflows still restore after the project is renamed or moved |

### Changing configuration

| | |
| --- | --- |
| Multiple providers | Endpoint, model, sizes, and prices live side by side in one config file and switch with a single line; the title bar shows which one is active |
| Switch config in the UI | Model chip in the top bar → config dialog: **pick** a provider and a model from the known lists, written back to your local `.env`; marked as pending restart |
| Everything else: edit the file | Endpoint / path / key are write-once — use a text editor on `config.json` (factory catalog) and `.env` (local overrides); the dialog and the files touch the **same data**, there is no second copy in the browser |

### Appearance

| | |
| --- | --- |
| Accent color | A set of presets plus hue fine-tuning; windows shift color by number automatically, and the tab icon follows |
| Background | Two light base tones (accent-following or plain white); page wallpaper from your own image |
| Card transparency | Can be pulled to nearly fully transparent; input fields keep a readability floor so text never floats on a busy background |
| Canvas border | Can be turned off so the canvas blends into the page background |

## Running it

### 1. Prerequisites

Python 3.12 and [`uv`](https://docs.astral.sh/uv/); add Node and `npm` if you want to change the interface.
Windows is the primary platform this project is used and verified on.

### 2. Configure a key

```powershell
Copy-Item .env.example .env
# Edit .env and fill in the key for the active profile, e.g. API_KEY_WANWU=sk-your-key
```

`.env` is git-ignored and never enters the repository. **The key is not entered in the UI** (the dialog only picks a provider and a model) — changing a key means editing this line in a text editor. The dialog shows whether the active provider has a key set.

> **Optional local mirror**　Dependencies install from the official PyPI. If that is slow where you are,
> add `index-url = "https://pypi.tuna.tsinghua.edu.cn/simple"` to your **machine-level**
> `%APPDATA%\uv\uv.toml` (Windows) or `~/.config/uv/uv.toml`.
> **Do not commit `uv.lock` while that is active** — the lock pins the source into every package
> (absolute download URLs included), which breaks CI runners abroad. `uv lock --check` tells you if it drifted.

### 3. Start

Double-click `启动生图工作台.exe` in the project root: it checks whether the frontend is built → starts the server → opens a window → enters an interactive menu, where `N` opens the next window and `Q` (or closing the window) stops the server and everything under it.

Or start it manually:

```powershell
uv run python -m main ui --port 8080
```

### 4. Your first image

Open the page → type a prompt → pick size and quality → click "Generate".
A minute or two later the result appears on the right and enters the generation history. That is the whole loop; everything else is wiring it into a flow on the canvas.

### 5. Common commands

| Command | Purpose |
| --- | --- |
| `uv run python -m main gen "a red apple" --size 1024x1024 --quality high -o out.png` | Single generation |
| `uv run python -m main batch --config <project dir>\batch_prompts.json --dry-run` | Batch preview, costs nothing |
| `uv run python -m main config` | Show which sizes, ratios, and qualities the current configuration supports |

Development commands for tests, builds, and E2E are in [AGENTS.md](AGENTS.md).

## Command line

`gen` is equivalent to the web page; outputs go into the same generation history, and either side can look up the other.

```powershell
uv run python -m main gen "a red apple on white background" --size 1024x1024 --quality high -o out.png
```

For available sizes, ratios, qualities, and default tiers, trust the live output of `python -m main config` — they follow the configuration, and any copy transcribed into documentation will eventually be stale.

## Where it came from

It started with online-shop product images: each product needed carousel and detail shots, doing them by hand took about an hour and a half per product, and the prompts returned by multimodal models were too inconsistent in format to batch directly.
After turning the whole chain — reference image understanding → prompt specification → batch generation → output and cost records — into a tool, and constraining model replies with a strict output format, the same job dropped to about fifteen minutes, and it was handed over to a colleague who keeps using it.

The format specs are [docs/prompt-import-format.md](docs/prompt-import-format.md) (general) and [docs/ecom-prompt-import-format.md](docs/ecom-prompt-import-format.md) (ordering specific to product images).
This is why it was built, not what it is limited to.

## More

To modify the code or look at the internals: [AGENTS.md](AGENTS.md) (what to sync when you change something) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (data flow, contracts, pitfall list) · [frontend/README.md](frontend/README.md) (frontend modules and styling system).

## Contributing

A personal project; issues and PRs are welcome. Before changing anything, read [AGENTS.md](AGENTS.md) — it spells out which files to sync and which checks to run for each kind of change.

## License

[MIT](LICENSE) © 2026 陈盛泷 (Chen Shenglong), zlZayn (Zayn Liu)
