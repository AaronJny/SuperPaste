# Super Paste

跨平台剪贴板管理器，支持 macOS、Windows 和 Linux。

基于 **Tauri v2 + React + TypeScript + Rust** 构建。

![Platform](https://img.shields.io/badge/平台-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/许可证-MIT-green)

## 功能特性

- 📋 **剪贴板监听** - 自动捕获文字和图片（过滤 >10MB 的内容）
- 🔍 **搜索过滤** - 快速查找历史记录
- ⌨️ **全局快捷键** - `Cmd/Ctrl+Shift+V` 随时唤起面板
- 🖥️ **多显示器支持** - 面板显示在光标所在的显示器上
- 🎯 **全屏应用支持** - 可在 macOS 全屏应用上显示
- 💾 **持久化存储** - SQLite 数据库保存历史记录
- 🔄 **内容去重** - SHA256 哈希防止重复条目
- 🖼️ **图片缩略图** - 可视化预览复制的图片
- ⏰ **自动清理** - 清除 30 天前或超过 1000 条的记录
- ⚙️ **可自定义** - 配置快捷键和偏好设置

## 下载

从 [Releases](../../releases) 下载最新版本。

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `Super Paste_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Super Paste_x.x.x_x64.dmg` |
| Windows | `Super Paste_x.x.x_x64.msi` |
| Linux | `.deb` / `.AppImage` |

### macOS 用户

如果提示 **"Super Paste"已损坏，无法打开**，请在终端运行以下命令：

```bash
xattr -cr /Applications/Super\ Paste.app
```

这是因为应用未经过 Apple 开发者证书签名。

## 使用方法

| 操作 | 快捷键 |
|------|--------|
| 打开/关闭面板 | `Cmd/Ctrl+Shift+V` |
| 切换卡片 | `←` `→` |
| 进入卡片模式 | `↓` |
| 返回搜索框 | `↑` |
| 复制并粘贴 | `Enter` 或点击 |
| 仅复制 | `Cmd/Ctrl+C` |
| 删除条目 | `Delete` |

## 从源码构建

### 前置条件

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

#### 仅 Linux
```bash
# Ubuntu/Debian
sudo apt install xdotool libgtk-3-dev libwebkit2gtk-4.1-dev

# Fedora
sudo dnf install xdotool gtk3-devel webkit2gtk4.1-devel

# Arch
sudo pacman -S xdotool gtk3 webkit2gtk-4.1
```

### 构建

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 生产构建
npm run tauri build
```

## 平台支持

| 平台 | 状态 | 备注 |
|------|------|------|
| macOS | ✅ 完整支持 | 原生 API |
| Windows | ✅ 完整支持 | Win32 API |
| Linux (X11) | ✅ 完整支持 | 需要 xdotool |
| Linux (Wayland) | ⚠️ 有限支持 | 焦点恢复可能不工作 |

## 许可证

MIT
