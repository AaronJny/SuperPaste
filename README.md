# Super Paste

A cross-platform clipboard manager for macOS, Windows and Linux.

Built with **Tauri v2 + React + TypeScript + Rust**.

## Features

- 📋 Clipboard monitoring (text + images, auto-filters >10MB)
- 🔍 Search and filter history
- ⌨️ Global hotkey `Cmd/Ctrl+Shift+V` to open panel
- 💾 SQLite persistent storage
- 🔄 Content deduplication (SHA256)
- 🖼️ Image thumbnails
- ⏰ Auto-cleanup (30 days / 1000 items)
- ⚙️ Customizable settings

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

#### Linux Only
```bash
# Ubuntu/Debian
sudo apt install xdotool

# Fedora
sudo dnf install xdotool

# Arch
sudo pacman -S xdotool
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

## Usage

| Action | Shortcut |
|--------|----------|
| Open/Close panel | `Cmd/Ctrl+Shift+V` |
| Navigate cards | `←` `→` |
| Enter card mode | `↓` |
| Back to search | `↑` |
| Paste selected | `Enter` |
| Delete item | `Delete` |

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | ✅ Full | Native API |
| Windows | ✅ Full | Win32 API |
| Linux (X11) | ✅ Full | Requires xdotool |
| Linux (Wayland) | ⚠️ Limited | Focus restore may not work |

## License

MIT
