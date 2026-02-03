# Super Paste

[中文文档](./README.zh-CN.md)

A cross-platform clipboard manager for macOS, Windows and Linux.

Built with **Tauri v2 + React + TypeScript + Rust**.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 📋 **Clipboard Monitoring** - Automatically captures text and images (filters >10MB)
- 🔍 **Search & Filter** - Quickly find items in your clipboard history
- ⌨️ **Global Hotkey** - `Cmd/Ctrl+Shift+V` to open panel from anywhere
- 🖥️ **Multi-Monitor Support** - Panel appears on the monitor where your cursor is
- 🎯 **Fullscreen Support** - Works over fullscreen apps on macOS
- 💾 **Persistent Storage** - SQLite database keeps your history safe
- 🔄 **Deduplication** - SHA256 hash prevents duplicate entries
- 🖼️ **Image Thumbnails** - Visual preview for copied images
- ⏰ **Auto Cleanup** - Removes items older than 30 days or exceeding 1000 entries
- ⚙️ **Customizable** - Configure shortcuts and preferences

## Download

Download the latest release from [Releases](../../releases).

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Super Paste_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Super Paste_x.x.x_x64.dmg` |
| Windows | `Super Paste_x.x.x_x64.msi` |
| Linux | `.deb` / `.AppImage` |

### macOS Users

If you see **"Super Paste" is damaged and can't be opened**, run this command in Terminal:

```bash
xattr -cr /Applications/Super\ Paste.app
```

This is because the app is not signed with an Apple Developer certificate.

## Usage

| Action | Shortcut |
|--------|----------|
| Open/Close panel | `Cmd/Ctrl+Shift+V` |
| Navigate cards | `←` `→` |
| Enter card mode | `↓` |
| Back to search | `↑` |
| Copy & Paste | `Enter` or click |
| Copy only | `Cmd/Ctrl+C` |
| Delete item | `Delete` |

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

#### Linux Only
```bash
# Ubuntu/Debian
sudo apt install xdotool libgtk-3-dev libwebkit2gtk-4.1-dev

# Fedora
sudo dnf install xdotool gtk3-devel webkit2gtk4.1-devel

# Arch
sudo pacman -S xdotool gtk3 webkit2gtk-4.1
```

### Build

```bash
# Install dependencies
npm install

# Development
npm run tauri dev

# Production build
npm run tauri build
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | ✅ Full | Native API |
| Windows | ✅ Full | Win32 API |
| Linux (X11) | ✅ Full | Requires xdotool |
| Linux (Wayland) | ⚠️ Limited | Focus restore may not work |

## License

MIT
