# ⚡ PhotoGPT Proxy

> **PhotoGPT (GPT Image 2) 多账号轮询反向代理服务**
> 
> 提供开箱即用的 **Web 可视化控制台**、**多账号智能积分追踪轮询**、**OpenAI 标准生图 API** 以及 **即梦 (Dreamina) 原生兼容接口**，支持一键无缝接入 **SHUO Canvas** 及任意第三方 AI 客户端。

---

## 🌟 核心特性

- 🎯 **零审核限制**：彻底解决官方公约/风控拦截痛点，完美支持人物三视图、半透服装、写实人像与各种创意出图。
- 👥 **多账号智能轮询 (Round-Robin)**：
  - 单账号赠送 20 积分（单次消耗 6 积分，可出 3 张图）；
  - 自动追踪各账号积分余量，耗尽时**毫秒级动态热切换 Cookie**，无需多开浏览器！
- 🖥️ **现代化 Web 可视化控制台**：
  - 实时监控账号池状态、积分余量、出图进度与系统负载；
  - 网页内一键弹窗添加新账号、启用/禁用或删除账号；
  - 内置 **Playground 在线生图测试**（支持提示词输入、垫图拖拽上传、比例切换与原图秒级下载）；
  - 实时调用日志流水与原图缩略图预览。
- 🔌 **双标准协议兼容**：
  - **OpenAI 兼容生图接口**：`POST /v1/images/generations`，支持标准 `url` 与 `b64_json` 响应；
  - **Dreamina 兼容接口**：`POST /api/v2/dreamina/image2image` 等，无缝直连 SHUO Canvas【人物替换工作室】。
- 🛡️ **反防盗链图片代理**：内置 `/proxy-image` 端点，彻底解决官方 CDN 图片 Referer 403 访问限制。

---

## 🚀 快速开始

### 1. 克隆与安装依赖

```bash
git clone https://github.com/tjq131023-ui/photogpt-proxy.git
cd photogpt-proxy
npm install
```

### 2. 启动后台调试 Chrome

PhotoGPT 依托后台 Chrome 实例进行请求派发：

```bash
# Windows 启动命令
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-dev"
```

### 3. 配置账号

首次使用可通过复制模板文件创建账号池：

```bash
cp accounts.example.json photogpt_accounts.json
```

或直接启动服务后，在 **Web 控制台 (http://127.0.0.1:8180)** 点击右上角 **【+ 添加账号】** 可视化录入。

### 4. 启动代理服务

```bash
npm start
```

服务默认运行在 `http://127.0.0.1:8180`。

---

## 🖥️ Web 可视化控制台

启动服务后，在浏览器访问：
👉 **http://127.0.0.1:8180**

- **账号池管理**：实时查看各账号剩余积分与出图张数；
- **Playground 在线测试**：输入提示词与上传垫图，一键测试生成并下载原图；
- **实时日志**：实时追踪每一笔生图调用的耗时与状态。

---

## 🔌 API 接口文档

### 1. OpenAI 格式生图 (`POST /v1/images/generations`)

```bash
curl http://127.0.0.1:8180/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "全身角色立绘三视图，正视图，侧视图，后视图，灰色背景",
    "image": "data:image/png;base64,...",
    "size": "1024x576"
  }'
```

**响应示例：**
```json
{
  "created": 1787840400,
  "data": [
    {
      "url": "http://127.0.0.1:8180/proxy-image?url=...",
      "sourceUrl": "https://..."
    }
  ]
}
```

### 2. Dreamina 格式生图 (`POST /api/v2/dreamina/image2image`)

```bash
curl http://127.0.0.1:8180/api/v2/dreamina/image2image \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "全身角色立绘三视图",
    "images": ["https://example.com/ref.png"],
    "ratio": "16:9"
  }'
```

---

## 🎨 SHUO Canvas 画布无缝集成

在 SHUO Canvas 中，本代理会自动接管【替换工作室】与【即梦】生图节点：
1. 打开 SHUO Canvas【人物替换工作室】；
2. 上传人物参考图并点击【生成人物三视图】；
3. 后端将自动由 `127.0.0.1:8180` 派发出图，享受零审核拦截与自动多账号轮询！

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
