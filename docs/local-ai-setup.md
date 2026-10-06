# Local AI for the Content Designer

The **Content Designer → ✨ AI generate** feature turns a text prompt into a finished
sign: the layout and copy come from an LLM, and (optionally) the background /
foreground imagery comes from an image model. ScreenTinker is **bring-your-own**:
you point each workspace at an **OpenAI-compatible** text endpoint and an image
endpoint of your choice. Nothing is sent to us, and the operator pays no AI costs.

This guide sets up a fully **local, free** stack:

- **Text / layout** → [Ollama](https://ollama.com) (OpenAI-compatible)
- **Images** → [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) server (OpenAI-compatible)

Prefer the cloud? Skip to [Using OpenAI instead](#using-openai-instead).

> [!NOTE]
> On ScreenTinker-hosted servers there is also a second path, **ScreenTinker credits**: images
> generated with platform keys and paid in organization credits. The bring-your-own setup on this
> page never uses credits. See [ai-credits.md](ai-credits.md).

> [!IMPORTANT]
> To use **localhost / LAN** AI endpoints, your instance must run with
> **`SELF_HOSTED=true`**. ScreenTinker blocks private/internal addresses for the
> AI endpoints (SSRF protection) unless it is in self-hosted mode. See
> [Enable self-hosted mode](#1-enable-self-hosted-mode).

---

## 1. Enable self-hosted mode

The AI endpoint config is gated by an SSRF guard. On a self-hosted box this guard
is relaxed so you can point at `localhost`. Set the env var:

```bash
# systemd: drop-in (recommended)
sudo mkdir -p /etc/systemd/system/screentinker.service.d
printf '[Service]\nEnvironment=SELF_HOSTED=true\n' | sudo tee /etc/systemd/system/screentinker.service.d/selfhosted.conf
sudo systemctl daemon-reload && sudo systemctl restart screentinker
```

(Or `SELF_HOSTED=true npm start` for a manual run.)

---

## 2. Text / layout model — Ollama

```bash
# Install (use a recent build — 0.30+ is required for NVIDIA 50-series / Blackwell)
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model. 8B is a good size/quality balance for signage copy.
ollama pull llama3.1:8b

# Confirm it's loaded on the GPU
ollama ps
```

Ollama exposes an OpenAI-compatible API at **`http://localhost:11434/v1`**. No API
key is required (any value works).

In **Designer → ⚙ AI settings**:

| Field | Value |
|---|---|
| Endpoint base URL | `http://localhost:11434/v1` |
| Model | `llama3.1:8b` (or click **Load models**) |
| API key | *(leave blank)* |

That alone enables AI generation (text + shapes). Add images below.

---

## 3. Image model — stable-diffusion.cpp (Vulkan)

We use the prebuilt **stable-diffusion.cpp** server. Its `--backend` runs on
**Vulkan**, which works on modern NVIDIA GPUs even where CUDA/PyTorch (ComfyUI)
fails to initialize — see [GPU notes](#gpu-notes--troubleshooting).

```bash
# 1. Grab the prebuilt server from the releases page and pick the variant for
#    your GPU (…-vulkan.zip works broadly; cuda / rocm builds also exist):
#    https://github.com/leejet/stable-diffusion.cpp/releases
mkdir -p ~/sd-server && cd ~/sd-server
unzip ~/Downloads/sd-*-vulkan.zip          # -> sd-server, sd-cli, libstable-diffusion.so

# 2. A checkpoint. SDXL base is a solid default (~6.5 GB):
mkdir -p models
curl -L -o models/sd_xl_base_1.0.safetensors \
  https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors

# 3. Find your GPU's Vulkan device index, then run the server.
#    The startup log prints "Found N Vulkan devices" — note the index of your
#    discrete GPU (an Intel/AMD iGPU is often device 0, the dGPU device 1).
LD_LIBRARY_PATH=~/sd-server ~/sd-server/sd-server \
  -m ~/sd-server/models/sd_xl_base_1.0.safetensors \
  --backend vulkan1 --listen-port 7860
```

The server is OpenAI-compatible at **`http://localhost:7860/v1`**
(`POST /v1/images/generations`). Smoke test:

```bash
curl -s http://localhost:7860/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a cozy cafe interior, no text","size":"1024x576","response_format":"b64_json"}' \
  | head -c 80
```

In **Designer → ⚙ AI settings → AI images**:

| Field | Value |
|---|---|
| Image provider | **Stable Diffusion — local (sd.cpp)** |
| Image endpoint URL | `http://localhost:7860/v1` |
| Image model | *(leave blank — uses the loaded checkpoint)* |
| Image API key | *(leave blank)* |

Now a prompt produces a full sign: an atmospheric background, crisp text on top,
and an optional foreground graphic.

### Run it as a service (recommended)

```ini
# /etc/systemd/system/sd-server.service
[Unit]
Description=stable-diffusion.cpp image server
After=network.target

[Service]
User=youruser
Environment=LD_LIBRARY_PATH=/home/youruser/sd-server
ExecStart=/home/youruser/sd-server/sd-server -m /home/youruser/sd-server/models/sd_xl_base_1.0.safetensors --backend vulkan1 --listen-port 7860
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now sd-server
```

> **VRAM:** the server keeps the checkpoint resident (~6.5 GB for SDXL). The app
> requests modest sizes (1024×576 background, 768×768 foreground) so it fits
> alongside the LLM on a single ~16 GB+ GPU. Larger sizes need a tiled VAE
> (`--vae-tiling`) or more VRAM. ComfyUI works too — set the provider to
> **ComfyUI** and point at `http://localhost:8188`.

---

## Using OpenAI instead

No local hardware? Use the cloud (you pay OpenAI directly):

- **Text:** endpoint `https://api.openai.com/v1`, model e.g. `gpt-4o-mini`, paste your key.
- **Images:** provider **OpenAI / OpenAI-compatible**, endpoint `https://api.openai.com/v1`,
  model e.g. `gpt-image-1`.

If your **text** endpoint is local (no key) but **images** are OpenAI, put the
OpenAI key in the separate **Image API key** field. When that field is blank, the
image endpoint reuses the main API key.

---

## GPU notes / troubleshooting

- **NVIDIA 50-series (Blackwell):** CUDA compute can fail to initialize for
  PyTorch-based tools (ComfyUI) with `CUDA unknown error`, even though
  `nvidia-smi` works. **Vulkan** does work — which is why this guide uses Ollama
  (Vulkan) and stable-diffusion.cpp (Vulkan). Use a recent Ollama (0.30+).
- **Wrong/slow device:** if generation is CPU-slow, the tool picked the wrong
  Vulkan device. Check the startup log's device list and set `--backend vulkanN`
  (sd.cpp) accordingly; Ollama honours `GGML_VK_VISIBLE_DEVICES`.
- **`Endpoint URL not allowed`** when saving AI settings → the instance is not in
  self-hosted mode. See [step 1](#1-enable-self-hosted-mode).
- **Images time out** → a cold or under-powered model. Try a smaller checkpoint
  (e.g. SD 1.5) or fewer steps; first request also pays the model-load cost.
- **Publishing a sign with images** embeds the generated images in the widget,
  so configs can be a few MB each. That's expected today.
